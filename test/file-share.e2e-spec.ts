import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { FileShareController } from '../src/modules/file-share/file-share.controller';
import { FileShareService } from '../src/modules/file-share/file-share.service';
import { FileShare } from '../src/entities/FileShare';
import { createFileShare } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const SHARE_ID = 'e2e-share';
const API_KEY = 'e2e-api-key';
/** ENV=LOCAL이면 컨트롤러가 process.cwd()/shared를 base로 잡는다 */
const SHARE_DIR = path.join(process.cwd(), 'shared', SHARE_ID);

/**
 * 파일 공유는 **JWT가 아닌 별도 인증**(shareId + apiKey)을 쓰는 유일한 경계다.
 * 가드가 아니라 컨트롤러가 직접 검사하므로, 라우트에 실제로 그 검사가 걸려 있는지는
 * E2E로만 확인된다.
 *
 * 더 중요한 것은 **경로 탐색 방어**다. 이 API는 요청 값(filename)으로 실제 파일시스템을
 * 읽으므로, 뚫리면 서버의 임의 파일이 그대로 다운로드된다. 방어가 문자열 검사
 * (`path.basename` 비교 + `..` 포함 여부)와 경로 해석 비교(`resolve().startsWith()`)
 * **2중**으로 되어 있는데, 문자열만으로는 URL 인코딩 우회를 놓칠 수 있어 실제 HTTP
 * 요청으로 태워봐야 의미가 있다.
 *
 * 실제 파일시스템을 쓴다 — mock하면 경로 해석 검증이 무의미해지기 때문이다.
 * 테스트 전용 디렉토리만 만들고 끝나면 지운다.
 */
