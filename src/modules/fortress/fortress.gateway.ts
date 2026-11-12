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
  HEARTBEAT_MIN_INTERVAL_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  LOBBY_BROADCAST_DEBOUNCE_MS,
  LOBBY_CHAT_ROOM,
  LOBBY_ROOM,
  PRESENCE_PING_INTERVAL_MS,
  roomChannel,
} from './fortress.constants';
import { FortressError } from './fortress.errors';
import {
  EmptyAckData,
  EnterRoomAckData,
  FORTRESS_NAMESPACE,
  FortressAck,
  FortressClientEvents,
  FortressServerEvents,
  JoinLobbyChatAckData,
  KickedPayload,
  LobbyChatAckData,
  ListRoomsAckData,
  MatchSnapshot,
  RoomState,
  SessionReplacedPayload,
} from './fortress.events';
import {
  ChatDto,
  CreateRoomDto,
  EmoteDto,
  JoinRoomDto,
  KickPlayerDto,
  ListRoomsDto,
  LobbyChatDto,
  RematchDto,
  ResyncDto,
  RoomCodeDto,
  SetReadyDto,
  SetTankDto,
  SetTeamDto,
  StartMatchDto,
  TurnSubmitDto,
  UpdateSettingsDto,
} from './fortress.gateway.dto';
import { FortressLobbyChatService } from './fortress-lobby-chat.service';
import { FortressMatchService, MatchBroadcast } from './fortress-match.service';
import { EnterRoomResult, FortressRoomService, RoomChangeResult, SocketIdentity } from './fortress-room.service';
import { FortressSkinService } from './fortress-skin.service';
import { FortressSocket, FortressWsGuard } from './fortress-ws.guard';
import { FortressWsExceptionFilter } from './fortress-ws-exception.filter';

const ok = <T>(data: T): FortressAck<T> => ({ ok: true, data });
const EMPTY: EmptyAckData = {};

/** promise가 ms 안에 끝나지 않으면 reject (타이머는 어느 쪽이든 정리) */
const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * 포트리스 게이트웨이 — namespace `/fortress` (DESIGN §11). 테트리스 대전 게이트웨이와 같은 구조:
 *
 * - 비로그인 허용: 가드는 신원(userId 또는 게스트)만 정한다
 * - **권한(멤버십)은 매 요청 Redis 방 기록으로 판정한다**(playbook 클러스터 1) — 서비스에 넘기는 신원은 소켓 id뿐
 * - 실패는 `FortressWsExceptionFilter`가 ack `{ ok: false, code, message }`로 돌려준다(ack 없으면 `error` 이벤트)
 * - socket.io room: 로비 `fortress:lobby`, 방 `fortress:room:{code}` — 멀티 레플리카 브로드캐스트는 Redis 어댑터
 * - 같은 소켓의 상태 변경은 소켓별 큐로 순서대로(WeakMap, 소켓 로컬 — 레플리카 공유 상태 아님)
 * - 경기 이벤트(turnResolved·matchEnded)는 경기 서비스가 CAS를 이긴 쪽에서 리스너로 알린다 — 요청 경로·타이머·스위퍼 모두 같은 길
 */
