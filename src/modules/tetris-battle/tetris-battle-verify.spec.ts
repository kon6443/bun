import golden from './battle-engine/__fixtures__/golden-battle-replays.json';
import { BattleReplayInput, simulateBattleReplay } from './battle-engine';
import { VerificationContext, verifyBattleReplay } from './tetris-battle-verify';

type GoldenCase = { name: string; input: BattleReplayInput; expected: { ok: boolean; reason?: string } };
const CASES = golden as unknown as GoldenCase[];
const OK_CASES = CASES.filter((c) => c.expected.ok);
const byName = (name: string) => {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`골든 케이스 없음: ${name}`);
  return c.input;
};

/**
 * 정직한 클라이언트의 서버 기록을 리플레이에서 만든다 — 서버가 실시간으로 받았을 값과 같다:
 * 받은 가비지 = 리플레이 garbage, lock 공격 로그 = 시뮬 sent > 0, 마지막 seq = 고정 수, 탈락 = 시뮬 탈락 프레임
 */
const honestContext = (replay: BattleReplayInput): VerificationContext => {
  const sim = simulateBattleReplay(replay);
  if (!sim.ok) throw new Error('골든 성공 케이스여야 한다');
  const garbage = [];
  for (let i = 0; i < replay.garbage.length; i += 4) {
    garbage.push({ id: replay.garbage[i + 1], lines: replay.garbage[i + 2], hole: replay.garbage[i + 3] });
  }
  return {
    seed: replay.seed,
    garbage,
    requiredBefore: null,
    sentLog: sim.sent.filter((l) => l.sent > 0).map((l) => ({ seq: l.seq, sent: l.sent })),
    lastSeq: sim.pieces,
    ko: sim.topOutFrame === null ? null : { reason: 'topout', frame: sim.topOutFrame },
    maxFrames: sim.frames,
  };
};

/**
 * 경기 후 검증(DESIGN §17-1) — 실시간 서버 기록과 리플레이 대조. 각 실패 갈래가 **정확한 이유**로 INVALID가 되는지,
 * 그리고 정직한 리플레이(골든 전체)가 거부되지 않는지를 본다. 오탐이면 정상 플레이어의 경기가 DISPUTED가 된다.
 */
