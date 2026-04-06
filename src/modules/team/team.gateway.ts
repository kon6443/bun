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
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';

import { WsJwtGuard, AuthenticatedSocket } from '../../common/guards/ws-jwt-auth.guard';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter';
import { getDisplayName } from '../../common/utils/user.utils';
import { TeamService } from './team.service';
import { OnlineUserService } from './online-user.service';
import { JoinTeamDto, LeaveTeamDto } from './team.gateway.dto';
import {
  TeamSocketEvents,
  TaskCreatedPayload,
  TaskUpdatedPayload,
  TaskStatusChangedPayload,
  TaskActiveStatusChangedPayload,
  TaskDeletedPayload,
  CommentCreatedPayload,
  CommentUpdatedPayload,
  CommentDeletedPayload,
  JoinedTeamPayload,
  LeftTeamPayload,
  UserJoinedPayload,
  UserLeftPayload,
  OnlineUsersPayload,
  MemberRoleChangedPayload,
  MemberStatusChangedPayload,
} from './team.events';
import { ALLOWED_ORIGINS } from '../../common/constants/cors.constants';

/**
 * Team WebSocket Gateway
 *
 * NestJS 정석 패턴:
 * - @WebSocketGateway: 네임스페이스와 CORS 설정
 * - @UseFilters: 전역 예외 필터 적용
 * - @Injectable: DI 지원
 * - OnGatewayInit/Connection/Disconnect: 라이프사이클 훅 구현
 * - @UseGuards + @UsePipes: 인증 및 유효성 검사
 *
 * Redis adapter가 server.to(room).emit()을 모든 레플리카에 자동 전달.
 * 온라인 유저 상태는 OnlineUserService(Redis)에서 관리.
 */
