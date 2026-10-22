import { BattleReplayInput, simulateBattleReplay } from './battle-engine';
import { KoReason } from './tetris-battle.events';

/**
 * 경기 후 리플레이 검증 — 순수 함수 (docs/tasks/tetris-battle DESIGN §17-1 2번)
 *
 * 실시간 경기에서 서버는 클라이언트 보고를 믿고 진행했다(DESIGN §8). 여기서 그 보고가 리플레이로 재현되는지 대조한다.
 * 대조 순서(앞에서 실패하면 그 이유로 INVALID):
 *  1. seed = 매치 seed
 *  2. 리플레이의 받은 가비지(id·lines·hole, 순서) = 서버 수신 로그의 **앞부분**(도착 프레임은 클라이언트 값)
 *     — 끝부분 누락은 **막판 것만** 허용(D-022): 서버가 `requiredBefore`(탈락자는 탈락 시각, 생존자는 종료 시각 − 1초,
 *       서버 Redis 시계) 전에 보낸 가비지는 반드시 리플레이에 있어야 한다. 그 뒤에 보낸 것은 클라이언트 판이 이미 끝나
 *       받지 못했을 수 있어(래퍼 receiveGarbage가 게임 오버 뒤 수신을 버림) 빠져도 된다. 중간이 빠지거나 다르면 불일치.
 *  3. simulateBattleReplay 성공(엔진 거절 이유는 그대로 실패 이유)
 *  4. 시뮬 결과의 공격 고정(sent > 0)을 서버 lock 로그와 대조 — 서버가 마지막으로 받은 seq까지만
 *     (서버가 먼저 탈락 처리한 뒤 클라이언트가 계속 둔 고정은 서버에 없다)
 *  5. 탈락(topout)이면 시뮬 탈락 프레임 = 서버 기록 탈락 프레임. 생존자면 시뮬에서 탈락하지 않았고 frames ≤ 경과 시간 상한.
 *     끊김·기권 탈락은 프레임을 대조하지 않는다(서버가 정한 탈락이라 클라이언트 판과 시점이 다르다)
 */

export interface VerificationContext {
  seed: number;
  /** 이 플레이어가 서버에서 받은 가비지(보낸 순서, at = 보낸 Redis 시각 — 없으면 옛 기록) */
  garbage: { id: number; lines: number; hole: number; at?: number | null }[];
  /** 이 시각(Redis ms) 전에 보낸 가비지는 리플레이에 반드시 있어야 한다. null이면 끝부분 누락을 모두 허용 */
  requiredBefore: number | null;
  /** 이 플레이어가 보고한 공격 lock (sent > 0, seq 순) */
  sentLog: { seq: number; sent: number }[];
  /** 서버가 받은 마지막 lock seq (없으면 0) */
  lastSeq: number;
  /** 탈락이면 사유·서버 기록 프레임, 생존(우승)이면 null */
  ko: { reason: KoReason; frame: number } | null;
  /** 생존자 frames 상한 = 경과 시간 × 60 + 여유 */
  maxFrames: number;
}

export type VerificationReason =
  | 'SEED_MISMATCH'
  | 'GARBAGE_MISMATCH'
  | 'SENT_MISMATCH'
  | 'TOP_OUT_FRAME_MISMATCH'
  | 'SURVIVOR_TOPPED_OUT'
  | 'FRAMES_EXCEED_ELAPSED'
  | `ENGINE_${string}`;

export type VerificationResult = { verdict: 'VERIFIED' } | { verdict: 'INVALID'; reason: VerificationReason };

const invalid = (reason: VerificationReason): VerificationResult => ({ verdict: 'INVALID', reason });

export function verifyBattleReplay(replay: BattleReplayInput, ctx: VerificationContext): VerificationResult {
  if (replay.seed !== ctx.seed) return invalid('SEED_MISMATCH');

  // 2. 가비지 — 리플레이 형식 [deltaFrame, id, lines, hole, ...]
  const received: { id: number; lines: number; hole: number }[] = [];
  for (let i = 0; i + 3 < replay.garbage.length; i += 4) {
    received.push({ id: replay.garbage[i + 1], lines: replay.garbage[i + 2], hole: replay.garbage[i + 3] });
  }
  if (received.length > ctx.garbage.length) return invalid('GARBAGE_MISMATCH');
  const { requiredBefore } = ctx;
  if (requiredBefore !== null) {
    // 보낸 시각 순서 = 로그 순서라 필수분은 앞부분이다. 시각이 없는 옛 기록은 필수로 본다(보수적)
    const required = ctx.garbage.filter((g) => g.at === undefined || g.at === null || g.at < requiredBefore).length;
    if (received.length < required) return invalid('GARBAGE_MISMATCH');
  }
  for (let i = 0; i < received.length; i++) {
    const a = received[i];
    const b = ctx.garbage[i];
    if (a.id !== b.id || a.lines !== b.lines || a.hole !== b.hole) return invalid('GARBAGE_MISMATCH');
  }

  // 3. 재현
  const sim = simulateBattleReplay(replay);
  if (!sim.ok) return invalid(`ENGINE_${sim.reason}`);

  // 4. 공격 — 서버가 받은 seq 범위 안의 공격 고정만
  const simSent = sim.sent.filter((l) => l.sent > 0 && l.seq <= ctx.lastSeq).map((l) => `${l.seq}:${l.sent}`);
  const serverSent = ctx.sentLog.map((l) => `${l.seq}:${l.sent}`);
  if (simSent.length !== serverSent.length || simSent.some((v, i) => v !== serverSent[i])) return invalid('SENT_MISMATCH');

  // 5. 탈락·생존
  if (ctx.ko === null) {
    if (sim.topOutFrame !== null) return invalid('SURVIVOR_TOPPED_OUT');
    if (sim.frames > ctx.maxFrames) return invalid('FRAMES_EXCEED_ELAPSED');
  } else if (ctx.ko.reason === 'topout' && sim.topOutFrame !== ctx.ko.frame) {
    return invalid('TOP_OUT_FRAME_MISMATCH');
  }
  return { verdict: 'VERIFIED' };
}