describe('verifyBattleReplay', () => {
  it.each(OK_CASES.map((c) => [c.name, c.input] as const))('정직한 골든 리플레이(%s)는 VERIFIED', (_name, replay) => {
    expect(verifyBattleReplay(replay, honestContext(replay))).toEqual({ verdict: 'VERIFIED' });
  });

  it('seed가 매치 seed와 다르면 SEED_MISMATCH', () => {
    const replay = byName('attack-combo');
    expect(verifyBattleReplay(replay, { ...honestContext(replay), seed: replay.seed + 1 })).toEqual({
      verdict: 'INVALID',
      reason: 'SEED_MISMATCH',
    });
  });

  describe('가비지', () => {
    const replay = byName('garbage-block-out'); // 받은 가비지 6개

    it('서버가 보낸 것과 구멍이 다르면 GARBAGE_MISMATCH', () => {
      const ctx = honestContext(replay);
      ctx.garbage[2] = { ...ctx.garbage[2], hole: (ctx.garbage[2].hole + 1) % 10 };
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'GARBAGE_MISMATCH' });
    });

    it('서버가 보내지 않은 가비지를 받았다고 하면 GARBAGE_MISMATCH', () => {
      const ctx = honestContext(replay);
      ctx.garbage = ctx.garbage.slice(0, 3);
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'GARBAGE_MISMATCH' });
    });

    it('경계(탈락·종료 − 1초) 전에 보낸 가비지가 리플레이에 없으면 GARBAGE_MISMATCH (D-022)', () => {
      const ctx = honestContext(replay);
      ctx.garbage = [...ctx.garbage.map((g) => ({ ...g, at: 1_000 })), { id: 99, lines: 4, hole: 3, at: 4_999 }];
      ctx.requiredBefore = 5_000; // 99번은 경계 전에 보냈다 → 받았어야 한다
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'GARBAGE_MISMATCH' });
    });

    it('경계 이후(막판)에 보낸 가비지만 빠졌으면 허용 (D-022)', () => {
      const ctx = honestContext(replay);
      ctx.garbage = [...ctx.garbage.map((g) => ({ ...g, at: 1_000 })), { id: 99, lines: 4, hole: 3, at: 5_000 }];
      ctx.requiredBefore = 5_000;
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'VERIFIED' });
    });

    it('보낸 시각이 없는 옛 기록은 필수로 본다(보수적)', () => {
      const ctx = honestContext(replay);
      ctx.garbage = [...ctx.garbage, { id: 99, lines: 4, hole: 3 }];
      ctx.requiredBefore = 5_000;
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'GARBAGE_MISMATCH' });
    });

    it('서버 로그 끝부분을 받지 못한 것은 허용(판이 끝난 뒤 도착한 가비지)', () => {
      const ctx = honestContext(replay);
      ctx.garbage = [...ctx.garbage, { id: 99, lines: 4, hole: 3 }];
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'VERIFIED' });
    });
  });

  describe('보낸 공격', () => {
    const replay = byName('attack-combo'); // 공격 고정 16개

    it('서버 lock 로그와 sent가 다르면 SENT_MISMATCH', () => {
      const ctx = honestContext(replay);
      ctx.sentLog[5] = { ...ctx.sentLog[5], sent: ctx.sentLog[5].sent + 1 };
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'SENT_MISMATCH' });
    });

    it('서버가 받지 않은 공격을 리플레이가 담고 있으면 SENT_MISMATCH', () => {
      const ctx = honestContext(replay);
      ctx.sentLog = ctx.sentLog.slice(1);
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'SENT_MISMATCH' });
    });

    it('서버가 먼저 탈락 처리한 뒤의 고정(seq > 서버 마지막 seq)은 대조하지 않는다', () => {
      const ctx = honestContext(replay);
      const cut = ctx.sentLog[9].seq;
      ctx.sentLog = ctx.sentLog.filter((l) => l.seq <= cut);
      ctx.lastSeq = cut;
      ctx.ko = { reason: 'disconnect', frame: 100 };
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'VERIFIED' });
    });
  });

  describe('탈락·생존', () => {
    it('탈락(topout) 프레임이 서버 기록과 다르면 TOP_OUT_FRAME_MISMATCH', () => {
      const replay = byName('garbage-top-out');
      const ctx = honestContext(replay);
      ctx.ko = { reason: 'topout', frame: (ctx.ko?.frame ?? 0) + 1 };
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: 'TOP_OUT_FRAME_MISMATCH' });
    });

    it('끊김·기권 탈락은 프레임을 대조하지 않는다(서버가 정한 탈락)', () => {
      const replay = byName('garbage-top-out');
      const ctx = honestContext(replay);
      ctx.ko = { reason: 'leave', frame: 1 };
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'VERIFIED' });
    });

    it('서버 기록상 생존자인데 리플레이에서 탈락했으면 SURVIVOR_TOPPED_OUT', () => {
      const replay = byName('garbage-top-out');
      expect(verifyBattleReplay(replay, { ...honestContext(replay), ko: null })).toEqual({
        verdict: 'INVALID',
        reason: 'SURVIVOR_TOPPED_OUT',
      });
    });

    it('생존자의 frames가 경과 시간 상한을 넘으면 FRAMES_EXCEED_ELAPSED (같으면 통과)', () => {
      const replay = byName('survivor');
      const ctx = honestContext(replay);
      expect(verifyBattleReplay(replay, { ...ctx, maxFrames: replay.frames })).toEqual({ verdict: 'VERIFIED' });
      expect(verifyBattleReplay(replay, { ...ctx, maxFrames: replay.frames - 1 })).toEqual({
        verdict: 'INVALID',
        reason: 'FRAMES_EXCEED_ELAPSED',
      });
    });
  });

  it.each(CASES.filter((c) => !c.expected.ok).map((c) => [c.name, c.input, c.expected.reason] as const))(
    '엔진이 거절하면(%s) 그 이유 그대로 ENGINE_*',
    (_name, replay, reason) => {
      const ctx: VerificationContext = {
        seed: replay.seed,
        garbage: [],
        requiredBefore: null,
        sentLog: [],
        lastSeq: 0,
        ko: null,
        maxFrames: 1_000_000,
      };
      // 가비지 대조가 먼저라 서버 로그를 리플레이와 같게 맞춘다 — 엔진 거절 갈래만 보기 위해
      for (let i = 0; i + 3 < replay.garbage.length; i += 4) {
        ctx.garbage.push({ id: replay.garbage[i + 1], lines: replay.garbage[i + 2], hole: replay.garbage[i + 3] });
      }
      expect(verifyBattleReplay(replay, ctx)).toEqual({ verdict: 'INVALID', reason: `ENGINE_${reason}` });
    },
  );
});
