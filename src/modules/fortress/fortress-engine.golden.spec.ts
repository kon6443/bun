import golden from './engine/__fixtures__/golden-matches.json';
import { ENGINE_VERSION, type Action, type MatchConfig, simulateMatch, stateHash } from './engine';

type GoldenCase = { name: string; config: MatchConfig; actions: Action[]; expected: Record<string, unknown> };

/**
 * 포트리스 엔진 백·프 계약 테스트 (docs/tasks/fortress DESIGN §10, D-009 ⑧)
 *
 * 골든 픽스처는 프론트가 AI·손작성 판으로 만든 파일이고 두 레포에 바이트 단위로 같다(매니페스트가 강제).
 * 백엔드(Node·jest)에서 같은 엔진 사본이 턴마다 같은 stateHash를 내는지 본다 — 서버 권위 턴 판정(F4)과
 * 클라이언트 연출이 어긋나지 않는다는 전제다.
 */
describe('포트리스 엔진 사본 — 골든 경기', () => {
  const cases = golden as unknown as GoldenCase[];

  it('엔진 버전이 2여야 함 (바꾸면 저장 리플레이와 호환이 깨진다)', () => {
    expect(ENGINE_VERSION).toBe(2);
  });

  it('성공 경기와 행동 실패 사유 8종·설정 실패가 모두 있어야 함', () => {
    expect(cases.filter((c) => c.expected.ok === true).length).toBeGreaterThanOrEqual(1);
    const reasons = new Set(cases.filter((c) => c.expected.ok === false).map((c) => c.expected.reason));
    for (const reason of ['NOT_RUNNING', 'BAD_KIND', 'MOVE_RANGE', 'ANGLE_RANGE', 'POWER_RANGE', 'WEAPON_UNKNOWN', 'WEAPON_COOLDOWN', 'SLOT_NOT_ALIVE']) {
      expect(reasons).toContain(reason);
    }
    expect(cases.some((c) => c.expected.ok === false && c.expected.at === -1)).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: 프론트 원본과 같은 결과를 내야 함', (_name, c) => {
    const out = simulateMatch(c.config, c.actions);
    const actual = out.ok ? { ok: true, hashes: out.hashes, result: out.final.result } : out;
    expect(actual).toEqual(c.expected);
  });

  it('최종 state는 JSON 왕복 뒤에도 해시가 같아야 함 — 서버 Redis 스냅샷 전제', () => {
    for (const c of cases.filter((x) => x.expected.ok === true)) {
      const out = simulateMatch(c.config, c.actions);
      if (!out.ok) throw new Error(`${c.name}: 실패 ${out.reason}`);
      expect(stateHash(JSON.parse(JSON.stringify(out.final)))).toBe(stateHash(out.final));
    }
  });
});
