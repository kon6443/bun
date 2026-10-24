import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { toErrorDetail } from '../../common/utils/error.utils';
import { GAME_VIEW_DAILY_LIMIT_PER_VIEWER } from '../../common/constants/app.constants';

/** 상한 창(초) — 첫 기록부터 24시간 */
const VIEWER_WINDOW_SECONDS = 24 * 60 * 60;

const viewKey = (scoreId: number, viewerKey: string) => `game:view:${scoreId}:${viewerKey}`;
const watchKey = (scoreId: number, viewerKey: string) => `game:watch:${scoreId}:${viewerKey}`;

/**
 * 리플레이 조회수·시청시간의 시청자별 하루 상한 (docs/tasks/replay-views D-002·D-004)
 *
 * Redis 키 패턴 (game: prefix, TTL = 첫 기록부터 24시간):
 * - game:view:{scoreId}:{viewerKey} → 조회 요청 수
 * - game:watch:{scoreId}:{viewerKey} → 보고된 시청시간 합(ms, 상한 초과분 포함)
 *
 * 같은 브라우저 하루 1회는 프론트(localStorage)가 거른다. 여기는 그 우회(스크립트 반복 호출)를 묶는 서버 상한이다.
 * viewerKey는 IP 해시 — 같은 IP 뒤의 여러 사람(NAT)을 위해 조회는 1이 아니라 여유를 둔다.
 * 조회수는 부가 기능이라 Redis를 못 쓰면 막지 않고 상한 없이 반영한다(fail-open).
 * Redis 클라이언트는 main.ts에서 RedisIoAdapter 초기화 후 주입한다(GameSessionService와 같은 방식).
 */
@Injectable()
export class GameViewService {
  private readonly logger = new Logger(GameViewService.name);
  private redis: Redis | null = null;

  /** main.ts에서 RedisIoAdapter 초기화 후 호출 */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /** 이번 조회를 셀지 — 시청자의 24시간 안 조회 요청 수가 상한 이하면 true */
  async claimView(scoreId: number, viewerKey: string): Promise<boolean> {
    const total = await this.addWithinWindow('claimView', viewKey(scoreId, viewerKey), 1);
    return total === null || total <= GAME_VIEW_DAILY_LIMIT_PER_VIEWER;
  }

  /** 이번 보고에서 반영할 시청시간(ms) — 시청자의 24시간 누적이 capMs를 넘는 부분은 잘라 0~watchedMs */
  async claimWatchMs(scoreId: number, viewerKey: string, watchedMs: number, capMs: number): Promise<number> {
    const total = await this.addWithinWindow('claimWatchMs', watchKey(scoreId, viewerKey), watchedMs);
    if (total === null) {
      return watchedMs;
    }
    const before = total - watchedMs;
    return Math.max(0, Math.min(watchedMs, capMs - before));
  }

  /** 키에 amount를 더하고 합을 돌려준다. TTL은 첫 기록 때만 건다(NX — 반복 호출이 창을 늘리지 못하게). Redis를 못 쓰면 null */
  private async addWithinWindow(caller: string, key: string, amount: number): Promise<number | null> {
    if (!this.redis || this.redis.status !== 'ready') {
      return null;
    }
    try {
      const [[commandError, total]] = (await this.redis.multi().incrby(key, amount).expire(key, VIEWER_WINDOW_SECONDS, 'NX').exec()) as [
        [Error | null, number],
        [Error | null, number],
      ];
      // MULTI 안의 명령 에러(예: 키 타입 충돌)는 throw되지 않고 결과로 온다
      if (commandError || typeof total !== 'number') {
        this.logger.warn(`${caller}() Redis 명령 오류 — 상한 없이 반영한다: ${toErrorDetail(commandError)}`);
        return null;
      }
      return total;
    } catch (error) {
      this.logger.warn(`${caller}() Redis 오류 — 상한 없이 반영한다: ${toErrorDetail(error)}`);
      return null;
    }
  }
}
