import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Repository } from 'typeorm';
import type { User } from '../../entities/User';
import { checkPlayerName, containsForbiddenWord } from '../games/player-name-policy';
import { containsDisallowedChars } from './game-room-text';

/** 계정 이름이 비었거나 이름 정책을 통과하지 못할 때 로그인 사용자 표시 */
const MEMBER_FALLBACK_NAME = '회원';

/** 로비 채팅 메시지 — 각 게임 events.ts의 LobbyChatMessage와 같은 모양(프론트 계약은 그 파일이 정본) */
export interface GameLobbyChatMessage {
  id: string;
  senderKey: string;
  name: string;
  isGuest: boolean;
  text: string;
  /** ISO 8601 (UTC) */
  at: string;
}

/** 보낸 사람 표시 — 구독할 때 정해 소켓에 둔다(메시지마다 DB를 읽지 않게) */
export interface LobbyChatSender {
  isGuest: boolean;
  /** 로그인 사용자는 서버가 정한 이름, 게스트는 null(보낼 때마다 이름을 받는다) */
  name: string | null;
}

/** 이 코어가 던지는 거부 — 각 게임이 자기 에러 클래스로 만든다 */
export type LobbyChatRejection =
  | 'CHAT_FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'NAME_INVALID'
  | 'NAME_FORBIDDEN';

export interface GameLobbyChatOptions {
  /** 최근 대화 Redis List 키 — 게임마다 다르다 */
  historyKey: string;
  historyLimit: number;
  historyTtlSec: number;
  reject: (code: LobbyChatRejection) => Error;
  /** 빈도 제한(게임 방 서비스의 공용 리미터) — 'lobbyChat'(보낸 사람)·'lobbyChatIp'(IP) 두 단위 */
  consumeRateLimit: (action: 'lobbyChat' | 'lobbyChatIp', subject: string) => Promise<boolean>;
}

/**
 * 게임 로비 전체 채팅 코어 (테트리스 대전 docs/tasks/tetris-chat D-001 · 포트리스 D-016) — DB에 남기지 않는다.
 * 방송은 게이트웨이가 socket.io 채널로 하고(멀티 레플리카는 Redis 어댑터), 이 클래스는 검증·최근 대화·차단 키만 맡는다.
 * 최근 대화는 들어온 사람이 빈 방을 보지 않게 하는 용도라 최근 N개를 TTL 동안만 Redis에 둔다.
 * 두 게임이 같은 사본을 들고 있던 것을 모았다(docs/tasks/fortress DECISIONS D-014 F3c)
 */
export class GameLobbyChat<TMessage extends GameLobbyChatMessage> {
  private redis: Redis | null = null;
  /** 차단 키 HMAC 비밀 — 설정이 없으면 프로세스마다 난수(레플리카 간 키가 달라 차단이 덜 정확할 뿐 신원은 새지 않는다) */
  private readonly senderKeySecret: string;

  constructor(
    private readonly options: GameLobbyChatOptions,
    private readonly userRepository: Repository<User>,
    senderKeySecret: string | undefined,
  ) {
    this.senderKeySecret = senderKeySecret || randomBytes(32).toString('hex');
  }

  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /** 보낸 사람 표시 — 로그인은 계정 이름(랭킹 이름 정책을 통과한 것만, 아니면 '회원'), 게스트는 이름 없음 */
  async senderOf(userId: number | null): Promise<LobbyChatSender> {
    if (userId === null) return { isGuest: true, name: null };
    const user = await this.userRepository.findOne({
      select: { userId: true, userName: true },
      where: { userId },
    });
    const name = user?.userName?.trim().replace(/\s+/g, ' ') ?? '';
    return { isGuest: false, name: name && checkPlayerName(name) === null ? name : MEMBER_FALLBACK_NAME };
  }

  /** 최근 대화 — 오래된 것부터, TTL 이내만. 깨진 항목은 건너뛴다 */
  async recent(now = Date.now()): Promise<TMessage[]> {
    const raw = await this.requireRedis().lrange(this.options.historyKey, 0, this.options.historyLimit - 1);
    const since = now - this.options.historyTtlSec * 1000;
    return raw
      .map(item => parseMessage<TMessage>(item))
      .filter((message): message is TMessage => message !== null && Date.parse(message.at) >= since)
      .reverse();
  }

