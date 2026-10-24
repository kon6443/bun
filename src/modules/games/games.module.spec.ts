import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { GamesModule } from './games.module';
import { GamesController } from './games.controller';
import { GameSessionService } from './game-session.service';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry } from './game-engine.registry';
import { DefenseVerifyService } from './defense-verify.service';
import { GameScore } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { GameReplayViewStat } from '../../entities/GameReplayViewStat';
import { GameViewService } from './game-view.service';
import { GameHallOfFameService } from './game-hall-of-fame.service';
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
  it('실제 가드·엔진 레지스트리를 포함해 컨트롤러 의존을 모두 해석하고, main.ts가 쓰는 GameSessionService·GameViewService·GameHallOfFameService를 노출해야 함', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), GlobalDataSourceStubModule, GamesModule],
    })
      .overrideProvider(getRepositoryToken(GameScore))
      .useValue(createMockRepository<GameScore>())
      .overrideProvider(getRepositoryToken(GameReplay))
      .useValue(createMockRepository<GameReplay>())
      .overrideProvider(getRepositoryToken(GameReplayViewStat))
      .useValue(createMockRepository<GameReplayViewStat>())
      .overrideProvider(getRepositoryToken(User))
      .useValue(createMockRepository<User>())
      .compile();

    expect(moduleRef.get(GamesController)).toBeInstanceOf(GamesController);
    expect(moduleRef.get(GameSessionService)).toBeInstanceOf(GameSessionService);
    expect(moduleRef.get(GameViewService)).toBeInstanceOf(GameViewService);
    expect(moduleRef.get(GameHallOfFameService)).toBeInstanceOf(GameHallOfFameService);
    await moduleRef.close();
  });

  describe('엔진 레지스트리 배선', () => {
    // ConfigService는 process.env를 먼저 본다 — 셸·CI에 설정된 값이 "설정 없음" 케이스를 깨지 않게 비운다
    const shellSecret = process.env.GAME_WEEKLY_SEED_SECRET;
    beforeEach(() => delete process.env.GAME_WEEKLY_SEED_SECRET);
    afterEach(() => {
      if (shellSecret !== undefined) {
        process.env.GAME_WEEKLY_SEED_SECRET = shellSecret;
      }
    });

    it('레지스트리에 테트리스·디펜스가 붙고, 디펜스 주간·테트리스 데일리는 GAME_WEEKLY_SEED_SECRET 설정을 읽는다', async () => {
      const compile = (env: Record<string, string>) =>
        Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
            GlobalDataSourceStubModule,
            GamesModule,
          ],
        })
          .overrideProvider(getRepositoryToken(GameScore))
          .useValue(createMockRepository<GameScore>())
          .overrideProvider(getRepositoryToken(GameReplay))
          .useValue(createMockRepository<GameReplay>())
          .overrideProvider(getRepositoryToken(GameReplayViewStat))
          .useValue(createMockRepository<GameReplayViewStat>())
          .overrideProvider(getRepositoryToken(User))
          .useValue(createMockRepository<User>())
          .compile();
      const now = new Date('2026-10-22T03:00:00.000Z');

      const without = await compile({});
      const engines = without.get<GameEngineRegistry>(GAME_ENGINE_REGISTRY);
      expect(Object.keys(engines).sort()).toEqual(['DEFENSE', 'TETRIS']);
      expect(() => engines.DEFENSE.resolveSessionBoard('weekly', now)).toThrow(
        expect.objectContaining({ code: 'GAME_WEEKLY_UNAVAILABLE' }),
      );
      expect(() => engines.TETRIS.resolveSessionBoard('daily', now)).toThrow(expect.objectContaining({ code: 'GAME_DAILY_UNAVAILABLE' }));
      await without.close();

      const withSecret = await compile({ GAME_WEEKLY_SEED_SECRET: 'module-spec' });
      expect(
        withSecret.get<GameEngineRegistry>(GAME_ENGINE_REGISTRY).DEFENSE.resolveSessionBoard('weekly', now),
      ).toMatchObject({ mode: 'weekly' });
      expect(withSecret.get<GameEngineRegistry>(GAME_ENGINE_REGISTRY).TETRIS.resolveSessionBoard('daily', now)).toMatchObject({
        boardKey: 'daily-2026-10-22',
        mode: 'daily',
      });

      // 디펜스 검증은 워커 풀 서비스로 간다(워커는 띄우지 않는다)
      const verify = jest
        .spyOn(withSecret.get(DefenseVerifyService), 'verify')
        .mockResolvedValue({ ok: false, reason: 'SPY' });
      const input = { seed: 1, boardKey: 'endless-s1', frames: 30, inputs: [], params: {} };
      await expect(
        withSecret.get<GameEngineRegistry>(GAME_ENGINE_REGISTRY).DEFENSE.verify(input),
      ).resolves.toEqual({ ok: false, reason: 'SPY' });
      expect(verify).toHaveBeenCalledWith(input);
      await withSecret.close();
    });
  });
});
