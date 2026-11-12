import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  type Action,
  type MatchConfig,
  ENGINE_VERSION,
  applyAction,
  createMatch,
  eventsEndTick,
  stateHash,
} from './engine';
import { computePlaces, createTally, tallyAction, turnDurationMs } from './fortress-match.rules';
import { FortressMatchStore, LoadedMatch, StoredMatch } from './fortress-match.store';
import {
  MATCH_CAS_MAX_ATTEMPTS,
  MATCH_DISCONNECT_GRACE_MS,
  MATCH_START_DELAY_MS,
  SERVER_ACTION_MAX_PER_WAKE,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  WAKE_MARGIN_MS,
} from './fortress.constants';
import { storedTankSkin } from './fortress-skins';
import { FortressError } from './fortress.errors';
import {
  FortressTankSkin,
  MatchEndedPayload,
  MatchResultEntry,
  MatchSlot,
  MatchSnapshot,
  TurnCause,
  TurnInfo,
  TurnResolvedPayload,
} from './fortress.events';

/** 경기 이벤트 — 게이트웨이가 방 채널로 그대로 보낸다 */
export type MatchBroadcast =
  | { event: 'turnResolved'; payload: TurnResolvedPayload }
  | { event: 'matchEnded'; payload: MatchEndedPayload };

export type MatchBroadcastListener = (code: string, broadcast: MatchBroadcast) => void;
/** 경기가 끝난 직후 한 번 — 방 서비스가 방을 RESULT로 바꾼다. 던지지 않아야 한다 */
export type MatchEndedHook = (code: string, matchId: string) => Promise<void>;
/** 경기가 끝난 직후 한 번(방송 뒤) — 결과 서비스가 DB에 저장한다(F6). 기다리지 않는다 */
export type MatchSaveHook = (matchId: string) => Promise<void>;

/** 경기 생성 입력 — slots는 계약 MatchSlot + 서버만 아는 userId(결과 저장용, 방송하지 않는다). skin이 없으면 내보낼 때 default */
export interface CreateMatchInput {
  matchId: string;
  code: string;
  roomName: string;
  config: MatchConfig;
  slots: (Omit<MatchSlot, 'skin'> & { userId: number | null; skin?: FortressTankSkin })[];
}

export interface TurnSubmitInput {
  seq: number;
  move: number;
  angle: number;
  power: number;
  weaponId: number;
}

type CommitResult = { kind: 'applied'; match: StoredMatch } | { kind: 'rejected'; reason: string } | { kind: 'conflict' };

/**
 * 포트리스 턴 매치 서버 (DESIGN §3·§11) — 서버가 턴마다 엔진을 돌려 결과를 확정한다.
 *
 * - 상태는 Redis 경기 JSON 하나(`fortress:match:{id}`)와 마감 ZSET(`fortress:deadlines`). 모든 쓰기는 버전 CAS(MATCH_CAS_SCRIPT)
 * - 행동 1개 = 엔진 applyAction 1번 → CAS 쓰기 성공한 쪽만 `turnResolved`(+ 끝났으면 `matchEnded`)를 방송한다 → 정확히 1번
 * - 서버 행동: 마감 초과 `skip`(timeout) · 끊김 유예 초과 `resign`(disconnect) · 경기 중 이탈 `resign`(leave)
 * - 마감 처리 트리거 3갈래, 모두 같은 멱등 경로(processDue): ① 처리한 레플리카의 로컬 타이머 ② `TASK_SLOT=1` 스위퍼(1초)
 *   ③ 요청 시점 lazy(turnSubmit·resync). 상태는 Redis에만 있어 어느 레플리카가 죽어도 경기가 멈추지 않는다
 * - 방은 모른다 — 경기가 끝나면 endedHook(방 서비스)이 방을 RESULT로 바꾼다
 * - DB 쓰기 없음 — 경기를 끝내는 행동은 CAS 전에 저장 대기(`fortress:pending-saves`)에 넣고, 방송 뒤 saveHook(결과 서비스)이 저장한다(F6, DESIGN §12)
 */
