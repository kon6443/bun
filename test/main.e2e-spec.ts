import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { MainController } from '../src/modules/main/main.controller';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

/**
 * E2E 인프라 자체를 검증하는 최소 스펙.
 *
 * 여기가 깨지면 다른 모든 E2E의 결과를 믿을 수 없다 — 전역 prefix가 안 붙었거나,
 * ValidationPipe·HttpExceptionFilter가 실제로 파이프라인에 들어가지 않았거나,
 * 앱이 뜨지 못한 것이기 때문이다. 그래서 **의존성이 0인 MainController**를 쓴다.
 *
 * 이 스펙이 통과한다는 것은 곧 "DB 없이 HTTP 파이프라인이 뜬다"는 증명이기도 하다
 * (D6 전략 A의 전제).
 */
describe('E2E 인프라 (MainController)', () => {
  let e2e: E2eApp;
  let app: INestApplication;

  beforeAll(async () => {
    e2e = await createE2eApp({ controllers: [MainController] });
    app = e2e.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('전역 prefix가 붙은 경로로 응답해야 함', async () => {
    const res = await request(app.getHttpServer()).get(e2e.url('/'));

    expect(res.status).toBe(200);
    // 이 프로젝트의 응답 규약: { code, data, message }
    expect(res.body).toEqual({ code: 'SUCCESS', data: null, message: '' });
  });

  it('prefix 없는 경로는 404여야 함 (setGlobalPrefix 적용 증명)', async () => {
    const res = await request(app.getHttpServer()).get('/');

    expect(res.status).toBe(404);
  });

  it('없는 경로의 404도 표준 에러 포맷으로 나가야 함', async () => {
    const res = await request(app.getHttpServer()).get(e2e.url('/not-exist'));

    expect(res.status).toBe(404);
    // HttpExceptionFilter가 파이프라인에 실제로 들어가 있다는 증거 —
    // 필터가 없으면 Nest 기본 포맷({statusCode, message, error})으로 나간다
    expect(res.body).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      timestamp: expect.any(String),
    });
    expect(res.body).not.toHaveProperty('statusCode');
  });
});
