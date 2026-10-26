import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DataSource, QueryFailedError } from 'typeorm';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TetrisBattleMatch } from '../../entities/TetrisBattleMatch';
import { TetrisBattlePlayer } from '../../entities/TetrisBattlePlayer';
import { TetrisBattleReplay } from '../../entities/TetrisBattleReplay';
import { User } from '../../entities/User';
import golden from './battle-engine/__fixtures__/golden-battle-replays.json';
import { BattleReplayInput, simulateBattleReplay } from './battle-engine';
import { PENDING_SAVE_RETRY_MS, REPLAY_SUBMIT_DEADLINE_MS, WAKE_MARGIN_MS } from './tetris-battle.constants';
import { MatchSnapshot, TetrisBattleMatchStore } from './tetris-battle-match.store';
import { TetrisBattleRoomService } from './tetris-battle-room.service';
import { TetrisBattleResultService } from './tetris-battle-result.service';
import { UserSkinService } from '../users/user-skin.service';

const MATCH = 'AbCdEfGhIjKlMnOp';
const T_END = 1_800_000_100_000;
const TOKEN = (n: number) => `token-${n}`.padEnd(32, 'x');
/** oracledb가 던지는 FK 위반 형태 — TypeORM QueryFailedError + driverError.errorNum (메시지 문자열로 판정하지 않는다, BE-13) */
const fkViolation = () =>
  new QueryFailedError('INSERT ...', [], Object.assign(new Error('ORA-02291: integrity constraint violated'), { errorNum: 2291 }));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

type GoldenCase = { name: string; input: BattleReplayInput };
const SURVIVOR = (golden as unknown as GoldenCase[]).find((c) => c.name === 'survivor')!.input;
const SURVIVOR_SIM = simulateBattleReplay(SURVIVOR);
if (!SURVIVOR_SIM.ok) throw new Error('survivor 골든은 성공이어야 한다');

/**
 * 2인 경기 스냅샷 — p1이 골든 'survivor' 리플레이의 주인(생존·우승), p2는 탑아웃 탈락.
 * 서버 기록(가비지 로그·lock 공격 로그·마지막 seq)은 리플레이와 일치하게 만든다 → p1 제출은 VERIFIED
 */
const snapshot = (over: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  matchId: MATCH,
  code: 'ABCDEF',
  seed: SURVIVOR.seed,
  startedAt: T_END - 60_000,
  status: 'ENDED',
  roomName: '한판',
  clockStart: 1_000,
  endedClock: 1_000 + 3_600_000, // 넉넉한 경과 시간
  endedAt: T_END,
  players: [
    {
      playerId: 'p1', name: '우승자', userId: 42, alive: true, seq: SURVIVOR_SIM.pieces, frame: 1100, pieces: SURVIVOR_SIM.pieces,
      sent: 5, received: 2, maxCombo: 1, kos: 1, board: null, pending: 0, combo: -1, b2b: false, place: 1, frames: 1100,
      koReason: null, disconnectedAt: null, koClock: null, tokenHash: hash(TOKEN(1)),
    },
    {
      playerId: 'p2', name: '도전자', userId: null, alive: false, seq: 10, frame: 900, pieces: 10, sent: 2, received: 5,
      maxCombo: 0, kos: 0, board: null, pending: 0, combo: -1, b2b: false, place: 2, frames: 900, koReason: 'topout',
      disconnectedAt: null, koClock: 5_000, tokenHash: hash(TOKEN(2)),
    },
  ],
  ...over,
});

const survivorGarbage = () => {
  const g = [];
  for (let i = 0; i < SURVIVOR.garbage.length; i += 4) {
    g.push({ id: SURVIVOR.garbage[i + 1], lines: SURVIVOR.garbage[i + 2], hole: SURVIVOR.garbage[i + 3], at: 2_000, from: 'p2' as string | null });
  }
  return g;
};
const survivorSent = () => SURVIVOR_SIM.sent.filter((l) => l.sent > 0).map((l) => ({ seq: l.seq, sent: l.sent }));
const replayDto = (patch: Partial<BattleReplayInput> = {}) => ({ ...SURVIVOR, ...patch });

/**
 * 경기 후 검증·저장(DESIGN §17) — 상태코드 갈래, 1회 제출·1회 저장 가드, verdict 집계, 저장 행 구성.
 * Redis 매치 저장소는 경계에서 대역(실제 Lua·명령은 6380 스펙), 리플레이 검증은 실제 래퍼로 돈다.
 */
