import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { checkPlayerName, containsForbiddenWord } from '../games/player-name-policy';
import { TetrisBattleError } from './tetris-battle.errors';
import { LOBBY_CHAT_HISTORY_LIMIT, LOBBY_CHAT_HISTORY_TTL_SEC } from './tetris-battle.constants';
import type { LobbyChatMessage } from './tetris-battle.events';
import { TetrisBattleRoomService, containsDisallowedChars } from './tetris-battle-room.service';

/** 최근 대화 — Redis List(최신이 앞), 최대 LOBBY_CHAT_HISTORY_LIMIT개, 마지막 메시지 뒤 LOBBY_CHAT_HISTORY_TTL_SEC 동안만 */
const HISTORY_KEY = 'tetris-battle:lobby-chat:recent';

/** 계정 이름이 비었거나 이름 정책을 통과하지 못할 때 로그인 사용자 표시 */
const MEMBER_FALLBACK_NAME = '회원';

/** 보낸 사람 표시 — 구독할 때 정해 소켓에 둔다(메시지마다 DB를 읽지 않게) */
export interface LobbyChatSender {
  isGuest: boolean;
  /** 로그인 사용자는 서버가 정한 이름, 게스트는 null(보낼 때마다 이름을 받는다) */
  name: string | null;
}

/**
 * 테트리스 로비 전체 채팅 (docs/tasks/tetris-chat D-001) — DB에 남기지 않는다.
 * 방송은 게이트웨이가 socket.io 채널로 하고(멀티 레플리카는 Redis 어댑터), 이 서비스는 검증·최근 대화·차단 키만 맡는다.
 * 최근 대화는 들어온 사람이 빈 방을 보지 않게 하는 용도라 최근 50개를 30분만 Redis에 둔다
 */
@Injectable()
export class TetrisLobbyChatService {
  private redis: Redis | null = null;
  /** 차단 키 HMAC 비밀 — 설정이 없으면 프로세스마다 난수(레플리카 간 키가 달라 차단이 덜 정확할 뿐 신원은 새지 않는다) */
  private readonly senderKeySecret: string;

  constructor(
    private readonly roomService: TetrisBattleRoomService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    configService: ConfigService,
  ) {
    this.senderKeySecret = configService.get<string>('GAME_IP_HASH_SECRET') || randomBytes(32).toString('hex');
  }

  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /** 보낸 사람 표시 — 로그인은 계정 이름(랭킹 이름 정책을 통과한 것만, 아니면 '회원'), 게스트는 이름 없음 */
  async senderOf(userId: number | null): Promise<LobbyChatSender> {
    if (userId === null) return { isGuest: true, name: null };
    const user = await this.userRepository.findOne({ select: { userId: true, userName: true }, where: { userId } });
    const name = user?.userName?.trim().replace(/\s+/g, ' ') ?? '';
    return { isGuest: false, name: name && checkPlayerName(name) === null ? name : MEMBER_FALLBACK_NAME };
  }

  /** 최근 대화 — 오래된 것부터, 30분 이내만. 깨진 항목은 건너뛴다 */
  async recent(now = Date.now()): Promise<LobbyChatMessage[]> {
    const raw = await this.requireRedis().lrange(HISTORY_KEY, 0, LOBBY_CHAT_HISTORY_LIMIT - 1);
    const since = now - LOBBY_CHAT_HISTORY_TTL_SEC * 1000;
    return raw
      .map(parseMessage)
      .filter((message): message is LobbyChatMessage => message !== null && Date.parse(message.at) >= since)
      .reverse();
  }

  /**
   * 검증 → 메시지 확정 → 최근 대화에 추가. 방송은 호출 쪽(게이트웨이).
   * 금지 문자·금칙어 → 게스트 이름 → 빈도 순으로 본다. 빈도는 보낸 사람(로그인 userId·게스트 IP)과 IP 두 단위
   */
  async publish(
    { sender, userId, ip, name, text }: { sender: LobbyChatSender; userId: number | null; ip: string; name?: string; text: string },
    now = Date.now(),
  ): Promise<LobbyChatMessage> {
    // 제어·bidi 문자(줄바꿈·방향 오버라이드 등)는 화면을 깨거나 다른 사람의 문장처럼 위장하는 데 쓰인다(방 채팅과 같은 규칙)
    if (containsDisallowedChars(text) || containsForbiddenWord(text)) throw new TetrisBattleError('CHAT_FORBIDDEN');
    const displayName = sender.isGuest ? guestName(name) : (sender.name ?? MEMBER_FALLBACK_NAME);
    const subject = senderSubject(userId, ip);
    const allowed =
      (await this.roomService.consumeRateLimit('lobbyChat', subject)) && (await this.roomService.consumeRateLimit('lobbyChatIp', ip));
    if (!allowed) throw new TetrisBattleError('RATE_LIMITED');

    const message: LobbyChatMessage = {
      id: randomUUID(),
      senderKey: this.senderKey(subject),
      name: displayName,
      isGuest: sender.isGuest,
      text,
      at: new Date(now).toISOString(),
    };
    // MULTI: 추가·자르기·TTL 갱신을 한 번에 — 마지막 메시지 뒤 30분이 지나면 목록 전체가 사라진다
    await this.requireRedis()
      .multi()
      .lpush(HISTORY_KEY, JSON.stringify(message))
      .ltrim(HISTORY_KEY, 0, LOBBY_CHAT_HISTORY_LIMIT - 1)
      .expire(HISTORY_KEY, LOBBY_CHAT_HISTORY_TTL_SEC)
      .exec();
    return message;
  }

  /** 이 사람의 차단 키 — 구독 응답의 me.senderKey(지난 내 글 알아보기) */
  senderKeyOf(userId: number | null, ip: string): string {
    return this.senderKey(senderSubject(userId, ip));
  }

  /** 차단용 키 — 같은 사람이면 같은 값, 해시라 userId·IP를 되돌릴 수 없다 */
  private senderKey(subject: string): string {
    return createHmac('sha256', this.senderKeySecret).update(`lobby-chat:${subject}`).digest('hex').slice(0, 16);
  }

  private requireRedis(): Redis {
    // 어댑터 클라이언트는 끊긴 동안 명령이 무한 대기한다 → ready가 아니면 바로 거부(방 서비스와 같은 규칙)
    if (!this.redis || this.redis.status !== 'ready') throw new TetrisBattleError('SERVICE_UNAVAILABLE');
    return this.redis;
  }
}

/** 보낸 사람 단위 — 로그인은 계정, 게스트는 접속 IP. 빈도 제한과 차단 키가 같은 단위를 쓴다 */
function senderSubject(userId: number | null, ip: string): string {
  return userId === null ? `ip:${ip}` : `u:${userId}`;
}

/** 게스트 이름 — 대전 플레이어 이름과 같은 정책(NAME_* code) */
function guestName(name: string | undefined): string {
  if (name === undefined) throw new TetrisBattleError('NAME_INVALID');
  const verdict = checkPlayerName(name);
  if (verdict === 'INVALID') throw new TetrisBattleError('NAME_INVALID');
  if (verdict === 'FORBIDDEN') throw new TetrisBattleError('NAME_FORBIDDEN');
  return name;
}

function parseMessage(raw: string): LobbyChatMessage | null {
  try {
    const value = JSON.parse(raw) as Partial<LobbyChatMessage>;
    return typeof value.id === 'string' && typeof value.text === 'string' && typeof value.at === 'string' && typeof value.name === 'string'
      ? (value as LobbyChatMessage)
      : null;
  } catch {
    return null;
  }
}