@Injectable()
export class FortressMatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FortressMatchService.name);
  private redis: Redis | null = null;
  private readonly store = new FortressMatchStore();
  private broadcastListener: MatchBroadcastListener | null = null;
  private endedHook: MatchEndedHook | null = null;
  private saveHook: MatchSaveHook | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  /** 스위프가 겹치지 않게(이 레플리카 로컬 — 공유 상태 아님) */
  private sweeping = false;
  /** 깨우기 타이머 — 프로세스 종료를 막지 않는다. 테스트는 setWakeScheduler로 바꾼다 */
  private wakeScheduler: (task: () => void, delayMs: number) => void = (task, delayMs) => {
    setTimeout(task, delayMs).unref();
  };

  /** main.ts에서 RedisIoAdapter 초기화 후 호출 (방 서비스와 같은 연결) */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /** 게이트웨이 afterInit에서 주입 */
  setBroadcastListener(listener: MatchBroadcastListener): void {
    this.broadcastListener = listener;
  }

  /** 방 서비스 생성자에서 주입 */
  setEndedHook(hook: MatchEndedHook): void {
    this.endedHook = hook;
  }

  /** 결과 서비스 생성자에서 주입(F6) */
  setSaveHook(hook: MatchSaveHook): void {
    this.saveHook = hook;
  }

  /** 결과 서비스가 같은 연결로 저장 대기·경기 키를 읽는다 — 준비 안 됐으면 null */
  readyRedisClient(): Redis | null {
    return this.readyRedis();
  }

  setWakeScheduler(scheduler: (task: () => void, delayMs: number) => void): void {
    this.wakeScheduler = scheduler;
  }

  // ==================== 스위퍼 (TASK_SLOT=1) ====================

  /**
   * 스위퍼는 `TASK_SLOT === '1'` 레플리카에서만 돈다(멀티 레플리카 원칙 — 여러 레플리카가 돌아도 CAS라 결과는 같지만 Redis 부하만 는다).
   * TASK_SLOT은 docker-stack `{{.Task.Slot}}` — 읽는 방식은 online-user.service와 같다(process.env 직접). LOCAL(미설정)은 로컬 타이머만
   */
  onModuleInit(): void {
    if (process.env.TASK_SLOT !== '1') return;
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** 처리 시각이 지난 경기를 처리한다 — 처리한 레플리카가 죽어 로컬 타이머가 사라진 경기를 회수. 실패는 로그만 */
  async sweep(now = Date.now()): Promise<void> {
    const redis = this.readyRedis();
    if (!redis || this.sweeping) return;
    this.sweeping = true;
    try {
      const ids = await this.store.dueMatchIds(redis, now, SWEEP_BATCH);
      for (const matchId of ids) await this.processDue(matchId, now);
    } catch (error) {
      this.logger.warn(`마감 스윕 실패 — 다음 주기에 다시: ${(error as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ==================== 생성 ====================

  /**
   * 경기 생성 — 첫 state·첫 턴 마감(시작 카운트다운 MATCH_START_DELAY_MS 뒤부터 첫 턴 길이)을 저장한다.
   * 마감 ZSET·깨우기는 걸지 않는다 — 방 CAS가 성공한 뒤 activate가 건다(리뷰 B1: 그 사이 레플리카가 죽으면
   * 방 없는 경기를 스위퍼가 시간 초과 skip만으로 끝내 공개 경기로 저장하지 않게, 키는 TTL로 사라진다).
   * config는 방 서비스가 만든 값이라 엔진이 거부하면 서버 버그다(INTERNAL_ERROR로 끝난다)
   */
  async create(input: CreateMatchInput, now = Date.now()): Promise<StoredMatch> {
    const redis = this.requireRedis();
    const created = createMatch(input.config);
    if (!created.ok) throw new Error(`엔진이 경기 설정을 거부: ${created.reason}`);
    const turnMs = turnDurationMs(0);
    const match: StoredMatch = {
      matchId: input.matchId,
      code: input.code,
      config: input.config,
      slots: input.slots.map((s) => ({
        slot: s.slot,
        playerId: s.playerId,
        name: s.name,
        userId: s.userId,
        ...(s.skin ? { skin: s.skin } : {}),
        disconnectedAt: null,
      })),
      actions: [],
      state: created.state,
      stateHash: stateHash(created.state),
      tally: createTally(created.state),
      status: 'PLAYING',
      deadlineAt: now + MATCH_START_DELAY_MS + turnMs,
      turnMs,
      startedAt: now,
      roomName: input.roomName,
      engineVersion: ENGINE_VERSION,
      endedAt: null,
    };
    if (!(await this.store.compareAndSet(redis, '0', match, null))) throw new FortressError('ROOM_BUSY');
    return match;
  }

  /**
   * 경기 시작 확정(방 CAS 성공 뒤) — 첫 마감을 마감 ZSET에 넣고 이 레플리카의 깨우기를 건다(리뷰 B1).
   * 이후 CAS 쓰기는 늘 마감 점수를 함께 쓰므로 lazy(turnSubmit·resync)·스위퍼 경로는 그대로 동작한다
   */
  async activate(match: StoredMatch, now = Date.now()): Promise<void> {
    const due = this.dueAt(match);
    if (due === null) return;
    // 이미 다른 레플리카가 행동을 적용했으면 그 CAS가 마감을 썼고 깨우기도 그쪽이 걸었다 — 덮지 않는다
    if (!(await this.store.addDue(this.requireRedis(), match.matchId, due))) return;
    this.scheduleDue(match, now);
  }

  /** 시작 커밋 실패 정리 */
  async remove(matchId: string): Promise<void> {
    await this.store.remove(this.requireRedis(), matchId);
  }

  // ==================== 턴 ====================

  /**
   * 턴 주인의 행동 제출. 판정 순서: 경기 없음·끝남 → seq 불일치(늦은·중복 제출) → 턴 주인 아님 → 시작 카운트다운 중 → 마감 지남(lazy skip 후) → 엔진 거부.
   * 버전 충돌(그 사이 다른 행동이 들어감)이면 다시 읽어 같은 판정을 한다 — 행동이 들어갔으면 seq가 달라 TURN_MISMATCH
   */
  async submit(matchId: string, playerId: string, input: TurnSubmitInput, now = Date.now()): Promise<void> {
    const redis = this.requireRedis();
    for (let attempt = 0; attempt < MATCH_CAS_MAX_ATTEMPTS; attempt++) {
      const loaded = await this.store.load(redis, matchId);
      if (!loaded || loaded.match.status !== 'PLAYING') throw new FortressError('MATCH_NOT_FOUND');
      const match = loaded.match;
      const slot = match.slots.find((s) => s.playerId === playerId);
      if (!slot) throw new FortressError('MATCH_NOT_FOUND');
      if (input.seq !== match.actions.length) throw new FortressError('TURN_MISMATCH');
      if (match.state.turn.slot !== slot.slot) throw new FortressError('NOT_YOUR_TURN');
      if (now < match.startedAt + MATCH_START_DELAY_MS) throw new FortressError('MATCH_NOT_STARTED');
      if (match.deadlineAt !== null && now >= match.deadlineAt) {
        // 요청 시점 lazy 마감 — 타이머·스위퍼보다 먼저 왔으면 여기서 skip을 넣어 방송한다
        await this.processDue(matchId, now);
        throw new FortressError('TURN_EXPIRED');
      }
      const action: Action = { kind: 'fire', move: input.move, angle: input.angle, power: input.power, weaponId: input.weaponId };
      const result = await this.commitAction(redis, loaded, action, 'player', now);
      if (result.kind === 'rejected') throw new FortressError('ACTION_REJECTED', result.reason);
      if (result.kind === 'applied') return;
    }
    this.logger.warn(`경기 변경 충돌 재시도 초과: match=${matchId}`);
    throw new FortressError('ROOM_BUSY');
  }

  /**
   * 기권(이탈 leave·끊김 유예 초과 disconnect) — 자기 턴이 아니어도 넣는다(엔진이 턴을 유지).
   * 이미 탈락했거나 경기가 끝났으면 아무것도 하지 않는다(false)
   */
  async resign(matchId: string, playerId: string, cause: Extract<TurnCause, 'leave' | 'disconnect'>, now = Date.now()): Promise<boolean> {
    const redis = this.requireRedis();
    for (let attempt = 0; attempt < MATCH_CAS_MAX_ATTEMPTS; attempt++) {
      const loaded = await this.store.load(redis, matchId);
      if (!loaded || loaded.match.status !== 'PLAYING') return false;
      const slot = loaded.match.slots.find((s) => s.playerId === playerId);
      if (!slot || !loaded.match.state.tanks[slot.slot]?.alive) return false;
      const result = await this.commitAction(redis, loaded, { kind: 'resign', slot: slot.slot }, cause, now);
      if (result.kind === 'applied') return true;
      if (result.kind === 'rejected') return false;
    }
    throw new FortressError('ROOM_BUSY');
  }

  /**
   * 경기 중 끊김 표시(at = 끊긴 시각) · 해제(at = null). 표시하면 유예가 끝날 때 깨운다 —
   * 마감 ZSET 점수도 유예 끝 쪽으로 당겨져 이 레플리카가 죽어도 스위퍼가 resign한다
   */
  async setDisconnected(matchId: string, playerId: string, at: number | null, now = Date.now()): Promise<void> {
    const redis = this.requireRedis();
    for (let attempt = 0; attempt < MATCH_CAS_MAX_ATTEMPTS; attempt++) {
      const loaded = await this.store.load(redis, matchId);
      if (!loaded || loaded.match.status !== 'PLAYING') return;
      const index = loaded.match.slots.findIndex((s) => s.playerId === playerId);
      if (index < 0 || loaded.match.slots[index].disconnectedAt === at) return;
      const next: StoredMatch = {
        ...loaded.match,
        slots: loaded.match.slots.map((s, i) => (i === index ? { ...s, disconnectedAt: at } : s)),
      };
      if (await this.store.compareAndSet(redis, loaded.version, next, this.dueAt(next))) {
        this.scheduleDue(next, now);
        return;
      }
    }
    throw new FortressError('ROOM_BUSY');
  }

  /** 경기에 기록된 끊김 시각(없거나 경기가 끝났으면 null) — 방 정리 경로가 기록 누락만 채울 때 */
  async disconnectedAt(matchId: string, playerId: string): Promise<number | null> {
    const loaded = await this.store.load(this.requireRedis(), matchId);
    if (!loaded || loaded.match.status !== 'PLAYING') return null;
    return loaded.match.slots.find((s) => s.playerId === playerId)?.disconnectedAt ?? null;
  }

  /**
   * 처리할 서버 행동이 있으면 넣는다(끊김 유예 초과 resign → 마감 초과 skip 순, 연달아 여러 개). 멱등 —
   * 같은 경기를 여러 레플리카·타이머가 동시에 불러도 CAS라 행동은 한 번만 들어가고, 늦은 쪽은 다시 읽어 할 일이 없음을 본다.
   * 던지지 않는다(타이머·스위퍼 경로) — 실패는 로그, 다음 트리거가 다시 한다
   */
  async processDue(matchId: string, now = Date.now()): Promise<void> {
    const redis = this.readyRedis();
    if (!redis) return;
    try {
      for (let step = 0; step < SERVER_ACTION_MAX_PER_WAKE; step++) {
        const loaded = await this.store.load(redis, matchId);
        if (!loaded) {
          await this.store.forgetDue(redis, matchId);
          return;
        }
        if (loaded.match.status !== 'PLAYING') return;
        const due = this.dueServerAction(loaded.match, now);
        if (!due) return;
        const result = await this.commitAction(redis, loaded, due.action, due.cause, now);
        if (result.kind === 'rejected') {
          // 이론상 없음(살아 있는 slot만 resign, skip은 늘 유효) — 반복하지 않게 멈춘다
          this.logger.warn(`서버 행동 거부: match=${matchId}, ${due.action.kind}, ${result.reason}`);
          return;
        }
      }
    } catch (error) {
      this.logger.warn(`마감 처리 실패 — 다음 깨우기·스윕이 다시: match=${matchId}, ${(error as Error).message}`);
    }
  }

  /**
   * resync·재연결 복원 — lazy 마감 처리 후 행동 목록·해시·지금 턴. 경기 키가 없으면(TTL) null.
   * clientHash가 오면 서버 해시와 비교해 다르면 로그를 남긴다(엔진 비결정성·버그 탐지)
   */
  async snapshot(matchId: string, now = Date.now(), client?: { seq?: number; clientHash?: string }): Promise<MatchSnapshot | null> {
    const redis = this.requireRedis();
    await this.processDue(matchId, now);
    const loaded = await this.store.load(redis, matchId);
    if (!loaded) return null;
    const match = loaded.match;
    if (client?.clientHash !== undefined && client.seq === match.actions.length && client.clientHash !== match.stateHash) {
      this.logger.warn(`해시 불일치 resync: match=${matchId}, seq=${client.seq}, client=${client.clientHash}, server=${match.stateHash}`);
    }
    return {
      matchId,
      engineVersion: ENGINE_VERSION,
      config: match.config,
      actions: match.actions,
      stateHash: match.stateHash,
      turn: match.status === 'PLAYING' ? this.turnInfo(match, now) : null,
      slots: this.publicSlots(match),
    };
  }

  /** 계약 TurnInfo — remainingMs는 지금(보내는 시점) 기준 */
  turnInfo(match: StoredMatch, now: number): TurnInfo {
    const deadlineAt = match.deadlineAt ?? now;
    return {
      seq: match.actions.length,
      turnNo: match.state.turn.no,
      slot: match.state.turn.slot,
      deadlineAt: new Date(deadlineAt).toISOString(),
      turnMs: match.turnMs,
      remainingMs: Math.max(0, deadlineAt - now),
    };
  }

  publicSlots(match: StoredMatch): MatchSlot[] {
    return match.slots.map(({ slot, playerId, name, skin }) => ({ slot, playerId, name, skin: storedTankSkin(skin) }));
  }

  // ==================== 내부 ====================

  /**
   * 행동 1개 적용 → CAS 쓰기 → (성공한 쪽만) 방송. 다음 턴 마감:
   * 턴이 넘어가면 지금 + turnDurationMs(이번 행동 연출 길이), 남의 턴 resign이면 진행 중 턴의 마감 그대로(D-009·§11)
   */
  private async commitAction(redis: Redis, loaded: LoadedMatch, action: Action, cause: TurnCause, now: number): Promise<CommitResult> {
    const match = loaded.match;
    const before = match.state;
    const applied = applyAction(before, action);
    if (!applied.ok) return { kind: 'rejected', reason: applied.reason };

    const seq = match.actions.length;
    const ended = applied.state.result.kind !== 'ongoing';
    const turnPassed = action.kind !== 'resign' || action.slot === before.turn.slot;
    let { deadlineAt, turnMs } = match;
    if (ended) {
      deadlineAt = null;
    } else if (turnPassed) {
      turnMs = turnDurationMs(eventsEndTick(applied.events));
      deadlineAt = now + turnMs;
    }
    const next: StoredMatch = {
      ...match,
      actions: [...match.actions, action],
      state: applied.state,
      stateHash: stateHash(applied.state),
      tally: tallyAction(match.tally, before, action, applied.events, seq),
      status: ended ? 'ENDED' : 'PLAYING',
      deadlineAt,
      turnMs,
      endedAt: ended ? now : (match.endedAt ?? null),
    };
    // 끝내는 행동이면 CAS 전에 저장 대기에 넣는다 — CAS 뒤에 넣으면 그 사이 이 레플리카가 죽을 때 저장이 빠진다.
    // CAS에 지면 경기는 그대로 PLAYING이라 저장 쪽이 건너뛰고 나중에 다시 본다(DESIGN §12)
    if (ended) await this.markPendingSave(redis, match.matchId, now);
    if (!(await this.store.compareAndSet(redis, loaded.version, next, ended ? null : this.dueAt(next)))) return { kind: 'conflict' };

    this.publish(next.code, {
      event: 'turnResolved',
      payload: {
        matchId: next.matchId,
        seq,
        action,
        cause,
        stateHash: next.stateHash,
        next: ended ? null : this.turnInfo(next, now),
      },
    });
    if (ended) {
      this.publish(next.code, { event: 'matchEnded', payload: this.endedPayload(next) });
      await this.notifyEnded(next.code, next.matchId);
      this.notifySave(next.matchId);
    } else {
      this.scheduleDue(next, now);
    }
    return { kind: 'applied', match: next };
  }

  /** 지금 넣어야 할 서버 행동 — 끊김 유예가 지난 생존자 resign(slot 순)이 먼저, 그다음 마감 skip */
  private dueServerAction(match: StoredMatch, now: number): { action: Action; cause: TurnCause } | null {
    for (const slot of match.slots) {
      if (slot.disconnectedAt === null || !match.state.tanks[slot.slot]?.alive) continue;
      if (now - slot.disconnectedAt >= MATCH_DISCONNECT_GRACE_MS) return { action: { kind: 'resign', slot: slot.slot }, cause: 'disconnect' };
    }
    if (match.deadlineAt !== null && now >= match.deadlineAt) return { action: { kind: 'skip' }, cause: 'timeout' };
    return null;
  }

  /** 다음 처리 시각 = 턴 마감과 (살아 있는) 끊긴 참가자의 유예 끝 중 이른 쪽. 끝난 경기는 null */
  private dueAt(match: StoredMatch): number | null {
    if (match.status !== 'PLAYING' || match.deadlineAt === null) return null;
    let due = match.deadlineAt;
    for (const slot of match.slots) {
      if (slot.disconnectedAt !== null && match.state.tanks[slot.slot]?.alive) {
        due = Math.min(due, slot.disconnectedAt + MATCH_DISCONNECT_GRACE_MS);
      }
    }
    return due;
  }

  /** 다음 처리 시각에 이 레플리카에서 한 번 깨운다 — 트리거일 뿐, 늦거나 사라져도 스위퍼·lazy가 같은 일을 한다 */
  private scheduleDue(match: StoredMatch, now: number): void {
    const due = this.dueAt(match);
    if (due === null) return;
    const matchId = match.matchId;
    this.wakeScheduler(() => void this.processDue(matchId), Math.max(0, due - now) + WAKE_MARGIN_MS);
  }

  /**
   * 순위 오름차순, 같은 순위는 slot 순(계약 MatchEndedPayload.players). 결과 저장(F6)도 같은 값을 쓴다.
   * replay id = matchId(경기당 리플레이 1개, DESIGN §12) — 저장 전에 방송해도 결과 조회가 그 자리에서 저장한다
   */
  endedPayload(match: StoredMatch): MatchEndedPayload {
    const places = computePlaces(match.state, match.tally);
    const players = match.slots
      .map((s): MatchResultEntry => {
        const tank = match.state.tanks[s.slot];
        const tally = match.tally[s.slot];
        return {
          playerId: s.playerId,
          name: s.name,
          slot: s.slot,
          team: match.state.mode === 'team' && (tank?.team === 0 || tank?.team === 1) ? tank.team : null,
          hp: tank?.hp ?? 0,
          damage: tally?.damage ?? 0,
          kos: tally?.kos ?? 0,
          place: places[s.slot] ?? match.slots.length,
        };
      })
      .sort((a, b) => a.place - b.place || a.slot - b.slot);
    return { matchId: match.matchId, result: match.state.result, players, replay: { id: match.matchId } };
  }

  private publish(code: string, broadcast: MatchBroadcast): void {
    try {
      this.broadcastListener?.(code, broadcast);
    } catch (error) {
      this.logger.warn(`경기 이벤트 알림 실패: code=${code}, ${(error as Error).message}`);
    }
  }

  private async notifyEnded(code: string, matchId: string): Promise<void> {
    try {
      await this.endedHook?.(code, matchId);
    } catch (error) {
      this.logger.warn(`경기 종료 반영 실패: code=${code}, match=${matchId}, ${(error as Error).message}`);
    }
  }

  /** 저장 대기 등록 실패는 경기 진행을 막지 않는다 — 방송 뒤 바로 저장(saveHook)·결과 조회 lazy 저장이 남는다 */
  private async markPendingSave(redis: Redis, matchId: string, now: number): Promise<void> {
    try {
      await this.store.markPendingSave(redis, matchId, now);
    } catch (error) {
      this.logger.warn(`저장 대기 등록 실패: match=${matchId}, ${(error as Error).message}`);
    }
  }

  /** 기다리지 않는다 — 턴 제출 ack·타이머 경로가 DB 쓰기만큼 늦어지지 않게. 실패는 저장 대기 크론·조회가 회수 */
  private notifySave(matchId: string): void {
    if (!this.saveHook) return;
    this.saveHook(matchId).catch((error: unknown) => {
      this.logger.warn(`결과 저장 알림 실패: match=${matchId}, ${(error as Error).message}`);
    });
  }

  private readyRedis(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  private requireRedis(): Redis {
    // 어댑터 클라이언트는 maxRetriesPerRequest: null이라 끊긴 동안 명령이 무한 대기한다 → ready가 아니면 바로 거부
    const redis = this.readyRedis();
    if (!redis) throw new FortressError('SERVICE_UNAVAILABLE');
    return redis;
  }
}
