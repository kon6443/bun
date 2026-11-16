import type { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { GameRoomRecord, GameRoomStore } from './game-room.store';

/** 변경 함수의 결과 — deleteRoom이면 방을 지운다 */
export interface RoomMutationOutcome<T> {
  result: T;
  deleteRoom?: boolean;
}

/** 방 변경 결과(방송 단위) — 방이 삭제됐으면 room null */
export interface RoomChange<TState> {
  room: TState | null;
  lobbyChanged: boolean;
}

/** 각 게임 방 서비스가 넘기는 규칙·에러·방송 — 이 코어는 게임 규칙을 모른다 */
export interface RoomMutationDeps<TRoom extends GameRoomRecord & { players: unknown[] }, TState> {
  store: GameRoomStore<TRoom>;
  logger: Logger;
  maxAttempts: number;
  /** 유예가 지난 끊긴 자리를 뺀 새 객체(원본 불변) */
  prune: (room: TRoom, now: number) => TRoom;
  changeOf: (room: TRoom, before: TRoom) => { room: TState; lobbyChanged: boolean };
  notify: (code: string, room: TState | null, lobbyChanged: boolean) => void;
  /** 요청 거부(게임 도메인 에러)인가 — 거부여도 정리분은 반영한다 */
  isRejection: (error: unknown) => boolean;
  roomNotFound: () => Error;
  roomBusy: () => Error;
}

/**
 * 읽기 → 정리(유예 지난 끊긴 플레이어) → 변경 → 버전 CAS 쓰기. 버전이 바뀌었으면 처음부터 다시(최대 maxAttempts, 넘으면 roomBusy).
 *
 * - `fn`은 재시도될 수 있으므로 **순수해야 한다**(Redis·소켓 부작용 금지) — 받은 room을 고치고 결과만 돌려준다.
 * - 내용이 하나도 바뀌지 않았으면 쓰지 않는다. 정리 결과 아무도 없으면 방을 지우고(삭제 방송) roomNotFound.
 * - 요청이 거부돼도(isRejection) 정리로 바뀐 것은 반영하고 방송한다. 결과가 null인데 정리로 바뀌었으면 여기서 방송한다
 *
 * 테트리스 대전·포트리스 방 서비스가 같은 본문을 두 벌 들고 있던 것을 모았다(docs/tasks/fortress DECISIONS D-014 F3c).
 */
export async function mutateGameRoom<TRoom extends GameRoomRecord & { players: unknown[] }, TState, T>(
  deps: RoomMutationDeps<TRoom, TState>,
  redis: Redis,
  code: string,
  now: number,
  fn: (room: TRoom, before: TRoom) => RoomMutationOutcome<T>,
): Promise<T> {
  for (let attempt = 0; attempt < deps.maxAttempts; attempt++) {
    const loaded = await deps.store.load(redis, code);
    if (!loaded) throw deps.roomNotFound();

    const originalJson = JSON.stringify(loaded.room);
    const room = deps.prune(loaded.room, now);

    if (room.players.length === 0) {
      // 전원이 유예를 넘겨 끊긴 방 — 삭제(다른 레플리카가 먼저 지웠어도 결과는 같다)
      if (await deps.store.compareAndSet(redis, code, loaded.version, null)) deps.notify(code, null, true);
      throw deps.roomNotFound();
    }

    const before = JSON.parse(originalJson) as TRoom;
    let outcome: RoomMutationOutcome<T>;
    try {
      outcome = fn(room, before);
    } catch (error) {
      // 요청은 거부됐지만 정리(유예 지난 플레이어 제거)는 반영하고 방송한다 — fn이 room을 일부 고쳤을 수 있어 다시 계산
      const prunedOnly = deps.prune(loaded.room, now);
      if (
        deps.isRejection(error) &&
        JSON.stringify(prunedOnly) !== originalJson &&
        (await deps.store.compareAndSet(redis, code, loaded.version, prunedOnly))
      ) {
        const change = deps.changeOf(prunedOnly, before);
        deps.notify(code, change.room, change.lobbyChanged);
      }
      throw error;
    }

    if (outcome.deleteRoom) {
      if (await deps.store.compareAndSet(redis, code, loaded.version, null)) return outcome.result;
      continue;
    }
    if (JSON.stringify(room) === originalJson) return outcome.result;
    if (await deps.store.compareAndSet(redis, code, loaded.version, room)) {
      // 요청 결과가 null(호출자가 방송할 게 없음)인데 정리로 방이 바뀌었으면 여기서 알린다(테트리스 리뷰 G3)
      if (outcome.result === null) {
        const change = deps.changeOf(room, before);
        deps.notify(code, change.room, change.lobbyChanged);
      }
      return outcome.result;
    }
  }
  deps.logger.warn(`방 변경 충돌 재시도 초과: code=${code}`);
  throw deps.roomBusy();
}

/** 방 변경 알림 — 리스너 실패는 로그만(요청 결과를 바꾸지 않는다) */
export function notifyRoomChange<TState>(
  listener: ((code: string, room: TState | null, lobbyChanged: boolean) => void) | null,
  logger: Logger,
  code: string,
  room: TState | null,
  lobbyChanged: boolean,
): void {
  try {
    listener?.(code, room, lobbyChanged);
  } catch (error) {
    logger.warn(`방 변경 알림 실패: code=${code}, ${(error as Error).message}`);
  }
}

/** 기본 깨우기 — 프로세스 종료를 막지 않는 1회 타이머. 레플리카가 죽으면 다음 요청의 lazy 정리가 대신한다 */
export const defaultWakeScheduler = (task: () => void, delayMs: number): void => {
  setTimeout(task, delayMs).unref();
};

/**
 * 빈도 제한용 소켓 IP — `trust proxy 1`(main.ts)과 같은 기준: X-Forwarded-For의 **마지막** 값(바로 앞 프록시가 붙인 값).
 * 첫 값은 요청자가 위조할 수 있어 쓰지 않는다(api-http.md 스로틀 절)
 */
export function socketClientIp(handshake: {
  headers: Record<string, string | string[] | undefined>;
  address?: string;
}): string {
  const xff = handshake.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  const last = raw?.split(',').pop()?.trim();
  return last || handshake.address || 'unknown';
}