@WebSocketGateway({
  namespace: '/teams',
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
})
@UseFilters(WsExceptionFilter)
@Injectable()
export class TeamGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TeamGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly teamService: TeamService,
    private readonly configService: ConfigService,
    private readonly onlineUserService: OnlineUserService,
  ) {}

  // ===== 라이프사이클 훅 (NestJS 정석) =====

  /**
   * Gateway 초기화 시 호출
   */
  afterInit(_server: Server): void {
    this.logger.log('Team WebSocket Gateway 초기화 완료');
  }

  /**
   * 클라이언트 연결 시 호출
   */
  handleConnection(client: Socket): void {
    this.logger.log(`클라이언트 연결: ${client.id}`);
  }

  /**
   * 클라이언트 연결 해제 시 호출
   */
  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`클라이언트 연결 해제: ${client.id}`);

    // 온라인 유저에서 제거
    await this.removeUserFromOnline(client.id);
  }

  // ===== 팀 Room 관리 (Client → Server) =====

  /**
   * 팀 room 참가
   *
   * NestJS 정석:
   * - @UseGuards: JWT 인증
   * - @UsePipes: DTO 유효성 검사
   * - @ConnectedSocket: 타입 안전한 Socket 접근
   * - @MessageBody: 메시지 본문 추출
   */
  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TeamSocketEvents.JOIN_TEAM)
  async handleJoinTeam(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: JoinTeamDto,
  ): Promise<JoinedTeamPayload> {
    const { teamId } = dto;
    const userId = client.data.user?.userId;

    this.logger.debug(`팀 참가 요청: teamId=${teamId}, userId=${userId}, socketId=${client.id}`);

    // 팀 멤버십 검증
    if (userId) {
      try {
        await this.teamService.verifyTeamMemberAccess(teamId, userId);
      } catch (_error) {
        this.logger.warn(`팀 접근 거부: teamId=${teamId}, userId=${userId}`);
        client.emit(TeamSocketEvents.ERROR, {
          code: 'FORBIDDEN',
          message: '해당 팀에 접근 권한이 없습니다.',
        });
        return { teamId, room: '' };
      }
    }

    const roomName = this.getRoomName(teamId);
    await client.join(roomName);

    // 온라인 유저에 추가
    if (userId) {
      const userName = getDisplayName(client.data.user?.userName, userId);

      const { wasAlreadyOnline } = await this.onlineUserService.addUserToOnline(
        teamId,
        userId,
        userName,
        client.id,
      );

      const userInfo = await this.onlineUserService.getUserOnlineInfo(teamId, userId);
      if (userInfo) {
        const onlineUsers = await this.onlineUserService.getOnlineUsersForTeam(teamId);

        // 첫 번째 연결일 때만 (이전에 온라인이 아니었을 때만) 입장 알림
        if (!wasAlreadyOnline) {
          const payload: UserJoinedPayload = {
            teamId,
            userId,
            userName,
            connectionCount: userInfo.connectionCount,
            totalOnlineCount: onlineUsers.length,
          };
          // 본인 제외하고 브로드캐스트
          client.to(roomName).emit(TeamSocketEvents.USER_JOINED, payload);
        }

        // 본인에게는 항상 현재 온라인 유저 목록 전송
        const onlineUsersPayload: OnlineUsersPayload = {
          teamId,
          users: onlineUsers,
          totalCount: onlineUsers.length,
        };
        client.emit(TeamSocketEvents.ONLINE_USERS, onlineUsersPayload);
      }
    }

    this.logger.log(`팀 참가 완료: teamId=${teamId}, userId=${userId}, room=${roomName}`);

    return { teamId, room: roomName };
  }

  /**
   * 팀 room 퇴장
   *
   * 주의: handleDisconnect에서 이미 처리된 소켓이면 중복 처리하지 않음
   */
  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TeamSocketEvents.LEAVE_TEAM)
  async handleLeaveTeam(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: LeaveTeamDto,
  ): Promise<LeftTeamPayload> {
    const { teamId } = dto;
    const roomName = this.getRoomName(teamId);

    // 온라인 유저에서 제거 및 퇴장 알림
    // 이미 handleDisconnect에서 처리된 소켓이면 스킵 (중복 알림 방지)
    const userId = client.data.user?.userId;
    if (userId && (await this.onlineUserService.isSocketRegistered(client.id))) {
      const result = await this.onlineUserService.removeSocket(client.id);
      if (result?.isFullyOffline) {
        await this.broadcastUserLeftIfOffline(teamId, userId, result.userName);
      }
    }

    await client.leave(roomName);

    this.logger.log(`팀 퇴장: teamId=${teamId}, socketId=${client.id}`);

    return { teamId, room: roomName };
  }

  // ===== 이벤트 브로드캐스트 (Server → Client) =====

  /**
   * 태스크 생성 이벤트 브로드캐스트
   */
  emitTaskCreated(teamId: number, payload: TaskCreatedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.TASK_CREATED, payload);
    this.logger.debug(`태스크 생성 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}`);
  }

  /**
   * 태스크 수정 이벤트 브로드캐스트
   */
  emitTaskUpdated(teamId: number, payload: TaskUpdatedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.TASK_UPDATED, payload);
    this.logger.debug(`태스크 수정 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}`);
  }

  /**
   * 태스크 상태 변경 이벤트 브로드캐스트
   */
  emitTaskStatusChanged(teamId: number, payload: TaskStatusChangedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.TASK_STATUS_CHANGED, payload);
    this.logger.debug(
      `태스크 상태 변경 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}, ` +
        `${payload.oldStatus} → ${payload.newStatus}`,
    );
  }

  /**
   * 태스크 활성 상태 변경 이벤트 브로드캐스트
   */
  emitTaskActiveStatusChanged(teamId: number, payload: TaskActiveStatusChangedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.TASK_ACTIVE_STATUS_CHANGED, payload);
    this.logger.debug(
      `태스크 활성 상태 변경 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}, ` +
        `${payload.oldActStatus} → ${payload.newActStatus}`,
    );
  }

  /**
   * 태스크 삭제 이벤트 브로드캐스트
   */
  emitTaskDeleted(teamId: number, payload: TaskDeletedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.TASK_DELETED, payload);
    this.logger.debug(`태스크 삭제 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}`);
  }

  // ===== 댓글 이벤트 브로드캐스트 =====

  /**
   * 댓글 생성 이벤트 브로드캐스트
   */
  emitCommentCreated(teamId: number, payload: CommentCreatedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.COMMENT_CREATED, payload);
    this.logger.debug(
      `댓글 생성 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}, commentId=${payload.commentId}`,
    );
  }

  /**
   * 댓글 수정 이벤트 브로드캐스트
   */
  emitCommentUpdated(teamId: number, payload: CommentUpdatedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.COMMENT_UPDATED, payload);
    this.logger.debug(
      `댓글 수정 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}, commentId=${payload.commentId}`,
    );
  }

  /**
   * 댓글 삭제 이벤트 브로드캐스트
   */
  emitCommentDeleted(teamId: number, payload: CommentDeletedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.COMMENT_DELETED, payload);
    this.logger.debug(
      `댓글 삭제 브로드캐스트: teamId=${teamId}, taskId=${payload.taskId}, commentId=${payload.commentId}`,
    );
  }

  // ===== 멤버 역할 이벤트 브로드캐스트 =====

  /**
   * 멤버 역할 변경 이벤트 브로드캐스트
   */
  emitMemberRoleChanged(teamId: number, payload: MemberRoleChangedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.MEMBER_ROLE_CHANGED, payload);
    this.logger.debug(
      `멤버 역할 변경 브로드캐스트: teamId=${teamId}, userId=${payload.userId}, ` +
        `${payload.previousRole} → ${payload.newRole}`,
    );
  }

  /**
   * 멤버 상태 변경 이벤트 브로드캐스트
   */
  emitMemberStatusChanged(teamId: number, payload: MemberStatusChangedPayload): void {
    const roomName = this.getRoomName(teamId);
    this.server.to(roomName).emit(TeamSocketEvents.MEMBER_STATUS_CHANGED, payload);
    this.logger.debug(
      `멤버 상태 변경 브로드캐스트: teamId=${teamId}, userId=${payload.userId}, ` +
        `${payload.previousStatus} → ${payload.newStatus}`,
    );
  }

  // ===== 유틸리티 =====

  /**
   * 팀 ID로 room 이름 생성
   */
  private getRoomName(teamId: number): string {
    return `team-${teamId}`;
  }

  /**
   * 특정 room에 연결된 클라이언트 수 조회
   */
  async getConnectedClientsCount(teamId: number): Promise<number> {
    const roomName = this.getRoomName(teamId);
    const sockets = await this.server.in(roomName).fetchSockets();
    return sockets.length;
  }

  // ===== 온라인 유저 관리 메서드 =====

  /**
   * 유저 퇴장 알림 브로드캐스트 (완전히 오프라인일 때만)
   */
  private async broadcastUserLeftIfOffline(
    teamId: number,
    userId: number,
    userName: string,
  ): Promise<void> {
    const userInfo = await this.onlineUserService.getUserOnlineInfo(teamId, userId);

    // 아직 접속 중이면 알림 안 보냄
    if (userInfo) return;

    const onlineUsers = await this.onlineUserService.getOnlineUsersForTeam(teamId);
    const roomName = this.getRoomName(teamId);
    const payload: UserLeftPayload = {
      teamId,
      userId,
      userName,
      connectionCount: 0,
      totalOnlineCount: onlineUsers.length,
    };

    this.server.to(roomName).emit(TeamSocketEvents.USER_LEFT, payload);
  }

  /**
   * 소켓 연결 해제 시 온라인 목록에서 제거
   *
   * 주의: handleLeaveTeam에서 이미 처리된 경우 스킵됨 (중복 알림 방지)
   */
  private async removeUserFromOnline(socketId: string): Promise<void> {
    const result = await this.onlineUserService.removeSocket(socketId);
    if (!result) return;

    const { teamId, userId, userName, isFullyOffline } = result;
    if (isFullyOffline) {
      await this.broadcastUserLeftIfOffline(teamId, userId, userName);
    }

    this.logger.debug(`온라인 유저 제거 (disconnect): socketId=${socketId}`);
  }

  /**
   * 팀의 온라인 유저 수 조회
   */
  async getOnlineUsersCount(teamId: number): Promise<number> {
    return this.onlineUserService.getOnlineUsersCount(teamId);
  }
}
