import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { FortressMatch } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { FortressReplay } from '../../entities/FortressReplay';
import { User } from '../../entities/User';
import { encodeMatchCursor } from '../tetris-battle/tetris-battle-browse.service';
import { type MatchConfig, ENGINE_VERSION } from './engine';
import { FortressMatchService } from './fortress-match.service';
import { FortressMatchStore } from './fortress-match.store';
import { FortressPointsService } from './fortress-points.service';
import * as pointsRules from './fortress-points.rules';
import golden from './engine/__fixtures__/golden-matches.json';
import type { Action } from './engine';
import { FortressResultService } from './fortress-result.service';
import { LAZY_SAVE_POLL_INTERVAL_MS, LAZY_SAVE_WAIT_MAX_MS, MATCH_START_DELAY_MS, PENDING_SAVE_RETRY_MS } from './fortress.constants';
import { createRedisMock } from './__spec__/redis-mock';

const T0 = 1_800_000_000_000;
const T_END = T0 + 5_000;
const MATCH_ID = 'AAAAAAAAAAAAAAAA';
const CODE = 'ABCDEF';
const CONFIG: MatchConfig = {
  seed: 12345,
  mapId: 'canyon',
  mode: 'ffa',
  players: [
    { slot: 0, team: 0, tankId: 2 },
    { slot: 1, team: 0, tankId: 1 },
  ],
};
const SAVED_KEY = `fortress:match:${MATCH_ID}:saved`;
const SAVING_KEY = `fortress:match:${MATCH_ID}:saving`;

/** oracledb가 던지는 제약 위반 형태 — TypeORM QueryFailedError + driverError.errorNum */
const oraError = (errorNum: number) => new QueryFailedError('INSERT ...', [], Object.assign(new Error(`ORA-${errorNum}`), { errorNum }));

const matchRow = (over: Partial<FortressMatch> = {}): FortressMatch => ({
  matchId: MATCH_ID,
  roomName: '한판',
  mode: 'ffa',
  mapId: 'canyon',
  seed: 12345,
  engineVersion: ENGINE_VERSION,
  playerCount: 2,
  turns: 0,
  resultKind: 'win',
  winnerTeam: null,
  startedAt: new Date(T0),
  endedAt: new Date(T_END),
  isHidden: 0,
  crtdAt: new Date(T_END + 100),
  ...over,
});

/**
 * 포트리스 결과 저장·조회 (DESIGN §12). 경기 서비스·엔진은 진짜(Redis 대역 위)로 끝난 경기를 만들고, DB 경계(Repository·DataSource)만 대역이다.
 * 저장 값이 matchEnded 방송과 같은지 · 정확히 1번(완료 표시·가드·기존 행·PK 위반) · 실패 시 재시도 여지 · 조회 lazy 저장 · 에러 status·code를 본다
 */
