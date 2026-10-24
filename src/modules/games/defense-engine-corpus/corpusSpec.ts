import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PortableCase, computeExpected, diffExpected } from './portableRunner';

/**
 * 디펜스 엔진 결과 동일성 안전망 (docs/tasks/defense-engine-refactor) — 리팩토링이 결과를 1비트라도 바꾸면 실패한다.
 *
 * 프론트가 현재 엔진으로 만든 이식용 코퍼스(무한·주간·캠페인, 판 상한 장판·보스 포함)를 백엔드 엔진 사본으로 다시 돌려
 * 최종 결과 + 300틱마다의 상태 해시가 같은지 본다. 첫 차이(체크포인트 번호·틱 또는 결과 필드)를 메시지로 남긴다.
 * 판이 많아 모드별 spec 파일로 나눠 jest가 병렬로 돌린다. 러너·픽스처는 프론트 원본의 사본이라 sha256으로 감시한다
 */
const DIR = __dirname;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const copyHashes = JSON.parse(readFileSync(join(DIR, 'copy-hashes.json'), 'utf8')) as Record<string, string>;
export const corpus = JSON.parse(readFileSync(join(DIR, 'portable.json'), 'utf8')) as {
  version: number;
  engineVersion: number;
  checkpointTicks: number;
  cases: PortableCase[];
};
export const readCorpusFile = (name: string) => readFileSync(join(DIR, name), 'utf8');

/** 한 모드의 판을 모두 돌려 고정값과 비교한다 */
export function describeCorpusMode(mode: string): void {
  const cases = corpus.cases.filter((c) => c.input.mode === mode);
  describe(`디펜스 엔진 결과 동일성 코퍼스 — ${mode}`, () => {
    it('이 모드의 판이 있다', () => expect(cases.length).toBeGreaterThan(0));
    it.each(cases.map((c) => [c.id, c] as const))('%s — 최종 결과·중간 해시가 고정값과 같다', (_id, c) => {
      const actual = computeExpected(c.input, corpus.checkpointTicks);
      if ('error' in actual) throw new Error(`재생 실패: ${actual.error}`);
      expect(diffExpected(actual, c.expected, corpus.checkpointTicks)).toBeNull();
    });
  });
}
