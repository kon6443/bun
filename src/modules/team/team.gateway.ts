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
} from './team.events';

/**
 * CORS 허용 Origin 목록
 */
const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:3500',
  'http://127.0.0.1:3000',
  'https://fivesouth.duckdns.org',
];

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

    this.logger.log(`팀 참가 완료: teamId=${teamId}, userId=${userId}, room=${roomName}`);

    return { teamId, room: roomName };
  }

  /**
   * 팀 room 퇴장
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
}