describe('E2E 파일 공유 (API Key 인증 + 경로 탐색 방어)', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let fileShareRepository: MockRepository<FileShare>;

  beforeAll(() => {
    fs.mkdirSync(SHARE_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHARE_DIR, 'report.txt'), 'e2e-content');
  });

  afterAll(() => {
    fs.rmSync(path.join(process.cwd(), 'shared'), { recursive: true, force: true });
  });

  beforeEach(async () => {
    fileShareRepository = createMockRepository<FileShare>();
    // 유효한 자격 증명일 때만 레코드가 나온다
    fileShareRepository.findOne.mockImplementation(async (options) => {
      const where = (options as { where: { shareId: string; apiKey: string } }).where;
      return where.shareId === SHARE_ID && where.apiKey === API_KEY
        ? createFileShare({ shareId: SHARE_ID, apiKey: API_KEY })
        : null;
    });

    e2e = await createE2eApp({
      controllers: [FileShareController],
      providers: [
        FileShareService,
        { provide: getRepositoryToken(FileShare), useValue: fileShareRepository },
        { provide: ConfigService, useValue: { get: jest.fn((k: string) => (k === 'ENV' ? 'LOCAL' : undefined)) } },
      ],
    });
    app = e2e.app;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('인증 (shareId + apiKey)', () => {
    it.each([
      ['둘 다 없으면', {}],
      ['shareId만 있으면', { shareId: SHARE_ID }],
      ['apiKey만 있으면', { apiKey: API_KEY }],
      ['자격 증명이 틀리면', { shareId: SHARE_ID, apiKey: 'wrong-key' }],
    ])('%s 401이어야 함', async (_desc, query) => {
      const res = await request(app.getHttpServer()).get(e2e.url('/files')).query(query);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'FILE_SHARE_UNAUTHORIZED' });
    });

    it('쿼리스트링으로 인증할 수 있어야 함', async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url('/files'))
        .query({ shareId: SHARE_ID, apiKey: API_KEY });

      expect(res.status).toBe(200);
    });

    it('헤더로도 인증할 수 있어야 함', async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url('/files'))
        .set('x-share-id', SHARE_ID)
        .set('x-api-key', API_KEY);

      // 두 방식을 모두 지원하는 것이 계약이다 — 한쪽만 되면 연동 클라이언트가 깨진다
      expect(res.status).toBe(200);
    });
  });

  describe('파일 목록', () => {
    it('공유 디렉토리의 파일을 크기와 함께 반환해야 함', async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url('/files'))
        .query({ shareId: SHARE_ID, apiKey: API_KEY });

      expect(res.status).toBe(200);
      expect(res.body.data.files).toEqual([
        expect.objectContaining({ filename: 'report.txt', size: 11, sizeMB: '0.00' }),
      ]);
    });

    it('공유 디렉토리가 없으면 빈 목록이어야 함 (404가 아니라)', async () => {
      fileShareRepository.findOne.mockResolvedValue(createFileShare({ shareId: 'no-dir', apiKey: API_KEY }));

      const res = await request(app.getHttpServer())
        .get(e2e.url('/files'))
        .query({ shareId: 'no-dir', apiKey: API_KEY });

      expect(res.status).toBe(200);
      expect(res.body.data.files).toEqual([]);
    });
  });

  describe('다운로드 — 경로 탐색 방어', () => {
    it.each([
      ['상위 디렉토리 탈출', '..%2f..%2fpackage.json'],
      ['인코딩된 절대 경로', '%2Fetc%2Fpasswd'],
      ['점 두 개 포함', 'a..b%2f..%2fpackage.json'],
      ['하위 경로 지정', 'sub%2ffile.txt'],
      ['점 두 개만 있는 이름', 'x..y'],
    ])('%s 시도는 403으로 차단해야 함', async (_desc, filename) => {
      const res = await request(app.getHttpServer())
        .get(e2e.url(`/files/${filename}`))
        .query({ shareId: SHARE_ID, apiKey: API_KEY });

      // 403(거부)과 404(파일 없음)를 반드시 구분해야 한다.
      // 방어를 제거하면 path.basename()이 경로를 무해화해 404가 나는데,
      // 404까지 허용하면 방어가 통째로 사라져도 테스트가 통과한다(실제로 그랬다).
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FILE_SHARE_FORBIDDEN' });
      expect(res.headers['content-disposition']).toBeUndefined();
    });

    it('탈출 경로로 실제 파일을 읽어내지 못해야 함', async () => {
      // 방어가 없으면 shared/{shareId}/../../package.json → 프로젝트 루트의 실제 파일에 닿는다
      const res = await request(app.getHttpServer())
        .get(e2e.url('/files/..%2f..%2fpackage.json'))
        .query({ shareId: SHARE_ID, apiKey: API_KEY });

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('devDependencies');
    });

    it('인증 없이는 경로 탐색조차 시도할 수 없어야 함', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/files/..%2fpackage.json'));

      // 인증이 경로 검사보다 앞에 있어야 한다
      expect(res.status).toBe(401);
    });
  });

  describe('다운로드 — 정상 경로', () => {
    it('첨부 헤더와 함께 파일 내용을 내려줘야 함', async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url('/files/report.txt'))
        .query({ shareId: SHARE_ID, apiKey: API_KEY })
        // octet-stream은 supertest가 자동 파싱하지 않는다 — 스트리밍 응답이라 직접 모은다
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/octet-stream');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-length']).toBe('11');
      expect((res.body as Buffer).toString()).toBe('e2e-content');
    });

    it('없는 파일은 404여야 함', async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url('/files/nope.txt'))
        .query({ shareId: SHARE_ID, apiKey: API_KEY });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'FILE_SHARE_FILE_NOT_FOUND' });
    });

    it('다른 shareId의 파일은 볼 수 없어야 함 (공유 격리)', async () => {
      fileShareRepository.findOne.mockResolvedValue(createFileShare({ shareId: 'other', apiKey: API_KEY }));

      const res = await request(app.getHttpServer())
        .get(e2e.url('/files/report.txt'))
        .query({ shareId: 'other', apiKey: API_KEY });

      // shareId가 디렉토리를 가르므로 남의 공유본에 접근할 수 없다
      expect(res.status).toBe(404);
    });
  });
});
