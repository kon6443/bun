import golden from './defense-engine/__fixtures__/golden-replays.json';
import { ENGINE_VERSION, MAX_TICKS, type ReplayInput as EngineReplayInput } from './defense-engine';
import { verifyDefenseReplay } from './defense-verify';

type GoldenCase = { name: string; input: EngineReplayInput; expected: Record<string, unknown> };

/**
 * 서버 검증 경로 + 실제 엔진 사본 (defense DESIGN §B2·§E4, D-025·D-026)
 *
 * defense-verify.spec.ts는 엔진을 대역으로 바꿔 분기만 본다. 여기서는 골든의 무한·주간 판을
 * 세션 값(boardKey·seed·frames)으로 verifyDefenseReplay에 넣어, 서버가 실제로 같은 점수를 내는지 본다.
 */
describe('verifyDefenseReplay — 실제 엔진 (무한·주간)', () => {
  const ranked = (golden as unknown as GoldenCase[]).filter(
    (c) => c.input.mode === 'endless' || c.input.mode === 'weekly',
  );
  const toServerInput = ({ input }: GoldenCase) => ({
    seed: input.seed,
    boardKey: input.boardKey,
    frames: input.ticks,
    inputs: input.inputs,
    params: {},
  });

  it('골든에 무한·주간 성공·실패 판이 모두 있어야 함', () => {
    expect(ranked.some((c) => c.input.mode === 'endless' && c.expected.ok === true)).toBe(true);
    expect(ranked.some((c) => c.input.mode === 'weekly' && c.expected.ok === true)).toBe(true);
    expect(ranked.some((c) => c.expected.ok === false)).toBe(true);
  });

  it.each(ranked.filter((c) => c.expected.ok === true).map((c) => [c.name, c] as const))(
    '%s: 서버 경로가 골든과 같은 점수·상세 값을 낸다',
    (_name, c) => {
      expect(verifyDefenseReplay(toServerInput(c))).toEqual({
        ok: true,
        score: c.expected.score,
        detail: expect.objectContaining({
          wave: c.expected.wave,
          progress: c.expected.progress,
          kills: c.expected.kills,
          livesLeft: c.expected.livesLeft,
          goldEarned: c.expected.goldEarned,
          engineVersion: ENGINE_VERSION,
        }),
      });
    },
  );

  it.each(ranked.filter((c) => c.expected.ok === false).map((c) => [c.name, c] as const))(
    '%s: 서버 경로가 같은 실패 사유를 낸다',
    (_name, c) => {
      expect(verifyDefenseReplay(toServerInput(c))).toEqual({ ok: false, reason: c.expected.reason });
    },
  );

  it.each([['endless-s1'], ['weekly-2026-w43']])(
    '%s: 웨이브를 하나도 시작하지 않고 판 상한까지 버틴 판은 NOT_STARTED(엔진은 성공·0점)',
    (boardKey) => {
      expect(verifyDefenseReplay({ seed: 7, boardKey, frames: MAX_TICKS, inputs: [], params: {} })).toEqual({
        ok: false,
        reason: 'NOT_STARTED',
      });
    },
  );
});
