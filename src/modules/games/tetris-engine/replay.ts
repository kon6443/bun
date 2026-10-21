/**
 * 리플레이 검증·기록 — 서버 검증과 프론트 재생이 같은 함수를 쓴다
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  ACTION_CODE_MAX,
  ARR_MAX,
  ARR_MIN,
  DAS_MAX,
  DAS_MIN,
  ENGINE_VERSION,
  MAX_FRAMES,
  MAX_INPUT_LENGTH,
  SEED_MAX,
} from './constants';
import { type GameState, createGame, getBoardHash, stepFrame } from './game';

export type ReplayInput = {
  seed: number;
  das: number;
  arr: number;
  frames: number;
  /** [deltaFrame, code, deltaFrame, code, ...] — deltaFrame은 직전 입력 프레임과의 차이(첫 입력은 0프레임 기준) */
  inputs: number[];
};

export type ReplayFailureReason = 'INVALID_HEADER' | 'INVALID_INPUT' | 'INPUT_AFTER_END' | 'NOT_ENDED';

export type ReplaySuccess = {
  ok: true;
  score: number;
  lines: number;
  level: number;
  pieces: number;
  tSpins: number;
  tetrises: number;
  maxCombo: number;
  endFrame: number;
  boardHash: string;
};

export type ReplayResult = ReplaySuccess | { ok: false; reason: ReplayFailureReason };

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidReplayHeader(input: { seed: unknown; das: unknown; arr: unknown; frames: unknown }): boolean {
  return (
    isIntInRange(input.seed, 0, SEED_MAX) &&
    isIntInRange(input.das, DAS_MIN, DAS_MAX) &&
    isIntInRange(input.arr, ARR_MIN, ARR_MAX) &&
    isIntInRange(input.frames, 1, MAX_FRAMES)
  );
}

function isValidInputLog(inputs: unknown): inputs is number[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUT_LENGTH || inputs.length % 2 !== 0) return false;
  for (let i = 0; i < inputs.length; i += 2) {
    if (!isIntInRange(inputs[i], 0, MAX_FRAMES) || !isIntInRange(inputs[i + 1], 0, ACTION_CODE_MAX)) return false;
  }
  return true;
}

/**
 * 시드·입력 로그로 게임을 화면 없이 처음부터 끝까지 실행한다
 * 성공 조건: 게임 오버로 끝났고 그 프레임 수가 frames와 같으며, 게임 오버 이후 입력이 없다
 */
export function simulateReplay(input: ReplayInput): ReplayResult {
  if (!isValidReplayHeader(input)) return { ok: false, reason: 'INVALID_HEADER' };
  if (!isValidInputLog(input.inputs)) return { ok: false, reason: 'INVALID_INPUT' };

  const { inputs, frames } = input;
  const state = createGame({ seed: input.seed, das: input.das, arr: input.arr });
  const buffer: number[] = [];
  let index = 0;
  let inputFrame = inputs.length > 0 ? inputs[0] : -1;

  for (let frame = 0; frame < frames && !state.over; frame++) {
    let count = 0;
    while (index < inputs.length && inputFrame === frame) {
      buffer[count++] = inputs[index + 1];
      index += 2;
      if (index < inputs.length) inputFrame += inputs[index];
    }
    const applied = stepFrame(state, buffer, count);
    if (applied < count) return { ok: false, reason: 'INPUT_AFTER_END' };
  }

  if (!state.over) return { ok: false, reason: 'NOT_ENDED' };
  if (index < inputs.length) return { ok: false, reason: 'INPUT_AFTER_END' };
  if (state.endFrame !== frames) return { ok: false, reason: 'NOT_ENDED' };
  return toReplaySuccess(state);
}

export function toReplaySuccess(state: GameState): ReplaySuccess {
  return {
    ok: true,
    score: state.score,
    lines: state.lines,
    level: state.level,
    pieces: state.pieces,
    tSpins: state.tSpins,
    tetrises: state.tetrises,
    maxCombo: state.maxCombo,
    endFrame: state.endFrame,
    boardHash: getBoardHash(state),
  };
}

// ==================== 실시간 플레이 기록 ====================

export type InputRecorder = {
  inputs: number[];
  lastFrame: number;
};

export function createInputRecorder(): InputRecorder {
  return { inputs: [], lastFrame: 0 };
}

/** 프레임 frame에 적용한 동작을 기록한다 — stepFrame에 넘긴 순서 그대로 부른다 */
export function recordInput(recorder: InputRecorder, frame: number, code: number): void {
  recorder.inputs.push(frame - recorder.lastFrame, code);
  recorder.lastFrame = frame;
}

/** 게임 오버 후 제출할 리플레이 (§4-1 형식) */
export function buildReplay(
  state: GameState,
  recorder: InputRecorder,
): { engineVersion: number; das: number; arr: number; frames: number; inputs: number[] } {
  return {
    engineVersion: ENGINE_VERSION,
    das: state.das,
    arr: state.arr,
    frames: state.endFrame,
    inputs: recorder.inputs.slice(),
  };
}
