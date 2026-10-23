import { Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'crypto';
import type { Redis } from 'ioredis';
import { promisify } from 'util';
import {
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_LIMIT_IP,
  PASSWORD_KEY_LENGTH,
  PASSWORD_SALT_BYTES,
  PLAYER_TOKEN_BYTES,
} from './tetris-battle.constants';
import { TetrisBattleError } from './tetris-battle.errors';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './tetris-battle.events';

/**
 * 대전 방의 비밀값 — 방 코드·재연결 토큰·방 비밀번호 (방 서비스에서 분리, tetris-audit BE-19).
 * 토큰·비밀번호 원문은 저장하지 않는다: 토큰은 sha256, 비밀번호는 scrypt 해시만 방 기록에 남는다.
 */

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const passwordFailKey = (code: string, socketId: string) => `tetris-battle:pwfail:${code}:${socketId}`;
const passwordFailIpKey = (code: string, ip: string) => `tetris-battle:pwfail-ip:${code}:${ip}`;

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

export function hashPlayerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issuePlayerToken(): { token: string; tokenHash: string } {
  const token = randomBytes(PLAYER_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashPlayerToken(token) };
}

/** 둘 다 sha256 hex(같은 길이)라 timingSafeEqual 전제를 만족한다 */
export function playerTokenMatches(storedHash: string, candidateHash: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function hashRoomPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const key = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** scrypt 대조 — 객체로 내보내 테스트가 "검증(scrypt)이 몇 번 돌았는지"를 셀 수 있게 한다(리뷰 F1·G6 테스트) */
export const roomPasswordCheck = {
  async matches(password: string, stored: string): Promise<boolean> {
    const [scheme, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(actual, expected);
  },
};

/**
 * 시도 예약 → 한도 판정 → 검증. 시도를 검증 **전에** INCR로 세고 그 반환값으로 판정하므로
 * 동시에 여러 시도를 보내도 한도를 넘는 시도는 scrypt까지 가지 않고 ROOM_PASSWORD_LOCKED다
 * (먼저 조회하고 실패 후 세는 방식은 동시 시도가 모두 0을 읽어 한도를 우회한다 — 리뷰 F1).
 *  - 같은 소켓: PASSWORD_FAILURE_LIMIT.maxFailures번까지 검증
 *  - 같은 IP: PASSWORD_FAILURE_LIMIT_IP.maxFailures번까지 검증
 * 정답이면 예약한 시도를 되돌린다(DECR) — 잠금은 오답만 센다.
 */
export async function verifyRoomPasswordOrThrow(
  redis: Redis,
  code: string,
  passwordHash: string | null,
  password: string | undefined,
  who: { socketId: string; ip: string },
  logger: Logger,
): Promise<void> {
  const socketKey = passwordFailKey(code, who.socketId);
  const ipKey = passwordFailIpKey(code, who.ip);

  const results = await redis
    .multi()
    .incr(socketKey)
    .expire(socketKey, PASSWORD_FAILURE_LIMIT.windowSec, 'NX')
    .incr(ipKey)
    .expire(ipKey, PASSWORD_FAILURE_LIMIT_IP.windowSec, 'NX')
    .exec();
  const socketAttempts = Number(results?.[0]?.[1] ?? 0);
  const ipAttempts = Number(results?.[2]?.[1] ?? 0);
  if (socketAttempts > PASSWORD_FAILURE_LIMIT.maxFailures || ipAttempts > PASSWORD_FAILURE_LIMIT_IP.maxFailures) {
    throw new TetrisBattleError('ROOM_PASSWORD_LOCKED');
  }

  if (password && passwordHash && (await roomPasswordCheck.matches(password, passwordHash))) {
    // 정답이면 예약한 시도를 돌려준다 — NAT로 IP를 공유하는 정상 입장이 잠금에 쌓이지 않게(리뷰 G7).
    // 그 사이 윈도가 끝나 키가 사라졌으면 DECR이 TTL 없는 -1 키를 만들므로 EXPIRE NX로 TTL을 다시 건다
    try {
      await redis
        .multi()
        .decr(socketKey)
        .expire(socketKey, PASSWORD_FAILURE_LIMIT.windowSec, 'NX')
        .decr(ipKey)
        .expire(ipKey, PASSWORD_FAILURE_LIMIT_IP.windowSec, 'NX')
        .exec();
    } catch (error) {
      logger.warn(`비밀번호 시도 카운터 복원 실패: code=${code}, ${(error as Error).message}`);
    }
    return;
  }
  throw new TetrisBattleError('ROOM_WRONG_PASSWORD');
}
