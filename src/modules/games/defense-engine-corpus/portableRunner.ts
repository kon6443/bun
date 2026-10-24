/**
 * 차등 테스트 이식용 러너 (defense 엔진 리팩토링 0단계) — **엔진 공개 API만** 쓴다(백엔드 사본이 이 파일과 portable.json을 그대로 쓴다)
 * 리플레이 헤더+입력 로그를 simulateReplay와 같은 규칙으로 다시 돌리며 CHECKPOINT_TICKS마다 상태 해시를 모은다
 * (명령 틱 = 그 틱까지 step한 뒤 적용 · 증강 대기 중에는 틱이 멈춘다 — engine/replay.ts simulateReplay와 같은 루프)
 * 결과 비교는 simulateReplay 자체의 결과(점수·웨이브·처치·해시 …)와 중간 해시 목록 둘 다로 한다
 */

import { OP_ARG_COUNTS, type ReplayInput, type ReplaySuccess, applyCommand, createGame, getStateHash, resolveBoard, simulateReplay, step } from '../defense-engine';

/** 중간 해시 간격(틱) — 10초 */
export const CHECKPOINT_TICKS = 300;

/** 한 판의 기대값 — 현재 엔진으로 만든 기준. checkpoints = tick이 CHECKPOINT_TICKS 배수가 된 순간의 해시(0틱 포함) */
export type PortableExpected = {
  result: Omit<ReplaySuccess, 'ok'>;
  checkpoints: string[];
};

export type PortableCase = { id: string; input: ReplayInput; expected: PortableExpected };

/**
 * 입력 로그를 다시 돌리며 CHECKPOINT_TICKS마다 해시 — **simulateReplay가 ok인 로그 전제**(computeExpected가 먼저 확인한다)
 * 인자 범위·헤더·끝 조건 검증은 simulateReplay 몫이다. 단독으로 부를 때는 simulateReplay(input).ok부터 확인한다
 * 끝난 상태의 해시·틱도 돌려준다 — simulateReplay 결과와 같아야 이 루프가 엔진 루프의 거울임이 확인된다(computeExpected)
 */
export function replayCheckpoints(input: ReplayInput, every = CHECKPOINT_TICKS): { checkpoints: string[]; finalHash: string; endTick: number } | null {
  const stage = resolveBoard(input.mode, input.boardKey, input.seed);
  if (!stage) return null;
  const state = createGame(stage, input.seed);
  const hashes: string[] = [];
  let recorded = -1;
  const mark = () => {
    if (state.tick % every === 0 && state.tick !== recorded) {
      recorded = state.tick;
      hashes.push(getStateHash(state));
    }
  };
  const advanceTo = (limit: number) => {
    while (state.tick < limit && !state.over && !state.augmentPending) {
      mark();
      step(state);
    }
    mark();
  };
  const { inputs, ticks } = input;
  let commandTick = 0;
  let i = 0;
  while (i < inputs.length) {
    const delta = inputs[i];
    const op = inputs[i + 1];
    const count = OP_ARG_COUNTS[op];
    // 최소 형식 방어(음수·소수 delta, 모르는 명령, 잘린 끝) — 루프가 엉뚱하게 돌지 않게. 전체 검증은 simulateReplay
    if (!Number.isInteger(delta) || delta < 0 || count === undefined || i + 2 + count > inputs.length) return null;
    commandTick += delta;
    advanceTo(Math.min(commandTick, ticks));
    if (state.over || state.tick < commandTick) return null;
    if (!applyCommand(state, op, count > 0 ? inputs[i + 2] : 0, count > 1 ? inputs[i + 3] : 0)) return null;
    i += 2 + count;
  }
  advanceTo(ticks);
  return { checkpoints: hashes, finalHash: getStateHash(state), endTick: state.endTick };
}

/** 이 엔진으로 한 판을 돌려 기대값 형식으로 — 픽스처를 만들 때와 검사할 때 같은 함수 */
export function computeExpected(input: ReplayInput, every = CHECKPOINT_TICKS): PortableExpected | { error: string } {
  const result = simulateReplay(input);
  if (!result.ok) return { error: `simulateReplay ${result.reason}` };
  const replayed = replayCheckpoints(input, every);
  if (!replayed) return { error: 'checkpoint replay failed' };
  // 거울 루프 자기 확인 — 엔진 루프와 같은 판을 돌렸다면 끝 상태가 같다
  if (replayed.finalHash !== result.stateHash || replayed.endTick !== result.endTick) {
    return { error: `checkpoint replay diverged from simulateReplay: ${replayed.finalHash}@${replayed.endTick} ≠ ${result.stateHash}@${result.endTick}` };
  }
  const checkpoints = replayed.checkpoints;
  const { score, wave, progress, kills, livesLeft, goldEarned, wavesStarted, augments, endTick, stateHash } = result;
  return { result: { score, wave, progress, kills, livesLeft, goldEarned, wavesStarted, augments, endTick, stateHash }, checkpoints };
}

/** 기대값 비교 — 다르면 사람이 읽을 첫 차이(어느 체크포인트·어느 필드)를 돌려준다. 같으면 null */
export function diffExpected(actual: PortableExpected, expected: PortableExpected, every = CHECKPOINT_TICKS): string | null {
  const n = Math.min(actual.checkpoints.length, expected.checkpoints.length);
  for (let k = 0; k < n; k++) {
    if (actual.checkpoints[k] !== expected.checkpoints[k]) return `checkpoint #${k} (tick ${k * every}): ${actual.checkpoints[k]} ≠ ${expected.checkpoints[k]}`;
  }
  if (actual.checkpoints.length !== expected.checkpoints.length) return `checkpoint count ${actual.checkpoints.length} ≠ ${expected.checkpoints.length}`;
  for (const key of Object.keys(expected.result) as (keyof PortableExpected['result'])[]) {
    const a = JSON.stringify(actual.result[key]);
    const e = JSON.stringify(expected.result[key]);
    if (a !== e) return `result.${key}: ${a} ≠ ${e}`;
  }
  return null;
}
