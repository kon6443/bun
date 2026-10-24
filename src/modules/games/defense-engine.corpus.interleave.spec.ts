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
function stepper(id: string, input: ReplayInput) {
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
      if (!applyCommand(state, op, count > 0 ? input.inputs[i + 2] : 0, count > 1 ? input.inputs[i + 3] : 0)) throw new Error(`명령 거부 — ${id} tick ${state.tick}`);
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
    // 캠페인 몫은 증강 없는 판(효과가 판 시작 효과 — 규칙·난이도 — 뿐) — 위 목록과 겹치지 않는다
    const campaign = cases.filter((c) => c.input.mode === 'campaign' && c.input.ticks < 162000 && c.expected.result.augments.length === 0).slice(0, 4);
    const group = [...withAugments, ...campaign];
    expect(withAugments.length).toBeGreaterThanOrEqual(3);
    expect(campaign.length).toBeGreaterThanOrEqual(2);
    const runners = group.map((c) => ({ c, run: stepper(c.id, c.input), done: false }));
    /**
     * 메모가 "배열 동일성"을 빼먹은 퇴행(길이만 비교)이 드러나는 조건 — 메모는 한 칸이라 **직전에 statValue를 부른 판**과만 부딪힌다
     * 실제 step 순서(순회 경계 포함)로 직전에 효과가 있는 채 step한 판과 비교해 배열이 다르고 길이는 같고 내용이 다른 순간이 있었는지 센다
     * (효과가 없는 판은 statValue가 메모를 건너뛰어 사이에 끼어도 상관없다)
     * 판 생성·끝나는 판의 마지막 명령 적용에서 바뀐 메모는 세지 않는다 — 덜 세는 쪽이라 거짓 통과로 이어지지 않는다
     */
    let previous: (typeof runners)[number] | null = null;
    let collided = false;
    // 모든 판이 끝날 때까지 한 틱씩 차례로
    for (let alive = runners.length; alive > 0; ) {
      alive = 0;
      for (const r of runners) {
        if (r.done) continue;
        if (!r.run.advance()) {
          r.done = true;
          continue;
        }
        alive++;
        // step 중에는 효과가 바뀌지 않는다(명령 적용은 step 전) → step 뒤의 효과가 이번 step에 쓰인 것
        const effects = r.run.state.effects;
        if (effects.length === 0) continue;
        if (!collided && previous) {
          const other = previous.run.state.effects;
          collided = other !== effects && other.length === effects.length && JSON.stringify(other) !== JSON.stringify(effects);
        }
        previous = r;
      }
    }
    // 표본이 위 조건을 만들지 못하면 이 테스트는 그 퇴행을 지킬 수 없다(코퍼스를 다시 만들어 표본이 바뀌면 여기서 알린다)
    // 필요조건일 뿐 충분조건은 아니다 — 결과에 안 쓰이는 수치만 다르면 낡은 버킷도 같은 해시를 낸다. 충분성은 변이로 확인한다:
    // effects.ts bucketOf 조건을 길이만 비교로 바꾸면 이 테스트가 실패해야 한다(2026-10-24 확인 — c2 tick 0 명령 거부). 표본을 바꾸면 다시 확인
    expect(collided).toBe(true);
    for (const r of runners) {
      expect({ id: r.c.id, hash: getStateHash(r.run.state) }).toEqual({ id: r.c.id, hash: r.c.expected.result.stateHash });
      expect(r.run.checkpoints).toEqual(r.c.expected.checkpoints);
    }
  }, 120_000);
});
