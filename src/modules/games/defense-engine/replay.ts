/**
 * 리플레이 검증·기록 — 서버 검증·프론트 재생·시뮬레이터가 같은 함수를 쓴다 (§E3·§E4)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  AUGMENT_CHOICES,
  BRANCH_COUNT,
  ENGINE_VERSION,
  MAX_INPUT_LENGTH,
  MAX_SLOT_ID,
  MAX_TICKS,
  MAX_TOWER_KIND,
  OP,
  OP_ARG_COUNTS,
  OP_MAX,
  SEED_MAX,
  TARGET_MODE_COUNT,
} from './constants';
import { resolveBoard } from './data/stages';
import { type GameState, applyCommand, createGame, getStateHash, scoreOf, step } from './game';

/** 헤더 mode·boardKey·seed는 서버 세션 값 — 클라이언트 제출값을 믿지 않는다(§E3). 해석은 resolveBoard(알 수 없는 mode·boardKey는 INVALID_HEADER) */
export type ReplayInput = {
  mode: string;
  boardKey: string;
  seed: number;
  /** 게임 틱 수 (API 필드명은 frames) */
  ticks: number;
  /** [deltaTick, op, ...인자] — deltaTick은 직전 명령과의 틱 차이(첫 명령은 0틱 기준) */
  inputs: number[];
};

export type ReplayFailureReason =
  | 'INVALID_HEADER'
  | 'INVALID_INPUT'
  | 'INVALID_COMMAND'
  | 'INPUT_AFTER_END'
  | 'NOT_ENDED'
  | 'LIMIT_EXCEEDED';

export type ReplaySuccess = {
  ok: true;
  score: number;
  wave: number;
  progress: number;
  kills: number;
  livesLeft: number;
  goldEarned: number;
  /** 시작한 웨이브 수 — CALL_WAVE(1웨이브 시작·조기 호출)와 카운트다운 자동 시작을 모두 센다. 0이면 시작하지 않은 판 */
  wavesStarted: number;
  /** 고른 증강 카드 id (고른 순서) */
  augments: number[];
  endTick: number;
  stateHash: string;
};

export type ReplayResult = ReplaySuccess | { ok: false; reason: ReplayFailureReason };

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** op별 인자 형식 범위 — 그 시점 상태에서 수행 가능한지는 applyCommand(INVALID_COMMAND)가 본다 */
function isValidArgs(op: number, a: number, b: number): boolean {
  switch (op) {
    case OP.BUILD:
      return isIntInRange(a, 0, MAX_SLOT_ID) && isIntInRange(b, 0, MAX_TOWER_KIND);
    case OP.UPGRADE:
    case OP.SELL:
      return isIntInRange(a, 0, MAX_SLOT_ID);
    case OP.BRANCH:
      return isIntInRange(a, 0, MAX_SLOT_ID) && isIntInRange(b, 0, BRANCH_COUNT - 1);
    case OP.SET_TARGET:
      return isIntInRange(a, 0, MAX_SLOT_ID) && isIntInRange(b, 0, TARGET_MODE_COUNT - 1);
    case OP.PICK_AUGMENT:
      return isIntInRange(a, 0, AUGMENT_CHOICES - 1);
    default:
      return true;
  }
}

/** 명령 로그 형식 — 정수·음수 아닌 delta·알 수 없는 op·인자 개수·인자 범위 */
function isValidInputLog(inputs: readonly unknown[]): boolean {
  let i = 0;
  while (i < inputs.length) {
    const op = inputs[i + 1];
    if (!isIntInRange(inputs[i], 0, MAX_TICKS) || !isIntInRange(op, 0, OP_MAX)) return false;
    const count = OP_ARG_COUNTS[op];
    if (i + 2 + count > inputs.length) return false;
    const a = count > 0 ? inputs[i + 2] : 0;
    const b = count > 1 ? inputs[i + 3] : 0;
    if (typeof a !== 'number' || typeof b !== 'number' || !isValidArgs(op, a, b)) return false;
    i += 2 + count;
  }
  return true;
}

