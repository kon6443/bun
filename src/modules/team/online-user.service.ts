import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import { Redis } from 'ioredis';
import { OnlineUserInfo } from './team.events';

/**
 * Redis 키 패턴:
 * - socket:{socketId}         → Hash { teamId, userId, userName }  (TTL 1시간)
 * - team:{teamId}:user:{userId}:sockets → Set of socketIds         (TTL 1시간)
 * - team:{teamId}:online      → Hash { userId → userName }         (TTL 없음)
 */

const SOCKET_KEY_TTL = 3600; // 1시간 (고아 키 자동 정리 안전장치)
const TEAM_ONLINE_KEY_TTL = 7200; // 2시간 (online 해시 — 서버 재시작 시 고아 데이터 자동 정리)

// 팀별 온라인 유저 수 Gauge 재계산 주기 (Prometheus scrape 15s 보다 길게 — 설계 결정 P3).
const METRIC_REFRESH_INTERVAL_MS = 60_000;
// 멀티 replica 환경에서 같은 team_id 에 대해 여러 replica 가 동시에 set 하면
// Prometheus 에 중복 timeseries 가 생겨 쿼리 혼란. TASK_SLOT=1 (리더) 만 갱신.
const METRIC_LEADER_TASK_SLOT = 1;

@Injectable()
export class OnlineUserService implements OnModuleDestroy {
  private readonly logger = new Logger(OnlineUserService.name);
  private redis: Redis;
  // 이 replica 가 joinTeam 이벤트를 받은 팀 집합. 60s 주기 재계산 대상.
  private readonly activeTeamIds = new Set<number>();
  private metricTimer?: NodeJS.Timeout;

  constructor(
    @InjectMetric('ws_team_online_users')
    private readonly teamOnlineGauge: Gauge<string>,
  ) {
    const taskSlot = Number(process.env.TASK_SLOT ?? 0);
    if (taskSlot === METRIC_LEADER_TASK_SLOT) {
      this.metricTimer = setInterval(
        () => void this.refreshTeamOnlineMetric(),
        METRIC_REFRESH_INTERVAL_MS,
      );
      this.logger.log(`ws_team_online_users 60s 주기 갱신 활성 (TASK_SLOT=${taskSlot})`);
    }
  }

  onModuleDestroy(): void {
    if (this.metricTimer) {
      clearInterval(this.metricTimer);
      this.metricTimer = undefined;
    }
  }

  /**
   * main.ts에서 RedisIoAdapter 초기화 후 호출
   */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /**
   * TeamGateway.handleJoinTeam 에서 호출 — 60s 주기 재계산 대상 팀 등록.
   * count == 0 이 되면 refreshTeamOnlineMetric 에서 자동으로 Set/Gauge 에서 제거.
   */
  trackActiveTeam(teamId: number): void {
    this.activeTeamIds.add(teamId);
  }

  /**
   * Redis 에서 팀별 온라인 유저 수를 재계산해 Gauge 에 set.
   * 정상 0 이면 remove + activeTeamIds 에서 제거 (stale label 방지).
   * TASK_SLOT=1 replica 에서만 호출됨.
   *
   * 구현 메모:
   *  - Redis.hlen 을 직접 호출 → 예외가 여기서 catch 되어 "이번 주기만 skip".
   *    (getOnlineUsersCount 는 내부 try-catch 로 0 반환하므로 실패/진짜 0 구분 불가.
   *     failure 를 0 과 구분해야 Gauge 를 잘못 지우지 않음.)
   *  - Promise.all 병렬화 — 순차 for-await 은 Redis 연결을 오래 점유해
   *    사용자 경로(addUserToOnline 등)의 응답 지연 유발.
   */
  private async refreshTeamOnlineMetric(): Promise<void> {
    if (!this.redis) return;
    const teamIds = Array.from(this.activeTeamIds);
    const results = await Promise.all(
      teamIds.map(async (teamId) => {
        try {
          const count = await this.redis.hlen(this.teamOnlineKey(teamId));
          return { teamId, count, ok: true as const };
        } catch (error) {
          this.logger.warn(
            `refreshTeamOnlineMetric 실패 (teamId=${teamId}): ${(error as Error).message}`,
          );
          return { teamId, count: 0, ok: false as const };
        }
      }),
    );
    for (const { teamId, count, ok } of results) {
      if (!ok) continue; // Redis 장애 — 이번 주기 skip, 이전 Gauge 값 유지
      if (count > 0) {
        this.teamOnlineGauge.set({ team_id: String(teamId) }, count);
      } else {
        this.teamOnlineGauge.remove({ team_id: String(teamId) });
        this.activeTeamIds.delete(teamId);
      }
    }
  }

  // ===== 키 생성 헬퍼 =====

  private socketKey(socketId: string): string {
    return `socket:${socketId}`;
  }

  private userSocketsKey(teamId: number, userId: number): string {
    return `team:${teamId}:user:${userId}:sockets`;
  }

  private teamOnlineKey(teamId: number): string {
    return `team:${teamId}:online`;
  }

  // ===== 공개 메서드 =====

