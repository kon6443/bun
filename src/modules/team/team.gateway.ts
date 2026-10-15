import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Injectable, Logger, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';
import { Server, Socket } from 'socket.io';

import { WsJwtGuard, AuthenticatedSocket } from '../../common/guards/ws-jwt-auth.guard';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter';
import { getDisplayName } from '../../common/utils/user.utils';
import { TeamService } from './team.service';
import { OnlineUserService } from './online-user.service';
import { TeamChatMessage } from '../../entities/TeamChatMessage';
import { TeamChatService, toChatMessageView } from './team-chat.service';
import { TeamForbiddenErrorResponseDto } from './team-error.dto';
import { JoinTeamDto, LeaveTeamDto, ChatMessageDto, ChatReadDto } from './team.gateway.dto';
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
  ChatReceivedPayload,
  ChatReadUpdatedPayload,
  MemberJoinedPayload,
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
    private readonly teamChatService: TeamChatService,
    @InjectMetric('ws_connections_active')
    private readonly wsConnectionsActive: Gauge<string>,
    @InjectMetric('ws_events_total')
    private readonly wsEventsTotal: Counter<string>,
    @InjectMetric('ws_event_duration_seconds')
    private readonly wsEventDuration: Histogram<string>,
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
    this.wsConnectionsActive.inc();
    this.logger.log(`클라이언트 연결: ${client.id}`);
  }

  /**
   * 클라이언트 연결 해제 시 호출
   */
  async handleDisconnect(client: Socket): Promise<void> {
    this.wsConnectionsActive.dec();
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
    this.wsEventsTotal.inc({ event: 'joinTeam' });
    const endTimer = this.wsEventDuration.startTimer({ event: 'joinTeam' });
    try {
      const { teamId } = dto;
      const userId = client.data.user?.userId;

      this.logger.debug(`팀 참가 요청: teamId=${teamId}, userId=${userId}, socketId=${client.id}`);

      // 인증 정보 확인
      // WsJwtGuard가 앞단에서 막지만, 팀 격리를 가드 한 겹에만 의존하지 않는다 —
      // @UseGuards가 빠지면 아무나 임의 팀 room에 들어가 모든 이벤트를 수신하게 된다.
      // HTTP 경로가 가드 + verifyTeamMemberAccess 2겹인 것과 같은 구조를 맞춘다.
      if (!userId) {
        this.logger.warn(`팀 참가 거부: 인증 정보 없음 socketId=${client.id}`);
        throw new WsException({
          code: 'AUTH_UNAUTHORIZED',
          message: '인증이 필요합니다.',
        });
      }

      // 팀 멤버십 검증
      try {
        await this.teamService.verifyTeamMemberAccess(teamId, userId);
      } catch (_error) {
        this.logger.warn(`팀 접근 거부: teamId=${teamId}, userId=${userId}`);
        // WsExceptionFilter가 {code, message, timestamp} 표준 포맷으로 'error' emit
        throw new WsException({
          code: 'FORBIDDEN',
          message: '해당 팀에 접근 권한이 없습니다.',
        });
      }

      const roomName = this.getRoomName(teamId);
      await client.join(roomName);

      // 채팅 등 후속 이벤트의 room 식별을 위해 teamId 캐싱
      client.data.teamId = teamId;

      // 온라인 유저에 추가
      const userName = getDisplayName(client.data.user?.userName, userId);

      const { wasAlreadyOnline } = await this.onlineUserService.addUserToOnline(
        teamId,
        userId,
        userName,
        client.id,
      );

      // 팀별 온라인 Gauge 갱신 대상에 등록 (TASK_SLOT=1 replica 에서 60s 주기로 count 재계산)
      this.onlineUserService.trackActiveTeam(teamId);

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

      this.logger.log(`팀 참가 완료: teamId=${teamId}, userId=${userId}, room=${roomName}`);

      return { teamId, room: roomName };
    } finally {
      endTimer();
    }
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
    this.wsEventsTotal.inc({ event: 'leaveTeam' });
    const endTimer = this.wsEventDuration.startTimer({ event: 'leaveTeam' });
    try {
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

      // 캐싱된 teamId 정리 (퇴장한 팀의 채팅이 계속 전송되는 것 방지)
      if (client.data.teamId === teamId) {
        client.data.teamId = undefined;
      }

      this.logger.log(`팀 퇴장: teamId=${teamId}, socketId=${client.id}`);

      return { teamId, room: roomName };
    } finally {
      endTimer();
    }
  }

  // ===== 채팅 (Client → Server) =====

  /**
   * 채팅 메시지 수신 → DB 저장 → 같은 팀 room에 브로드캐스트 (docs/tasks/team-chat-persistence)
   *
   * - teamId는 joinTeam 시 소켓에 캐싱된 값을 사용 (room 미참여자 차단)
   * - 저장(COMMIT)이 끝난 뒤 뿌린다 — 받은 메시지는 항상 DB에 있다 (D-020)
   * - 본인 포함 브로드캐스트(server.to) → 프론트는 clientMsgId로 낙관적 메시지를 교체
   * - 거부·실패는 clientMsgId를 실어 error 이벤트로 보낸다 → 프론트가 해당 메시지를 '전송 실패'로 표시 (D-016)
   */
  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TeamSocketEvents.CHAT_MESSAGE)
  async handleChatMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: ChatMessageDto,
  ): Promise<void> {
    this.wsEventsTotal.inc({ event: 'chatMessage' });
    const endTimer = this.wsEventDuration.startTimer({ event: 'chatMessage' });
    try {
      const teamId = client.data.teamId;
      const user = client.data.user;
      const { clientMsgId } = dto;

      // 팀 room에 참가하지 않았거나 인증 정보가 없으면 에러 응답 (침묵 실패 방지)
      // WsExceptionFilter가 {code, message, timestamp, clientMsgId} 포맷으로 'error' emit
      if (!teamId || !user) {
        this.logger.warn(`채팅 거부: 팀 미참여 소켓 socketId=${client.id}`);
        throw new WsException({
          code: 'CHAT_NOT_JOINED',
          message: '채팅을 보내려면 먼저 팀에 참가해야 합니다.',
          clientMsgId,
        });
      }

      const userId = user.userId;

      if (!(await this.teamChatService.consumeRateLimit('send', teamId, userId))) {
        this.logger.warn(`채팅 거부: 레이트 리밋 초과 teamId=${teamId}, userId=${userId}`);
        throw new WsException({
          code: 'CHAT_RATE_LIMITED',
          message: '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내주세요.',
          clientMsgId,
        });
      }

      let saved: TeamChatMessage;
      try {
        saved = await this.teamChatService.sendMessage({ teamId, userId, content: dto.message, clientMsgId });
      } catch (error) {
        if (error instanceof TeamForbiddenErrorResponseDto) {
          // join 이후 추방·비활성화된 멤버 — 소켓은 살아 있어도 보낼 수 없다 (D-006)
          this.logger.warn(`채팅 거부: 활성 멤버 아님 teamId=${teamId}, userId=${userId}`);
          throw new WsException({
            code: 'CHAT_FORBIDDEN',
            message: '팀 멤버만 채팅을 보낼 수 있습니다.',
            clientMsgId,
          });
        }
        this.logger.error(
          `채팅 저장 실패: teamId=${teamId}, userId=${userId}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw new WsException({
          code: 'CHAT_SEND_FAILED',
          message: '메시지를 보내지 못했습니다. 다시 시도해주세요.',
          clientMsgId,
        });
      }

      const payload: ChatReceivedPayload = toChatMessageView(saved, user.userName);
      this.server.to(this.getRoomName(teamId)).emit(TeamSocketEvents.CHAT_RECEIVED, payload);
      this.logger.debug(`채팅 브로드캐스트: teamId=${teamId}, userId=${userId}, messageId=${payload.messageId}`);
    } finally {
      endTimer();
    }
  }

  /**
   * 읽음 위치 갱신 → 커서가 실제로 전진했을 때만 room에 chatReadUpdated
   *
   * 프론트는 1초 debounce로 최댓값만 보낸다. 레이트 리밋을 넘으면 에러 없이 무시한다 —
   * 커서는 증가만 하므로 다음 chatRead가 최댓값을 다시 실어 온다(사용자에게 띄울 실패가 아니다).
   */
  @UseGuards(WsJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TeamSocketEvents.CHAT_READ)
  async handleChatRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: ChatReadDto,
  ): Promise<void> {
    this.wsEventsTotal.inc({ event: 'chatRead' });
    const endTimer = this.wsEventDuration.startTimer({ event: 'chatRead' });
    try {
      const teamId = client.data.teamId;
      const user = client.data.user;

      if (!teamId || !user) {
        this.logger.warn(`읽음 거부: 팀 미참여 소켓 socketId=${client.id}`);
        throw new WsException({
          code: 'CHAT_NOT_JOINED',
          message: '먼저 팀에 참가해야 합니다.',
        });
      }

      const userId = user.userId;

      if (!(await this.teamChatService.consumeRateLimit('read', teamId, userId))) {
        this.logger.warn(`읽음 무시: 레이트 리밋 초과 teamId=${teamId}, userId=${userId}`);
        return;
      }

      let advanced: boolean;
      try {
        advanced = await this.teamChatService.markRead(teamId, userId, dto.lastReadMessageId);
      } catch (error) {
        if (error instanceof TeamForbiddenErrorResponseDto) {
          this.logger.warn(`읽음 거부: 활성 멤버 아님 teamId=${teamId}, userId=${userId}`);
          throw new WsException({
            code: 'CHAT_FORBIDDEN',
            message: '팀 멤버만 읽음 처리할 수 있습니다.',
          });
        }
        throw error;
      }

      if (!advanced) return;

      const payload: ChatReadUpdatedPayload = {
        teamId,
        userId,
        lastReadMessageId: dto.lastReadMessageId,
      };
      // 본인 포함 — 같은 유저의 다른 탭도 배지를 맞춘다
      this.server.to(this.getRoomName(teamId)).emit(TeamSocketEvents.CHAT_READ_UPDATED, payload);
    } finally {
      endTimer();
    }
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

  /**
   * 멤버 가입 브로드캐스트 (초대 수락 — 신규·재가입, D-018)
   */
  emitMemberJoined(teamId: number, payload: MemberJoinedPayload): void {
    this.server.to(this.getRoomName(teamId)).emit(TeamSocketEvents.MEMBER_JOINED, payload);
    this.logger.debug(`멤버 가입 브로드캐스트: teamId=${teamId}, userId=${payload.userId}`);
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
