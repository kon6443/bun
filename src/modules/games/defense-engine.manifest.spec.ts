import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from './defense-engine-manifest.json';
import { ENGINE_VERSION } from './defense-engine';

/**
 * 디펜스 엔진 사본 동기화 검사 (docs/tasks/defense DESIGN §E0, D-013·D-025)
 *
 * `defense-engine/`은 프론트(next-bun `src/app/games/defense/engine/`) 원본의 사본이고, 매니페스트는 두 레포에 같은 파일이다.
 * 프론트 테스트도 원본 폴더 해시가 매니페스트와 같은지 단정하므로, 한쪽만 고치면 어느 쪽 CI든 깨진다.
 * 사본은 직접 고치지 않는다 — 원본 수정 → 프론트에서 매니페스트 재생성 → 사본·매니페스트 그대로 복사.
 *
 * 계산식(프론트 engine-dev/manifest.ts와 같다):
 *  대상 = 엔진 루트 아래 `**\/*.ts`(`*.test.ts` 제외) + `__fixtures__/**`, `.`으로 시작하는 파일·폴더 제외
 *  경로 = 상대경로·`/` 구분·UTF-16 코드 단위 사전순 · 파일 해시 = 바이트 sha256 hex
 *  전체 해시 = 파일마다 `${path}\n${sha}\n`을 이어 붙인 문자열의 sha256
 */
const ENGINE_ROOT = path.join(__dirname, 'defense-engine');

function listTargetFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listTargetFiles(path.join(dir, entry.name), relative));
    } else if (relative.startsWith('__fixtures__/') || (relative.endsWith('.ts') && !relative.endsWith('.test.ts'))) {
      files.push(relative);
    }
  }
  return files;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe('디펜스 엔진 사본 — 매니페스트', () => {
  // 기본 sort()는 UTF-16 코드 단위 순서 — localeCompare를 쓰면 프론트와 순서가 달라진다
  const files = listTargetFiles(ENGINE_ROOT).sort();
  const entries = files.map((file) => ({ path: file, sha256: sha256(readFileSync(path.join(ENGINE_ROOT, file))) }));

  it('엔진 버전이 매니페스트와 같아야 함', () => {
    expect(ENGINE_VERSION).toBe(manifest.engineVersion);
  });

  it('파일 목록·파일별 해시가 매니페스트와 같아야 함 (사본을 고쳤거나 복사가 빠짐)', () => {
    expect(entries).toEqual(manifest.files);
  });

  it('전체 해시가 매니페스트와 같아야 함', () => {
    expect(sha256(entries.map((entry) => `${entry.path}\n${entry.sha256}\n`).join(''))).toBe(manifest.sha256);
  });

  it('사본 폴더에 대상 밖 파일이 없어야 함 — 해시 검사를 벗어나는 파일 방지(숨김 파일은 계산식처럼 건너뜀: .DS_Store 등)', () => {
    const all: string[] = [];
    const walk = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else all.push(relative);
      }
    };
    walk(ENGINE_ROOT);
    expect(all.sort()).toEqual(files);
  });
});
