import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { FishingOnlineUserInfo, PlayerPosition } from './fishing.events';
import { toErrorMessage } from '../../common/utils/error.utils';
import { ADD_SOCKET_SCRIPT, REMOVE_SOCKET_SCRIPT } from '../../common/utils/presence-scripts';

/**
 * Redis 키 패턴 (fishing: prefix로 team 키와 완전 분리):
 * - fishing:socket:{socketId}                   → Hash { mapId, userId, userName }  (TTL 1시간)
 * - fishing:map:{mapId}:user:{userId}:sockets   → Set of socketIds                  (TTL 1시간)
 * - fishing:map:{mapId}:online                  → Hash { userId → userName }         (TTL 없음)
 * - fishing:map:{mapId}:positions               → Hash { userId → JSON position }    (TTL 없음)
 * - fishing:map:{mapId}:states                  → Hash { userId → fishingState }     (TTL 없음)
 */

const SOCKET_KEY_TTL = 3600; // 1시간 (고아 키 자동 정리 안전장치)
const MAP_KEY_TTL = 7200; // 2시간 (online/positions/states — 서버 재시작 시 고아 데이터 자동 정리)

@Injectable()
export class FishingOnlineService {
  private readonly logger = new Logger(FishingOnlineService.name);
  private redis: Redis;

  /**
   * main.ts에서 RedisIoAdapter 초기화 후 호출
   */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /**
   * 등록·조회용 — 어댑터 클라이언트는 maxRetriesPerRequest: null(redis-adapter 필수)이라 끊긴 동안 명령이 무한 대기하고,
   * 재연결 때 쌓인 명령이 한꺼번에 흐른다. ready가 아니면 묻지 않고 각 메서드의 실패 기본값을 돌려준다
   * (team-chat.service.ts consumeRateLimit과 같은 방식)
   */
  private isRedisReady(): boolean {
    return this.redis?.status === 'ready';
  }

  // ===== 키 생성 헬퍼 =====

  private socketKey(socketId: string): string {
    return `fishing:socket:${socketId}`;
  }

  private userSocketsKey(mapId: string, userId: number): string {
    return `fishing:map:${mapId}:user:${userId}:sockets`;
  }

  private mapOnlineKey(mapId: string): string {
    return `fishing:map:${mapId}:online`;
  }

  private mapPositionsKey(mapId: string): string {
    return `fishing:map:${mapId}:positions`;
  }

  private mapStatesKey(mapId: string): string {
    return `fishing:map:${mapId}:states`;
  }

  // ===== 온라인 유저 관리 =====

