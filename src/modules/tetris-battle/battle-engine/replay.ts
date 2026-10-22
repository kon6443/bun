/**
 * 대전 리플레이 기록·검증 — 서버 경기 후 검증과 프론트 재생이 같은 함수를 쓴다 (DESIGN §8·§15)
 * 리플레이 = 시드 + 입력(엔진 형식) + 받은 가비지(도착 프레임 순). 같은 기록이면 같은 판·같은 공격이 나온다
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import { BATTLE_ENGINE_VERSION, MAX_BATTLE_FRAMES, MAX_GARBAGE_EVENTS } from './constants';
import { type BattleLock, type BattleState, createBattle, isValidGarbageEvent, receiveGarbage, stepBattle } from './battle';
import {
  ACTION_CODE_MAX,
  ARR_MAX,
  ARR_MIN,
  DAS_MAX,
  DAS_MIN,
  MAX_INPUT_LENGTH,
  SEED_MAX,
  getBoardHash,
} from './engine';

export type BattleReplayInput = {
  battleEngineVersion: number;
  seed: number;
  das: number;
  arr: number;
  /** 진행한 프레임 수 — 탈락했으면 탈락 프레임(endFrame), 끝까지 살았으면 경기 종료까지 */
  frames: number;
  /** [deltaFrame, code, ...] — 엔진 리플레이와 같은 형식 */
  inputs: number[];
  /** [deltaFrame, id, lines, hole, ...] — deltaFrame은 직전 가비지 도착 프레임과의 차이(첫 항목은 0프레임 기준) */
  garbage: number[];
};

export type BattleReplayFailureReason =
  | 'INVALID_HEADER'
  | 'INVALID_INPUT'
  | 'INVALID_GARBAGE'
  | 'INPUT_AFTER_END'
  | 'GARBAGE_AFTER_END'
  | 'FRAMES_MISMATCH';

export type BattleReplaySuccess = {
  ok: true;
  frames: number;
  /** 탈락(엔진 게임 오버·가비지 탑아웃) 프레임 수, 살아남았으면 null */
  topOutFrame: number | null;
  /** 가비지에 밀려 탈락했는지 */
  toppedOut: boolean;
  /** 공격이 있었던 고정 — 서버가 실시간 보고(lock.seq·sent)와 대조한다 */
  sent: BattleLock[];
  totalAttack: number;
  totalSent: number;
  garbageReceived: number;
  pieces: number;
  lines: number;
  maxCombo: number;
  boardHash: string;
};

export type BattleReplayResult = BattleReplaySuccess | { ok: false; reason: BattleReplayFailureReason };

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidBattleReplayHeader(input: {
  battleEngineVersion: unknown;
  seed: unknown;
  das: unknown;
  arr: unknown;
  frames: unknown;
}): boolean {
  return (
    input.battleEngineVersion === BATTLE_ENGINE_VERSION &&
    isIntInRange(input.seed, 0, SEED_MAX) &&
    isIntInRange(input.das, DAS_MIN, DAS_MAX) &&
    isIntInRange(input.arr, ARR_MIN, ARR_MAX) &&
    isIntInRange(input.frames, 1, MAX_BATTLE_FRAMES)
  );
}

function isValidInputLog(inputs: unknown): inputs is number[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUT_LENGTH || inputs.length % 2 !== 0) return false;
  for (let i = 0; i < inputs.length; i += 2) {
    if (!isIntInRange(inputs[i], 0, MAX_BATTLE_FRAMES) || !isIntInRange(inputs[i + 1], 0, ACTION_CODE_MAX)) return false;
  }
  return true;
}

/** id는 엄격히 증가, 줄 수 1~MAX_ATTACK, 구멍 열 0~9 — 이벤트 판정은 실시간 수신과 같은 함수 */
function isValidGarbageLog(garbage: unknown): garbage is number[] {
  if (!Array.isArray(garbage) || garbage.length > MAX_GARBAGE_EVENTS * 4 || garbage.length % 4 !== 0) return false;
  let lastId = -1;
  for (let i = 0; i < garbage.length; i += 4) {
    if (!isIntInRange(garbage[i], 0, MAX_BATTLE_FRAMES) || !isValidGarbageEvent(lastId, garbage[i + 1], garbage[i + 2], garbage[i + 3])) {
      return false;
    }
    lastId = garbage[i + 1];
  }
  return true;
}

