import { gunzipSync } from 'node:zlib';
import type { DataSource, EntityManager } from 'typeorm';
import { FortressMatch } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { FortressReplay } from '../../entities/FortressReplay';
import golden from './engine/__fixtures__/golden-matches.json';
import { ENGINE_VERSION, type Action, type MatchConfig, simulateMatch, stateHash } from './engine';
import { UploadSoloMatchDto } from './fortress-solo.dto';
import { FortressSoloService } from './fortress-solo.service';
import type { FortressSkinService } from './fortress-skin.service';

type GoldenCase = { name: string; config: MatchConfig; actions: Action[]; expected: { ok: boolean } };
const cases = golden as unknown as GoldenCase[];
const caseOf = (name: string): GoldenCase => {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`골든 경기 없음: ${name}`);
  return found;
};
const NOW = 1_800_000_000_000;
const DEFAULT_SKIN = { id: 'default', level: 1 };

/** 골든 경기를 업로드 요청으로 — 사람 slot 0, 나머지 AI 중 */
const uploadOf = (c: GoldenCase, over: Partial<UploadSoloMatchDto> = {}): UploadSoloMatchDto => {
  const sim = simulateMatch(c.config, c.actions);
  const hash = sim.ok ? stateHash(sim.final) : '00000000';
  return {
    engineVersion: ENGINE_VERSION,
    config: c.config as UploadSoloMatchDto['config'],
    actions: c.actions,
    stateHash: hash,
    slots: c.config.players.map((p) => (p.slot === 0 ? { slot: p.slot, kind: 'human' as const } : { slot: p.slot, kind: 'ai' as const, aiLevel: 1 as const })),
    ...over,
  };
};

/**
 * AI전 기록 업로드(D-027) — 서버 엔진 재시뮬레이션 검증 → 경기·참가자·리플레이 한 트랜잭션 저장.
 * 엔진 판정은 골든 경기(프론트와 바이트 동일)로, 저장은 트랜잭션 manager mock으로 본다
 */
