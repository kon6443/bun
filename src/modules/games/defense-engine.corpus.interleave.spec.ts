import { OP_ARG_COUNTS, type ReplayInput, applyCommand, createGame, getStateHash, resolveBoard, step } from './defense-engine';
import { corpus } from './defense-engine-corpus/corpusSpec';
import { CHECKPOINT_TICKS } from './defense-engine-corpus/portableRunner';

/**
 * 판 간 격리 (리팩토링 1단계 — 프론트 engine-dev/corpus/interleave.test.ts를 jest로 옮긴 것) — 엔진의 모듈 수준 메모·scratch가 판 사이에 새지 않는지
 * 같은 프로세스에서 판 여러 개를 틱 단위로 번갈아 돌려도(서버 워커의 연속 검증·프론트의 재생+미리보기) 각 판의 중간 해시·끝 해시가
 * 단독 실행(portable.json 기대값)과 같아야 한다. 효과(증강)가 있는 판과 없는 판, 서로 다른 모드를 섞는다
 */
const cases = corpus.cases;

/** 리플레이를 한 틱씩 진행하는 커서 — portableRunner.replayCheckpoints와 같은 규칙(명령 틱까지 step 뒤 적용, 증강 대기 중 멈춤) */
function stepper(input: ReplayInput) {
  const stage = resolveBoard(input.mode, input.boardKey, input.seed);
  if (!stage) throw new Error(`보드 없음 ${input.boardKey}`);
  const state = createGame(stage, input.seed);
  const checkpoints: string[] = [];
  let recorded = -1;
  let i = 0;
  let commandTick = input.inputs.length > 0 ? input.inputs[0] : Infinity;
  const mark = () => {
    if (state.tick % CHECKPOINT_TICKS === 0 && state.tick !== recorded) {
      recorded = state.tick;
      checkpoints.push(getStateHash(state));
    }
  };
  /** 명령을 적용할 수 있는 만큼 적용하고 한 틱 — 끝났으면 false */
  const advance = (): boolean => {
    mark();
    while (i < input.inputs.length && state.tick === commandTick && !state.over) {
      const op = input.inputs[i + 1];
      const count = OP_ARG_COUNTS[op];
      if (!applyCommand(state, op, count > 0 ? input.inputs[i + 2] : 0, count > 1 ? input.inputs[i + 3] : 0)) throw new Error('명령 거부');
      i += 2 + count;
      commandTick = i < input.inputs.length ? commandTick + input.inputs[i] : Infinity;
    }
    if (state.over || state.augmentPending || state.tick >= input.ticks) {
      mark();
      return false;
    }
    step(state);
    return true;
  };
  return { state, checkpoints, advance };
}

describe('판 간 격리 — 판 여러 개를 틱 단위로 번갈아 돌려도 단독 실행과 같다', () => {
  it('증강 있는 무한·주간 판과 캠페인 판을 섞어 4판씩 번갈아', () => {
    const withAugments = cases.filter((c) => c.expected.result.augments.length > 0).slice(0, 4);
    const campaign = cases.filter((c) => c.input.mode === 'campaign' && c.input.ticks < 162000).slice(0, 4);
    const group = [...withAugments, ...campaign];
    expect(withAugments.length).toBeGreaterThanOrEqual(3);
    const runners = group.map((c) => ({ c, run: stepper(c.input), done: false }));
    // 모든 판이 끝날 때까지 한 틱씩 차례로
    for (let alive = runners.length; alive > 0; ) {
      alive = 0;
      for (const r of runners) {
        if (r.done) continue;
        if (r.run.advance()) alive++;
        else r.done = true;
      }
    }
    for (const r of runners) {
      expect({ id: r.c.id, hash: getStateHash(r.run.state) }).toEqual({ id: r.c.id, hash: r.c.expected.result.stateHash });
      expect(r.run.checkpoints).toEqual(r.c.expected.checkpoints);
    }
  }, 120_000);
});
