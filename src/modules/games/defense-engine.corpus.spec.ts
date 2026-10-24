import { ENGINE_VERSION } from './defense-engine';
import { copyHashes, corpus, readCorpusFile, sha256 } from './defense-engine-corpus/corpusSpec';

/** 코퍼스 사본·구성 검사 — 판 재생은 모드별 spec(defense-engine.corpus.<mode>.spec.ts) */
describe('디펜스 엔진 결과 동일성 코퍼스 — 사본·구성', () => {
  it('픽스처·러너가 프론트 원본과 같다(러너는 엔진 import 경로만 다름)', () => {
    expect(sha256(readCorpusFile('portable.json'))).toBe(copyHashes['portable.json']);
    const runner = readCorpusFile('portableRunner.ts').replace("} from '../defense-engine';", "} from '../../engine';");
    expect(sha256(runner)).toBe(copyHashes['portableRunner.ts']);
  });

  it('픽스처를 만든 엔진 버전이 지금 엔진과 같다 — 규칙 변경(버전 상승) 뒤에는 픽스처를 다시 만들어야 한다', () => {
    expect(corpus.engineVersion).toBe(ENGINE_VERSION);
  });

  it('seed를 2^31 이상까지 담는다 — 부호 있는 32비트 처리 변경을 잡는다', () => {
    expect(corpus.cases.some((c) => c.input.seed >= 2 ** 31)).toBe(true);
  });

  it('무한·주간·캠페인을 모두 담는다', () => {
    expect([...new Set(corpus.cases.map((c) => c.input.mode))].sort()).toEqual(['campaign', 'endless', 'weekly']);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(70);
  });
});