describe('FortressSoloService', () => {
  let saved: { entity: unknown; value: Record<string, unknown> }[];
  let skins: { tankSkinOf: jest.Mock };
  let service: FortressSoloService;

  beforeEach(() => {
    saved = [];
    const manager = {
      create: jest.fn((entity: unknown, value: Record<string, unknown>) => ({ entity, value })),
      save: jest.fn(async (row: { entity: unknown; value: Record<string, unknown> }) => {
        saved.push(row);
        return row;
      }),
    } as unknown as EntityManager;
    const dataSource = { transaction: jest.fn(async (fn: (m: EntityManager) => Promise<void>) => fn(manager)) } as unknown as DataSource;
    skins = { tankSkinOf: jest.fn().mockResolvedValue({ id: 'desert', level: 3 }) };
    service = new FortressSoloService(dataSource, skins as unknown as FortressSkinService);
  });

  const rowsOf = (entity: unknown) => saved.filter((r) => r.entity === entity).map((r) => r.value);

  it('끝난 경기 → source solo·방 이름 null·USER_ID 없음으로 저장, 순위·집계는 엔진 재시뮬레이션 값', async () => {
    const c = caseOf('ffa 2인 hills AI 중·중');
    const { matchId } = await service.upload(uploadOf(c), null, NOW);

    expect(matchId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const [match] = rowsOf(FortressMatch);
    const sim = simulateMatch(c.config, c.actions);
    if (!sim.ok) throw new Error('골든 경기가 성공이어야 함');
    expect(match).toMatchObject({
      matchId,
      source: 'solo',
      roomName: null,
      mode: 'ffa',
      mapId: 'hills',
      seed: c.config.seed,
      engineVersion: ENGINE_VERSION,
      playerCount: 2,
      turns: sim.final.turn.no,
      resultKind: sim.final.result.kind,
      isHidden: 0,
    });
    const players = rowsOf(FortressPlayer);
    expect(players.map((p) => [p.playerId, p.name, p.userId])).toEqual([
      ['p1', 'P1', null],
      ['p2', 'P2 (AI 중)', null],
    ]);
    expect(players.map((p) => p.place).sort()).toEqual(sim.final.result.kind === 'win' ? [1, 2] : [1, 1]);
    expect(players.reduce((sum, p) => sum + (p.damage as number), 0)).toBeGreaterThan(0);
  });

  it('리플레이 본문 = 정규화한 config·actions + 서버가 정한 이름·스킨 + 서버 stateHash (모르는 필드는 버린다)', async () => {
    const c = caseOf('ffa 2인 canyon AI 하·상');
    const dirty = c.actions.map((a) => ({ ...a, junk: 'x' })) as unknown[];
    await service.upload(uploadOf(c, { actions: dirty }), 7, NOW);

    const [replay] = rowsOf(FortressReplay);
    const body = JSON.parse(gunzipSync(replay.replay as Buffer).toString('utf8')) as Record<string, unknown>;
    expect(body.actions).toEqual(c.actions);
    expect(body.config).toEqual(c.config);
    expect(body.slots).toEqual([
      { slot: 0, playerId: 'p1', name: 'P1', skin: { id: 'desert', level: 3 } },
      { slot: 1, playerId: 'p2', name: 'P2 (AI 중)', skin: DEFAULT_SKIN },
    ]);
    expect(skins.tankSkinOf).toHaveBeenCalledWith(7);
  });

  it('게스트는 스킨 조회 없이 전원 기본 스킨', async () => {
    await service.upload(uploadOf(caseOf('ffa 2인 canyon AI 하·상')), null, NOW);
    const [replay] = rowsOf(FortressReplay);
    const body = JSON.parse(gunzipSync(replay.replay as Buffer).toString('utf8')) as { slots: { skin: unknown }[] };
    expect(body.slots.map((s) => s.skin)).toEqual([DEFAULT_SKIN, DEFAULT_SKIN]);
    expect(skins.tankSkinOf).not.toHaveBeenCalled();
  });

  it('팀전 — 팀·이긴 팀이 저장된다', async () => {
    const c = caseOf('team 2:2 hills AI');
    await service.upload(uploadOf(c), null, NOW);
    const [match] = rowsOf(FortressMatch);
    expect(match.mode).toBe('team');
    expect(rowsOf(FortressPlayer).every((p) => p.team === 0 || p.team === 1)).toBe(true);
    if (match.resultKind === 'win') expect([0, 1]).toContain(match.winnerTeam);
  });

  describe('거부 — 아무것도 저장하지 않는다', () => {
    it('엔진 버전이 다르면 409 FORTRESS_SOLO_ENGINE_MISMATCH', async () => {
      await expect(service.upload(uploadOf(caseOf('ffa 2인 canyon AI 하·상'), { engineVersion: ENGINE_VERSION + 1 }), null, NOW)).rejects.toMatchObject({
        status: 409,
        code: 'FORTRESS_SOLO_ENGINE_MISMATCH',
      });
      expect(saved).toEqual([]);
    });

    it.each<[string, (c: GoldenCase) => Partial<UploadSoloMatchDto>, Record<string, unknown>]>([
      ['자리 목록이 config와 다름', () => ({ slots: [{ slot: 0, kind: 'human' }] }), { reason: 'CONFIG' }],
      ['AI인데 난이도 없음', (c) => ({ slots: c.config.players.map((p) => ({ slot: p.slot, kind: 'ai' as const })) }), { reason: 'CONFIG' }],
      ['사람인데 난이도 있음', (c) => ({ slots: c.config.players.map((p) => ({ slot: p.slot, kind: 'human' as const, aiLevel: 0 as const })) }), { reason: 'CONFIG' }],
      ['모르는 행동 kind', (c) => ({ actions: [...c.actions.slice(0, 1), { kind: 'teleport' }] as unknown[] }), { reason: 'ACTION', at: 1 }],
      ['규칙 위반 행동(파워 범위)', (c) => ({ actions: [{ kind: 'fire', move: 0, angle: 45, power: 999, weaponId: 0 }, ...c.actions] }), { reason: 'ACTION', at: 0 }],
      ['끝나지 않은 경기', (c) => ({ actions: c.actions.slice(0, 1) as unknown[] }), { reason: 'NOT_ENDED' }],
      ['마지막 상태 해시가 다름', () => ({ stateHash: 'ffffffff' }), { reason: 'HASH' }],
      [
        '자리 번호가 0..n−1이 아님(리뷰 S2 — 엔진은 중복·범위만 본다)',
        (c) => ({
          config: { ...c.config, players: c.config.players.map((p) => (p.slot === 1 ? { ...p, slot: 3 } : p)) } as UploadSoloMatchDto['config'],
          slots: [
            { slot: 0, kind: 'human' as const },
            { slot: 3, kind: 'ai' as const, aiLevel: 1 as const },
          ],
        }),
        { reason: 'CONFIG' },
      ],
    ])('%s → 422 FORTRESS_SOLO_REPLAY_INVALID', async (_label, patch, details) => {
      const c = caseOf('ffa 2인 hills AI 중·중');
      await expect(service.upload(uploadOf(c, patch(c)), null, NOW)).rejects.toMatchObject({ status: 422, code: 'FORTRESS_SOLO_REPLAY_INVALID', details });
      expect(saved).toEqual([]);
    });

    it('엔진 설정 오류(팀 구성) → CONFIG', async () => {
      const c = caseOf('실패 설정 BAD_TEAMS');
      await expect(service.upload(uploadOf(c, { stateHash: '00000000' }), null, NOW)).rejects.toMatchObject({ status: 422, details: { reason: 'CONFIG' } });
    });
  });
});