  /**
   * 유저를 온라인 목록에 추가
   * @returns { wasAlreadyOnline } - 이미 온라인이었는지 여부
   */
  async addUserToOnline(
    teamId: number,
    userId: number,
    userName: string,
    socketId: string,
  ): Promise<{ wasAlreadyOnline: boolean }> {
    try {
      const sKey = this.socketKey(socketId);
      const uKey = this.userSocketsKey(teamId, userId);
      const tKey = this.teamOnlineKey(teamId);

      // 기존 소켓 수로 이미 온라인인지 판단
      const existingCount = await this.redis.scard(uKey);
      const wasAlreadyOnline = existingCount > 0;

      const pipeline = this.redis.pipeline();

      // 소켓 → 유저 역방향 매핑
      pipeline.hset(sKey, { teamId: String(teamId), userId: String(userId), userName });
      pipeline.expire(sKey, SOCKET_KEY_TTL);

      // 유저별 소켓 목록
      pipeline.sadd(uKey, socketId);
      pipeline.expire(uKey, SOCKET_KEY_TTL);

      // 팀 온라인 유저 (TTL로 고아 데이터 자동 정리)
      pipeline.hset(tKey, String(userId), userName);
      pipeline.expire(tKey, TEAM_ONLINE_KEY_TTL);

      await pipeline.exec();

      this.logger.debug(
        `온라인 유저 추가: teamId=${teamId}, userId=${userId}, socketId=${socketId}, ` +
          `wasAlreadyOnline=${wasAlreadyOnline}`,
      );

      return { wasAlreadyOnline };
    } catch (error) {
      this.logger.error(`addUserToOnline 실패: ${(error as Error).message}`);
      return { wasAlreadyOnline: false };
    }
  }

  /**
   * 소켓 연결 해제 시 정리
   * @returns 제거된 소켓의 정보 + 완전히 오프라인인지 여부 (null이면 매핑 없음)
   */
  async removeSocket(socketId: string): Promise<{
    teamId: number;
    userId: number;
    userName: string;
    isFullyOffline: boolean;
  } | null> {
    try {
      const sKey = this.socketKey(socketId);

      // 소켓 매핑 조회
      const mapping = await this.redis.hgetall(sKey);
      if (!mapping.teamId) return null;

      const teamId = Number(mapping.teamId);
      const userId = Number(mapping.userId);
      const userName = mapping.userName;

      const uKey = this.userSocketsKey(teamId, userId);
      const tKey = this.teamOnlineKey(teamId);

      const pipeline = this.redis.pipeline();

      // 소켓 매핑 삭제
      pipeline.del(sKey);
      // 유저 소켓 목록에서 제거
      pipeline.srem(uKey, socketId);

      await pipeline.exec();

      // 남은 소켓 수 확인
      const remainingCount = await this.redis.scard(uKey);
      const isFullyOffline = remainingCount === 0;

      if (isFullyOffline) {
        // 유저의 모든 소켓이 제거됨 → 온라인 목록에서도 제거
        await this.redis.hdel(tKey, String(userId));
        // 소켓 Set 키도 정리
        await this.redis.del(uKey);
      }

      this.logger.debug(
        `소켓 제거: socketId=${socketId}, teamId=${teamId}, userId=${userId}, isFullyOffline=${isFullyOffline}`,
      );

      return { teamId, userId, userName, isFullyOffline };
    } catch (error) {
      this.logger.error(`removeSocket 실패: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * 특정 유저의 온라인 정보 조회
   */
  async getUserOnlineInfo(teamId: number, userId: number): Promise<OnlineUserInfo | null> {
    try {
      const tKey = this.teamOnlineKey(teamId);
      const userName = await this.redis.hget(tKey, String(userId));
      if (!userName) return null;

      const uKey = this.userSocketsKey(teamId, userId);
      const connectionCount = await this.redis.scard(uKey);

      return { userId, userName, connectionCount };
    } catch (error) {
      this.logger.error(`getUserOnlineInfo 실패: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * 팀의 온라인 유저 목록 조회 (최대 100명)
   */
  async getOnlineUsersForTeam(teamId: number): Promise<OnlineUserInfo[]> {
    try {
      const tKey = this.teamOnlineKey(teamId);
      const allUsers = await this.redis.hgetall(tKey);

      const entries = Object.entries(allUsers).slice(0, 100);
      if (entries.length === 0) return [];

      // 파이프라인으로 소켓 수 일괄 조회
      const pipeline = this.redis.pipeline();
      for (const [uid] of entries) {
        pipeline.scard(this.userSocketsKey(teamId, Number(uid)));
      }
      const results = await pipeline.exec();

      return entries.map(([uid, userName], i) => ({
        userId: Number(uid),
        userName,
        connectionCount: (results?.[i]?.[1] as number) ?? 0,
      }));
    } catch (error) {
      this.logger.error(`getOnlineUsersForTeam 실패: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * 팀의 온라인 유저 수 조회
   */
  async getOnlineUsersCount(teamId: number): Promise<number> {
    try {
      const tKey = this.teamOnlineKey(teamId);
      return await this.redis.hlen(tKey);
    } catch (error) {
      this.logger.error(`getOnlineUsersCount 실패: ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * 소켓이 등록되어 있는지 확인
   */
  async isSocketRegistered(socketId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.socketKey(socketId))) === 1;
    } catch (error) {
      this.logger.error(`isSocketRegistered 실패: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * 소켓의 유저/팀 매핑 정보 조회
   */
  async getSocketUserMapping(
    socketId: string,
  ): Promise<{ teamId: number; userId: number; userName: string } | null> {
    try {
      const mapping = await this.redis.hgetall(this.socketKey(socketId));
      if (!mapping.teamId) return null;

      return {
        teamId: Number(mapping.teamId),
        userId: Number(mapping.userId),
        userName: mapping.userName,
      };
    } catch (error) {
      this.logger.error(`getSocketUserMapping 실패: ${(error as Error).message}`);
      return null;
    }
  }
}
