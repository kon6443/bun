import golden from './defense-engine/__fixtures__/golden-replays.json';
import { ENGINE_VERSION, simulateReplay, type ReplayInput } from './defense-engine';

type GoldenCase = { name: string; input: ReplayInput; expected: Record<string, unknown> };

/**
 * 디펜스 엔진 백·프 계약 테스트 (docs/tasks/defense DESIGN §E0·§E4·§E7)
 *
 * 골든 픽스처는 프론트가 봇·손작성 판으로 만든 파일이고 두 레포에 바이트 단위로 같다(매니페스트가 강제).
 * 백엔드(Node·jest)에서 같은 엔진 사본이 같은 결과를 내는지 본다 — 서버 검증 = 클라이언트 플레이의 전제.
 */
describe('디펜스 엔진 사본 — 골든 리플레이', () => {
  const cases = golden as unknown as GoldenCase[];

  it('엔진 버전이 2여야 함 (바꾸면 세션·저장 리플레이와 호환이 깨진다 — E2 전투 전체, D-028)', () => {
    expect(ENGINE_VERSION).toBe(2);
  });

  it('성공 케이스와 실패 사유 6종이 모두 있어야 함', () => {
    expect(cases.filter((c) => c.expected.ok === true).length).toBeGreaterThanOrEqual(1);
    expect(new Set(cases.filter((c) => c.expected.ok === false).map((c) => c.expected.reason))).toEqual(
      new Set(['INVALID_HEADER', 'INVALID_INPUT', 'INVALID_COMMAND', 'INPUT_AFTER_END', 'NOT_ENDED', 'LIMIT_EXCEEDED']),
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: 프론트 원본과 같은 결과를 내야 함', (_name, c) => {
    expect(simulateReplay(c.input)).toEqual(c.expected);
  });
});
