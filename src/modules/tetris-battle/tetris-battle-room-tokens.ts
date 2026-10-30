import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  generateRoomCode as generateGameRoomCode,
  hashRoomPassword as hashGameRoomPassword,
  issuePlayerToken as issueGamePlayerToken,
  verifyRoomPassword,
} from '../game-room/game-room-secrets';
import {
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_LIMIT_IP,
  PASSWORD_KEY_LENGTH,
  PASSWORD_SALT_BYTES,
  PLAYER_TOKEN_BYTES,
  TETRIS_BATTLE_ROOM_KEYS,
} from './tetris-battle.constants';
import { TetrisBattleError } from './tetris-battle.errors';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './tetris-battle.events';

/**
 * 대전 방의 비밀값 — 방 코드·재연결 토큰·방 비밀번호 (방 서비스에서 분리, tetris-audit BE-19).
 * 구현은 공용 부품(game-room-secrets)이고, 여기서는 테트리스 값(코드 문자표·바이트 수·한도·키 접두사)을 채우고
 * 판정을 TetrisBattleError로 바꾼다. 토큰·비밀번호 원문은 저장하지 않는다.
 */

export { hashPlayerToken, playerTokenMatches, roomPasswordCheck } from '../game-room/game-room-secrets';

export function generateRoomCode(): string {
  return generateGameRoomCode(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);
}

export function issuePlayerToken(): { token: string; tokenHash: string } {
  return issueGamePlayerToken(PLAYER_TOKEN_BYTES);
}

export function hashRoomPassword(password: string): Promise<string> {
  return hashGameRoomPassword(password, { saltBytes: PASSWORD_SALT_BYTES, keyLength: PASSWORD_KEY_LENGTH });
}

/**
 * 비밀번호 검증 + 실패 잠금(공용 verifyRoomPassword) — 한도 초과는 ROOM_PASSWORD_LOCKED, 오답은 ROOM_WRONG_PASSWORD.
 *  - 같은 소켓: PASSWORD_FAILURE_LIMIT.maxFailures번까지 검증
 *  - 같은 IP: PASSWORD_FAILURE_LIMIT_IP.maxFailures번까지 검증
 */
export async function verifyRoomPasswordOrThrow(
  redis: Redis,
  code: string,
  passwordHash: string | null,
  password: string | undefined,
  who: { socketId: string; ip: string },
  logger: Logger,
): Promise<void> {
  const verdict = await verifyRoomPassword(
    redis,
    TETRIS_BATTLE_ROOM_KEYS,
    { socket: PASSWORD_FAILURE_LIMIT, ip: PASSWORD_FAILURE_LIMIT_IP },
    code,
    passwordHash,
    password,
    who,
    logger,
  );
  if (verdict === 'LOCKED') throw new TetrisBattleError('ROOM_PASSWORD_LOCKED');
  if (verdict === 'WRONG') throw new TetrisBattleError('ROOM_WRONG_PASSWORD');
}
