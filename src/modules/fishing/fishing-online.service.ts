import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { FishingOnlineUserInfo, PlayerPosition } from './fishing.events';

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
    try {
      const sKey = this.socketKey(socketId);
      const uKey = this.userSocketsKey(mapId, userId);
      const tKey = this.mapOnlineKey(mapId);

      const existingCount = await this.redis.scard(uKey);
      const wasAlreadyOnline = existingCount > 0;

      const pipeline = this.redis.pipeline();

      // 소켓 → 유저 역방향 매핑
      pipeline.hset(sKey, { mapId, userId: String(userId), userName });
      pipeline.expire(sKey, SOCKET_KEY_TTL);

      // 유저별 소켓 목록
      pipeline.sadd(uKey, socketId);
      pipeline.expire(uKey, SOCKET_KEY_TTL);

      // 맵 온라인 유저 (TTL로 고아 데이터 자동 정리)
      pipeline.hset(tKey, String(userId), userName);
      pipeline.expire(tKey, MAP_KEY_TTL);

      await pipeline.exec();

      this.logger.debug(
        `온라인 유저 추가: mapId=${mapId}, userId=${userId}, socketId=${socketId}, ` +
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
   */
  async removeSocket(socketId: string): Promise<{
    mapId: string;
    userId: number;
    userName: string;
    isFullyOffline: boolean;
  } | null> {
    try {
      const sKey = this.socketKey(socketId);

      const mapping = await this.redis.hgetall(sKey);
      if (!mapping.mapId) return null;

      const mapId = mapping.mapId;
      const userId = Number(mapping.userId);
      const userName = mapping.userName;

      const uKey = this.userSocketsKey(mapId, userId);

      const pipeline = this.redis.pipeline();
      pipeline.del(sKey);
      pipeline.srem(uKey, socketId);
      await pipeline.exec();

      const remainingCount = await this.redis.scard(uKey);
      const isFullyOffline = remainingCount === 0;

      if (isFullyOffline) {
        const tKey = this.mapOnlineKey(mapId);
        const pKey = this.mapPositionsKey(mapId);
        const stKey = this.mapStatesKey(mapId);

        const cleanupPipeline = this.redis.pipeline();
        cleanupPipeline.hdel(tKey, String(userId));
        cleanupPipeline.hdel(pKey, String(userId));
        cleanupPipeline.hdel(stKey, String(userId));
        cleanupPipeline.del(uKey);
        await cleanupPipeline.exec();
      }

      this.logger.debug(
        `소켓 제거: socketId=${socketId}, mapId=${mapId}, userId=${userId}, isFullyOffline=${isFullyOffline}`,
      );

      return { mapId, userId, userName, isFullyOffline };
    } catch (error) {
      this.logger.error(`removeSocket 실패: ${(error as Error).message}`);
      return null;
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
   * 소켓의 유저/맵 매핑 정보 조회
   */
  async getSocketMapping(
    socketId: string,
  ): Promise<{ mapId: string; userId: number; userName: string } | null> {
    try {
      const mapping = await this.redis.hgetall(this.socketKey(socketId));
      if (!mapping.mapId) return null;

      return {
        mapId: mapping.mapId,
        userId: Number(mapping.userId),
        userName: mapping.userName,
      };
    } catch (error) {
      this.logger.error(`getSocketMapping 실패: ${(error as Error).message}`);
      return null;
    }
  }

  // ===== 온라인 유저 목록 =====

  /**
   * 맵의 온라인 유저 목록 조회 (최대 50명)
   */
  async getOnlineUsersForMap(mapId: string): Promise<FishingOnlineUserInfo[]> {
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
      this.logger.error(`getOnlineUsersForMap 실패: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * 맵의 온라인 유저 수 조회
   */
  async getOnlineUsersCount(mapId: string): Promise<number> {
    try {
      return await this.redis.hlen(this.mapOnlineKey(mapId));
    } catch (error) {
      this.logger.error(`getOnlineUsersCount 실패: ${(error as Error).message}`);
      return 0;
    }
  }

  // ===== 위치 관리 =====

  /**
   * 유저 위치 업데이트
   */
  async updatePosition(mapId: string, userId: number, position: PlayerPosition): Promise<void> {
    try {
      const pKey = this.mapPositionsKey(mapId);
      const pipeline = this.redis.pipeline();
      pipeline.hset(pKey, String(userId), JSON.stringify(position));
      pipeline.expire(pKey, MAP_KEY_TTL);
      void pipeline.exec(); // fire-and-forget (await 불필요 — gateway에서 broadcast 먼저 처리)
    } catch (error) {
      this.logger.error(`updatePosition 실패: ${(error as Error).message}`);
    }
  }

  /**
   * 모든 유저 위치 조회 (새 접속자용)
   */
  async getAllPositions(
    mapId: string,
  ): Promise<Record<number, PlayerPosition & { userName: string; fishingState?: string }>> {
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
      this.logger.error(`getAllPositions 실패: ${(error as Error).message}`);
      return {};
    }
  }

  // ===== 낚시 상태 관리 =====

  /**
   * 유저 낚시 상태 업데이트
   */
  async updateFishingState(mapId: string, userId: number, state: string): Promise<void> {
    try {
      const stKey = this.mapStatesKey(mapId);
      const pipeline = this.redis.pipeline();
      pipeline.hset(stKey, String(userId), state);
      pipeline.expire(stKey, MAP_KEY_TTL);
      void pipeline.exec(); // fire-and-forget
    } catch (error) {
      this.logger.error(`updateFishingState 실패: ${(error as Error).message}`);
    }
  }
}
