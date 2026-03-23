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
@UseFilters(new WsExceptionFilter())
@Injectable()
export class FishingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(FishingGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly fishingOnlineService: FishingOnlineService) {}

  // ===== 라이프사이클 훅 =====

  afterInit(server: Server): void {
    this.logger.log('Fishing WebSocket Gateway 초기화 완료');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`[Fishing] 클라이언트 연결: ${client.id}`);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`[Fishing] 클라이언트 연결 해제: ${client.id}`);
    await this.removeUserFromOnline(client.id);
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
    const { mapId } = dto;
    const info = getClientInfo(client);

    this.logger.debug(`[Fishing] 맵 참가 요청: mapId=${mapId}, userId=${info?.userId}, socketId=${client.id}`);

    const roomName = this.getRoomName(mapId);
    await client.join(roomName);

    // mapId를 소켓에 캐싱 (move 등 고빈도 이벤트에서 Redis 조회 생략용)
    (client as any)._fishingMapId = mapId;

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
    const roomName = this.getRoomName(mapId);

    const info = getClientInfo(client);
    if (info && (await this.fishingOnlineService.isSocketRegistered(client.id))) {
      const result = await this.fishingOnlineService.removeSocket(client.id);
      if (result?.isFullyOffline) {
        await this.broadcastUserLeftIfOffline(mapId, info.userId, result.userName);
      }
    }

    await client.leave(roomName);

    this.logger.log(`[Fishing] 맵 퇴장: mapId=${mapId}, socketId=${client.id}`);

    return { mapId, room: roomName };
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
    const mapId = (client as any)._fishingMapId;
    if (!info || !mapId) return;

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
    this.fishingOnlineService.updatePosition(mapId, userId, position);
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
    const mapId = (client as any)._fishingMapId;
    if (!info || !mapId) return;

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
    this.fishingOnlineService.updateFishingState(mapId, userId, dto.state);
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
    const mapId = (client as any)._fishingMapId;
    if (!info || !mapId) return;

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
    const mapId = (client as any)._fishingMapId;
    if (!info || !mapId) return;

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