@WebSocketGateway({
  namespace: FORTRESS_NAMESPACE,
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
})
@UseFilters(FortressWsExceptionFilter)
@Injectable()
export class FortressGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(FortressGateway.name);

  @WebSocketServer()
  server: Server;

  private readonly socketQueues = new WeakMap<FortressSocket, Promise<void>>();
  private presenceTimer: NodeJS.Timeout | null = null;
  private lobbyBroadcastTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly roomService: FortressRoomService,
    private readonly matchService: FortressMatchService,
    private readonly lobbyChatService: FortressLobbyChatService,
    private readonly skinService: FortressSkinService,
  ) {}

  /** 서비스에 생존 확인 함수·변경 알림을 주입한다(서비스가 socket.io 서버에 직접 의존하지 않게) */
  afterInit(): void {
    this.roomService.setLiveSocketProbe(async (code) => {
      const sockets = await withTimeout(
        this.server.in(roomChannel(code)).fetchSockets(),
        LIVENESS_PROBE_TIMEOUT_MS,
        `생존 확인 ${LIVENESS_PROBE_TIMEOUT_MS}ms 초과`,
      );
      return new Set(sockets.map((s) => s.id));
    });
    this.roomService.setChangeListener((code, room, lobbyChanged) => this.broadcastChange(code, room, lobbyChanged));
    this.matchService.setBroadcastListener((code, broadcast) => this.emitMatch(code, broadcast));
    // 하트비트가 끊긴 소켓을 끊는다 — 이 namespace만(close=false)
    this.roomService.setSocketEvictor((socketIds) => {
      if (socketIds.length > 0) this.server.in(socketIds).disconnectSockets(false);
    });
    this.presenceTimer = setInterval(() => {
      this.server.local.emit(FortressServerEvents.PRESENCE_PING);
    }, PRESENCE_PING_INTERVAL_MS);
    this.presenceTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    if (this.lobbyBroadcastTimer) clearTimeout(this.lobbyBroadcastTimer);
    this.lobbyBroadcastTimer = null;
  }

  handleDisconnect(client: FortressSocket): Promise<void> {
    return this.serialize(client, () => this.markDisconnected(client));
  }

  private async markDisconnected(client: FortressSocket): Promise<void> {
    const current = client.data?.room;
    if (!current) return;
    try {
      const change = await this.roomService.markDisconnected(current.code, client.id);
      if (change) this.broadcastChange(current.code, change.room, change.lobbyChanged);
    } catch (error) {
      // 실패하면 이 플레이어는 connected=true로 남는다 — 생존 확인이 정리한다
      this.logger.warn(`끊김 처리 실패: code=${current.code}, socket=${client.id}, ${(error as Error).message}`);
    }
  }

  // ==================== 로비 ====================

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.LIST_ROOMS)
  async handleListRooms(@ConnectedSocket() client: FortressSocket, @MessageBody() _dto: ListRoomsDto): Promise<FortressAck<ListRoomsAckData>> {
    return this.serialize(client, async () => {
      await this.consumeOrThrow('listRoomsSocket', 'listRoomsIp', client);
      const rooms = await this.roomService.listRooms();
      await client.join(LOBBY_ROOM);
      return ok({ rooms });
    });
  }

  // ==================== 방 ====================

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.CREATE_ROOM)
  async handleCreateRoom(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: CreateRoomDto): Promise<FortressAck<EnterRoomAckData>> {
    return this.serialize(client, async () => {
      await this.consumeOrThrow('createRoomSocket', 'createRoomIp', client);
      const result = await this.roomService.createRoom(dto, await this.enterIdentity(client), undefined, () => this.leavePrevious(client, null));
      await this.enter(client, result);
      return ok({ room: result.room, playerId: result.playerId, playerToken: result.playerToken });
    });
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.JOIN_ROOM)
  async handleJoinRoom(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: JoinRoomDto): Promise<FortressAck<EnterRoomAckData>> {
    return this.serialize(client, async () => {
      await this.consumeOrThrow('joinRoomSocket', 'joinRoomIp', client);
      const result = await this.roomService.joinRoom(
        dto,
        await this.enterIdentity(client),
        undefined,
        () => this.leavePrevious(client, dto.code),
        (entered) => this.enter(client, entered),
      );
      return ok({
        room: result.room,
        playerId: result.playerId,
        playerToken: result.playerToken,
        ...(result.rejoin ? { rejoin: result.rejoin } : {}),
      });
    });
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.LEAVE_ROOM)
  async handleLeaveRoom(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: RoomCodeDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      let change: RoomChangeResult;
      try {
        change = await this.roomService.leaveRoom(dto.code, client.id);
      } catch (error) {
        // 이미 방에 없음이면 채널만 정리하고 오류 ack. 커밋 전 실패(ROOM_BUSY 등)면 아직 멤버라 채널을 유지한다
        if (error instanceof FortressError && (error.code === 'NOT_IN_ROOM' || error.code === 'ROOM_NOT_FOUND')) {
          await this.leaveChannels(client, dto.code);
        }
        throw error;
      }
      await this.leaveChannels(client, dto.code);
      this.broadcastChange(dto.code, change.room, change.lobbyChanged);
      return ok(EMPTY);
    });
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.KICK_PLAYER)
  async handleKickPlayer(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: KickPlayerDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const result = await this.roomService.kickPlayer(dto.code, client.id, dto.playerId);
      if (result.kickedSocketId) {
        this.server.in(result.kickedSocketId).socketsLeave(roomChannel(dto.code));
        const kicked: KickedPayload = { code: dto.code };
        this.server.to(result.kickedSocketId).emit(FortressServerEvents.KICKED, kicked);
      }
      this.broadcastChange(dto.code, result.room, result.lobbyChanged);
      return ok(EMPTY);
    });
  }

  /** presencePing 응답 — ack 없음, 큐에 넣지 않는다. 이 소켓이 그 방에 들어가 있을 때만 기록 */
  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.HEARTBEAT)
  async handleHeartbeat(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: RoomCodeDto): Promise<void> {
    const current = client.data.room;
    if (current?.code !== dto.code) return;
    const now = Date.now();
    const last = client.data.lastHeartbeatAt;
    if (last !== undefined && now - last < HEARTBEAT_MIN_INTERVAL_MS) return;
    client.data.lastHeartbeatAt = now;
    await this.roomService.recordHeartbeat(current.code, client.id);
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.SET_READY)
  async handleSetReady(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: SetReadyDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => this.applyChange(dto.code, await this.roomService.setReady(dto.code, client.id, dto.ready)));
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.UPDATE_SETTINGS)
  async handleUpdateSettings(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: UpdateSettingsDto): Promise<FortressAck<EmptyAckData>> {
    const { code, mode, mapId, maxPlayers } = dto;
    const patch = { ...(mode !== undefined ? { mode } : {}), ...(mapId !== undefined ? { mapId } : {}), ...(maxPlayers !== undefined ? { maxPlayers } : {}) };
    return this.serialize(client, async () => this.applyChange(code, await this.roomService.updateSettings(code, client.id, patch)));
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.SET_TEAM)
  async handleSetTeam(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: SetTeamDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => this.applyChange(dto.code, await this.roomService.setTeam(dto.code, client.id, dto.team)));
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.SET_TANK)
  async handleSetTank(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: SetTankDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => this.applyChange(dto.code, await this.roomService.setTank(dto.code, client.id, dto.tankId)));
  }

  // ==================== 경기 ====================

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.START_MATCH)
  async handleStartMatch(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: StartMatchDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      const result = await this.roomService.startMatch(dto.code, client.id);
      this.server.to(roomChannel(dto.code)).emit(FortressServerEvents.MATCH_STARTING, result.starting);
      this.broadcastChange(dto.code, result.room, result.lobbyChanged);
      return ok(EMPTY);
    });
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.REMATCH)
  async handleRematch(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: RematchDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => this.applyChange(dto.code, await this.roomService.rematch(dto.code, client.id)));
  }

  /** 턴 제출 — 방 코드는 이 소켓이 들어간 방. 판정·방송(turnResolved·matchEnded)은 경기 서비스, ack는 `{}` */
  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.TURN_SUBMIT)
  async handleTurnSubmit(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: TurnSubmitDto): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      await this.roomService.turnSubmit(this.currentRoomCode(client), client.id, dto);
      return ok(EMPTY);
    });
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.RESYNC)
  async handleResync(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: ResyncDto): Promise<FortressAck<MatchSnapshot>> {
    return this.serialize(client, async () => ok(await this.roomService.resync(this.currentRoomCode(client), client.id, dto)));
  }

  // ==================== 채팅·이모트 ====================

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.CHAT)
  async handleChat(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: ChatDto): Promise<FortressAck<EmptyAckData>> {
    const payload = await this.roomService.prepareChat(dto.code, client.id, dto.text);
    this.server.to(roomChannel(dto.code)).emit(FortressServerEvents.CHAT_MESSAGE, payload);
    return ok(EMPTY);
  }

  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.EMOTE)
  async handleEmote(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: EmoteDto): Promise<FortressAck<EmptyAckData>> {
    const payload = await this.roomService.prepareEmote(dto.code, client.id, dto.emoteId);
    this.server.to(roomChannel(dto.code)).emit(FortressServerEvents.EMOTE_RECEIVED, payload);
    return ok(EMPTY);
  }

  // ==================== 로비 전체 채팅 (D-016 — 테트리스 대전 로비 채팅과 같은 규칙) ====================

  /**
   * 구독 — 보낸 사람 표시를 정해 소켓에 두고(메시지마다 DB를 읽지 않게) 채널에 넣은 뒤 최근 대화·참여 수를 돌려준다.
   * 누구나 들어올 수 있다(게스트 포함). 재연결하면 클라이언트가 다시 보낸다
   */
  @UseGuards(FortressWsGuard)
  @SubscribeMessage(FortressClientEvents.JOIN_LOBBY_CHAT)
  handleJoinLobbyChat(@ConnectedSocket() client: FortressSocket): Promise<FortressAck<JoinLobbyChatAckData>> {
    // 같은 소켓의 join·leave·보내기는 도착 순서대로 — 겹치면 클라이언트는 나갔는데 서버는 구독 상태로 남는다(방 입장과 같은 큐)
    return this.serialize(client, () => this.joinLobbyChat(client));
  }

  private async joinLobbyChat(client: FortressSocket): Promise<FortressAck<JoinLobbyChatAckData>> {
    const allowed =
      (await this.roomService.consumeRateLimit('lobbyChatJoin', client.id)) &&
      (await this.roomService.consumeRateLimit('lobbyChatJoinIp', this.identity(client).ip));
    if (!allowed) throw new FortressError('RATE_LIMITED');
    const me = await this.lobbyChatService.senderOf(client.data.userId ?? null);
    // 기다리는 동안 끊겼으면 넣지 않는다 — join()은 연결 상태를 보지 않아, 끊김 정리(leaveAll)가 끝난 뒤 넣으면 어댑터에 영구히 남는다
    if (client.disconnected) throw new FortressError('LOBBY_CHAT_NOT_JOINED');
    client.data.lobbyChat = me;
    // 채널에 먼저 들어간 뒤 최근 대화를 읽는다 — 반대 순서면 그 사이 다른 레플리카가 보낸 메시지를 둘 다에서 놓친다(겹치면 id로 거른다)
    await client.join(LOBBY_CHAT_ROOM);
    let messages: JoinLobbyChatAckData['messages'];
    try {
      messages = await this.lobbyChatService.recent();
    } catch (error) {
      // 구독 실패로 돌려주므로 채널에 남기지 않는다
      delete client.data.lobbyChat;
      await client.leave(LOBBY_CHAT_ROOM);
      throw error;
    }
    const { userId, ip } = this.identity(client);
    return ok({ messages, onlineCount: await this.countLobbyChat(), me: { ...me, senderKey: this.lobbyChatService.senderKeyOf(userId, ip) } });
  }

  @UseGuards(FortressWsGuard)
  @SubscribeMessage(FortressClientEvents.LEAVE_LOBBY_CHAT)
  handleLeaveLobbyChat(@ConnectedSocket() client: FortressSocket): Promise<FortressAck<EmptyAckData>> {
    return this.serialize(client, async () => {
      delete client.data.lobbyChat;
      await client.leave(LOBBY_CHAT_ROOM);
      return ok(EMPTY);
    });
  }

  /** 보내기 — 구독한 소켓만. 서버가 확정한 메시지를 보낸 사람 포함 구독자 전원에게 방송하고 ack로도 돌려준다 */
  @UseGuards(FortressWsGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(FortressClientEvents.LOBBY_CHAT)
  handleLobbyChat(@ConnectedSocket() client: FortressSocket, @MessageBody() dto: LobbyChatDto): Promise<FortressAck<LobbyChatAckData>> {
    // join 직후 바로 보내도 join이 끝난 뒤 판정하도록 같은 큐로
    return this.serialize(client, async () => {
      const sender = client.data.lobbyChat;
      if (!sender || !client.rooms.has(LOBBY_CHAT_ROOM)) throw new FortressError('LOBBY_CHAT_NOT_JOINED');
      const { userId, ip } = this.identity(client);
      const message = await this.lobbyChatService.publish({ sender, userId, ip, name: dto.name, text: dto.text });
      this.server.to(LOBBY_CHAT_ROOM).emit(FortressServerEvents.LOBBY_CHAT_MESSAGE, message);
      return ok({ message });
    });
  }

  /** 로비 채팅 참여 소켓 수(전 레플리카) — 어댑터 조회가 늦거나 실패하면 null(구독은 성공시킨다) */
  private async countLobbyChat(): Promise<number | null> {
    try {
      const sockets = await withTimeout(
        this.server.in(LOBBY_CHAT_ROOM).fetchSockets(),
        LIVENESS_PROBE_TIMEOUT_MS,
        `로비 채팅 참여 수 ${LIVENESS_PROBE_TIMEOUT_MS}ms 초과`,
      );
      return sockets.length;
    } catch (error) {
      this.logger.warn(`countLobbyChat(): ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ==================== 내부 ====================

  private applyChange(code: string, change: RoomChangeResult): FortressAck<EmptyAckData> {
    this.broadcastChange(code, change.room, change.lobbyChanged);
    return ok(EMPTY);
  }

  private emitMatch(code: string, broadcast: MatchBroadcast): void {
    const event = broadcast.event === 'turnResolved' ? FortressServerEvents.TURN_RESOLVED : FortressServerEvents.MATCH_ENDED;
    this.server.to(roomChannel(code)).emit(event, broadcast.payload);
  }

  private async leaveChannels(client: FortressSocket, code: string): Promise<void> {
    await client.leave(roomChannel(code));
    if (client.data.room?.code === code) delete client.data.room;
  }

  private currentRoomCode(client: FortressSocket): string {
    const code = client.data.room?.code;
    if (!code) throw new FortressError('NOT_IN_ROOM');
    return code;
  }

  /** 같은 소켓의 작업을 도착 순서대로 하나씩. 앞 작업이 실패해도 다음 작업은 실행된다 */
  private serialize<T>(client: FortressSocket, task: () => Promise<T>): Promise<T> {
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
    client: FortressSocket,
  ): Promise<void> {
    const allowed =
      (await this.roomService.consumeRateLimit(socketAction, client.id)) &&
      (await this.roomService.consumeRateLimit(ipAction, this.identity(client).ip));
    if (!allowed) throw new FortressError('RATE_LIMITED');
  }

  private identity(client: FortressSocket): SocketIdentity {
    return { socketId: client.id, userId: client.data.userId ?? null, ip: this.clientIp(client) };
  }

  /**
   * 입장(create·join)용 신원 — 계정 장착 탱크 스킨을 붙인다(F7, DESIGN §13). 클라이언트가 보낸 값은 받지 않는다(게스트는 조회 없이 default).
   * 조회가 실패해도 입장은 막지 않는다 — 새 자리는 default, 기존 자리는 이전 스킨으로 들어가고 다음 입장 때 다시 읽는다(테트리스 enterIdentity와 같다)
   */
  private async enterIdentity(client: FortressSocket): Promise<SocketIdentity> {
    const who = this.identity(client);
    if (who.userId === null) return who;
    try {
      return { ...who, skin: await this.skinService.tankSkinOf(who.userId) };
    } catch (error) {
      this.logger.warn(`enterIdentity(): 탱크 스킨 조회 실패 — 스킨 없이 입장 (${error instanceof Error ? error.message : String(error)})`);
      return who;
    }
  }

  /**
   * 입장 커밋 후 소켓 정리: 로비 구독 해제, 방 채널 입장, 넘겨받은 이전 소켓을 방 채널에서 빼고 sessionReplaced.
   * 처리 중 소켓이 이미 끊겼으면 채널에 넣지 않고 바로 끊김으로 표시한다(유령 자리 방지)
   */
  private async enter(client: FortressSocket, result: EnterRoomResult): Promise<void> {
    const code = result.room.code;
    client.data.room = { code, playerId: result.playerId };
    if (result.replacedSocketId) {
      this.server.in(result.replacedSocketId).socketsLeave(roomChannel(code));
      const replaced: SessionReplacedPayload = { code };
      this.server.to(result.replacedSocketId).emit(FortressServerEvents.SESSION_REPLACED, replaced);
    }
    if (client.disconnected) {
      this.broadcastChange(code, result.room, result.lobbyChanged);
      await this.markDisconnected(client);
      return;
    }
    await client.leave(LOBBY_ROOM);
    await client.join(roomChannel(code));
    this.broadcastChange(code, result.room, result.lobbyChanged);
  }

  /** 한 소켓은 한 방에만 — 다른 방에 들어가기 전에 이전 방을 이탈한다(없음·멤버 아님은 무시) */
  private async leavePrevious(client: FortressSocket, nextCode: string | null): Promise<void> {
    const previous = client.data.room;
    if (!previous || previous.code === nextCode) return;
    try {
      const change = await this.roomService.leaveRoom(previous.code, client.id);
      this.broadcastChange(previous.code, change.room, change.lobbyChanged);
    } catch (error) {
      if (!(error instanceof FortressError && (error.code === 'ROOM_NOT_FOUND' || error.code === 'NOT_IN_ROOM'))) throw error;
    }
    await client.leave(roomChannel(previous.code));
    delete client.data.room;
  }

  private broadcastChange(code: string, room: RoomState | null, lobbyChanged: boolean): void {
    if (room) this.server.to(roomChannel(code)).emit(FortressServerEvents.ROOM_STATE, room);
    if (lobbyChanged) this.broadcastLobby();
  }

  /** 로비 구독자에게 목록 전체 — 레플리카당 LOBBY_BROADCAST_DEBOUNCE_MS에 1번으로 묶는다 */
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
      this.server.to(LOBBY_ROOM).emit(FortressServerEvents.ROOMS_CHANGED, { rooms });
    } catch (error) {
      this.logger.warn(`로비 목록 브로드캐스트 실패: ${(error as Error).message}`);
    }
  }

  /** 빈도 제한용 IP — X-Forwarded-For의 **마지막** 값(main.ts `trust proxy 1`과 같은 기준, 첫 값은 위조 가능) */
  private clientIp(client: FortressSocket): string {
    const xff = client.handshake.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const last = raw?.split(',').pop()?.trim();
    return last || client.handshake.address || 'unknown';
  }
}
