import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GameSessionService } from './game-session.service';
import { GameViewService } from './game-view.service';
import { GameHallOfFameService } from './game-hall-of-fame.service';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry } from './game-engine.registry';
import { createTetrisGameEngine } from './tetris-game-engine';
import { createDefenseGameEngine } from './defense-game-engine';
import { DefenseVerifyService } from './defense-verify.service';
import { GameScore } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { GameReplayViewStat } from '../../entities/GameReplayViewStat';
import { User } from '../../entities/User';

@Module({
  // User: 라우트의 OptionalJwtAuthGuard(JwtAuthGuard 상속)가 사용자 조회에 쓴다
  imports: [TypeOrmModule.forFeature([GameScore, GameReplay, GameReplayViewStat, User])],
  controllers: [GamesController],
  providers: [
    GamesService,
    GameSessionService,
    GameViewService,
    GameHallOfFameService,
    DefenseVerifyService,
    {
      provide: GAME_ENGINE_REGISTRY,
      inject: [ConfigService, DefenseVerifyService],
      useFactory: (config: ConfigService, defenseVerify: DefenseVerifyService): GameEngineRegistry => ({
        // 데일리 seed는 디펜스 주간과 같은 비밀값을 쓴다 — HMAC 입력 접두로 용도를 나눈다(games-growth D-004)
        TETRIS: createTetrisGameEngine({ getDailySecret: () => config.get<string>('GAME_WEEKLY_SEED_SECRET') || undefined }),
        DEFENSE: createDefenseGameEngine({
          getWeeklySecret: () => config.get<string>('GAME_WEEKLY_SEED_SECRET') || undefined,
          verify: input => defenseVerify.verify(input),
        }),
      }),
    },
  ],
  // main.ts가 Redis 클라이언트를 주입한다
  exports: [GameSessionService, GameViewService, GameHallOfFameService],
})
export class GamesModule {}