  /**
   * 유저를 온라인 목록에 추가
   */
  async addUserToOnline(
    mapId: string,
    userId: number,
    userName: string,
    socketId: string,
  ): Promise<{ wasAlreadyOnline: boolean }> {
    if (!this.isRedisReady()) return { wasAlreadyOnline: false };
    try {
      const sKey = this.socketKey(socketId);
      const uKey = this.userSocketsKey(mapId, userId);
      const tKey = this.mapOnlineKey(mapId);

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
        String(MAP_KEY_TTL),
        'mapId',
        mapId,
      );
      const wasAlreadyOnline = Number(before) > 0;

      this.logger.debug(
        `온라인 유저 추가: mapId=${mapId}, userId=${userId}, socketId=${socketId}, ` +
          `wasAlreadyOnline=${wasAlreadyOnline}`,
      );

      return { wasAlreadyOnline };
    } catch (error) {
      this.logger.error(`addUserToOnline 실패: ${toErrorMessage(error)}`);
      return { wasAlreadyOnline: false };
    }
  }

  /**
   * 소켓 연결 해제 시 정리
   */
  async removeSocket(socketId: string): Promise<{
    mapId: string;
    userId: number;
    userName: string;
    isFullyOffline: boolean;
  } | null> {
    // 정리 쪽은 ready 가드를 두지 않는다 — 끊긴 동안의 명령은 오프라인 큐에 쌓였다가 재연결 때 적용된다.
    // 여기서 버리면 닫힌 탭이 온라인으로 남고, 죽은 socketId가 소켓 집합에 남아 이후 마지막 탭 판정(SCARD=0)이 영영 안 된다.
    // 기다리는 쪽은 연결 해제·퇴장 핸들러라 사용자 응답을 막지 않는다
    try {
      const sKey = this.socketKey(socketId);

      const mapping = await this.redis.hgetall(sKey);
      if (!mapping.mapId) return null;

      const mapId = mapping.mapId;
      const userId = Number(mapping.userId);
      const userName = mapping.userName;

      const removed = await this.redis.eval(
        REMOVE_SOCKET_SCRIPT,
        5,
        sKey,
        this.userSocketsKey(mapId, userId),
        this.mapOnlineKey(mapId),
        this.mapPositionsKey(mapId),
        this.mapStatesKey(mapId),
        socketId,
        String(userId),
      );
      const isFullyOffline = removed === 1;

      this.logger.debug(
        `소켓 제거: socketId=${socketId}, mapId=${mapId}, userId=${userId}, isFullyOffline=${isFullyOffline}`,
      );

      return { mapId, userId, userName, isFullyOffline };
    } catch (error) {
      this.logger.error(`removeSocket 실패: ${toErrorMessage(error)}`);
      return null;
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
   * 소켓의 유저/맵 매핑 정보 조회
   */
  async getSocketMapping(
    socketId: string,
  ): Promise<{ mapId: string; userId: number; userName: string } | null> {
    if (!this.isRedisReady()) return null;
    try {
      const mapping = await this.redis.hgetall(this.socketKey(socketId));
      if (!mapping.mapId) return null;

      return {
        mapId: mapping.mapId,
        userId: Number(mapping.userId),
        userName: mapping.userName,
      };
    } catch (error) {
      this.logger.error(`getSocketMapping 실패: ${toErrorMessage(error)}`);
      return null;
    }
  }

  // ===== 온라인 유저 목록 =====

  /**
   * 맵의 온라인 유저 목록 조회 (최대 50명)
   */
  async getOnlineUsersForMap(mapId: string): Promise<FishingOnlineUserInfo[]> {
    if (!this.isRedisReady()) return [];
    try {
      const tKey = this.mapOnlineKey(mapId);
      const pKey = this.mapPositionsKey(mapId);
      const stKey = this.mapStatesKey(mapId);

      const allUsers = await this.redis.hgetall(tKey);
      const entries = Object.entries(allUsers).slice(0, 50);
      if (entries.length === 0) return [];

      // 파이프라인으로 소켓 수 + 위치 + 상태 일괄 조회
      const pipeline = this.redis.pipeline();
      for (const [uid] of entries) {
        pipeline.scard(this.userSocketsKey(mapId, Number(uid)));
        pipeline.hget(pKey, uid);
        pipeline.hget(stKey, uid);
      }
      const results = await pipeline.exec();

      return entries.map(([uid, userName], i) => {
        const baseIdx = i * 3;
        const posJson = results?.[baseIdx + 1]?.[1] as string | null;
        const fishingState = results?.[baseIdx + 2]?.[1] as string | null;

        let position: PlayerPosition | undefined;
        if (posJson) {
          try {
            position = JSON.parse(posJson);
          } catch {
            // 파싱 실패 시 무시
          }
        }

        return {
          userId: Number(uid),
          userName,
          connectionCount: (results?.[baseIdx]?.[1] as number) ?? 0,
          position,
          fishingState: fishingState ?? undefined,
        };
      });
    } catch (error) {
      this.logger.error(`getOnlineUsersForMap 실패: ${toErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * 맵의 온라인 유저 수 조회
   */
  async getOnlineUsersCount(mapId: string): Promise<number> {
    if (!this.isRedisReady()) return 0;
    try {
      return await this.redis.hlen(this.mapOnlineKey(mapId));
    } catch (error) {
      this.logger.error(`getOnlineUsersCount 실패: ${toErrorMessage(error)}`);
      return 0;
    }
  }

  // ===== 위치 관리 =====

  /**
   * 유저 위치 업데이트
   */
  async updatePosition(mapId: string, userId: number, position: PlayerPosition): Promise<void> {
    // 위치는 새 접속자용 스냅샷일 뿐이라 끊긴 동안은 버린다 — 오프라인 큐에 쌓였다가 재연결 때 몰려 나가지 않게
    if (!this.isRedisReady()) return;
    const pKey = this.mapPositionsKey(mapId);
    this.fireAndForget('updatePosition', (pipeline) => {
      pipeline.hset(pKey, String(userId), JSON.stringify(position));
      pipeline.expire(pKey, MAP_KEY_TTL);
    });
  }

  /**
   * 모든 유저 위치 조회 (새 접속자용)
   */
  async getAllPositions(
    mapId: string,
  ): Promise<Record<number, PlayerPosition & { userName: string; fishingState?: string }>> {
    if (!this.isRedisReady()) return {};
    try {
      const pKey = this.mapPositionsKey(mapId);
      const tKey = this.mapOnlineKey(mapId);
      const stKey = this.mapStatesKey(mapId);

      const [positions, users, states] = await Promise.all([
        this.redis.hgetall(pKey),
        this.redis.hgetall(tKey),
        this.redis.hgetall(stKey),
      ]);

      const result: Record<number, PlayerPosition & { userName: string; fishingState?: string }> = {};

      for (const [uid, posJson] of Object.entries(positions)) {
        try {
          const pos = JSON.parse(posJson) as PlayerPosition;
          result[Number(uid)] = {
            ...pos,
            userName: users[uid] ?? `유저${uid}`,
            fishingState: states[uid] ?? undefined,
          };
        } catch {
          // 파싱 실패 시 무시
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`getAllPositions 실패: ${toErrorMessage(error)}`);
      return {};
    }
  }

  // ===== 낚시 상태 관리 =====

  /**
   * 유저 낚시 상태 업데이트
   */
  async updateFishingState(mapId: string, userId: number, state: string): Promise<void> {
    if (!this.isRedisReady()) return;
    const stKey = this.mapStatesKey(mapId);
    this.fireAndForget('updateFishingState', (pipeline) => {
      pipeline.hset(stKey, String(userId), state);
      pipeline.expire(stKey, MAP_KEY_TTL);
    });
  }

  /**
   * 응답을 기다리지 않는 쓰기 — gateway가 broadcast를 먼저 처리하고 저장은 뒤따른다.
   * exec()의 거부도 여기서 받아 로그로 남긴다(처리되지 않은 rejection으로 새지 않게)
   */
  private fireAndForget(label: string, build: (pipeline: ReturnType<Redis['pipeline']>) => void): void {
    try {
      const pipeline = this.redis.pipeline();
      build(pipeline);
      pipeline.exec().catch((error: unknown) => {
        this.logger.error(`${label} 실패: ${toErrorMessage(error)}`);
      });
    } catch (error) {
      this.logger.error(`${label} 실패: ${toErrorMessage(error)}`);
    }
  }
}
