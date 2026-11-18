import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import { Redis } from 'ioredis';
import { OnlineUserInfo } from './team.events';
import { toErrorMessage } from '../../common/utils/error.utils';
import { ADD_SOCKET_SCRIPT, REMOVE_SOCKET_SCRIPT } from '../../common/utils/presence-scripts';
import { isLeaderReplica } from '../../common/utils/replica.utils';

/**
 * Redis 키 패턴:
 * - socket:{socketId}         → Hash { teamId, userId, userName }  (TTL 1시간)
 * - team:{teamId}:user:{userId}:sockets → Set of socketIds         (TTL 1시간)
 * - team:{teamId}:online      → Hash { userId → userName }         (TTL 2시간)
 * userName은 팀 안 표시 이름(팀 닉네임 → 계정 닉네임)이다. 팀 닉네임이 바뀌면 updateUserName으로 갱신한다.
 */

const SOCKET_KEY_TTL = 3600; // 1시간 (고아 키 자동 정리 안전장치)

/**
 * 이미 있는 필드만 바꾼다 — 이름 변경 중에 유저가 나갔으면 온라인 목록·소켓 매핑을 되살리지 않는다.
 * KEYS[1]=hash · ARGV[1]=field · ARGV[2]=value
 */
const HSET_IF_FIELD_EXISTS_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
`;
/** 온라인 목록 상한 — getOnlineUsersForTeam이 이만큼만 돌려준다(페이로드 무한 증가 방지) */
export const ONLINE_USERS_LIST_LIMIT = 100;
const TEAM_ONLINE_KEY_TTL = 7200; // 2시간 (online 해시 — 서버 재시작 시 고아 데이터 자동 정리)

// 팀별 온라인 유저 수 Gauge 재계산 주기 (Prometheus scrape 15s 보다 길게 — 설계 결정 P3).
const METRIC_REFRESH_INTERVAL_MS = 60_000;
// 멀티 replica 환경에서 같은 team_id 에 대해 여러 replica 가 동시에 set 하면
// Prometheus 에 중복 timeseries 가 생겨 쿼리 혼란. TASK_SLOT=1 (리더, isLeaderReplica) 만 갱신.

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
    if (isLeaderReplica()) {
      this.metricTimer = setInterval(
        () => void this.refreshTeamOnlineMetric(),
        METRIC_REFRESH_INTERVAL_MS,
      );
      this.logger.log('ws_team_online_users 60s 주기 갱신 활성 (TASK_SLOT=1)');
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
   * 등록·조회용 — 어댑터 클라이언트는 maxRetriesPerRequest: null(redis-adapter 필수)이라 끊긴 동안 명령이 무한 대기한다 —
   * joinTeam·disconnect 핸들러가 응답 없이 멈추지 않게 ready가 아니면 각 메서드의 실패 기본값을 돌려준다
   * (team-chat.service.ts consumeRateLimit과 같은 방식)
   */
  private isRedisReady(): boolean {
    return this.redis?.status === 'ready';
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
            `refreshTeamOnlineMetric 실패 (teamId=${teamId}): ${toErrorMessage(error)}`,
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
    if (!this.isRedisReady()) return { wasAlreadyOnline: false };
    try {
      const sKey = this.socketKey(socketId);
      const uKey = this.userSocketsKey(teamId, userId);
      const tKey = this.teamOnlineKey(teamId);

      // 소켓 수 확인과 등록을 한 번에 — 나누면 사이에 다른 탭의 제거가 끼어 userLeft 뒤에 입장 알림이 빠진다
      const before = await this.redis.eval(
        ADD_SOCKET_SCRIPT,
        3,
        sKey,
        uKey,
        tKey,
        socketId,
        String(userId),
        userName,
        String(SOCKET_KEY_TTL),
        String(TEAM_ONLINE_KEY_TTL),
        'teamId',
        String(teamId),
      );
      const wasAlreadyOnline = Number(before) > 0;

      this.logger.debug(
        `온라인 유저 추가: teamId=${teamId}, userId=${userId}, socketId=${socketId}, ` +
          `wasAlreadyOnline=${wasAlreadyOnline}`,
      );

      return { wasAlreadyOnline };
    } catch (error) {
      this.logger.error(`addUserToOnline 실패: ${toErrorMessage(error)}`);
      return { wasAlreadyOnline: false };
    }
  }

  /**
   * 온라인 유저의 표시 이름 갱신 — 팀 닉네임 변경 시 (docs/tasks/team-nickname)
   *
   * joinTeam 때 저장한 이름이 onlineUsers·userLeft로 다시 나가므로 바꿔 둔다. 오프라인이면 할 일 없다
   * (다음 joinTeam이 새 이름으로 등록한다). 실패해도 다음 joinTeam에서 맞춰지므로 예외를 올리지 않는다.
   */
  async updateUserName(teamId: number, userId: number, userName: string): Promise<void> {
    if (!this.isRedisReady()) return;
    try {
      const socketIds = await this.redis.smembers(this.userSocketsKey(teamId, userId));
      if (socketIds.length === 0) return;

      await Promise.all([
        this.redis.eval(HSET_IF_FIELD_EXISTS_SCRIPT, 1, this.teamOnlineKey(teamId), String(userId), userName),
        ...socketIds.map((socketId) =>
          this.redis.eval(HSET_IF_FIELD_EXISTS_SCRIPT, 1, this.socketKey(socketId), 'userName', userName),
        ),
      ]);
    } catch (error) {
      this.logger.error(`updateUserName 실패: ${toErrorMessage(error)}`);
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
    // 정리 쪽은 ready 가드를 두지 않는다 — 끊긴 동안의 명령은 오프라인 큐에 쌓였다가 재연결 때 적용된다.
    // 여기서 버리면 닫힌 탭이 온라인으로 남고, 죽은 socketId가 소켓 집합에 남아 이후 마지막 탭 판정(SCARD=0)이 영영 안 된다.
    // 기다리는 쪽은 연결 해제·퇴장 핸들러라 사용자 응답을 막지 않는다
    try {
      const sKey = this.socketKey(socketId);

      // 소켓 매핑 조회
      const mapping = await this.redis.hgetall(sKey);
      if (!mapping.teamId) return null;

      const teamId = Number(mapping.teamId);
      const userId = Number(mapping.userId);
      const userName = mapping.userName;

      const removed = await this.redis.eval(
        REMOVE_SOCKET_SCRIPT,
        3,
        sKey,
        this.userSocketsKey(teamId, userId),
        this.teamOnlineKey(teamId),
        socketId,
        String(userId),
      );
      const isFullyOffline = removed === 1;

      this.logger.debug(
        `소켓 제거: socketId=${socketId}, teamId=${teamId}, userId=${userId}, isFullyOffline=${isFullyOffline}`,
      );

      return { teamId, userId, userName, isFullyOffline };
    } catch (error) {
      this.logger.error(`removeSocket 실패: ${toErrorMessage(error)}`);
      return null;
    }
  }

  /**
   * 특정 유저의 온라인 정보 조회
   */
  async getUserOnlineInfo(teamId: number, userId: number): Promise<OnlineUserInfo | null> {
    if (!this.isRedisReady()) return null;
    try {
      const tKey = this.teamOnlineKey(teamId);
      const userName = await this.redis.hget(tKey, String(userId));
      if (!userName) return null;

      const uKey = this.userSocketsKey(teamId, userId);
      const connectionCount = await this.redis.scard(uKey);

      return { userId, userName, connectionCount };
    } catch (error) {
      this.logger.error(`getUserOnlineInfo 실패: ${toErrorMessage(error)}`);
      return null;
    }
  }

  /**
   * 팀의 온라인 유저 목록 조회 (최대 100명)
   */
  async getOnlineUsersForTeam(teamId: number): Promise<OnlineUserInfo[]> {
    if (!this.isRedisReady()) return [];
    try {
      const tKey = this.teamOnlineKey(teamId);
      const allUsers = await this.redis.hgetall(tKey);

      const entries = Object.entries(allUsers).slice(0, ONLINE_USERS_LIST_LIMIT);
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
      this.logger.error(`getOnlineUsersForTeam 실패: ${toErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * 팀의 온라인 유저 수 조회
   */
  async getOnlineUsersCount(teamId: number): Promise<number> {
    if (!this.isRedisReady()) return 0;
    try {
      const tKey = this.teamOnlineKey(teamId);
      return await this.redis.hlen(tKey);
    } catch (error) {
      this.logger.error(`getOnlineUsersCount 실패: ${toErrorMessage(error)}`);
      return 0;
    }
  }

  /**
   * 소켓이 등록되어 있는지 확인
   */
  async isSocketRegistered(socketId: string): Promise<boolean> {
    // removeSocket 앞의 확인이다 — 정리와 같은 이유로 ready 가드를 두지 않는다(false면 정리가 건너뛰어진다)
    try {
      return (await this.redis.exists(this.socketKey(socketId))) === 1;
    } catch (error) {
      this.logger.error(`isSocketRegistered 실패: ${toErrorMessage(error)}`);
      return false;
    }
  }

  /**
   * 소켓의 유저/팀 매핑 정보 조회
   */
  async getSocketUserMapping(
    socketId: string,
  ): Promise<{ teamId: number; userId: number; userName: string } | null> {
    if (!this.isRedisReady()) return null;
    try {
      const mapping = await this.redis.hgetall(this.socketKey(socketId));
      if (!mapping.teamId) return null;

      return {
        teamId: Number(mapping.teamId),
        userId: Number(mapping.userId),
        userName: mapping.userName,
      };
    } catch (error) {
      this.logger.error(`getSocketUserMapping 실패: ${toErrorMessage(error)}`);
      return null;
    }
  }
}
