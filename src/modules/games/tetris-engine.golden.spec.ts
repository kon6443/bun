import golden from './tetris-engine/__fixtures__/golden-replays.json';
import { ENGINE_VERSION, FRAMES_PER_SECOND, MAX_FRAMES, MAX_INPUT_LENGTH, simulateReplay } from './tetris-engine';
import { GAME_REPLAY_MAX_FRAMES, GAME_REPLAY_MAX_INPUT_LENGTH } from '../../common/constants/app.constants';
import { tetrisGameEngine } from './tetris-game-engine';

type GoldenCase = {
  name: string;
  input: { seed: number; das: number; arr: number; frames: number; inputs: number[] };
  expected: Record<string, unknown>;
};

/**
 * 백·프 엔진 계약 테스트 (docs/tasks/games D-008, DESIGN §4-3·§4-4).
 *
 * `tetris-engine/`은 프론트(next-bun) 원본의 사본이고 골든 픽스처는 두 레포에 바이트 단위로 같은 파일이다.
 * 프론트 테스트도 같은 픽스처를 단정하므로, 어느 한쪽 엔진만 바뀌면 이 테스트나 프론트 테스트가 깨진다.
 * 원본을 고치면: 프론트에서 엔진·픽스처 갱신 → 이 폴더로 그대로 복사(파일 수정 금지) → 규칙이 바뀌었으면 ENGINE_VERSION 증가.
 */
describe('테트리스 엔진 사본 — 골든 리플레이', () => {
  const cases = golden as GoldenCase[];

  it('엔진 버전이 1이어야 함 (바꾸면 세션·저장 리플레이와 호환이 깨진다)', () => {
    expect(ENGINE_VERSION).toBe(1);
  });

  it('레지스트리 상한·틱레이트가 엔진 상수와 같고, DTO 공통 상한이 그 이상이어야 함 (DTO가 더 작으면 정상 리플레이가 422)', () => {
    expect(tetrisGameEngine.maxFrames).toBe(MAX_FRAMES);
    expect(tetrisGameEngine.maxInputLength).toBe(MAX_INPUT_LENGTH);
    expect(tetrisGameEngine.ticksPerSecond).toBe(FRAMES_PER_SECOND);
    expect(tetrisGameEngine.maxSpeed).toBe(1);
    expect(GAME_REPLAY_MAX_FRAMES).toBeGreaterThanOrEqual(MAX_FRAMES);
    expect(GAME_REPLAY_MAX_INPUT_LENGTH).toBeGreaterThanOrEqual(MAX_INPUT_LENGTH);
  });

  it('성공·실패 케이스가 모두 있어야 함', () => {
    expect(cases.filter((c) => c.expected.ok === true).length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((c) => c.expected.ok === false).map((c) => c.expected.reason)).toEqual(
      expect.arrayContaining(['INVALID_HEADER', 'INVALID_INPUT', 'INPUT_AFTER_END', 'NOT_ENDED']),
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: 프론트 원본과 같은 결과를 내야 함', (_name, c) => {
    expect(simulateReplay(c.input)).toEqual(c.expected);
  });

  // 픽스처 입력 { seed, das, arr, frames, inputs } → 레지스트리 입력 { seed, frames, inputs, params: { das, arr } }
  const toRegistryInput = ({ das, arr, ...rest }: GoldenCase['input']) => ({ ...rest, boardKey: 'default', params: { das, arr } });

  it('검증 어댑터는 성공이면 엔진 점수·요약 값을, 실패면 사유를 돌려줘야 함', async () => {
    const ok = cases.find((c) => c.name === 'back-to-back')!;
    const fail = cases.find((c) => c.expected.ok === false)!;

    await expect(tetrisGameEngine.verify(toRegistryInput(ok.input))).resolves.toEqual({
      ok: true,
      score: ok.expected.score,
      detail: expect.objectContaining({ lines: ok.expected.lines, level: ok.expected.level, engineVersion: 1, das: ok.input.das, arr: ok.input.arr }),
    });
    await expect(tetrisGameEngine.verify(toRegistryInput(fail.input))).resolves.toEqual({ ok: false, reason: fail.expected.reason });
  });

  it.each([
    ['das·arr 정수', { das: 10, arr: 2 }, true],
    ['범위 밖이어도 형식만 본다 (범위는 엔진 INVALID_HEADER)', { das: 999, arr: -1 }, true],
    ['arr 누락', { das: 10 }, false],
    ['정의 외 키', { das: 10, arr: 2, extra: 1 }, false],
    ['정수 아님', { das: 10.5, arr: 2 }, false],
    ['빈 객체', {}, false],
  ])('params 형식 검사 — %s', (_name, params, expected) => {
    expect(tetrisGameEngine.isValidParams(params as Record<string, number>)).toBe(expected);
  });
});