/**
 * 헤더·명령 로그로 게임을 화면 없이 처음부터 끝까지 실행한다
 * 성공 조건: 게임이 끝났고(목숨 0·전 웨이브 클리어·판 상한) 그 틱 수가 ticks와 같으며, 끝난 뒤 명령이 없다
 * 사유 경계: 끝난 뒤·선언 ticks 뒤 명령 = INPUT_AFTER_END · 끝난 틱 ≠ ticks(늦게·일찍 모두) = NOT_ENDED
 * input은 서버 DTO가 형식을 막은 뒤의 객체다(null 등은 호출 전에 거른다)
 */
export function simulateReplay(input: ReplayInput): ReplayResult {
  if (!isIntInRange(input.seed, 0, SEED_MAX) || !isIntInRange(input.ticks, 1, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'INVALID_HEADER' };
  }
  const stage = typeof input.mode === 'string' && typeof input.boardKey === 'string' ? resolveBoard(input.mode, input.boardKey, input.seed) : null;
  if (!stage) return { ok: false, reason: 'INVALID_HEADER' };
  if (!Array.isArray(input.inputs)) return { ok: false, reason: 'INVALID_INPUT' };
  if (input.ticks > MAX_TICKS || input.inputs.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'LIMIT_EXCEEDED' };
  if (!isValidInputLog(input.inputs)) return { ok: false, reason: 'INVALID_INPUT' };

  const { inputs, ticks } = input;
  const state = createGame(stage, input.seed);
  let commandTick = 0;
  let i = 0;
  while (i < inputs.length) {
    commandTick += inputs[i];
    const op = inputs[i + 1];
    const count = OP_ARG_COUNTS[op];
    while (state.tick < commandTick && !state.over && !state.augmentPending && state.tick < ticks) step(state);
    // 증강 대기 중에는 틱이 멈춘다 — 그동안의 명령은 delta 0이어야 한다(뒤 틱으로 미룬 명령은 수행 불가)
    if (state.augmentPending && state.tick < commandTick) return { ok: false, reason: 'INVALID_COMMAND' };
    // 명령 틱 전에 끝났거나, 선언한 틱 수를 넘어선 명령
    if (state.over || state.tick < commandTick) return { ok: false, reason: 'INPUT_AFTER_END' };
    const a = count > 0 ? inputs[i + 2] : 0;
    const b = count > 1 ? inputs[i + 3] : 0;
    if (!applyCommand(state, op, a, b)) return { ok: false, reason: 'INVALID_COMMAND' };
    i += 2 + count;
  }
  while (!state.over && !state.augmentPending && state.tick < ticks) step(state);

  // 증강을 고르지 않고 멈춘 판·선언 틱에 끝나지 않은 판·선언보다 일찍 끝난 판
  if (!state.over || state.endTick !== ticks) return { ok: false, reason: 'NOT_ENDED' };
  return toReplaySuccess(state);
}

export function toReplaySuccess(state: GameState): ReplaySuccess {
  const { score, wave, progress } = scoreOf(state);
  return {
    ok: true,
    score,
    wave,
    progress,
    kills: state.kills,
    livesLeft: state.lives,
    goldEarned: state.goldEarned,
    wavesStarted: state.wavesStarted,
    augments: state.augments.slice(),
    endTick: state.endTick,
    stateHash: getStateHash(state),
  };
}

// ==================== 실시간 플레이 기록 ====================

export type CommandRecorder = {
  inputs: number[];
  lastTick: number;
};

export function createCommandRecorder(): CommandRecorder {
  return { inputs: [], lastTick: 0 };
}

/** applyCommand가 수락한 명령만, 그 시점의 state.tick(처리 완료 틱 수)으로 기록한다 */
export function recordCommand(recorder: CommandRecorder, tick: number, op: number, a = 0, b = 0): void {
  recorder.inputs.push(tick - recorder.lastTick, op);
  const count = OP_ARG_COUNTS[op];
  if (count > 0) recorder.inputs.push(a);
  if (count > 1) recorder.inputs.push(b);
  recorder.lastTick = tick;
}

/** 끝난 판의 제출용 리플레이 (§E3 제출 본문 replay — mode·boardKey·seed는 서버 세션 값이라 싣지 않는다) */
export function buildReplay(state: GameState, recorder: CommandRecorder): { engineVersion: number; frames: number; inputs: number[] } {
  return { engineVersion: ENGINE_VERSION, frames: state.endTick, inputs: recorder.inputs.slice() };
}
