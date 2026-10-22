import { START_LIVES, simulateReplay } from './defense-engine';
import { defenseModeOf, verifyDefenseReplay } from './defense-verify';

jest.mock('./defense-engine', () => ({
  ...jest.requireActual<typeof import('./defense-engine')>('./defense-engine'),
  simulateReplay: jest.fn(),
}));

const simulate = simulateReplay as jest.MockedFunction<typeof simulateReplay>;

describe('verifyDefenseReplay — 디펜스 엔진 결과 → 검증 결과', () => {
  const input = { seed: 7, boardKey: 'endless-s1', frames: 9000, inputs: [0, 0], params: {} };
  const success = {
    ok: true as const,
    score: 12_345_000,
    wave: 12,
    progress: 345,
    kills: 300,
    livesLeft: 4,
    goldEarned: 5000,
    augments: [3, 8],
    endTick: 9000,
    stateHash: 'abcd1234',
  };

  beforeEach(() => simulate.mockReset());

  it.each([
    ['endless-s1', 'endless'],
    ['weekly-2026-w43', 'weekly'],
    ['default', null],
    ['e1', null],
  ])('보드 키 %s → 엔진 mode %s', (boardKey, mode) => {
    expect(defenseModeOf(boardKey)).toBe(mode);
  });

  it('세션 값으로 엔진 헤더를 채우고, 성공이면 점수와 상세 값을 돌려준다', () => {
    simulate.mockReturnValue(success);

    expect(verifyDefenseReplay(input)).toEqual({
      ok: true,
      score: 12_345_000,
      detail: {
        wave: 12,
        progress: 345,
        kills: 300,
        livesLeft: 4,
        goldEarned: 5000,
        engineVersion: expect.any(Number),
      },
    });
    expect(simulate).toHaveBeenCalledWith({
      mode: 'endless',
      boardKey: 'endless-s1',
      seed: 7,
      ticks: 9000,
      inputs: [0, 0],
    });
  });

  it('주간 보드는 mode weekly로 부른다', () => {
    simulate.mockReturnValue(success);

    verifyDefenseReplay({ ...input, boardKey: 'weekly-2026-w43' });

    expect(simulate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'weekly', boardKey: 'weekly-2026-w43' }),
    );
  });

  it('엔진 재현 실패 사유를 그대로 돌려준다', () => {
    simulate.mockReturnValue({ ok: false, reason: 'NOT_ENDED' });

    expect(verifyDefenseReplay(input)).toEqual({ ok: false, reason: 'NOT_ENDED' });
  });

  it('모르는 보드는 엔진을 부르지 않고 INVALID_HEADER', () => {
    expect(verifyDefenseReplay({ ...input, boardKey: 'default' })).toEqual({
      ok: false,
      reason: 'INVALID_HEADER',
    });
    expect(simulate).not.toHaveBeenCalled();
  });

  it('엔진 예외는 확정 결과(ENGINE_ERROR)다 — 던지면 503·세션 유지로 무한 재시도된다', () => {
    simulate.mockImplementation(() => {
      throw new RangeError('boom');
    });

    expect(verifyDefenseReplay(input)).toEqual({ ok: false, reason: 'ENGINE_ERROR' });
  });

  it('웨이브를 시작하지 않은 판(클리어 0·처치 0·목숨 그대로)은 NOT_STARTED', () => {
    simulate.mockReturnValue({
      ...success,
      score: 0,
      wave: 0,
      progress: 0,
      kills: 0,
      livesLeft: START_LIVES,
    });

    expect(verifyDefenseReplay(input)).toEqual({ ok: false, reason: 'NOT_STARTED' });
  });

  it.each([
    ['처치가 있으면', { kills: 1 }],
    ['목숨이 깎였으면', { livesLeft: START_LIVES - 1 }],
  ])('클리어 0이어도 %s 시작한 판', (_name, overrides) => {
    simulate.mockReturnValue({
      ...success,
      score: 0,
      wave: 0,
      progress: 0,
      kills: 0,
      livesLeft: START_LIVES,
      ...overrides,
    });

    expect(verifyDefenseReplay(input)).toMatchObject({ ok: true, score: 0 });
  });
});