  /**
   * 검증 → 메시지 확정 → 최근 대화에 추가. 방송은 호출 쪽(게이트웨이).
   * 금지 문자·금칙어 → 게스트 이름 → 빈도 순으로 본다. 빈도는 보낸 사람(로그인 userId·게스트 IP)과 IP 두 단위
   */
  async publish(
    {
      sender,
      userId,
      ip,
      name,
      text,
    }: { sender: LobbyChatSender; userId: number | null; ip: string; name?: string; text: string },
    now = Date.now(),
  ): Promise<TMessage> {
    const { reject } = this.options;
    // 제어·bidi 문자(줄바꿈·방향 오버라이드 등)는 화면을 깨거나 다른 사람의 문장처럼 위장하는 데 쓰인다(방 채팅과 같은 규칙)
    if (containsDisallowedChars(text) || containsForbiddenWord(text)) throw reject('CHAT_FORBIDDEN');
    const displayName = sender.isGuest ? guestName(name, reject) : (sender.name ?? MEMBER_FALLBACK_NAME);
    const subject = senderSubject(userId, ip);
    const allowed =
      (await this.options.consumeRateLimit('lobbyChat', subject)) &&
      (await this.options.consumeRateLimit('lobbyChatIp', ip));
    if (!allowed) throw reject('RATE_LIMITED');

    const message = {
      id: randomUUID(),
      senderKey: this.senderKey(subject),
      name: displayName,
      isGuest: sender.isGuest,
      text,
      at: new Date(now).toISOString(),
    } as TMessage;
    const { historyKey, historyLimit, historyTtlSec } = this.options;
    // MULTI: 추가·자르기·TTL 갱신을 한 번에 — 마지막 메시지 뒤 TTL이 지나면 목록 전체가 사라진다
    await this.requireRedis()
      .multi()
      .lpush(historyKey, JSON.stringify(message))
      .ltrim(historyKey, 0, historyLimit - 1)
      .expire(historyKey, historyTtlSec)
      .exec();
    return message;
  }

  /** 이 사람의 차단 키 — 구독 응답의 me.senderKey(지난 내 글 알아보기) */
  senderKeyOf(userId: number | null, ip: string): string {
    return this.senderKey(senderSubject(userId, ip));
  }

  /** 차단용 키 — 같은 사람이면 같은 값, 해시라 userId·IP를 되돌릴 수 없다 */
  private senderKey(subject: string): string {
    return createHmac('sha256', this.senderKeySecret)
      .update(`lobby-chat:${subject}`)
      .digest('hex')
      .slice(0, 16);
  }

  private requireRedis(): Redis {
    // 어댑터 클라이언트는 끊긴 동안 명령이 무한 대기한다 → ready가 아니면 바로 거부(방 서비스와 같은 규칙)
    if (!this.redis || this.redis.status !== 'ready') throw this.options.reject('SERVICE_UNAVAILABLE');
    return this.redis;
  }
}

/** 보낸 사람 단위 — 로그인은 계정, 게스트는 접속 IP. 빈도 제한과 차단 키가 같은 단위를 쓴다 */
function senderSubject(userId: number | null, ip: string): string {
  return userId === null ? `ip:${ip}` : `u:${userId}`;
}

/** 게스트 이름 — 대전 플레이어 이름과 같은 정책(NAME_* code) */
function guestName(name: string | undefined, reject: (code: LobbyChatRejection) => Error): string {
  if (name === undefined) throw reject('NAME_INVALID');
  const verdict = checkPlayerName(name);
  if (verdict === 'INVALID') throw reject('NAME_INVALID');
  if (verdict === 'FORBIDDEN') throw reject('NAME_FORBIDDEN');
  return name;
}

function parseMessage<TMessage extends GameLobbyChatMessage>(raw: string): TMessage | null {
  try {
    const value = JSON.parse(raw) as Partial<TMessage>;
    return typeof value.id === 'string' &&
      typeof value.text === 'string' &&
      typeof value.at === 'string' &&
      typeof value.name === 'string'
      ? (value as TMessage)
      : null;
  } catch {
    return null;
  }
}
