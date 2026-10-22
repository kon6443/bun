import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { gzipSync } from 'node:zlib';
import { DataSource } from 'typeorm';
import { TetrisBattleResultController } from '../src/modules/tetris-battle/tetris-battle-result.controller';
import { TetrisBattleResultService } from '../src/modules/tetris-battle/tetris-battle-result.service';
import { TetrisBattleRoomService } from '../src/modules/tetris-battle/tetris-battle-room.service';
import { MatchSnapshot, TetrisBattleMatchStore } from '../src/modules/tetris-battle/tetris-battle-match.store';
import { BattleReplayInput, simulateBattleReplay } from '../src/modules/tetris-battle/battle-engine';
import golden from '../src/modules/tetris-battle/battle-engine/__fixtures__/golden-battle-replays.json';
import { TetrisBattleMatch } from '../src/entities/TetrisBattleMatch';
import { TetrisBattlePlayer } from '../src/entities/TetrisBattlePlayer';
import { TetrisBattleReplay } from '../src/entities/TetrisBattleReplay';
import { User } from '../src/entities/User';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const MATCH = 'AbCdEfGhIjKlMnOp';
const TOKEN_P1 = 'A'.repeat(32);
const TOKEN_P2 = 'B'.repeat(32);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const SURVIVOR = (golden as unknown as { name: string; input: BattleReplayInput }[]).find((c) => c.name === 'survivor')!.input;
const SIM = simulateBattleReplay(SURVIVOR);
if (!SIM.ok) throw new Error('survivor 골든은 성공이어야 한다');

const snapshot = (over: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  matchId: MATCH,
  code: 'ABCDEF',
  seed: SURVIVOR.seed,
  startedAt: Date.now() - 60_000,
  status: 'ENDED',
  roomName: '한판',
  clockStart: 0,
  endedClock: 3_600_000,
  endedAt: Date.now() - 1_000, // 방금 끝남 → 마감 전
  players: [
    { playerId: 'p1', name: '우승자', userId: null, alive: true, seq: SIM.pieces, frame: 1, pieces: SIM.pieces, sent: 0, received: 0,
      maxCombo: 0, kos: 1, board: null, pending: 0, combo: -1, b2b: false, place: 1, frames: 1, koReason: null, disconnectedAt: null,
      koClock: null, tokenHash: hash(TOKEN_P1) },
    { playerId: 'p2', name: '도전자', userId: null, alive: false, seq: 3, frame: 1, pieces: 3, sent: 0, received: 0,
      maxCombo: 0, kos: 0, board: null, pending: 0, combo: -1, b2b: false, place: 2, frames: 1, koReason: 'leave', disconnectedAt: null,
      koClock: 1_000, tokenHash: hash(TOKEN_P2) },
  ],
  ...over,
});

/**
 * 대전 경기 후 검증 REST를 HTTP 경계에서 검증한다 (DESIGN §17).
 * 실제 컨트롤러·서비스·**실제 대전 래퍼 검증**(골든 'survivor')을 태우고 Redis 매치 저장소·Repository·DataSource만 대역으로 바꾼다.
 * 여기서 보는 것: 상태코드(201/403/404/409/410/413/422) · 전역 ValidationPipe(whitelist·forbidNonWhitelisted) · 응답 형태.
 * 라우트 스로틀은 E2E가 CustomThrottlerGuard를 조립하지 않아 보지 않는다(games E2E와 같음).
 */