describe('FortressResultService', () => {
  let mock: ReturnType<typeof createRedisMock>;
  let matches: FortressMatchService;
  let matchRepository: MockRepository<FortressMatch>;
  let playerRepository: MockRepository<FortressPlayer>;
  let replayRepository: MockRepository<FortressReplay>;
  let userRepository: MockRepository<User>;
  let created: { entity: string; row: Record<string, unknown> }[];
  let existingInTx: boolean;
  let saveFailures: Error[];
  let transaction: jest.Mock;
  let env: Record<string, string | undefined>;
  let points: { awardInTransaction: jest.Mock; pointsOf: jest.Mock };

  const newService = () =>
    new FortressResultService(
      matches,
      matchRepository as unknown as Repository<FortressMatch>,
      playerRepository as unknown as Repository<FortressPlayer>,
      replayRepository as unknown as Repository<FortressReplay>,
      userRepository as unknown as Repository<User>,
      { transaction } as unknown as DataSource,
      { get: (key: string) => env[key] } as unknown as ConfigService,
      points as unknown as FortressPointsService,
    );
  const rowsOf = (entity: string) => created.filter((c) => c.entity === entity).map((c) => c.row);

  /** 2인 경기를 만들고 p2(로그인 아님)가 나가 끝낸다 — p1(userId 7) 승 */
  const endMatch = async () => {
    await matches.create(
      {
        matchId: MATCH_ID,
        code: CODE,
        roomName: '한판',
        config: CONFIG,
        slots: [
          { slot: 0, playerId: 'p1', name: '포병', userId: 7 },
          { slot: 1, playerId: 'p2', name: '손님', userId: null },
        ],
      },
      T0,
    );
    await matches.resign(MATCH_ID, 'p2', 'leave', T_END);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mock = createRedisMock();
    matches = new FortressMatchService();
    matches.setRedisClient(mock.redis as unknown as Redis);
    matches.setWakeScheduler(() => undefined);
    matchRepository = createMockRepository<FortressMatch>();
    playerRepository = createMockRepository<FortressPlayer>();
    replayRepository = createMockRepository<FortressReplay>();
    userRepository = createMockRepository<User>();
    created = [];
    existingInTx = false;
    saveFailures = [];
    env = { ENV: 'PROD', TASK_SLOT: '1' };
    points = { awardInTransaction: jest.fn().mockResolvedValue(undefined), pointsOf: jest.fn() };
    const manager = {
      findOne: jest.fn(async () => (existingInTx ? { matchId: MATCH_ID } : null)),
      create: (entity: { name: string }, row: Record<string, unknown>) => (created.push({ entity: entity.name, row }), row),
      save: jest.fn(async (row: unknown) => {
        const failure = saveFailures.shift();
        if (failure) throw failure;
        return row;
      }),
    };
    transaction = jest.fn(async (run: (m: typeof manager) => Promise<unknown>) => {
      const before = created.length;
      try {
        return await run(manager);
      } catch (error) {
        created.splice(before); // 롤백
        throw error;
      }
    });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('saveIfEnded', () => {
    it('끝난 경기: 경기·참가자·리플레이를 matchEnded와 같은 값으로 1 트랜잭션에 저장 → 완료 표시 · 저장 대기에서 뺀다 · 가드 해제', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined); // 방송 뒤 저장 훅은 기다리지 않으므로 끄고 직접 부른다(훅 경로는 다음 테스트)
      await endMatch();
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(T_END);
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');

      expect(transaction).toHaveBeenCalledTimes(1);
      const stored = mock.readMatch(MATCH_ID);
      if (!stored) throw new Error('match');
      const ended = matches.endedPayload(stored);
      expect(rowsOf('FortressMatch')).toEqual([
        expect.objectContaining({
          matchId: MATCH_ID,
          roomName: '한판',
          mode: 'ffa',
          mapId: 'canyon',
          seed: 12345,
          engineVersion: ENGINE_VERSION,
          playerCount: 2,
          turns: stored.state.turn.no,
          resultKind: 'win',
          winnerTeam: null,
          startedAt: new Date(T0),
          endedAt: new Date(T_END),
          isHidden: 0,
          crtdAt: expect.any(Date),
        }),
      ]);
      expect(rowsOf('FortressPlayer')).toEqual(
        ended.players.map((p) => ({
          matchId: MATCH_ID,
          playerId: p.playerId,
          slot: p.slot,
          name: p.name,
          userId: p.playerId === 'p1' ? 7 : null,
          team: null,
          tankId: p.slot === 0 ? 2 : 1,
          hp: p.hp,
          damage: p.damage,
          kos: p.kos,
          place: p.place,
        })),
      );
      expect(rowsOf('FortressPlayer').map((p) => [p.playerId, p.place])).toEqual([
        ['p1', 1],
        ['p2', 2],
      ]);
      const replay = rowsOf('FortressReplay')[0];
      expect(replay).toMatchObject({ matchId: MATCH_ID, engineVersion: ENGINE_VERSION });
      expect(JSON.parse(gunzipSync(replay.replay as Buffer).toString('utf8'))).toEqual({
        config: CONFIG,
        actions: [{ kind: 'resign', slot: 1 }],
        // F7: 시작 때 고정한 탱크 스킨 — 방 서비스 없이 만든 경기(skin 없음)는 default
        slots: [
          { slot: 0, playerId: 'p1', name: '포병', skin: { id: 'default', level: 1 } },
          { slot: 1, playerId: 'p2', name: '손님', skin: { id: 'default', level: 1 } },
        ],
        stateHash: stored.stateHash,
      });
      // F7: 같은 트랜잭션에서 적립 — 게스트 상대가 첫 턴에 나가 끝난 경기(6턴 미만)라 적립 대상 없음
      expect(points.awardInTransaction).toHaveBeenCalledWith(expect.anything(), MATCH_ID, [], rowsOf('FortressMatch')[0].crtdAt);
      expect(mock.strings.get(SAVED_KEY)).toBe('1');
      expect(mock.strings.has(SAVING_KEY)).toBe(false);
      expect(mock.pendingSaveOf(MATCH_ID)).toBeUndefined();

      // 두 번째부터는 완료 표시만 보고 끝 — 트랜잭션 없음
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('경기를 끝낸 레플리카가 방송 뒤 저장 훅으로 바로 저장한다(기다리지 않음)', async () => {
      newService();
      await endMatch();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(mock.strings.get(SAVED_KEY)).toBe('1');
    });

    it('진행 중이면 not-ended(저장 안 함) · 경기 키가 없으면 missing + 저장 대기에서 뺀다', async () => {
      const service = newService();
      await matches.create({ matchId: MATCH_ID, code: CODE, roomName: '한판', config: CONFIG, slots: [
        { slot: 0, playerId: 'p1', name: '포병', userId: null },
        { slot: 1, playerId: 'p2', name: '손님', userId: null },
      ] }, T0);
      await expect(service.saveIfEnded(MATCH_ID, T0)).resolves.toBe('not-ended');

      await mock.redis.zadd('fortress:pending-saves', T0, 'BBBBBBBBBBBBBBBB');
      await expect(service.saveIfEnded('BBBBBBBBBBBBBBBB', T0)).resolves.toBe('missing');
      expect(mock.pendingSaveOf('BBBBBBBBBBBBBBBB')).toBeUndefined();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('다른 저장이 진행 중(가드)이면 busy — 저장하지 않고 대기는 남는다', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      mock.strings.set(SAVING_KEY, '1');
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('busy');
      expect(transaction).not.toHaveBeenCalled();
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(T_END);
    });

    it('트랜잭션 실패 → failed · 완료 표시 없음 · 가드 해제 · 저장 대기 유지(다음 계기에 다시)', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      saveFailures.push(new Error('ORA-03113'));
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('failed');
      expect(mock.strings.has(SAVED_KEY)).toBe(false);
      expect(mock.strings.has(SAVING_KEY)).toBe(false);
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(T_END);

      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      expect(rowsOf('FortressMatch')).toHaveLength(1);
    });

    it('경기 행이 이미 있으면(완료 표시 유실) 아무것도 넣지 않고 saved', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      existingInTx = true;
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      expect(created).toHaveLength(0);
      expect(mock.strings.get(SAVED_KEY)).toBe('1');
    });

    it('동시 저장 경합으로 PK 위반(ORA-00001)이고 경기 행이 있으면 이미 저장된 것으로 본다', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      saveFailures.push(oraError(1));
      matchRepository.exists.mockResolvedValue(true);
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      expect(matchRepository.exists).toHaveBeenCalledWith({ where: { matchId: MATCH_ID } });
      expect(mock.pendingSaveOf(MATCH_ID)).toBeUndefined();
    });

    it('리뷰 A2: 유니크 위반인데 경기 행이 없으면(참가자·원장 위반) failed — 완료 표시 없음 · 저장 대기 유지', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      saveFailures.push(oraError(1));
      matchRepository.exists.mockResolvedValue(false);
      const markSaved = jest.spyOn(FortressMatchStore.prototype, 'markSaved');
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('failed');
      expect(markSaved).not.toHaveBeenCalled();
      expect(mock.strings.has(SAVED_KEY)).toBe(false);
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(T_END);
    });

    it('그 사이 탈퇴한 사용자(FK 위반 ORA-02291)면 그 USER_ID만 비우고 1번 더 저장한다', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      saveFailures.push(oraError(2291));
      userRepository.find.mockResolvedValue([]);
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(rowsOf('FortressPlayer').map((p) => p.userId)).toEqual([null, null]);
      expect(rowsOf('FortressMatch')).toHaveLength(1);
    });
  });

  describe('sweepPendingSaves', () => {
    it('QA·PROD + TASK_SLOT 1에서만 돈다 — LOCAL·슬롯 2는 아무것도 하지 않는다', async () => {
      matches.setSaveHook(async () => undefined);
      await endMatch();
      for (const e of [{ ENV: 'LOCAL', TASK_SLOT: '1' }, { ENV: 'PROD', TASK_SLOT: '2' }]) {
        env = e;
        const service = newService();
        matches.setSaveHook(async () => undefined);
        await service.sweepPendingSaves(T_END + 1);
      }
      expect(transaction).not.toHaveBeenCalled();
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(T_END);
    });

    it('지난 대기를 저장하고 빼며, 진행 중 경기는 뒤로 미룬다', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      const PLAYING = 'CCCCCCCCCCCCCCCC';
      await matches.create({ matchId: PLAYING, code: 'GHJKMN', roomName: '진행', config: CONFIG, slots: [
        { slot: 0, playerId: 'p1', name: 'a', userId: null },
        { slot: 1, playerId: 'p2', name: 'b', userId: null },
      ] }, T0);
      await mock.redis.zadd('fortress:pending-saves', T0, PLAYING);

      await service.sweepPendingSaves(T_END + 1);
      expect(mock.strings.get(SAVED_KEY)).toBe('1');
      expect(mock.pendingSaveOf(MATCH_ID)).toBeUndefined();
      expect(mock.pendingSaveOf(PLAYING)).toBe(T_END + 1 + PENDING_SAVE_RETRY_MS);
    });
  });

  describe('getMatch', () => {
    it('저장된 경기 → 순위·slot 순 참가자, 팀은 0|1|null, userId는 싣지 않는다', async () => {
      const service = newService();
      matchRepository.findOne.mockResolvedValue(matchRow({ mode: 'team', winnerTeam: 1 }));
      playerRepository.find.mockResolvedValue([
        { matchId: MATCH_ID, playerId: 'p2', slot: 1, name: 'b', userId: 9, team: 1, tankId: 0, hp: 50, damage: 120, kos: 1, place: 1 },
        { matchId: MATCH_ID, playerId: 'p1', slot: 0, name: 'a', userId: null, team: 0, tankId: 1, hp: 0, damage: 30, kos: 0, place: 3 },
      ]);
      const dto = await service.getMatch(MATCH_ID);
      expect(matchRepository.findOne).toHaveBeenCalledWith({ where: { matchId: MATCH_ID, isHidden: 0 } });
      expect(playerRepository.find).toHaveBeenCalledWith({ where: { matchId: MATCH_ID }, order: { place: 'ASC', slot: 'ASC' } });
      expect(dto).toMatchObject({ matchId: MATCH_ID, mode: 'team', result: { kind: 'win', team: 1 }, startedAt: new Date(T0) });
      expect(dto.players[0]).toEqual({ playerId: 'p2', name: 'b', slot: 1, team: 1, tankId: 0, hp: 50, damage: 120, kos: 1, place: 1 });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('DB에 없고 Redis에 끝난 경기가 있으면 그 자리에서 저장한 뒤 돌려준다', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      matchRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(matchRow());
      playerRepository.find.mockResolvedValue([]);
      await expect(service.getMatch(MATCH_ID, T_END)).resolves.toMatchObject({ matchId: MATCH_ID });
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    describe('리뷰 A1: 다른 레플리카가 저장 중(busy)이면 상한까지 DB 행을 기다린다', () => {
      beforeEach(() => jest.useFakeTimers({ now: T_END }));
      afterEach(() => jest.useRealTimers());

      it('기다리는 사이 행이 생기면 그 행을 돌려준다', async () => {
        const service = newService();
        matches.setSaveHook(async () => undefined);
        await endMatch();
        mock.strings.set(SAVING_KEY, '1');
        matchRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(matchRow());
        playerRepository.find.mockResolvedValue([]);

        const pending = service.getMatch(MATCH_ID, T_END);
        await jest.advanceTimersByTimeAsync(LAZY_SAVE_POLL_INTERVAL_MS * 2);
        await expect(pending).resolves.toMatchObject({ matchId: MATCH_ID });
        expect(matchRepository.findOne).toHaveBeenCalledTimes(3);
        expect(transaction).not.toHaveBeenCalled();
      });

      it('상한까지 행이 없으면 404 FORTRESS_MATCH_NOT_FOUND', async () => {
        const service = newService();
        matches.setSaveHook(async () => undefined);
        await endMatch();
        mock.strings.set(SAVING_KEY, '1');
        matchRepository.findOne.mockResolvedValue(null);

        const pending = service.getMatch(MATCH_ID, T_END);
        const settled = expect(pending).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });
        await jest.advanceTimersByTimeAsync(LAZY_SAVE_WAIT_MAX_MS);
        await settled;
        expect(matchRepository.findOne).toHaveBeenCalledTimes(1 + LAZY_SAVE_WAIT_MAX_MS / LAZY_SAVE_POLL_INTERVAL_MS);
      });
    });

    it('404 FORTRESS_MATCH_NOT_FOUND — 형식 오류(DB 조회 없음) · 없음 · 진행 중 · 숨김(저장 완료 표시만 있음)', async () => {
      const service = newService();
      await expect(service.getMatch('short')).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });
      expect(matchRepository.findOne).not.toHaveBeenCalled();

      matchRepository.findOne.mockResolvedValue(null);
      await expect(service.getMatch('ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });

      await matches.create({ matchId: MATCH_ID, code: CODE, roomName: '한판', config: CONFIG, slots: [
        { slot: 0, playerId: 'p1', name: 'a', userId: null },
        { slot: 1, playerId: 'p2', name: 'b', userId: null },
      ] }, T0);
      await expect(service.getMatch(MATCH_ID)).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });

      mock.strings.set(SAVED_KEY, '1'); // 저장됐지만 IS_HIDDEN=1 → findOne(isHidden 0)이 null
      await expect(service.getMatch(MATCH_ID)).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('getReplay', () => {
    it('gzip 본문을 풀어 engineVersion과 함께 돌려준다', async () => {
      const service = newService();
      const body = { config: CONFIG, actions: [{ kind: 'skip' }], slots: [{ slot: 0, playerId: 'p1', name: 'a' }], stateHash: 'deadbeef' };
      matchRepository.findOne.mockResolvedValue(matchRow());
      replayRepository.findOne.mockResolvedValue({ matchId: MATCH_ID, engineVersion: 1, replay: gzipSync(JSON.stringify(body)), crtdAt: new Date(T_END) });
      // F7 전 본문(skin 없음)은 default로 채운다
      await expect(service.getReplay(MATCH_ID)).resolves.toEqual({
        matchId: MATCH_ID,
        engineVersion: 1,
        ...body,
        slots: [{ slot: 0, playerId: 'p1', name: 'a', skin: { id: 'default', level: 1 } }],
      });
    });

    it('F7 이후 본문은 저장된 스킨 그대로(카탈로그와 대조하지 않는다)', async () => {
      const service = newService();
      const slots = [{ slot: 0, playerId: 'p1', name: 'a', skin: { id: 'retired-item', level: 4 } }];
      const body = { config: CONFIG, actions: [], slots, stateHash: 'deadbeef' };
      matchRepository.findOne.mockResolvedValue(matchRow());
      replayRepository.findOne.mockResolvedValue({ matchId: MATCH_ID, engineVersion: 1, replay: gzipSync(JSON.stringify(body)), crtdAt: new Date(T_END) });
      await expect(service.getReplay(MATCH_ID)).resolves.toMatchObject({ slots });
    });

    it('404 — 경기 없음 FORTRESS_MATCH_NOT_FOUND · 리플레이 행 없음 FORTRESS_REPLAY_NOT_FOUND', async () => {
      const service = newService();
      matchRepository.findOne.mockResolvedValue(null);
      await expect(service.getReplay(MATCH_ID)).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });
      matchRepository.findOne.mockResolvedValue(matchRow());
      replayRepository.findOne.mockResolvedValue(null);
      await expect(service.getReplay(MATCH_ID)).rejects.toMatchObject({ status: 404, code: 'FORTRESS_REPLAY_NOT_FOUND' });
    });
  });

  describe('F7 포인트 — 저장 트랜잭션에 기본 적립을 넘긴다', () => {
    type GoldenCase = { name: string; config: MatchConfig; actions: Action[] };
    const DUEL = (golden as unknown as GoldenCase[]).find((c) => c.name === 'ffa 2인 hills AI 중·중');
    const store = new FortressMatchStore();

    /** 골든 경기를 실제 경기 서비스에 턴마다 제출해 끝낸다 — p1(slot 0, userId 7) · p2(slot 1, userId 8 또는 게스트) */
    const playGolden = async (secondUserId: number | null) => {
      if (!DUEL) throw new Error('골든 경기 없음');
      await matches.create(
        {
          matchId: MATCH_ID,
          code: CODE,
          roomName: '한판',
          config: DUEL.config,
          slots: [
            { slot: 0, playerId: 'p1', name: '포병', userId: 7, skin: { id: 'desert', level: 3 } },
            { slot: 1, playerId: 'p2', name: '둘째', userId: secondUserId },
          ],
        },
        T0,
      );
      for (const [seq, action] of DUEL.actions.entries()) {
        if (action.kind !== 'fire') throw new Error('fire만 있는 골든');
        const loaded = await store.load(mock.redis as unknown as Redis, MATCH_ID);
        const playerId = loaded?.match.state.turn.slot === 0 ? 'p1' : 'p2';
        await matches.submit(MATCH_ID, playerId, { seq, move: action.move, angle: action.angle, power: action.power, weaponId: action.weaponId }, T0 + MATCH_START_DELAY_MS + seq);
      }
    };

    it('로그인 2명 유효 경기: 슬롯별 실제 발사로 유효 판정, 승자는 승리·KO까지, 리플레이 slots에 시작 때 스킨', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      const baseAwards = jest.spyOn(pointsRules, 'baseAwards');
      await playGolden(8);
      const stored = mock.readMatch(MATCH_ID);
      if (!stored || stored.status !== 'ENDED') throw new Error('경기가 끝나지 않음');
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      // 최소 턴 판정은 playedTurns — 승패로 끝나 엔진이 turn.no를 올리지 않은 마지막 턴까지 센다(리뷰 B2, turn.no 그대로면 1 적다)
      expect(stored.state.turn.no).toBeLessThan(stored.state.maxTurns);
      expect(baseAwards).toHaveBeenCalledWith(expect.objectContaining({ turns: stored.state.turn.no + 1 }));

      const ended = matches.endedPayload(stored);
      const kosOf = (slot: number) => ended.players.find((p) => p.slot === slot)?.kos ?? 0;
      const [, , awards] = points.awardInTransaction.mock.calls[0] as [unknown, string, { playerId: string }[]];
      // 골든 결과: slot 0 승. 25발을 번갈아 쏴 두 사람 모두 3발 이상, 경기 6턴 이상
      expect(stored.state.turn.no).toBeGreaterThanOrEqual(6);
      expect(awards).toEqual([
        { userId: 7, playerId: 'p1', participation: 20_000, win: 30_000, ko: Math.min(kosOf(0), 3) * 10_000, others: [8] },
        { userId: 8, playerId: 'p2', participation: 20_000, win: 0, ko: Math.min(kosOf(1), 3) * 10_000, others: [7] },
      ]);
      const replay = rowsOf('FortressReplay')[0];
      const body = JSON.parse(gunzipSync(replay.replay as Buffer).toString('utf8')) as { slots: unknown[] };
      expect(body.slots).toEqual([
        { slot: 0, playerId: 'p1', name: '포병', skin: { id: 'desert', level: 3 } },
        { slot: 1, playerId: 'p2', name: '둘째', skin: { id: 'default', level: 1 } },
      ]);
    });

    it('상대가 게스트면 로그인 1명 — 승리·KO 없이 참가만, 게스트는 대상 아님', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await playGolden(null);
      await service.saveIfEnded(MATCH_ID, T_END);
      const [, , awards] = points.awardInTransaction.mock.calls[0] as [unknown, string, unknown[]];
      expect(awards).toEqual([{ userId: 7, playerId: 'p1', participation: 20_000, win: 0, ko: 0, others: [] }]);
    });

    it('적립이 실패하면 경기 저장도 롤백 — failed, 완료 표시 없음, 저장 대기 유지(다시 저장할 때 적립도 다시)', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      points.awardInTransaction.mockRejectedValueOnce(new Error('ORA-00060 deadlock'));
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('failed');
      expect(created).toEqual([]);
      expect(mock.strings.has(SAVED_KEY)).toBe(false);
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(T_END);
    });

    it('경기 행이 이미 있으면 적립도 부르지 않는다(두 번 적립 없음)', async () => {
      const service = newService();
      matches.setSaveHook(async () => undefined);
      await endMatch();
      existingInTx = true;
      await expect(service.saveIfEnded(MATCH_ID, T_END)).resolves.toBe('saved');
      expect(points.awardInTransaction).not.toHaveBeenCalled();
    });

    it('getMyPoints: 저장된 경기면 포인트 서비스로 · 없는 경기는 404 FORTRESS_MATCH_NOT_FOUND', async () => {
      const service = newService();
      matchRepository.findOne.mockResolvedValue(matchRow());
      points.pointsOf.mockResolvedValue({ matchId: MATCH_ID, participant: true, earned: 50_000, memo: 'm' });
      await expect(service.getMyPoints(MATCH_ID, 7)).resolves.toEqual({ matchId: MATCH_ID, participant: true, earned: 50_000, memo: 'm' });
      expect(points.pointsOf).toHaveBeenCalledWith(MATCH_ID, 7);
      matchRepository.findOne.mockResolvedValue(null);
      await expect(service.getMyPoints(MATCH_ID, 7)).rejects.toMatchObject({ status: 404, code: 'FORTRESS_MATCH_NOT_FOUND' });
    });
  });

  describe('listMatches', () => {
    it('limit+1로 다음 페이지를 판단하고 참가자는 IN 1번으로 묶는다(순위·slot 순)', async () => {
      const service = newService();
      const a = matchRow({ matchId: 'AAAAAAAAAAAAAAA1', crtdAt: new Date(T0 + 2) });
      const b = matchRow({ matchId: 'AAAAAAAAAAAAAAA2', crtdAt: new Date(T0 + 1), mode: 'team', resultKind: 'draw' });
      matchRepository.find.mockResolvedValue([a, b, matchRow({ matchId: 'AAAAAAAAAAAAAAA3' })]);
      playerRepository.find.mockResolvedValue([
        { matchId: a.matchId, playerId: 'p2', slot: 1, name: 'y', userId: null, team: null, tankId: 0, hp: 0, damage: 0, kos: 0, place: 2 },
        { matchId: a.matchId, playerId: 'p1', slot: 0, name: 'x', userId: null, team: null, tankId: 0, hp: 9, damage: 0, kos: 0, place: 1 },
        { matchId: b.matchId, playerId: 'p1', slot: 0, name: 'z', userId: null, team: 0, tankId: 0, hp: 9, damage: 0, kos: 0, place: 1 },
      ]);
      const page = await service.listMatches({ limit: 2 });
      expect(matchRepository.find).toHaveBeenCalledWith(expect.objectContaining({ take: 3, order: { crtdAt: 'DESC', matchId: 'DESC' } }));
      expect(page.items.map((i) => i.matchId)).toEqual([a.matchId, b.matchId]);
      expect(page.items[0].players).toEqual([
        { name: 'x', slot: 0, team: null, place: 1 },
        { name: 'y', slot: 1, team: null, place: 2 },
      ]);
      expect(page.items[1]).toMatchObject({ mode: 'team', result: { kind: 'draw', team: null } });
      expect(page.nextCursor).toBe(encodeMatchCursor({ t: b.crtdAt.getTime(), id: b.matchId }));
    });

    it('빈 목록 · 마지막 페이지는 nextCursor null · 잘못된 cursor는 422 VALIDATION_ERROR', async () => {
      const service = newService();
      matchRepository.find.mockResolvedValue([]);
      await expect(service.listMatches({})).resolves.toEqual({ items: [], nextCursor: null });
      expect(playerRepository.find).not.toHaveBeenCalled();
      await expect(service.listMatches({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    });
  });
});
