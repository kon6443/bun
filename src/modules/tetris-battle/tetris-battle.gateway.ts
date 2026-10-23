import { Injectable, Logger, OnModuleDestroy, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { ALLOWED_ORIGINS } from '../../common/constants/cors.constants';
import {
  LIVENESS_PROBE_TIMEOUT_MS,
  LOBBY_BROADCAST_DEBOUNCE_MS,
  LOBBY_ROOM,
  PRESENCE_PING_INTERVAL_MS,
  playerChannel,
  roomChannel,
} from './tetris-battle.constants';
import { TetrisBattleError } from './tetris-battle.errors';
import {
  EmptyAckData,
  EnterRoomAckData,
  KickedPayload,
  ListRoomsAckData,
  LockAckData,
  RoomState,
  SessionReplacedPayload,
  TETRIS_BATTLE_NAMESPACE,
  TetrisBattleAck,
  TetrisBattleClientEvents,
  TetrisBattleServerEvents,
} from './tetris-battle.events';
import {
  ChatDto,
  CreateRoomDto,
  EmoteDto,
  JoinRoomDto,
  KickPlayerDto,
  ListRoomsDto,
  LockDto,
  RematchDto,
  RoomCodeDto,
  SetReadyDto,
  StartMatchDto,
  TopOutDto,
} from './tetris-battle.gateway.dto';
import {
  EnterRoomResult,
  MatchEvents,
  RoomChangeResult,
  SocketIdentity,
  TetrisBattleRoomService,
} from './tetris-battle-room.service';
import { TetrisBattleSocket, TetrisBattleWsGuard } from './tetris-battle-ws.guard';
import { TetrisBattleWsExceptionFilter } from './tetris-battle-ws-exception.filter';

const ok = <T>(data: T): TetrisBattleAck<T> => ({ ok: true, data });

/** promise가 ms 안에 끝나지 않으면 reject (타이머는 어느 쪽이든 정리) */
export const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
const EMPTY: EmptyAckData = {};

/**
 * 테트리스 대전 게이트웨이 — namespace `/tetris-battle` (DESIGN §16, P1: 방·로비·채팅·이모트)
 *
 * - 비로그인 허용: 가드는 신원(userId 또는 게스트)만 정한다
 * - **권한(멤버십)은 매 요청 Redis 방 기록으로 판정한다** — "이 소켓이 그 방 플레이어의 대표 소켓인가".
 *   클라이언트가 보낸 playerId나 소켓에 캐시한 방 정보는 믿지 않는다(playbook 클러스터 1)
 * - 실패는 `TetrisBattleWsExceptionFilter`가 ack `{ ok: false, code, message }`로 돌려준다
 * - socket.io room: 로비 `tetris-battle:lobby`, 방 `tetris-battle:room:{code}` — 멀티 레플리카 브로드캐스트는 Redis 어댑터
 * - **같은 소켓의 상태 변경(create·join·leave·ready·disconnect)은 소켓별 큐로 순서대로 처리한다** — 동시에 보낸 join A/B,
 *   입장 처리 중 끊김이 서로 엇갈려 유령 자리·두 방 동시 소속이 생기지 않게. 큐는 그 소켓 객체에 묶인 로컬 상태라
 *   (WeakMap, 소켓이 사라지면 같이 사라짐) 레플리카 간 공유 상태가 아니다
 * - P2(startMatch·rematch·lock·topOut)는 이 클래스에 핸들러를 더한다
 */
@WebSocketGateway({
  namespace: TETRIS_BATTLE_NAMESPACE,
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
})
@UseFilters(TetrisBattleWsExceptionFilter)
@Injectable()
export class TetrisBattleGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(TetrisBattleGateway.name);

  @WebSocketServer()
  server: Server;

  /** 소켓별 상태 변경 직렬화 큐 — 마지막 작업의 완료(성공·실패 무관) 약속 */
  private readonly socketQueues = new WeakMap<TetrisBattleSocket, Promise<void>>();
  /** presencePing 타이머(D-012) — 이 레플리카의 소켓에만 보낸다. 공유 상태 없음 */
  private presenceTimer: NodeJS.Timeout | null = null;
  /** 예약된 로비 방송(BE-09) — 있으면 새 방송을 예약하지 않는다 */
  private lobbyBroadcastTimer: NodeJS.Timeout | null = null;

  constructor(private readonly roomService: TetrisBattleRoomService) {}

  /** 서비스에 생존 확인 함수·변경 알림을 주입한다(서비스가 socket.io 서버에 직접 의존하지 않게) */
  afterInit(): void {
    this.roomService.setLiveSocketProbe(async (code) => {
      // Redis 어댑터를 통해 전 레플리카의 방 채널 소켓을 모은다.
      // @socket.io/redis-adapter의 fetchSockets는 `.timeout()`을 무시하고 어댑터 requestsTimeout(기본 5초)만 쓴다 —
      // 공용 어댑터 설정을 바꾸지 않고 여기서 자체 타이머로 끊는다(리뷰 G1). 시간 초과면 throw → 이번 확인 건너뜀
      const sockets = await withTimeout(
        this.server.in(roomChannel(code)).fetchSockets(),
        LIVENESS_PROBE_TIMEOUT_MS,
        `생존 확인 ${LIVENESS_PROBE_TIMEOUT_MS}ms 초과`,
      );
      return new Set(sockets.map((s) => s.id));
    });
    this.roomService.setChangeListener((code, room, lobbyChanged) => {
      void this.broadcastChange(code, room, lobbyChanged);
    });
    this.roomService.setMatchListener((code, events) => this.emitMatchEvents(code, events));
    // 하트비트가 끊긴 소켓을 끊는다 — 살아 있으면 클라이언트가 재연결해 토큰으로 복귀한다(D-010).
    // 이 namespace만 끊는다(close=false): 같은 연결을 공유하는 다른 namespace(팀 채팅 등)까지 닫지 않게(리뷰 R1).
    // 서버가 끊으면 클라이언트는 자동 재연결하지 않으므로 사유 "io server disconnect"에서 직접 connect한다(프론트 계약)
    this.roomService.setSocketEvictor((socketIds) => {
      if (socketIds.length > 0) this.server.in(socketIds).disconnectSockets(false);
    });
    this.presenceTimer = setInterval(() => {
      this.server.local.emit(TetrisBattleServerEvents.PRESENCE_PING);
    }, PRESENCE_PING_INTERVAL_MS);
    this.presenceTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    if (this.lobbyBroadcastTimer) clearTimeout(this.lobbyBroadcastTimer);
    this.lobbyBroadcastTimer = null;
  }

  handleDisconnect(client: TetrisBattleSocket): Promise<void> {
    // 큐에 넣어 진행 중인 입장 뒤에 실행 — 입장이 끝난 뒤의 client.data.room을 본다
    return this.serialize(client, () => this.markDisconnected(client));
  }

  private async markDisconnected(client: TetrisBattleSocket): Promise<void> {
    const current = client.data?.room;
    if (!current) return;
    try {
      const change = await this.roomService.markDisconnected(current.code, client.id);
      if (change) await this.broadcastChange(current.code, change.room, change.lobbyChanged);
    } catch (error) {
      // 실패하면 이 플레이어는 connected=true로 남는다 — 생존 확인(reconcileLiveness)이 정리한다
      this.logger.warn(`끊김 처리 실패: code=${current.code}, socket=${client.id}, ${(error as Error).message}`);
    }
  }

  // ==================== 로비 ====================

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.LIST_ROOMS)
  async handleListRooms(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() _dto: ListRoomsDto,
  ): Promise<TetrisBattleAck<ListRoomsAckData>> {
    // 큐에 넣는다 — 입장 처리(로비 구독 해제)와 순서가 엇갈려 방 안의 소켓이 로비를 다시 구독하지 않게(리뷰 G8)
    return this.serialize(client, async () => {
      // 목록 1번이 방 최대 200개 읽기 + 생존 확인이라 연타·반복 송신을 막는다(games-polish BT-02)
      await this.consumeOrThrow('listRoomsSocket', 'listRoomsIp', client);
      const rooms = await this.roomService.listRooms();
      await client.join(LOBBY_ROOM);
      return ok({ rooms });
    });
  }

  // ==================== 방 ====================

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.CREATE_ROOM)
  async handleCreateRoom(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: CreateRoomDto,
  ): Promise<TetrisBattleAck<EnterRoomAckData>> {
    return this.serialize(client, async () => {
      await this.consumeOrThrow('createRoomSocket', 'createRoomIp', client);
      // 이전 방 이탈은 검증을 통과한 뒤, 저장 직전에(리뷰 G6)
      const result = await this.roomService.createRoom(dto, this.identity(client), undefined, () =>
        this.leavePrevious(client, null),
      );
      await this.enter(client, result);
      return ok({ room: result.room, playerId: result.playerId, playerToken: result.playerToken });
    });
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.JOIN_ROOM)
  async handleJoinRoom(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: JoinRoomDto,
  ): Promise<TetrisBattleAck<EnterRoomAckData>> {
    return this.serialize(client, async () => {
      await this.consumeOrThrow('joinRoomSocket', 'joinRoomIp', client);
      // 이전 방 이탈은 새 방 사전 검증(존재·상태·정원·이름·비밀번호)을 통과한 뒤, 저장 직전에(리뷰 G6)
      // 채널 입장(enter)은 커밋 직후·놓친 가비지 조회 전에 서비스가 부른다(리뷰 H2)
      const result = await this.roomService.joinRoom(
        dto,
        this.identity(client),
        undefined,
        () => this.leavePrevious(client, dto.code),
        (entered) => this.enter(client, entered),
      );
      if (result.match) this.emitMatchEvents(result.room.code, result.match);
      return ok({
        room: result.room,
        playerId: result.playerId,
        playerToken: result.playerToken,
        ...(result.rejoin ? { rejoin: result.rejoin } : {}),
      });
    });
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.LEAVE_ROOM)
  async handleLeaveRoom(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: RoomCodeDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      let change: RoomChangeResult;
      try {
        change = await this.roomService.leaveRoom(dto.code, client.id);
      } catch (error) {
        // 이미 방에 없음(NOT_IN_ROOM·ROOM_NOT_FOUND)이면 채널만 정리하고 오류 ack.
        // 커밋 전 실패(ROOM_BUSY·SERVICE_UNAVAILABLE·Redis 오류)면 아직 방 멤버라 채널을 유지한다 — 재시도하면 정상 이탈(리뷰 K1)
        if (error instanceof TetrisBattleError && (error.code === 'NOT_IN_ROOM' || error.code === 'ROOM_NOT_FOUND')) {
          await this.leaveChannels(client, dto.code);
        }
        throw error;
      }
      // 이탈이 커밋됐다 — 서비스가 커밋 뒤 KO 실패를 흡수하므로(J2) 여기까지 오면 항상 채널을 떠난다
      await this.leaveChannels(client, dto.code);
      // 경기 중 이탈(기권 KO)·그로 인한 종료를 roomState보다 먼저
      if (change.match) this.emitMatchEvents(dto.code, change.match);
      await this.broadcastChange(dto.code, change.room, change.lobbyChanged);
      return ok(EMPTY);
    });
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.KICK_PLAYER)
  async handleKickPlayer(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: KickPlayerDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const result = await this.roomService.kickPlayer(dto.code, client.id, dto.playerId);
      if (result.kickedSocketId) {
        // 다른 레플리카 소켓이어도 어댑터가 전달한다. 그 소켓의 client.data.room은 남지만 이후 요청은 NOT_IN_ROOM으로 끝난다
        this.server.in(result.kickedSocketId).socketsLeave([roomChannel(dto.code), playerChannel(dto.code, dto.playerId)]);
        const kicked: KickedPayload = { code: dto.code };
        this.server.to(result.kickedSocketId).emit(TetrisBattleServerEvents.KICKED, kicked);
      }
      await this.broadcastChange(dto.code, result.room, result.lobbyChanged);
      return ok(EMPTY);
    });
  }

  /**
   * presencePing 응답(D-010·D-012) — ack 없음, 큐에 넣지 않는다(입장 처리에 밀려 늦게 기록되지 않게).
   * 이 소켓이 그 방에 들어가 있을 때만 기록한다(멤버십 판정은 하트비트 판정이 방 기록의 socketId로 다시 한다)
   */
  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.HEARTBEAT)
  async handleHeartbeat(@ConnectedSocket() client: TetrisBattleSocket, @MessageBody() dto: RoomCodeDto): Promise<void> {
    const current = client.data.room;
    if (current?.code !== dto.code) return;
    await this.roomService.recordHeartbeat(current.code, client.id);
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.SET_READY)
  async handleSetReady(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: SetReadyDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const change = await this.roomService.setReady(dto.code, client.id, dto.ready);
      await this.broadcastChange(dto.code, change.room, change.lobbyChanged);
      return ok(EMPTY);
    });
  }

  // ==================== 매치 (P2) ====================

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.START_MATCH)
  async handleStartMatch(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: StartMatchDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const result = await this.roomService.startMatch(dto.code, client.id);
      this.server.to(roomChannel(dto.code)).emit(TetrisBattleServerEvents.MATCH_STARTING, result.starting);
      await this.broadcastChange(dto.code, result.room, result.lobbyChanged);
      return ok(EMPTY);
    });
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.REMATCH)
  async handleRematch(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: RematchDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const change = await this.roomService.rematch(dto.code, client.id);
      await this.broadcastChange(dto.code, change.room, change.lobbyChanged);
      return ok(EMPTY);
    });
  }

  /**
   * 블록 고정 — 고빈도(플레이어당 초당 1~3회). 큐 안에서는 서비스 처리(Redis 읽기 1 + Lua 1)만 기다리고
   * 방송은 기다리지 않는다(로비 목록 재조회 등이 다음 lock을 늦추지 않게).
   * 방 코드는 페이로드에 없어 이 소켓이 들어간 방(client.data.room)을 쓰고, 권한은 서비스가 Redis로 다시 확인한다.
   */
  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.LOCK)
  async handleLock(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: LockDto,
  ): Promise<TetrisBattleAck<LockAckData>> {
    return this.serialize(client, async () => {
      const code = this.currentRoomCode(client);
      const out = await this.roomService.lock(code, client.id, dto);
      const channel = roomChannel(code);
      if (out.garbage) {
        // 대상 플레이어 채널 — 지금 그 플레이어를 대표하는 소켓(재연결 직후 포함)이 받는다(리뷰 H2)
        this.server.to(playerChannel(code, out.garbage.toPlayerId)).emit(TetrisBattleServerEvents.GARBAGE, out.garbage.payload);
      }
      if (out.attack) this.server.to(channel).emit(TetrisBattleServerEvents.ATTACK, out.attack);
      if (out.opponentUpdate) client.to(channel).emit(TetrisBattleServerEvents.OPPONENT_UPDATE, out.opponentUpdate);
      this.emitMatchEvents(code, out.match);
      this.broadcastRoomChangeInBackground(code, out.roomChange);
      return ok({ targetId: out.targetId });
    });
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.TOP_OUT)
  async handleTopOut(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: TopOutDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const code = this.currentRoomCode(client);
      const out = await this.roomService.topOut(code, client.id, dto);
      this.emitMatchEvents(code, out.match);
      this.broadcastRoomChangeInBackground(code, out.roomChange);
      return ok(EMPTY);
    });
  }

  // ==================== 채팅·이모트 ====================

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.CHAT)
  async handleChat(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: ChatDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    const payload = await this.roomService.prepareChat(dto.code, client.id, dto.text);
    // 보낸 사람 포함 — 화면에 서버가 확정한 메시지만 그린다
    this.server.to(roomChannel(dto.code)).emit(TetrisBattleServerEvents.CHAT_MESSAGE, payload);
    return ok(EMPTY);
  }

  @UseGuards(TetrisBattleWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(TetrisBattleClientEvents.EMOTE)
  async handleEmote(
    @ConnectedSocket() client: TetrisBattleSocket,
    @MessageBody() dto: EmoteDto,
  ): Promise<TetrisBattleAck<EmptyAckData>> {
    const payload = await this.roomService.prepareEmote(dto.code, client.id, dto.emoteId);
    this.server.to(roomChannel(dto.code)).emit(TetrisBattleServerEvents.EMOTE_RECEIVED, payload);
    return ok(EMPTY);
  }

  // ==================== 내부 ====================

  /** 방·플레이어 채널을 떠나고, 그 방이 이 소켓의 현재 방이면 소켓 캐시도 비운다 */
  private async leaveChannels(client: TetrisBattleSocket, code: string): Promise<void> {
    await client.leave(roomChannel(code));
    if (client.data.room?.code === code) {
      await client.leave(playerChannel(code, client.data.room.playerId));
      delete client.data.room;
    }
  }

  private currentRoomCode(client: TetrisBattleSocket): string {
    const code = client.data.room?.code;
    if (!code) throw new TetrisBattleError('NOT_IN_ROOM');
    return code;
  }

  /** KO(발생 순) → 종료 순서로 방에 보낸다 */
  private emitMatchEvents(code: string, events: MatchEvents): void {
    const channel = roomChannel(code);
    for (const ko of events.kos) this.server.to(channel).emit(TetrisBattleServerEvents.PLAYER_KO, ko);
    if (events.ended) this.server.to(channel).emit(TetrisBattleServerEvents.MATCH_ENDED, events.ended);
  }

  private broadcastRoomChangeInBackground(code: string, change: RoomChangeResult | null): void {
    if (!change) return;
    void this.broadcastChange(code, change.room, change.lobbyChanged);
  }

  /**
   * 같은 소켓의 작업을 도착 순서대로 하나씩 실행한다. 앞 작업이 실패해도 다음 작업은 실행된다.
   * 반환값·예외는 그 작업의 것 그대로(예외는 필터가 ack로 바꾼다).
   */
  private serialize<T>(client: TetrisBattleSocket, task: () => Promise<T>): Promise<T> {
    const previous = this.socketQueues.get(client) ?? Promise.resolve();
    const run = previous.then(task);
    this.socketQueues.set(
      client,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async consumeOrThrow(
    socketAction: 'createRoomSocket' | 'joinRoomSocket' | 'listRoomsSocket',
    ipAction: 'createRoomIp' | 'joinRoomIp' | 'listRoomsIp',
    client: TetrisBattleSocket,
  ): Promise<void> {
    const allowed =
      (await this.roomService.consumeRateLimit(socketAction, client.id)) &&
      (await this.roomService.consumeRateLimit(ipAction, this.identity(client).ip));
    if (!allowed) throw new TetrisBattleError('RATE_LIMITED');
  }

  private identity(client: TetrisBattleSocket): SocketIdentity {
    return { socketId: client.id, userId: client.data.userId ?? null, ip: this.clientIp(client) };
  }

  /**
   * 입장 커밋 후 소켓 정리: 로비 구독 해제, 방 채널 입장, 재연결로 넘겨받은 이전 소켓을 방 채널에서 뺀다
   * (다른 레플리카 소켓이어도 어댑터가 전달). 여기서부터는 실패할 수 있는 단계가 없다 — 커밋 후 오류 ack 갈래를 남기지 않는다.
   * 처리 중 소켓이 이미 끊겼으면(가드 대기 중 끊김 등) 바로 끊김으로 표시해 유령 자리를 남기지 않는다.
   */
  private async enter(client: TetrisBattleSocket, result: EnterRoomResult): Promise<void> {
    const code = result.room.code;
    client.data.room = { code, playerId: result.playerId };
    if (result.replacedSocketId) {
      this.server.in(result.replacedSocketId).socketsLeave([roomChannel(code), playerChannel(code, result.playerId)]);
      // 넘겨받힌 쪽(다른 탭·기기)이 멈춘 화면으로 남지 않고, 저장된 토큰으로 되찾으려 하지 않게 알린다(tetris-audit D-007)
      const replaced: SessionReplacedPayload = { code };
      this.server.to(result.replacedSocketId).emit(TetrisBattleServerEvents.SESSION_REPLACED, replaced);
    }

    // 끊긴 소켓은 어댑터 room에 넣지 않는다(리뷰 G2) — 입장 결과를 방송한 뒤 바로 끊김으로 표시
    if (client.disconnected) {
      await this.broadcastChange(code, result.room, result.lobbyChanged);
      await this.markDisconnected(client);
      return;
    }

    await client.leave(LOBBY_ROOM);
    await client.join([roomChannel(code), playerChannel(code, result.playerId)]);
    await this.broadcastChange(code, result.room, result.lobbyChanged);
  }

  /**
   * 한 소켓은 한 방에만 — 다른 방에 들어가기 **전에** 이전 방을 이탈한다(새 방 커밋 후 실패 갈래를 없애기 위해).
   * 이전 방이 이미 없거나(ROOM_NOT_FOUND) 이미 멤버가 아니면(NOT_IN_ROOM) 무시, 그 외 오류는 새 입장을 중단한다.
   * nextCode가 이전 방과 같으면(같은 방 재입장) 아무것도 하지 않는다.
   */
  private async leavePrevious(client: TetrisBattleSocket, nextCode: string | null): Promise<void> {
    const previous = client.data.room;
    if (!previous || previous.code === nextCode) return;
    try {
      const change = await this.roomService.leaveRoom(previous.code, client.id);
      if (change.match) this.emitMatchEvents(previous.code, change.match);
      await this.broadcastChange(previous.code, change.room, change.lobbyChanged);
    } catch (error) {
      if (!(error instanceof TetrisBattleError && (error.code === 'ROOM_NOT_FOUND' || error.code === 'NOT_IN_ROOM'))) {
        throw error;
      }
    }
    await client.leave(roomChannel(previous.code));
    await client.leave(playerChannel(previous.code, previous.playerId));
    delete client.data.room;
  }

  private async broadcastChange(code: string, room: RoomState | null, lobbyChanged: boolean): Promise<void> {
    if (room) this.server.to(roomChannel(code)).emit(TetrisBattleServerEvents.ROOM_STATE, room);
    if (lobbyChanged) this.broadcastLobby();
  }

  /**
   * 로비 구독자에게 목록 전체. 실패해도 요청 자체는 성공시킨다(다음 변경·재조회로 회복).
   * 레플리카당 LOBBY_BROADCAST_DEBOUNCE_MS에 1번으로 묶는다(tetris-audit BE-09) — 방 변경마다 방 200개를 다시 읽지 않게.
   * 묶는 동안 생긴 변경은 끝에 만드는 목록에 모두 들어간다. 다른 레플리카의 변경은 그 레플리카가 따로 방송한다(지금과 같음)
   */
  private broadcastLobby(): void {
    if (this.lobbyBroadcastTimer) return;
    this.lobbyBroadcastTimer = setTimeout(() => {
      this.lobbyBroadcastTimer = null;
      void this.emitLobby();
    }, LOBBY_BROADCAST_DEBOUNCE_MS);
    this.lobbyBroadcastTimer.unref();
  }

  private async emitLobby(): Promise<void> {
    try {
      const rooms = await this.roomService.listRooms(undefined, { reconcile: false });
      this.server.to(LOBBY_ROOM).emit(TetrisBattleServerEvents.ROOMS_CHANGED, { rooms });
    } catch (error) {
      this.logger.warn(`로비 목록 브로드캐스트 실패: ${(error as Error).message}`);
    }
  }

  /**
   * 빈도 제한용 IP — `trust proxy 1`(main.ts)과 같은 기준: X-Forwarded-For의 **마지막** 값(바로 앞 프록시가 붙인 값).
   * 첫 값은 요청자가 위조할 수 있어 쓰지 않는다(api-http.md 스로틀 절).
   */
  private clientIp(client: TetrisBattleSocket): string {
    const xff = client.handshake.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const last = raw?.split(',').pop()?.trim();
    return last || client.handshake.address || 'unknown';
  }
}
