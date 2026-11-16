import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Injectable, Logger, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

import { FishingWsGuard, FishingSocket as FishingAuthSocket } from './fishing-ws.guard';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter';
import { getDisplayName } from '../../common/utils/user.utils';
import { FishingOnlineService } from './fishing-online.service';
import { JoinMapDto, LeaveMapDto, MoveDto, FishingStateDto, ChatMessageDto, CatchResultDto } from './fishing.gateway.dto';
import {
  FishingSocketEvents,
  PlayerMovedPayload,
  PlayerFishingStatePayload,
  ChatReceivedPayload,
  CatchNotificationPayload,
  FishingUserJoinedPayload,
  FishingUserLeftPayload,
  FishingOnlineUsersPayload,
  JoinedMapPayload,
  LeftMapPayload,
} from './fishing.events';
import { ALLOWED_ORIGINS } from '../../common/constants/cors.constants';
import { consumeFishingRate, FishingRateAction } from './fishing-rate-limit';

/** 소켓에서 유저 정보 추출 (인증 유저 또는 게스트) */
function getClientInfo(client: FishingAuthSocket): { userId: number; userName: string } | null {
  if (client.data.isAuthenticated && client.data.user) {
    return {
      userId: client.data.user.userId,
      userName: getDisplayName(client.data.user.userName, client.data.user.userId),
    };
  }
  if (client.data.guestId && client.data.guestName) {
    return {
      userId: client.data.guestId,
      userName: client.data.guestName,
    };
  }
  return null;
}

/**
 * Fishing WebSocket Gateway
 *
 * /fishing namespace. /teams와 완전히 독립적으로 운영.
 * 인증/게스트 모두 접속 가능.
 * Room: fishing-map-{mapId}
 */
