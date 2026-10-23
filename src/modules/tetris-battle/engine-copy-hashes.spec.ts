import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import manifest from './engine-copy-hashes.json';

/**
 * 엔진 사본 드리프트 감시 (tetris-audit BE-23·FE-07) — 테트리스 엔진·대전 래퍼는 프론트(next-bun) 원본의 사본이다.
 * 사본 파일 해시를 매니페스트에 고정해, 한쪽만 고치면 이 테스트가 깨지게 한다. 고쳤다면 프론트와 같은 변경인지 확인한 뒤
 * 매니페스트를 갱신하고, 프론트 레포의 같은 매니페스트와 값이 같은지 대조한다.
 * 제외: battle-engine/engine.ts(import 경로만 다름)·테스트 파일(러너가 jest/vitest로 달라 내용이 다르다 — 같은 golden fixture를 쓰는지만 본다).
 */
describe('엔진 사본 해시 매니페스트', () => {
  const root = join(__dirname, '..');

  it.each(Object.entries(manifest))('%s', (path, expected) => {
    const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    expect(actual).toBe(expected);
  });
});
