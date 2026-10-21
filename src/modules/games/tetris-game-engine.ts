import { ENGINE_VERSION, simulateReplay } from './tetris-engine';
import type { GameEngine } from './game-engine.registry';

/**
 * 테트리스 리플레이 검증 — 엔진 사본(./tetris-engine, 원본 next-bun)의 simulateReplay를 감싼다 (DESIGN §4-4)
 *
 * detail은 랭킹·재생 화면에 쓰는 요약 값이다. 엔진 결과의 boardHash·endFrame은 검증용이라 저장하지 않는다.
 */
export const tetrisGameEngine: GameEngine = {
  engineVersion: ENGINE_VERSION,
  verify(input) {
    const result = simulateReplay(input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return {
      ok: true,
      score: result.score,
      detail: {
        lines: result.lines,
        level: result.level,
        pieces: result.pieces,
        tSpins: result.tSpins,
        tetrises: result.tetrises,
        maxCombo: result.maxCombo,
        engineVersion: ENGINE_VERSION,
        das: input.das,
        arr: input.arr,
      },
    };
  },
};