@WebSocketGateway({
  namespace: '/fishing',
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
})
@UseFilters(WsExceptionFilter)
@Injectable()
export class FishingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(FishingGateway.name);

  @WebSocketServer()
  server: Server;

  /**
   * 소켓별 맵 소속 변경(입장·퇴장·연결 해제) 직렬화 큐 — Nest는 같은 소켓의 핸들러도 동시에 돌린다.
   * 퇴장 직후 재입장·연달은 맵 이동이 겹치면 늦게 끝난 쪽이 방금 한 등록·room 참가를 지우거나 유령을 남긴다
   * (tetris-battle.gateway의 socketQueues와 같은 방식, 소켓이 사라지면 함께 사라진다)
   */
  private readonly membershipQueues = new WeakMap<Socket, Promise<void>>();

  constructor(private readonly fishingOnlineService: FishingOnlineService) {}

  // ===== 라이프사이클 훅 =====

  afterInit(_server: Server): void {
    this.logger.log('Fishing WebSocket Gateway 초기화 완료');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`[Fishing] 클라이언트 연결: ${client.id}`);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`[Fishing] 클라이언트 연결 해제: ${client.id}`);
    await this.serializeMembership(client, () => this.removeUserFromOnline(client.id));
  }

  // ===== 맵 Room 관리 =====

  /**
   * 맵 room 참가
   */
  @UseGuards(FishingWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FishingSocketEvents.JOIN_MAP)
  async handleJoinMap(
    @ConnectedSocket() client: FishingAuthSocket,
    @MessageBody() dto: JoinMapDto,
  ): Promise<JoinedMapPayload> {
    return this.serializeMembership(client, async () => {
      const { mapId } = dto;
      // 가드(DB 조회)를 기다리는 사이 끊긴 소켓 — 연결 해제 정리가 이미 큐 앞에서 끝났을 수 있다.
      // 여기서 등록하면 죽은 소켓이 TTL까지 온라인으로 남는다
      if (client.disconnected) return { mapId, room: this.getRoomName(mapId) };
      const info = getClientInfo(client);

      this.logger.debug(`[Fishing] 맵 참가 요청: mapId=${mapId}, userId=${info?.userId}, socketId=${client.id}`);

      const roomName = this.getRoomName(mapId);

      // 다른 맵에 있던 소켓이면 먼저 떠난다 — 아니면 이전 맵 room 이벤트를 계속 받고, 소켓 매핑이 새 맵으로 덮여
      // 이전 맵의 온라인·위치·상태가 TTL까지 유령으로 남는다
      const previousMapId = client._fishingMapId;
      if (previousMapId && previousMapId !== mapId) {
        await this.leaveMap(client, previousMapId);
      }

      await client.join(roomName);

      // mapId를 소켓에 캐싱 (move 등 고빈도 이벤트에서 Redis 조회 생략용)
      client._fishingMapId = mapId;

      if (info) {
        const { userId, userName } = info;

        const { wasAlreadyOnline } = await this.fishingOnlineService.addUserToOnline(
          mapId,
          userId,
          userName,
          client.id,
        );

        const onlineUsers = await this.fishingOnlineService.getOnlineUsersForMap(mapId);

        // 첫 번째 연결일 때만 입장 알림
        if (!wasAlreadyOnline) {
          const userInfo = onlineUsers.find((u) => u.userId === userId);
          const payload: FishingUserJoinedPayload = {
            userId,
            userName,
            connectionCount: userInfo?.connectionCount ?? 1,
            totalOnlineCount: onlineUsers.length,
            position: userInfo?.position,
          };
          client.to(roomName).emit(FishingSocketEvents.USER_JOINED, payload);
        }

        // 본인에게 현재 온라인 유저 목록 전송
        const onlineUsersPayload: FishingOnlineUsersPayload = {
          mapId,
          users: onlineUsers,
          totalCount: onlineUsers.length,
        };
        client.emit(FishingSocketEvents.ONLINE_USERS, onlineUsersPayload);

        // 본인에게 현재 모든 플레이어 위치 전송
        const positions = await this.fishingOnlineService.getAllPositions(mapId);
        client.emit(FishingSocketEvents.PLAYER_POSITIONS, { positions });
      }

      this.logger.log(`[Fishing] 맵 참가 완료: mapId=${mapId}, userId=${info?.userId}, room=${roomName}`);

      return { mapId, room: roomName };
    });
  }

  /**
   * 맵 room 퇴장
   */
  @UseGuards(FishingWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FishingSocketEvents.LEAVE_MAP)
  async handleLeaveMap(
    @ConnectedSocket() client: FishingAuthSocket,
    @MessageBody() dto: LeaveMapDto,
  ): Promise<LeftMapPayload> {
    const { mapId } = dto;
    await this.serializeMembership(client, () => this.leaveMap(client, mapId));
    return { mapId, room: this.getRoomName(mapId) };
  }

  // ===== 플레이어 이동 =====

  /**
   * 위치 업데이트 (고빈도 이벤트 — 클라이언트에서 throttle 적용)
   */
  @UseGuards(FishingWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FishingSocketEvents.MOVE)
  async handleMove(
    @ConnectedSocket() client: FishingAuthSocket,
    @MessageBody() dto: MoveDto,
  ): Promise<void> {
    // client.data에서 직접 읽기 (Redis 조회 생략 — 고빈도 이벤트 최적화)
    const info = getClientInfo(client);
    const mapId = client._fishingMapId;
    if (!info || !mapId) return;
    if (!this.allowEvent(client, 'move')) return;

    const { userId, userName } = info;

    // broadcast 먼저 실행 (지연 최소화)
    const roomName = this.getRoomName(mapId);
    const payload: PlayerMovedPayload = {
      userId,
      userName,
      x: dto.x,
      y: dto.y,
      direction: dto.direction,
      timestamp: Date.now(),
    };
    client.to(roomName).emit(FishingSocketEvents.PLAYER_MOVED, payload);

    // Redis 저장은 fire-and-forget (새 접속자용 스냅샷, broadcast와 독립)
    const position = { x: dto.x, y: dto.y, direction: dto.direction };
    void this.fishingOnlineService.updatePosition(mapId, userId, position);
  }

  // ===== 낚시 상태 =====

  /**
   * 낚시 상태 변경 브로드캐스트
   */
  @UseGuards(FishingWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FishingSocketEvents.FISHING_STATE)
  async handleFishingState(
    @ConnectedSocket() client: FishingAuthSocket,
    @MessageBody() dto: FishingStateDto,
  ): Promise<void> {
    const info = getClientInfo(client);
    const mapId = client._fishingMapId;
    if (!info || !mapId) return;
    if (!this.allowEvent(client, 'state')) return;

    const { userId, userName } = info;

    // 본인 제외 브로드캐스트 (먼저 실행)
    const roomName = this.getRoomName(mapId);
    const payload: PlayerFishingStatePayload = {
      userId,
      userName,
      state: dto.state,
      pointId: dto.pointId,
    };
    client.to(roomName).emit(FishingSocketEvents.PLAYER_FISHING_STATE, payload);

    // Redis 저장은 fire-and-forget
    void this.fishingOnlineService.updateFishingState(mapId, userId, dto.state);
  }

  // ===== 채팅 =====

  /**
   * 채팅 메시지 전송
   */
  @UseGuards(FishingWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FishingSocketEvents.CHAT_MESSAGE)
  async handleChatMessage(
    @ConnectedSocket() client: FishingAuthSocket,
    @MessageBody() dto: ChatMessageDto,
  ): Promise<void> {
    const info = getClientInfo(client);
    const mapId = client._fishingMapId;
    if (!info || !mapId) return;
    if (!this.allowEvent(client, 'chat')) return;

    const { userId, userName } = info;
    const roomName = this.getRoomName(mapId);

    const payload: ChatReceivedPayload = {
      userId,
      userName,
      message: dto.message,
      timestamp: new Date().toISOString(),
    };

    // 전체 브로드캐스트 (본인 포함 — 채팅은 본인도 확인 필요)
    this.server.to(roomName).emit(FishingSocketEvents.CHAT_RECEIVED, payload);
  }

  // ===== 낚시 결과 =====

  /**
   * 낚시 성공 시 전체 알림
   */
  @UseGuards(FishingWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FishingSocketEvents.CATCH_RESULT)
  async handleCatchResult(
    @ConnectedSocket() client: FishingAuthSocket,
    @MessageBody() dto: CatchResultDto,
  ): Promise<void> {
    const info = getClientInfo(client);
    const mapId = client._fishingMapId;
    if (!info || !mapId) return;
    if (!this.allowEvent(client, 'catch')) return;

    const { userId, userName } = info;
    const roomName = this.getRoomName(mapId);

    const payload: CatchNotificationPayload = {
      userId,
      userName,
      fishName: dto.fishName,
      grade: dto.grade,
      size: dto.size,
      weight: dto.weight,
      timestamp: new Date().toISOString(),
    };

    // 본인 제외 브로드캐스트 (본인은 이미 UI에서 결과 표시)
    client.to(roomName).emit(FishingSocketEvents.CATCH_NOTIFICATION, payload);
  }

  // ===== 유틸리티 =====

  private getRoomName(mapId: string): string {
    return `fishing-map-${mapId}`;
  }

  private serializeMembership<T>(client: Socket, task: () => Promise<T>): Promise<T> {
    const previous = this.membershipQueues.get(client) ?? Promise.resolve();
    const run = previous.then(task);
    this.membershipQueues.set(
      client,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** 소켓 단위 빈도 제한 — 넘으면 이벤트를 조용히 버린다(한도는 정상 입력의 2배 이상, fishing-rate-limit.ts) */
  private allowEvent(client: FishingAuthSocket, action: FishingRateAction): boolean {
    client._fishingRateWindows ??= {};
    if (consumeFishingRate(client._fishingRateWindows, action, Date.now())) return true;
    this.logger.debug(`[Fishing] 빈도 제한 초과로 무시: action=${action}, socketId=${client.id}`);
    return false;
  }

  /**
   * 맵 퇴장 — 온라인 등록 해제 + 마지막 연결이면 퇴장 알림 + room 이탈 (leaveMap 이벤트·다른 맵 입장 공용).
   * 호출자가 serializeMembership 안에서 부른다
   */
  private async leaveMap(client: FishingAuthSocket, mapId: string): Promise<void> {
    // 캐시를 먼저 비운다 — 정리를 기다리는 사이 들어온 이동·상태가 지운 위치를 다시 쓰지 않게(큐 밖 고빈도 이벤트는 캐시만 본다)
    if (client._fishingMapId === mapId) client._fishingMapId = undefined;
    const info = getClientInfo(client);
    if (info && (await this.fishingOnlineService.isSocketRegistered(client.id))) {
      const result = await this.fishingOnlineService.removeSocket(client.id);
      if (result?.isFullyOffline) {
        await this.broadcastUserLeftIfOffline(result.mapId, info.userId, result.userName);
      }
    }

    await client.leave(this.getRoomName(mapId));

    this.logger.log(`[Fishing] 맵 퇴장: mapId=${mapId}, socketId=${client.id}`);
  }

  /**
   * 유저 퇴장 알림 브로드캐스트 (완전히 오프라인일 때만)
   */
  private async broadcastUserLeftIfOffline(
    mapId: string,
    userId: number,
    userName: string,
  ): Promise<void> {
    const onlineUsers = await this.fishingOnlineService.getOnlineUsersForMap(mapId);
    const stillOnline = onlineUsers.find((u) => u.userId === userId);
    if (stillOnline) return;

    const roomName = this.getRoomName(mapId);
    const payload: FishingUserLeftPayload = {
      userId,
      userName,
      connectionCount: 0,
      totalOnlineCount: onlineUsers.length,
    };

    this.server.to(roomName).emit(FishingSocketEvents.USER_LEFT, payload);
  }

  /**
   * 소켓 연결 해제 시 온라인 목록에서 제거
   */
  private async removeUserFromOnline(socketId: string): Promise<void> {
    const result = await this.fishingOnlineService.removeSocket(socketId);
    if (!result) return;

    const { mapId, userId, userName, isFullyOffline } = result;
    if (isFullyOffline) {
      await this.broadcastUserLeftIfOffline(mapId, userId, userName);
    }

    this.logger.debug(`[Fishing] 온라인 유저 제거 (disconnect): socketId=${socketId}`);
  }
}
