import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { GamesModule } from './games.module';
import { GamesController } from './games.controller';
import { GameSessionService } from './game-session.service';
import { GameScore } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { User } from '../../entities/User';
import { createMockRepository } from '../../common/__spec__/mock-repository';

/** AppModule이 주는 DataSource(TypeOrmModule.forRoot)를 대신한다 — 연결 없음 */
@Global()
@Module({
  providers: [{ provide: getDataSourceToken(), useValue: { transaction: jest.fn() } }],
  exports: [getDataSourceToken()],
})
class GlobalDataSourceStubModule {}

/**
 * GamesModule의 DI 배선 — 실제 모듈을 조립한다(Repository·DataSource만 대체, DB 연결 없음).
 *
 * E2E(createE2eApp)는 가드를 대체하고 컨트롤러만 조립하므로 모듈 import 누락을 잡지 못한다
 * (docs/lessons.md 2026-10-21 — 피드백 모듈 부팅 실패). OptionalJwtAuthGuard는 User Repository가 필요하다.
 */
describe('GamesModule', () => {
  it('실제 가드·엔진 레지스트리를 포함해 컨트롤러 의존을 모두 해석하고, main.ts가 쓰는 GameSessionService를 노출해야 함', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), GlobalDataSourceStubModule, GamesModule],
    })
      .overrideProvider(getRepositoryToken(GameScore))
      .useValue(createMockRepository<GameScore>())
      .overrideProvider(getRepositoryToken(GameReplay))
      .useValue(createMockRepository<GameReplay>())
      .overrideProvider(getRepositoryToken(User))
      .useValue(createMockRepository<User>())
      .compile();

    expect(moduleRef.get(GamesController)).toBeInstanceOf(GamesController);
    expect(moduleRef.get(GameSessionService)).toBeInstanceOf(GameSessionService);
    await moduleRef.close();
  });
});
