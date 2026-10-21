import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FeedbackModule } from './feedback.module';
import { FeedbackController } from './feedback.controller';
import { Feedback } from '../../entities/Feedback';
import { User } from '../../entities/User';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { createMockRepository } from '../../common/__spec__/mock-repository';

/** AppModule에서 전역으로 오는 의존(@Global NotificationModule)을 대신한다 */
@Global()
@Module({
  providers: [{ provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn(), notifyFeedbackChannel: jest.fn() } }],
  exports: [NOTIFICATION_PORT],
})
class GlobalNotificationStubModule {}

/**
 * FeedbackModule의 DI 배선 — 실제 모듈을 그대로 조립한다(Repository만 mock, DB 연결 없음).
 *
 * E2E(createE2eApp)는 JwtAuthGuard를 override하고 컨트롤러만 조립하므로, 모듈이 가드의 의존(User Repository)을
 * 등록하지 않아도 통과한다. 그 누락은 `pnpm dev` 부팅 시 UnknownDependenciesException으로만 드러났다.
 * forFeature에서 User를 빼면 이 테스트가 같은 예외로 깨진다.
 */
describe('FeedbackModule', () => {
  it('실제 JwtAuthGuard를 포함해 컨트롤러 의존을 모두 해석해야 함', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), GlobalNotificationStubModule, FeedbackModule],
    })
      .overrideProvider(getRepositoryToken(Feedback))
      .useValue(createMockRepository<Feedback>())
      .overrideProvider(getRepositoryToken(User))
      .useValue(createMockRepository<User>())
      .compile();

    expect(moduleRef.get(FeedbackController)).toBeInstanceOf(FeedbackController);
    await moduleRef.close();
  });
});
