import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from './fortress-engine-manifest.json';
import { ENGINE_VERSION } from './engine';

/**
 * 포트리스 엔진 사본 동기화 검사 (docs/tasks/fortress DESIGN §10, D-008)
 *
 * `engine/`은 프론트(next-bun `src/app/games/fortress/engine/`) 원본의 사본이고, 매니페스트는 프론트
 * `engine-dev/ENGINE_MANIFEST.json`과 같은 파일이다. 프론트 테스트도 원본 폴더 해시가 매니페스트와 같은지 단정한다.
 * 사본은 직접 고치지 않는다 — 원본 수정 → 프론트에서 매니페스트 재생성 → 사본·매니페스트 그대로 복사.
 *
 * 계산식(디펜스 엔진 매니페스트와 같다):
 *  대상 = 엔진 루트 아래 `**\/*.ts`(`*.test.ts` 제외) + `__fixtures__/**`, `.`으로 시작하는 파일·폴더 제외
 *  경로 = 상대경로·`/` 구분·UTF-16 코드 단위 사전순 · 파일 해시 = 바이트 sha256 hex
 *  전체 해시 = 파일마다 `${path}\n${sha}\n`을 이어 붙인 문자열의 sha256
 */
const ENGINE_ROOT = path.join(__dirname, 'engine');

function listAllFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listAllFiles(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

const isTarget = (relative: string) =>
  relative.startsWith('__fixtures__/') || (relative.endsWith('.ts') && !relative.endsWith('.test.ts'));

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe('포트리스 엔진 사본 — 매니페스트', () => {
  // 기본 sort()는 UTF-16 코드 단위 순서 — localeCompare를 쓰면 프론트와 순서가 달라진다
  const all = listAllFiles(ENGINE_ROOT).sort();
  const files = all.filter(isTarget);
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

  it('사본 폴더에 대상 밖 파일이 없어야 함 — 해시 검사를 벗어나는 파일 방지(숨김 파일은 계산식처럼 건너뜀)', () => {
    expect(all).toEqual(files);
  });
});
