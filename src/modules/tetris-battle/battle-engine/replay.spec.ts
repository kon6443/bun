// jest 이식 — 원본 `battle-engine/replay.test.ts`와 이 import 줄만 다르다(vitest → jest 전역)
import golden from './__fixtures__/golden-battle-replays.json';
import { type BattleReplayInput, type BattleReplayResult, buildBattleReplay, createBattle, receiveGarbage, simulateBattleReplay, stepBattle } from './index';
import { ACTION, getBoardHash } from './engine';

type GoldenCase = { name: string; input: BattleReplayInput; expected: BattleReplayResult };

describe('대전 골든 리플레이 (백엔드 사본과 같은 결과여야 한다)', () => {
  const cases = golden as unknown as GoldenCase[];

  it('케이스가 빠지지 않았다', () => {
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining(['offset', 'combo-blocking', 'cap-split', 'delay', 'garbage-block-out', 'garbage-top-out', 'survivor', 'fail-frames-mismatch']),
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(simulateBattleReplay(c.input)).toEqual(c.expected);
  });
});

describe('대전 리플레이 기록', () => {
  it('실시간 판 → buildBattleReplay → simulateBattleReplay가 같은 결과', () => {
    const bs = createBattle({ seed: 7, das: 10, arr: 2 });
    const inputs: number[] = [];
    let lastInputFrame = 0;
    for (let f = 0; f < 2000 && !bs.game.over; f++) {
      if (f === 40) receiveGarbage(bs, { id: 1, lines: 3, hole: 2 });
      if (f === 300) receiveGarbage(bs, { id: 2, lines: 5, hole: 7 });
      const actions = f % 20 === 0 ? [ACTION.HARD_DROP] : [];
      const frame = bs.game.frame;
      const { applied } = stepBattle(bs, actions, actions.length);
      for (let i = 0; i < applied; i++) {
        inputs.push(frame - lastInputFrame, actions[i]);
        lastInputFrame = frame;
      }
    }
    const result = simulateBattleReplay(buildBattleReplay(bs, inputs, 10, 2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.garbageReceived).toBe(bs.garbageReceived);
    expect(result.boardHash).toBe(getBoardHash(bs.game));
    expect(result.sent).toEqual(bs.sentLog);
    expect(result.pieces).toBe(bs.game.pieces);
    expect(result.topOutFrame).toBe(bs.game.over ? bs.game.endFrame : null);
  });

  it('진행하지 않은 마지막 프레임에 받은 가비지는 기록에서 빠진다 (살아남은 플레이어)', () => {
    const bs = createBattle({ seed: 7, das: 10, arr: 2 });
    for (let f = 0; f < 100; f++) stepBattle(bs, [], 0);
    receiveGarbage(bs, { id: 1, lines: 2, hole: 0 });
    const replay = buildBattleReplay(bs, [], 10, 2);
    expect(replay.frames).toBe(100);
    expect(replay.garbage).toEqual([]);
    expect(simulateBattleReplay(replay).ok).toBe(true);
  });
});
