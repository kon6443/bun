import request from 'supertest';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { sign } from 'jsonwebtoken';
import { CustomThrottlerGuard } from '../src/common/guards/custom-throttler.guard';
import { RedisThrottlerStorage } from '../src/common/throttler/redis-throttler.storage';

const SECRET = 'e2e-throttle-secret';
const LIMIT = 2;

@Controller('probe')
class ProbeController {
  @Get()
  ok() {
    return { ok: true };
  }
}

/**
 * 스로틀 키를 **실제 DI·전역 가드·Express trust proxy** 위에서 검증한다.
 *
 * 단위 테스트(custom-throttler.guard.spec.ts)는 getTracker만 본다. 여기서는
 *  - APP_GUARD로 등록된 가드가 ConfigService·스토리지를 주입받아 실제로 동작하는지
 *  - 같은 IP 뒤의 서로 다른 로그인 사용자가 한도를 나누지 않는지
 *  - X-Forwarded-For 첫 값을 바꿔도 같은 버킷으로 세는지(trust proxy 1)
 * 를 HTTP 요청으로 확인한다. Redis는 붙이지 않는다 — 클라이언트가 없으면 저장소가 인메모리로 센다.
 */
describe('E2E 스로틀 키 (사용자·IP 단위)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ JWT_SECRET: SECRET })] }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'short', ttl: 60000, limit: LIMIT }],
          storage: new RedisThrottlerStorage(),
        }),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: CustomThrottlerGuard }],
    }).compile();

    const nestApp = moduleRef.createNestApplication<NestExpressApplication>();
    nestApp.use(cookieParser());
    nestApp.set('trust proxy', 1); // main.ts와 동일
    app = nestApp;
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const token = (sub: number) => sign({ sub, loginType: 'KAKAO' }, SECRET, { expiresIn: '1h' });
  const hit = (headers: Record<string, string>) => {
    const req = request(app.getHttpServer()).get('/probe');
    Object.entries(headers).forEach(([k, v]) => req.set(k, v));
    return req;
  };

  it('같은 IP의 서로 다른 로그인 사용자는 한도를 나누지 않는다', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.10' };
    for (let i = 0; i < LIMIT; i++) {
      expect((await hit({ ...ip, Cookie: `access_token=${token(1)}` })).status).toBe(200);
    }
    expect((await hit({ ...ip, Cookie: `access_token=${token(1)}` })).status).toBe(429);

    // 같은 공인 IP 뒤의 다른 사용자는 영향 없음 (이전에는 IP 하나로 묶여 함께 429)
    expect((await hit({ ...ip, Authorization: `Bearer ${token(2)}` })).status).toBe(200);
  });

  it('비로그인은 IP 단위로 센다 — XFF 첫 값을 바꿔도 우회되지 않는다', async () => {
    // 바로 앞 프록시가 붙인 마지막 값(198.51.100.7)이 req.ip다. 앞쪽은 요청자가 임의로 넣은 값
    for (let i = 0; i < LIMIT; i++) {
      expect((await hit({ 'X-Forwarded-For': `10.0.0.${i}, 198.51.100.7` })).status).toBe(200);
    }
    expect((await hit({ 'X-Forwarded-For': '10.9.9.9, 198.51.100.7' })).status).toBe(429);

    // 다른 사용자 IP는 별개 버킷
    expect((await hit({ 'X-Forwarded-For': '198.51.100.8' })).status).toBe(200);
  });

  it('서명이 틀린 토큰은 그 IP 버킷으로 센다 (남의 userId 버킷을 쓰지 못한다)', async () => {
    const forged = sign({ sub: 1 }, 'wrong-secret');
    const ip = { 'X-Forwarded-For': '203.0.113.20' };
    for (let i = 0; i < LIMIT; i++) {
      expect((await hit({ ...ip, Cookie: `access_token=${forged}` })).status).toBe(200);
    }
    // 위조 토큰을 바꿔 끼워도 같은 IP 버킷이라 막힌다
    expect((await hit({ ...ip, Cookie: `access_token=${sign({ sub: 99 }, 'wrong-secret')}` })).status).toBe(429);
  });
});
