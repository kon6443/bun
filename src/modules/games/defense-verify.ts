import { ENGINE_VERSION, simulateReplay } from './defense-engine';
import type { ReplayInput, VerifiedReplay } from './game-engine.registry';

/** 엔진 헤더 mode — 보드 키 접두로 정한다. 캠페인은 서버에 제출하지 않는다(D-006) */
const BOARD_MODE_PREFIXES = [
  ['endless-', 'endless'],
  ['weekly-', 'weekly'],
] as const;

export function defenseModeOf(boardKey: string): string | null {
  return BOARD_MODE_PREFIXES.find(([prefix]) => boardKey.startsWith(prefix))?.[1] ?? null;
}

/**
 * 디펜스 리플레이 검증 — 엔진 사본(./defense-engine, 원본 next-bun)의 simulateReplay를 감싼다 (defense DESIGN §E4·§B2)
 *
 * 워커 스크립트(defense-verify.worker.ts)가 이 함수를 돌리고, 테스트는 같은 함수를 인프로세스로 부른다.
 * 엔진 예외도 입력에 대한 확정 결과다 — 재현 실패로 돌려준다(§B2 ③, 503 무한 재시도 방지).
 * 웨이브를 한 번도 시작하지 않은 판(판 상한까지 버팀)은 랭킹 오염이라 거부한다(D-025 4) — 엔진 결과 `wavesStarted`(D-026)로 판정.
 */
export function verifyDefenseReplay({ seed, boardKey, frames, inputs }: ReplayInput): VerifiedReplay {
  const mode = defenseModeOf(boardKey);
  if (!mode) {
    return { ok: false, reason: 'INVALID_HEADER' };
  }
  let result: ReturnType<typeof simulateReplay>;
  try {
    result = simulateReplay({ mode, boardKey, seed, ticks: frames, inputs });
  } catch {
    return { ok: false, reason: 'ENGINE_ERROR' };
  }
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  if (result.wavesStarted === 0) {
    return { ok: false, reason: 'NOT_STARTED' };
  }
  return {
    ok: true,
    score: result.score,
    detail: {
      wave: result.wave,
      progress: result.progress,
      kills: result.kills,
      livesLeft: result.livesLeft,
      goldEarned: result.goldEarned,
      engineVersion: ENGINE_VERSION,
    },
  };
}
