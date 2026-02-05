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
  OnlineUserInfo,
  UserJoinedPayload,
  UserLeftPayload,
  OnlineUsersPayload,
  MemberRoleChangedPayload,
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
 */
@WebSocketGateway({
  namespace: '/teams',
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
})
@UseFilters(new WsExceptionFilter())
@Injectable()
export class TeamGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TeamGateway.name);

  @WebSocketServer()
  server: Server;

  /**
   * 온라인 유저 저장소
   * Map<teamId, Map<userId, { userName, socketIds }>>
   */
  private onlineUsers = new Map<number, Map<number, { userName: string; socketIds: Set<string> }>>();

  /**
   * 소켓 ID → 유저/팀 매핑 (disconnect 시 빠른 조회용)
   */
  private socketToUser = new Map<string, { teamId: number; userId: number; userName: string }>();

  constructor(
    private readonly teamService: TeamService,
    private readonly configService: ConfigService,
  ) {}

  // ===== 라이프사이클 훅 (NestJS 정석) =====

  /**
   * Gateway 초기화 시 호출
   */
  afterInit(server: Server): void {
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
  handleDisconnect(client: Socket): void {
    this.logger.log(`클라이언트 연결 해제: ${client.id}`);

    // 온라인 유저에서 제거
    this.removeUserFromOnline(client.id);
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
      } catch (error) {
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

      // 추가 전에 이미 접속 중인지 확인 (중복 알림 방지)
      const wasAlreadyOnline = this.getUserOnlineInfo(teamId, userId) !== null;

      this.addUserToOnline(teamId, userId, userName, client.id);

      const userInfo = this.getUserOnlineInfo(teamId, userId);
      if (userInfo) {
        const onlineUsers = this.getOnlineUsersForTeam(teamId);

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
    if (userId && this.isSocketRegistered(client.id)) {
      const userName = getDisplayName(client.data.user?.userName, userId);
      this.removeUserSocketFromTeam(teamId, userId, client.id);
      this.broadcastUserLeftIfOffline(teamId, userId, userName, client.id);
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
   *
   * @param teamId - 팀 ID
   * @param userId - 유저 ID
   * @param userName - 유저 이름
   * @param excludeSocketId - 브로드캐스트에서 제외할 소켓 ID (본인 제외용, optional)
   */
  private broadcastUserLeftIfOffline(
    teamId: number,
    userId: number,
    userName: string,
    excludeSocketId?: string,
  ): void {
    const userInfo = this.getUserOnlineInfo(teamId, userId);

    // 아직 접속 중이면 알림 안 보냄
    if (userInfo) return;

    const onlineUsers = this.getOnlineUsersForTeam(teamId);
    const roomName = this.getRoomName(teamId);
    const payload: UserLeftPayload = {
      teamId,
      userId,
      userName,
      connectionCount: 0,
      totalOnlineCount: onlineUsers.length,
    };

    if (excludeSocketId) {
      // 특정 소켓 제외하고 브로드캐스트 (handleLeaveTeam에서 사용)
      // excludeSocketId는 이미 room을 떠났거나 떠날 예정이므로 server.to로 전송
      this.server.to(roomName).emit(TeamSocketEvents.USER_LEFT, payload);
    } else {
      // 전체 브로드캐스트 (removeUserFromOnline에서 사용)
      this.server.to(roomName).emit(TeamSocketEvents.USER_LEFT, payload);
    }
  }

  /**
   * 유저를 온라인 목록에 추가
   */
  private addUserToOnline(teamId: number, userId: number, userName: string, socketId: string): void {
    // 팀별 Map 초기화
    if (!this.onlineUsers.has(teamId)) {
      this.onlineUsers.set(teamId, new Map());
    }

    const teamUsers = this.onlineUsers.get(teamId)!;

    // 유저별 소켓 Set 초기화 또는 추가
    if (!teamUsers.has(userId)) {
      teamUsers.set(userId, { userName, socketIds: new Set([socketId]) });
    } else {
      teamUsers.get(userId)!.socketIds.add(socketId);
    }

    // 역방향 매핑 저장
    this.socketToUser.set(socketId, { teamId, userId, userName });

    this.logger.debug(
      `온라인 유저 추가: teamId=${teamId}, userId=${userId}, socketId=${socketId}, ` +
        `총 접속 수=${teamUsers.get(userId)!.socketIds.size}`,
    );
  }

  /**
   * 특정 소켓을 팀의 온라인 목록에서 제거
   */
  private removeUserSocketFromTeam(teamId: number, userId: number, socketId: string): void {
    const teamUsers = this.onlineUsers.get(teamId);
    if (!teamUsers) return;

    const userInfo = teamUsers.get(userId);
    if (!userInfo) return;

    userInfo.socketIds.delete(socketId);

    // 모든 소켓이 제거되면 유저도 제거
    if (userInfo.socketIds.size === 0) {
      teamUsers.delete(userId);
    }

    // 팀에 유저가 없으면 팀 Map도 제거
    if (teamUsers.size === 0) {
      this.onlineUsers.delete(teamId);
    }

    // 역방향 매핑 제거
    this.socketToUser.delete(socketId);

    this.logger.debug(
      `온라인 유저 소켓 제거: teamId=${teamId}, userId=${userId}, socketId=${socketId}`,
    );
  }

  /**
   * 소켓 연결 해제 시 온라인 목록에서 제거
   * 
   * 주의: handleLeaveTeam에서 이미 처리된 경우 스킵됨 (중복 알림 방지)
   */
  private removeUserFromOnline(socketId: string): void {
    const userMapping = this.getSocketUserMapping(socketId);
    if (!userMapping) return;

    const { teamId, userId, userName } = userMapping;
    this.removeUserSocketFromTeam(teamId, userId, socketId);
    this.broadcastUserLeftIfOffline(teamId, userId, userName);

    this.logger.debug(`온라인 유저 제거 (disconnect): socketId=${socketId}`);
  }

  /**
   * 특정 유저의 온라인 정보 조회
   */
  private getUserOnlineInfo(teamId: number, userId: number): OnlineUserInfo | null {
    const teamUsers = this.onlineUsers.get(teamId);
    if (!teamUsers) return null;

    const userInfo = teamUsers.get(userId);
    if (!userInfo) return null;

    return {
      userId,
      userName: userInfo.userName,
      connectionCount: userInfo.socketIds.size,
    };
  }

  /**
   * 팀의 온라인 유저 목록 조회 (최대 100명)
   */
  private getOnlineUsersForTeam(teamId: number): OnlineUserInfo[] {
    const teamUsers = this.onlineUsers.get(teamId);
    if (!teamUsers) return [];

    const users: OnlineUserInfo[] = [];
    for (const [userId, userInfo] of teamUsers.entries()) {
      users.push({
        userId,
        userName: userInfo.userName,
        connectionCount: userInfo.socketIds.size,
      });
      // 최대 100명까지만
      if (users.length >= 100) break;
    }

    return users;
  }

  /**
   * 팀의 온라인 유저 수 조회
   */
  getOnlineUsersCount(teamId: number): number {
    const teamUsers = this.onlineUsers.get(teamId);
    return teamUsers?.size ?? 0;
  }

  // ===== 소켓 상태 확인 헬퍼 (중복 처리 방지) =====

  /**
   * 소켓이 온라인 유저 시스템에 등록되어 있는지 확인
   * 
   * 사용 목적:
   * - handleLeaveTeam과 handleDisconnect의 중복 처리 방지
   * - 이미 처리된 소켓인지 확인하여 중복 알림 방지
   * 
   * @param socketId - 확인할 소켓 ID
   * @returns 등록 여부
   */
  private isSocketRegistered(socketId: string): boolean {
    return this.socketToUser.has(socketId);
  }

  /**
   * 소켓의 유저/팀 매핑 정보 조회
   * 
   * @param socketId - 소켓 ID
   * @returns 매핑 정보 (없으면 null)
   */
  private getSocketUserMapping(socketId: string): { teamId: number; userId: number; userName: string } | null {
    return this.socketToUser.get(socketId) ?? null;
  }
}