describe('E2E 테트리스 대전 결과', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let subs: Record<string, string>;
  let matchRepository: MockRepository<TetrisBattleMatch>;
  let playerRepository: MockRepository<TetrisBattlePlayer>;
  let replayRepository: MockRepository<TetrisBattleReplay>;
  let saved: unknown[];

  const submit = (body: unknown, matchId = MATCH) => request(app.getHttpServer()).post(e2e.url(`/tetris-battle/matches/${matchId}/replays`)).send(body as object);

  beforeEach(async () => {
    subs = {};
    saved = [];
    const proto = TetrisBattleMatchStore.prototype;
    jest.spyOn(proto, 'snapshot').mockResolvedValue(snapshot());
    jest.spyOn(proto, 'garbageLog').mockImplementation(async (_r, _m, pid) => {
      if (pid !== 'p1') return [];
      const g = [];
      for (let i = 0; i < SURVIVOR.garbage.length; i += 4) g.push({ id: SURVIVOR.garbage[i + 1], lines: SURVIVOR.garbage[i + 2], hole: SURVIVOR.garbage[i + 3], at: 1_000 });
      return g;
    });
    jest
      .spyOn(proto, 'sentLog')
      .mockImplementation(async (_r, _m, pid) => (pid === 'p1' ? SIM.sent.filter((l) => l.sent > 0).map((l) => ({ seq: l.seq, sent: l.sent })) : []));
    jest.spyOn(proto, 'submissions').mockImplementation(async () => ({ ...subs }));
    let closed = false;
    jest.spyOn(proto, 'claimSubmission').mockImplementation(async (_r, _m, pid, record) => {
      if (closed) return 'CLOSED';
      if (subs[pid]) return 'DUPLICATE';
      subs[pid] = record;
      return 'CLAIMED';
    });
    jest.spyOn(proto, 'closeSubmissions').mockImplementation(async () => ((closed = true), { ...subs }));
    jest.spyOn(proto, 'markSaved').mockResolvedValue(undefined);
    jest.spyOn(proto, 'isSaved').mockResolvedValue(false);
    jest.spyOn(proto, 'claimSave').mockResolvedValue(true);
    jest.spyOn(proto, 'releaseSave').mockResolvedValue(undefined);

    matchRepository = createMockRepository<TetrisBattleMatch>();
    playerRepository = createMockRepository<TetrisBattlePlayer>();
    replayRepository = createMockRepository<TetrisBattleReplay>();
    const manager = {
      create: (_e: unknown, row: Record<string, unknown>) => row,
      save: async (row: unknown) => (saved.push(row), row),
    };

    e2e = await createE2eApp({
      controllers: [TetrisBattleResultController],
      providers: [
        TetrisBattleResultService,
        { provide: TetrisBattleRoomService, useValue: { readyRedisClient: () => ({}) } },
        { provide: getRepositoryToken(TetrisBattleMatch), useValue: matchRepository },
        { provide: getRepositoryToken(TetrisBattlePlayer), useValue: playerRepository },
        { provide: getRepositoryToken(TetrisBattleReplay), useValue: replayRepository },
        { provide: getDataSourceToken(), useValue: { transaction: (run: (m: typeof manager) => unknown) => run(manager) } as unknown as DataSource },
        // OptionalJwtAuthGuard 의존 — 토큰이 없으면 쓰지 않는다
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    });
    app = e2e.app;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  describe('POST /tetris-battle/matches/:matchId/replays', () => {
    it('정직한 리플레이 → 201 { code: SUCCESS, data: { verdict: VERIFIED } }', async () => {
      const res = await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(201);
      expect(res.body).toEqual({ code: 'SUCCESS', data: { verdict: 'VERIFIED' }, message: '' });
    });

    it('조작(seed 변조)도 201 — verdict INVALID', async () => {
      const res = await submit({ playerToken: TOKEN_P1, replay: { ...SURVIVOR, seed: SURVIVOR.seed + 1 } }).expect(201);
      expect(res.body.data).toEqual({ verdict: 'INVALID' });
    });

    it('전원 제출이면 그 요청에서 경기·참가자·리플레이를 저장한다', async () => {
      subs.p2 = JSON.stringify({ verdict: 'VERIFIED', reason: null, userId: null, battleEngineVersion: 1, replay: gzipSync('{}').toString('base64') });
      await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(201);
      expect(saved).toHaveLength(1 + 2 + 2);
    });

    it('토큰 불일치 → 403', async () => {
      const res = await submit({ playerToken: 'C'.repeat(32), replay: SURVIVOR }).expect(403);
      expect(res.body).toMatchObject({ code: 'TETRIS_BATTLE_PLAYER_TOKEN_INVALID' });
    });

    it('재제출 → 409', async () => {
      await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(201);
      const res = await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(409);
      expect(res.body).toMatchObject({ code: 'TETRIS_BATTLE_REPLAY_ALREADY_SUBMITTED' });
    });

    it('진행 중 → 409 MATCH_NOT_ENDED · 마감 후 → 410 · 없는 경기 → 404', async () => {
      const proto = TetrisBattleMatchStore.prototype;
      jest.spyOn(proto, 'snapshot').mockResolvedValueOnce(snapshot({ status: 'PLAYING' }));
      expect((await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(409)).body.code).toBe('TETRIS_BATTLE_MATCH_NOT_ENDED');

      jest.spyOn(proto, 'snapshot').mockResolvedValueOnce(snapshot({ endedAt: Date.now() - 61_000 }));
      expect((await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(410)).body.code).toBe('TETRIS_BATTLE_SUBMISSION_CLOSED');

      jest.spyOn(proto, 'snapshot').mockResolvedValueOnce(null);
      expect((await submit({ playerToken: TOKEN_P1, replay: SURVIVOR }).expect(404)).body.code).toBe('TETRIS_BATTLE_MATCH_NOT_FOUND');
    });

    it.each([
      ['replay 누락', { playerToken: TOKEN_P1 }],
      ['토큰 형식', { playerToken: 'short', replay: SURVIVOR }],
      ['frames 0', { playerToken: TOKEN_P1, replay: { ...SURVIVOR, frames: 0 } }],
      ['래퍼 버전이 현재와 다름(리뷰 L1)', { playerToken: TOKEN_P1, replay: { ...SURVIVOR, battleEngineVersion: 99999999 } }],
      ['inputs에 문자열', { playerToken: TOKEN_P1, replay: { ...SURVIVOR, inputs: ['a'] } }],
      ['알 수 없는 필드(forbidNonWhitelisted)', { playerToken: TOKEN_P1, replay: SURVIVOR, score: 999 }],
    ])('형식 오류(%s) → 422 VALIDATION_ERROR', async (_label, body) => {
      const res = await submit(body).expect(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(subs).toEqual({});
    });

    it('본문이 300kb를 넘으면 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await submit({ playerToken: TOKEN_P1, replay: { ...SURVIVOR, inputs: new Array(160_000).fill(12) } }).expect(413);
      expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });
  });

  describe('GET', () => {
    it('경기 결과 200 — VERIFIED 경기, 참가자 순위순', async () => {
      matchRepository.findOne.mockResolvedValueOnce({
        matchId: MATCH, roomName: '한판', playerCount: 2, startedAt: new Date('2026-10-22T00:00:00Z'), endedAt: new Date('2026-10-22T00:01:00Z'),
      } as TetrisBattleMatch);
      playerRepository.find.mockResolvedValueOnce([
        { playerId: 'p1', name: '우승자', place: 1, kos: 1, sent: 4, received: 0, pieces: 20, maxCombo: 2, frames: 900, koReason: null, verdict: 'VERIFIED' },
      ] as TetrisBattlePlayer[]);

      const res = await request(app.getHttpServer()).get(e2e.url(`/tetris-battle/matches/${MATCH}`)).expect(200);

      expect(res.body).toEqual({
        code: 'SUCCESS',
        message: '',
        data: {
          matchId: MATCH,
          roomName: '한판',
          playerCount: 2,
          startedAt: '2026-10-22T00:00:00.000Z',
          endedAt: '2026-10-22T00:01:00.000Z',
          players: [
            { playerId: 'p1', name: '우승자', place: 1, kos: 1, sent: 4, received: 0, pieces: 20, maxCombo: 2, frames: 900, koReason: null, verdict: 'VERIFIED' },
          ],
        },
      });
    });

    it('없음·DISPUTED → 404', async () => {
      matchRepository.findOne.mockResolvedValueOnce(null);
      const res = await request(app.getHttpServer()).get(e2e.url(`/tetris-battle/matches/${MATCH}`)).expect(404);
      expect(res.body).toMatchObject({ code: 'TETRIS_BATTLE_MATCH_NOT_FOUND' });
    });

    it('리플레이 200 (VERIFIED 참가자) · 미제출 참가자 404', async () => {
      const body = { seed: 1, das: 10, arr: 2, frames: 60, inputs: [0, 1], garbage: [] };
      matchRepository.findOne.mockResolvedValue({ matchId: MATCH } as TetrisBattleMatch);
      playerRepository.findOne.mockResolvedValueOnce({ verdict: 'VERIFIED' } as TetrisBattlePlayer);
      replayRepository.findOne.mockResolvedValueOnce({ battleEngineVersion: 1, replay: gzipSync(JSON.stringify(body)) } as TetrisBattleReplay);

      const ok = await request(app.getHttpServer()).get(e2e.url(`/tetris-battle/matches/${MATCH}/replays/p1`)).expect(200);
      expect(ok.body.data).toEqual({ matchId: MATCH, playerId: 'p1', battleEngineVersion: 1, ...body });

      playerRepository.findOne.mockResolvedValueOnce({ verdict: 'MISSING' } as TetrisBattlePlayer);
      const missing = await request(app.getHttpServer()).get(e2e.url(`/tetris-battle/matches/${MATCH}/replays/p2`)).expect(404);
      expect(missing.body).toMatchObject({ code: 'TETRIS_BATTLE_REPLAY_NOT_FOUND' });
    });
  });
});