function toSuccess(bs: BattleState, frames: number): BattleReplaySuccess {
  let totalAttack = 0;
  let totalSent = 0;
  for (let i = 0; i < bs.sentLog.length; i++) {
    totalAttack += bs.sentLog[i].attack;
    totalSent += bs.sentLog[i].sent;
  }
  const game = bs.game;
  return {
    ok: true,
    frames,
    topOutFrame: game.over ? game.endFrame : null,
    toppedOut: bs.toppedOut,
    sent: bs.sentLog.slice(),
    totalAttack,
    totalSent,
    garbageReceived: bs.garbageReceived,
    pieces: game.pieces,
    lines: game.lines,
    maxCombo: game.maxCombo,
    boardHash: getBoardHash(game),
  };
}

/**
 * 시드·입력·받은 가비지로 대전 한 판을 화면 없이 실행한다
 * 매 프레임: 그 프레임에 도착한 가비지를 받는다 → 그 프레임 입력으로 stepBattle
 * 성공 조건: frames까지 진행했고, 탈락했다면 탈락 프레임이 frames와 같으며, 탈락 뒤 입력·가비지가 없다
 */
export function simulateBattleReplay(input: BattleReplayInput): BattleReplayResult {
  if (!isValidBattleReplayHeader(input)) return { ok: false, reason: 'INVALID_HEADER' };
  if (!isValidInputLog(input.inputs)) return { ok: false, reason: 'INVALID_INPUT' };
  if (!isValidGarbageLog(input.garbage)) return { ok: false, reason: 'INVALID_GARBAGE' };

  const { inputs, garbage, frames } = input;
  const bs = createBattle({ seed: input.seed, das: input.das, arr: input.arr });
  const buffer: number[] = [];
  let inputIndex = 0;
  let inputFrame = inputs.length > 0 ? inputs[0] : -1;
  let garbageIndex = 0;
  let garbageFrame = garbage.length > 0 ? garbage[0] : -1;

  for (let frame = 0; frame < frames && !bs.game.over; frame++) {
    while (garbageIndex < garbage.length && garbageFrame === frame) {
      receiveGarbage(bs, { id: garbage[garbageIndex + 1], lines: garbage[garbageIndex + 2], hole: garbage[garbageIndex + 3] });
      garbageIndex += 4;
      if (garbageIndex < garbage.length) garbageFrame += garbage[garbageIndex];
    }
    let count = 0;
    while (inputIndex < inputs.length && inputFrame === frame) {
      buffer[count++] = inputs[inputIndex + 1];
      inputIndex += 2;
      if (inputIndex < inputs.length) inputFrame += inputs[inputIndex];
    }
    const { applied } = stepBattle(bs, buffer, count);
    if (applied < count) return { ok: false, reason: 'INPUT_AFTER_END' };
  }

  if (inputIndex < inputs.length) return { ok: false, reason: 'INPUT_AFTER_END' };
  if (garbageIndex < garbage.length) return { ok: false, reason: 'GARBAGE_AFTER_END' };
  if (bs.game.over && bs.game.endFrame !== frames) return { ok: false, reason: 'FRAMES_MISMATCH' };
  return toSuccess(bs, frames);
}

/** 받은 가비지 → 리플레이 형식 [deltaFrame, id, lines, hole, ...] — frames 이후(진행하지 않은 프레임)에 도착한 것은 뺀다 */
export function encodeGarbageLog(received: BattleState['received'], frames: number): number[] {
  const out: number[] = [];
  let last = 0;
  for (let i = 0; i < received.length; i++) {
    const ev = received[i];
    if (ev.frame >= frames) break;
    out.push(ev.frame - last, ev.id, ev.lines, ev.hole);
    last = ev.frame;
  }
  return out;
}

/** 경기가 끝난 뒤 제출할 대전 리플레이 — inputs는 엔진 InputRecorder 기록 그대로 */
export function buildBattleReplay(bs: BattleState, inputs: readonly number[], das: number, arr: number): BattleReplayInput {
  const frames = bs.game.over ? bs.game.endFrame : bs.game.frame;
  return {
    battleEngineVersion: BATTLE_ENGINE_VERSION,
    seed: bs.seed,
    das,
    arr,
    frames,
    inputs: inputs.slice(),
    garbage: encodeGarbageLog(bs.received, frames),
  };
}
