import { parentPort } from 'node:worker_threads';
import { verifyDefenseReplay } from './defense-verify';
import type { ReplayInput } from './game-engine.registry';

/**
 * 디펜스 검증 워커 엔트리 — VerifyWorkerPool 규약(verify-worker-pool.ts 머리 주석)을 따른다.
 * 빌드 결과(dist의 .js)로만 뜬다. verifyDefenseReplay는 재현 실패·엔진 예외를 확정 결과로 돌려주므로
 * `ok: false`는 그 밖의 처리 실패(인프라)에만 쓴다.
 */
const port = parentPort;
if (port) {
  port.on('message', ({ id, input }: { id: number; input: ReplayInput }) => {
    try {
      port.postMessage({ id, ok: true, result: verifyDefenseReplay(input) });
    } catch (error) {
      port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  port.postMessage({ ready: true });
}