describe('TetrisBattleResultService', () => {
  let service: TetrisBattleResultService;
  let store: Record<
    | 'snapshot'
    | 'garbageLog'
    | 'sentLog'
    | 'submissions'
    | 'claimSubmission'
    | 'closeSubmissions'
    | 'markSaved'
    | 'isSaved'
    | 'claimSave'
    | 'releaseSave'
    | 'isClosed'
    | 'claimVerification'
    | 'releaseVerification'
    | 'markPendingSave'
    | 'duePendingSaves'
    | 'clearPendingSave'
    | 'exists',
    jest.SpyInstance
  >;
  let subs: Record<string, string>;
  let closed: boolean;
  let userRepository: MockRepository<User>;
  let redisReady: boolean;
  let matchRepository: MockRepository<TetrisBattleMatch>;
  let playerRepository: MockRepository<TetrisBattlePlayer>;
  let replayRepository: MockRepository<TetrisBattleReplay>;
  let saved: { entity: string; row: Record<string, unknown> }[];
  let transaction: jest.Mock;
  let existingMatch: { matchId: string; crtdAt: Date } | null;
  let matchFinished: ((matchId: string) => void) | null;
  let wakes: { task: () => Promise<void>; delayMs: number }[];

  const submit = (token = TOKEN(1), replay = replayDto(), now = T_END + 1_000, userId: number | null = null) =>
    service.submitReplay({ matchId: MATCH, playerToken: token, replay, userId, now });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    subs = {};
    closed = false;
    redisReady = true;
    const proto = TetrisBattleMatchStore.prototype;
    store = {
      snapshot: jest.spyOn(proto, 'snapshot').mockResolvedValue(snapshot()),
      garbageLog: jest.spyOn(proto, 'garbageLog').mockImplementation(async (_r, _m, pid) => (pid === 'p1' ? survivorGarbage() : [])),
      sentLog: jest.spyOn(proto, 'sentLog').mockImplementation(async (_r, _m, pid) => (pid === 'p1' ? survivorSent() : [])),
      submissions: jest.spyOn(proto, 'submissions').mockImplementation(async () => ({ ...subs })),
      claimSubmission: jest.spyOn(proto, 'claimSubmission').mockImplementation(async (_r, _m, pid, record) => {
        if (closed) return 'CLOSED';
        if (subs[pid]) return 'DUPLICATE';
        subs[pid] = record;
        return 'CLAIMED';
      }),
      closeSubmissions: jest.spyOn(proto, 'closeSubmissions').mockImplementation(async () => {
        closed = true;
        return { ...subs };
      }),
      markSaved: jest.spyOn(proto, 'markSaved').mockResolvedValue(undefined),
      isSaved: jest.spyOn(proto, 'isSaved').mockResolvedValue(false),
      claimSave: jest.spyOn(proto, 'claimSave').mockResolvedValue(true),
      releaseSave: jest.spyOn(proto, 'releaseSave').mockResolvedValue(undefined),
      isClosed: jest.spyOn(proto, 'isClosed').mockImplementation(async () => closed),
      claimVerification: jest.spyOn(proto, 'claimVerification').mockResolvedValue(true),
      releaseVerification: jest.spyOn(proto, 'releaseVerification').mockResolvedValue(undefined),
      markPendingSave: jest.spyOn(proto, 'markPendingSave').mockResolvedValue(undefined),
      duePendingSaves: jest.spyOn(proto, 'duePendingSaves').mockResolvedValue([]),
      clearPendingSave: jest.spyOn(proto, 'clearPendingSave').mockResolvedValue(undefined),
      exists: jest.spyOn(proto, 'exists').mockResolvedValue(true),
    };

    matchRepository = createMockRepository<TetrisBattleMatch>();
    playerRepository = createMockRepository<TetrisBattlePlayer>();
    replayRepository = createMockRepository<TetrisBattleReplay>();
    userRepository = createMockRepository<User>();
    saved = [];
    existingMatch = null;
    const manager = {
      findOne: jest.fn(async () => existingMatch),
      create: (entity: { name: string }, row: Record<string, unknown>) => ({ __entity: entity.name, ...row }),
      save: async (row: Record<string, unknown> & { __entity: string }) => {
        const { __entity, ...rest } = row;
        saved.push({ entity: __entity, row: rest });
        return rest;
      },
    };
    transaction = jest.fn((run: (m: typeof manager) => unknown) => run(manager));
    matchFinished = null;
    wakes = [];
    const roomService = {
      readyRedisClient: () => (redisReady ? ({} as never) : null),
      setMatchFinishedListener: (listener: (matchId: string) => void) => (matchFinished = listener),
      scheduleWake: (task: () => Promise<void>, delayMs: number) => wakes.push({ task, delayMs }),
    } as unknown as TetrisBattleRoomService;
    service = createService(roomService, { ENV: 'PROD', TASK_SLOT: 1 });
  });

  // 보드 주인 스킨 — 저장된 장착이 없는 사용자는 결과에 없다(서비스가 default로 채운다)
  const skinService = { boardSkinsOfMany: jest.fn().mockResolvedValue(new Map()) } as unknown as UserSkinService;
  const createService = (roomService: TetrisBattleRoomService, env: Record<string, unknown>) =>
    new TetrisBattleResultService(
      roomService,
      matchRepository as never,
      playerRepository as never,
      replayRepository as never,
      userRepository as never,
      { transaction } as unknown as DataSource,
      { get: (key: string) => env[key] } as unknown as ConfigService,
      skinService,
    );

  afterEach(() => jest.restoreAllMocks());

  describe('마감 깨우기 (tetris-audit D-009·BE-06)', () => {
    it('매치가 끝나면 제출 마감 뒤로 저장 확인을 한 번 예약하고, 깨어나면 마감 지난 ENDED 매치를 저장한다', async () => {
      matchFinished?.(MATCH);
      expect(wakes).toEqual([{ task: expect.any(Function), delayMs: REPLAY_SUBMIT_DEADLINE_MS + WAKE_MARGIN_MS }]);

      const now = jest.spyOn(Date, 'now').mockReturnValue(T_END + REPLAY_SUBMIT_DEADLINE_MS + WAKE_MARGIN_MS);
      await wakes[0].task();
      now.mockRestore();

      expect(store.claimSave).toHaveBeenCalled();
      expect(transaction).toHaveBeenCalled();
    });
  });

  describe('저장 대기 스윕 (games-polish BT-05 — 깨우기 타이머가 레플리카 재시작으로 사라져도 저장)', () => {
    const due = T_END + REPLAY_SUBMIT_DEADLINE_MS + WAKE_MARGIN_MS;

    it('매치가 끝나면 Redis 저장 대기에도 마감 시각으로 올린다', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(T_END);
      matchFinished?.(MATCH);
      now.mockRestore();
      await Promise.resolve();
      expect(store.markPendingSave).toHaveBeenCalledWith(expect.anything(), MATCH, due);
    });

    it('마감 지난 대기 매치를 저장하고, 저장됐으면 대기에서 뺀다', async () => {
      store.duePendingSaves.mockResolvedValueOnce([MATCH]);
      store.isSaved.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await service.sweepPendingSaves(due + 1);

      expect(transaction).toHaveBeenCalled();
      expect(store.clearPendingSave).toHaveBeenCalledWith(expect.anything(), MATCH);
    });

    it('저장이 실패하면 대기에 남겨 다음 스윕이 다시 시도한다', async () => {
      store.duePendingSaves.mockResolvedValueOnce([MATCH]);
      transaction.mockRejectedValueOnce(new Error('ORA-12516'));

      await service.sweepPendingSaves(due + 1);

      expect(store.releaseSave).toHaveBeenCalled();
      expect(store.clearPendingSave).not.toHaveBeenCalled();
      // 뒤로 미뤄 다음 스윕이 다른 대기 매치부터 본다(앞 20개 고착 방지)
      expect(store.markPendingSave).toHaveBeenCalledWith(expect.anything(), MATCH, due + 1 + PENDING_SAVE_RETRY_MS);
    });

    it('매치가 TTL로 사라졌으면 저장 없이 대기에서 뺀다', async () => {
      store.duePendingSaves.mockResolvedValueOnce([MATCH]);
      store.snapshot.mockResolvedValueOnce(null);
      store.exists.mockResolvedValueOnce(false);

      await service.sweepPendingSaves(due + 1);

      expect(transaction).not.toHaveBeenCalled();
      expect(store.clearPendingSave).toHaveBeenCalledWith(expect.anything(), MATCH);
    });

    it.each([
      ['LOCAL', { ENV: 'local', TASK_SLOT: 1 }],
      ['TASK_SLOT 2', { ENV: 'PROD', TASK_SLOT: 2 }],
    ])('%s 레플리카는 스윕하지 않는다(2단 가드)', async (_label, env) => {
      const roomService = { readyRedisClient: () => ({}) as never, setMatchFinishedListener: () => undefined } as unknown as TetrisBattleRoomService;
      await createService(roomService, env).sweepPendingSaves(due + 1);
      expect(store.duePendingSaves).not.toHaveBeenCalled();
    });
  });

  describe('조회 계기 저장 (games-polish BT-09)', () => {
    it('이미 저장된 경기는 매치 Hash를 읽지 않는다', async () => {
      store.isSaved.mockResolvedValue(true);
      matchRepository.findOne.mockResolvedValue(null);
      await service.getMatch(MATCH, T_END + REPLAY_SUBMIT_DEADLINE_MS + 1).catch(() => undefined);
      expect(store.snapshot).not.toHaveBeenCalled();
    });
  });

  describe('다시보기 공격자 기록 (games-polish D-006)', () => {
    it('제출 리플레이의 가비지마다 서버 로그의 공격자를 같은 순서로 저장한다 — 로그에 없는 id는 null', async () => {
      const log = survivorGarbage().map((g, i) => ({ ...g, from: i % 2 === 0 ? 'p2' : 'p3' }));
      store.garbageLog.mockResolvedValueOnce(log.slice(1)); // 첫 이벤트는 로그에서 빠진 경우
      await submit();
      const record = JSON.parse(subs.p1) as { replay: string };
      const body = JSON.parse(gunzipSync(Buffer.from(record.replay, 'base64')).toString('utf8')) as { garbageFrom: (string | null)[] };
      expect(body.garbageFrom).toEqual([null, ...log.slice(1).map((g) => g.from)]);
      expect(body.garbageFrom).toHaveLength(SURVIVOR.garbage.length / 4);
    });
  });

  describe('제출 — 상태코드', () => {
    it('정직한 리플레이는 201 verdict VERIFIED, 제출 기록(gzip)을 남긴다', async () => {
      await expect(submit(TOKEN(1), replayDto(), T_END + 1_000, 7)).resolves.toEqual({ verdict: 'VERIFIED' });
      const record = JSON.parse(subs.p1) as { verdict: string; userId: number; replay: string; battleEngineVersion: number };
      expect(record).toMatchObject({ verdict: 'VERIFIED', userId: 7, battleEngineVersion: SURVIVOR.battleEngineVersion });
      expect(JSON.parse(gunzipSync(Buffer.from(record.replay, 'base64')).toString('utf8'))).toMatchObject({
        seed: SURVIVOR.seed,
        frames: SURVIVOR.frames,
      });
    });

    it('생존자 frames 상한 여유 300프레임: 경과 시간보다 240프레임 많으면 통과, 306프레임 많으면 INVALID (리뷰 L5)', async () => {
      const frames = SURVIVOR.frames; // 1200
      const elapsedFor = (overFrames: number) => ((frames - overFrames) * 1000) / 60;
      store.snapshot.mockResolvedValueOnce(snapshot({ clockStart: 0, endedClock: elapsedFor(240) }));
      await expect(submit()).resolves.toEqual({ verdict: 'VERIFIED' });

      delete subs.p1;
      store.snapshot.mockResolvedValueOnce(snapshot({ clockStart: 0, endedClock: elapsedFor(306) }));
      await expect(submit()).resolves.toEqual({ verdict: 'INVALID' });
      expect(JSON.parse(subs.p1)).toMatchObject({ reason: 'FRAMES_EXCEED_ELAPSED' });
    });

    it('생존자: 종료 시각 − 3초 전에 보낸 가비지가 리플레이에 없으면 INVALID, 그 뒤 것만 빠졌으면 VERIFIED (D-022)', async () => {
      const endedClock = snapshot().endedClock as number;
      store.garbageLog.mockResolvedValueOnce([...survivorGarbage(), { id: 99, lines: 2, hole: 1, at: endedClock - 3_001, from: 'p2' }]);
      await expect(submit()).resolves.toEqual({ verdict: 'INVALID' });
      expect(JSON.parse(subs.p1)).toMatchObject({ reason: 'GARBAGE_MISMATCH' });

      delete subs.p1;
      store.garbageLog.mockResolvedValueOnce([...survivorGarbage(), { id: 99, lines: 2, hole: 1, at: endedClock - 3_000, from: 'p2' }]);
      await expect(submit()).resolves.toEqual({ verdict: 'VERIFIED' });
    });

    it('검증 실패도 201 — verdict INVALID (재시도 무의미)', async () => {
      store.sentLog.mockResolvedValueOnce([]); // 서버는 공격을 받은 적 없다
      await expect(submit()).resolves.toEqual({ verdict: 'INVALID' });
      expect(JSON.parse(subs.p1)).toMatchObject({ verdict: 'INVALID', reason: 'SENT_MISMATCH' });
    });

    it.each([
      ['matchId 형식', () => service.submitReplay({ matchId: 'bad', playerToken: TOKEN(1), replay: replayDto(), userId: null }), 404, 'TETRIS_BATTLE_MATCH_NOT_FOUND'],
    ])('%s → %s', async (_l, call, status, code) => {
      await expect(call()).rejects.toMatchObject({ status, code });
    });

    it('Redis 매치 기록이 없고 DB에도 없으면 404, DB에 이미 있으면 410', async () => {
      store.snapshot.mockResolvedValue(null);
      await expect(submit()).rejects.toMatchObject({ status: 404, code: 'TETRIS_BATTLE_MATCH_NOT_FOUND' });
      matchRepository.findOne.mockResolvedValueOnce({ matchId: MATCH } as TetrisBattleMatch);
      await expect(submit()).rejects.toMatchObject({ status: 410, code: 'TETRIS_BATTLE_SUBMISSION_CLOSED' });
    });

    it('진행 중 경기면 409 MATCH_NOT_ENDED', async () => {
      store.snapshot.mockResolvedValue(snapshot({ status: 'PLAYING' }));
      await expect(submit()).rejects.toMatchObject({ status: 409, code: 'TETRIS_BATTLE_MATCH_NOT_ENDED' });
    });

    it('토큰이 참가자와 맞지 않으면 403', async () => {
      await expect(submit(TOKEN(9))).rejects.toMatchObject({ status: 403, code: 'TETRIS_BATTLE_PLAYER_TOKEN_INVALID' });
    });

    it('마감(종료 후 60초) 뒤면 410 — 그리고 그 제출이 저장 계기가 된다(미제출 MISSING)', async () => {
      await expect(submit(TOKEN(1), replayDto(), T_END + REPLAY_SUBMIT_DEADLINE_MS + 1)).rejects.toMatchObject({
        status: 410,
        code: 'TETRIS_BATTLE_SUBMISSION_CLOSED',
      });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(saved.filter((s) => s.entity === 'TetrisBattlePlayer').map((s) => s.row.verdict)).toEqual(['MISSING', 'MISSING']);
      expect(subs.p1).toBeUndefined();
    });

    it('마감 직전(정확히 60초)은 받는다', async () => {
      await expect(submit(TOKEN(1), replayDto(), T_END + REPLAY_SUBMIT_DEADLINE_MS)).resolves.toEqual({ verdict: 'VERIFIED' });
    });

    it('이미 제출했으면 409 — 시뮬레이션 전에 거른다', async () => {
      subs.p1 = '{}';
      await expect(submit()).rejects.toMatchObject({ status: 409, code: 'TETRIS_BATTLE_REPLAY_ALREADY_SUBMITTED' });
      expect(store.claimSubmission).not.toHaveBeenCalled();
    });

    it('같은 참가자의 검증이 이미 진행 중이면 503(잠시 후 재시도) — 시뮬레이션·기록 없이 (BE-08·리뷰 R1)', async () => {
      store.claimVerification.mockResolvedValueOnce(false);
      await expect(submit()).rejects.toMatchObject({ status: 503, code: 'TETRIS_BATTLE_UNAVAILABLE' });
      expect(store.garbageLog).not.toHaveBeenCalled();
      expect(store.claimSubmission).not.toHaveBeenCalled();
      expect(store.releaseVerification).not.toHaveBeenCalled();
    });

    it('검증이 끝나면(성공·실패 모두) 검증 가드를 푼다', async () => {
      store.claimSubmission.mockRejectedValueOnce(new Error('redis down'));
      await expect(submit()).rejects.toThrow('redis down');
      expect(store.releaseVerification).toHaveBeenCalledWith(expect.anything(), MATCH, 'p1');
    });

    it('제출이 이미 닫혔으면 시뮬레이션 전에 410', async () => {
      closed = true;
      await expect(submit()).rejects.toMatchObject({ status: 410 });
      expect(store.claimVerification).not.toHaveBeenCalled();
    });

    it('동시 제출 경합에서 HSETNX를 놓치면 409', async () => {
      store.claimSubmission.mockResolvedValueOnce('DUPLICATE');
      await expect(submit()).rejects.toMatchObject({ status: 409, code: 'TETRIS_BATTLE_REPLAY_ALREADY_SUBMITTED' });
    });

    it('저장이 제출 목록을 이미 닫았으면(전원 제출·마감 저장 뒤) 201 대신 410 (리뷰 L2)', async () => {
      store.claimSubmission.mockResolvedValueOnce('CLOSED');
      await expect(submit()).rejects.toMatchObject({ status: 410, code: 'TETRIS_BATTLE_SUBMISSION_CLOSED' });
    });

    it('Redis를 못 쓰면 503', async () => {
      redisReady = false;
      await expect(submit()).rejects.toMatchObject({ status: 503, code: 'TETRIS_BATTLE_UNAVAILABLE' });
    });
  });

  describe('저장 — 1회 가드·verdict 집계', () => {
    const p2Record = (verdict: 'VERIFIED' | 'INVALID') =>
      JSON.stringify({ verdict, reason: null, userId: 9, battleEngineVersion: 1, replay: gzipSync('{}').toString('base64') });

    it('끊김·기권 탈락자는 예상 제출자가 아니다 — 남은 예상 제출자가 내면 바로 저장, 그 탈락자는 MISSING (D-022)', async () => {
      const base = snapshot();
      store.snapshot.mockResolvedValue({ ...base, players: [base.players[0], { ...base.players[1], koReason: 'leave' }] });

      await submit();

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(saved.filter((s) => s.entity === 'TetrisBattlePlayer').map((s) => [s.row.playerId, s.row.verdict])).toEqual([
        ['p1', 'VERIFIED'],
        ['p2', 'MISSING'],
      ]);
    });

    it('즉시 저장 뒤에 비예상 제출자(기권 탈락자)가 내면 410 — 저장에 빠진 201이 생기지 않는다 (리뷰 L2)', async () => {
      const base = snapshot();
      store.snapshot.mockResolvedValue({ ...base, players: [base.players[0], { ...base.players[1], koReason: 'leave' }] });
      await submit(); // p1만 예상 제출자 → 닫고 저장
      expect(closed).toBe(true);

      await expect(submit(TOKEN(2))).rejects.toMatchObject({ status: 410, code: 'TETRIS_BATTLE_SUBMISSION_CLOSED' });
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('저장은 닫는 순간 확정된 목록으로 하고, 끝나면 저장 완료 표시를 남긴다', async () => {
      subs.p2 = JSON.stringify({ verdict: 'VERIFIED', reason: null, userId: null, battleEngineVersion: 1, replay: gzipSync('{}').toString('base64') });
      await submit();
      expect(store.closeSubmissions).toHaveBeenCalledTimes(1);
      expect(store.markSaved).toHaveBeenCalledWith(expect.anything(), MATCH);
    });

    it('이미 저장 완료면 다시 저장하지 않는다(가드 TTL이 지나도)', async () => {
      store.isSaved.mockResolvedValue(true);
      await expect(submit(TOKEN(1), replayDto(), T_END + REPLAY_SUBMIT_DEADLINE_MS + 1)).rejects.toMatchObject({ status: 410 });
      expect(store.claimSave).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('탈퇴한 사용자(FK 위반)면 그 USER_ID만 비우고 1번 더 저장한다 (리뷰 L6)', async () => {
      subs.p2 = JSON.stringify({ verdict: 'VERIFIED', reason: null, userId: 9, battleEngineVersion: 1, replay: gzipSync('{}').toString('base64') });
      transaction.mockImplementationOnce(async () => {
        throw fkViolation();
      });
      userRepository.find.mockResolvedValueOnce([{ userId: 9 }] as User[]); // 42(p1)는 탈퇴, 9(p2)는 있음

      await submit(TOKEN(1), replayDto(), T_END + 1_000, 42);

      expect(transaction).toHaveBeenCalledTimes(2);
      const players = saved.filter((r) => r.entity === 'TetrisBattlePlayer').map((r) => [r.row.playerId, r.row.userId]);
      expect(players).toEqual([
        ['p1', null],
        ['p2', 9],
      ]);
      expect(store.markSaved).toHaveBeenCalled();
      expect(store.releaseSave).not.toHaveBeenCalled();
    });

    it('FK가 아닌 저장 실패는 재시도하지 않고 가드를 푼다', async () => {
      subs.p2 = JSON.stringify({ verdict: 'VERIFIED', reason: null, userId: null, battleEngineVersion: 1, replay: gzipSync('{}').toString('base64') });
      transaction.mockRejectedValueOnce(new Error('ORA-12541: TNS:no listener'));
      await submit();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(store.releaseSave).toHaveBeenCalled();
      expect(store.markSaved).not.toHaveBeenCalled();
    });

    it('topout 탈락자는 예상 제출자 — 생존자만 내면 아직 저장하지 않는다', async () => {
      await submit();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('한 명만 제출하면 아직 저장하지 않는다', async () => {
      await submit();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('전원 제출하면 바로 저장 — 경기 VERIFIED, 참가자 통계·verdict, 제출한 리플레이 행', async () => {
      subs.p2 = p2Record('VERIFIED');
      await submit(TOKEN(1), replayDto(), T_END + 1_000, 7);

      expect(transaction).toHaveBeenCalledTimes(1);
      const byEntity = (e: string) => saved.filter((s) => s.entity === e).map((s) => s.row);
      expect(byEntity('TetrisBattleMatch')).toEqual([
        expect.objectContaining({
          matchId: MATCH,
          roomName: '한판',
          seed: SURVIVOR.seed,
          playerCount: 2,
          status: 'VERIFIED',
          startedAt: new Date(T_END - 60_000),
          endedAt: new Date(T_END),
          isHidden: 0,
        }),
      ]);
      expect(byEntity('TetrisBattlePlayer')).toEqual([
        expect.objectContaining({ playerId: 'p1', userId: 7, place: 1, kos: 1, sent: 5, frames: 1100, koReason: null, verdict: 'VERIFIED' }),
        expect.objectContaining({ playerId: 'p2', userId: 9, place: 2, koReason: 'topout', frames: 900, verdict: 'VERIFIED' }),
      ]);
      expect(byEntity('TetrisBattleReplay').map((r) => r.playerId).sort()).toEqual(['p1', 'p2']);
      expect(byEntity('TetrisBattleReplay')[0].replay).toBeInstanceOf(Buffer);
    });

    it('재저장(기존 경기 행이 있음)이면 CRTD_AT를 보존한다 — 최근 대전 목록 정렬 키 유지 (리뷰 N2)', async () => {
      const original = new Date('2026-10-22T01:02:03.456Z');
      existingMatch = { matchId: MATCH, crtdAt: original };
      subs.p2 = p2Record('VERIFIED');
      await submit();
      expect(saved.find((s) => s.entity === 'TetrisBattleMatch')?.row.crtdAt).toEqual(original);
      expect(saved.filter((s) => s.entity === 'TetrisBattleReplay').every((s) => (s.row.crtdAt as Date).getTime() === original.getTime())).toBe(true);
    });

    it('INVALID가 하나라도 있으면 경기 DISPUTED', async () => {
      subs.p2 = p2Record('INVALID');
      await submit();
      expect(saved.find((s) => s.entity === 'TetrisBattleMatch')?.row.status).toBe('DISPUTED');
    });

    it('저장 가드를 다른 쪽이 이미 잡았으면 저장하지 않는다(정확히 1번)', async () => {
      subs.p2 = p2Record('VERIFIED');
      store.claimSave.mockResolvedValueOnce(false);
      await submit();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('저장이 실패해도 제출은 성공하고, 가드를 풀어 다음 계기에 다시 시도하게 한다', async () => {
      subs.p2 = p2Record('VERIFIED');
      transaction.mockRejectedValueOnce(new Error('ORA-00001'));
      await expect(submit()).resolves.toEqual({ verdict: 'VERIFIED' });
      expect(store.releaseSave).toHaveBeenCalledWith(expect.anything(), MATCH);
    });
  });

  describe('조회', () => {
    it('조회가 마감 뒤 첫 계기면 저장한 다음 읽는다', async () => {
      matchRepository.findOne.mockResolvedValueOnce({
        matchId: MATCH, roomName: '한판', playerCount: 2, startedAt: new Date(0), endedAt: new Date(1),
      } as TetrisBattleMatch);
      playerRepository.find.mockResolvedValueOnce([]);
      await service.getMatch(MATCH, T_END + REPLAY_SUBMIT_DEADLINE_MS + 1);
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('숨김 아님이면 DISPUTED도 조회하고(검증 실패는 참가자 단위, D-004) 참가자를 순위순·판정 그대로 돌려준다', async () => {
      matchRepository.findOne.mockResolvedValueOnce({
        matchId: MATCH, roomName: '한판', playerCount: 3, startedAt: new Date(0), endedAt: new Date(1), status: 'DISPUTED',
      } as TetrisBattleMatch);
      playerRepository.find.mockResolvedValueOnce([
        { playerId: 'p1', name: 'a', place: 1, kos: 1, sent: 3, received: 0, pieces: 9, maxCombo: 2, frames: 99, koReason: null, verdict: 'VERIFIED' },
        { playerId: 'p2', name: 'b', place: 2, kos: 0, sent: 0, received: 3, pieces: 5, maxCombo: 0, frames: 50, koReason: 'leave', verdict: 'MISSING' },
        { playerId: 'p3', name: 'c', place: 3, kos: 0, sent: 0, received: 0, pieces: 2, maxCombo: 0, frames: 20, koReason: 'topout', verdict: 'INVALID' },
      ] as TetrisBattlePlayer[]);

      const data = await service.getMatch(MATCH, T_END);

      expect(matchRepository.findOne).toHaveBeenCalledWith({ where: { matchId: MATCH, isHidden: 0 } });
      expect(playerRepository.find).toHaveBeenCalledWith({ where: { matchId: MATCH }, order: { place: 'ASC' } });
      expect(data.disputed).toBe(true);
      expect(data.players.map((p) => [p.playerId, p.verdict])).toEqual([
        ['p1', 'VERIFIED'],
        ['p2', 'MISSING'],
        ['p3', 'INVALID'],
      ]);
    });

    it('INVALID 참가자의 리플레이는 404 (D-004)', async () => {
      matchRepository.findOne.mockResolvedValue({ matchId: MATCH, status: 'DISPUTED' } as TetrisBattleMatch);
      playerRepository.findOne.mockResolvedValueOnce({ verdict: 'INVALID' } as TetrisBattlePlayer);
      await expect(service.getReplay(MATCH, 'p3')).rejects.toMatchObject({ status: 404 });
    });

    it('없음·숨김(조건에 안 걸림)은 404', async () => {
      matchRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.getMatch(MATCH, T_END)).rejects.toMatchObject({ status: 404, code: 'TETRIS_BATTLE_MATCH_NOT_FOUND' });
    });

    it('리플레이: VERIFIED 참가자만, 본문은 gunzip해서', async () => {
      const body = { seed: 1, das: 10, arr: 2, frames: 60, inputs: [0, 1], garbage: [] };
      matchRepository.findOne.mockResolvedValue({ matchId: MATCH } as TetrisBattleMatch);
      playerRepository.findOne.mockResolvedValueOnce({ verdict: 'VERIFIED' } as TetrisBattlePlayer);
      replayRepository.findOne.mockResolvedValueOnce({ battleEngineVersion: 1, replay: gzipSync(JSON.stringify(body)) } as TetrisBattleReplay);

      await expect(service.getReplay(MATCH, 'p1')).resolves.toEqual({ matchId: MATCH, playerId: 'p1', battleEngineVersion: 1, ...body });

      playerRepository.findOne.mockResolvedValueOnce({ verdict: 'MISSING' } as TetrisBattlePlayer);
      await expect(service.getReplay(MATCH, 'p2')).rejects.toMatchObject({ status: 404, code: 'TETRIS_BATTLE_REPLAY_NOT_FOUND' });
      await expect(service.getReplay(MATCH, 'x1')).rejects.toMatchObject({ status: 404, code: 'TETRIS_BATTLE_REPLAY_NOT_FOUND' });
    });
  });
});
