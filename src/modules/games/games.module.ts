import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GameSessionService } from './game-session.service';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry } from './game-engine.registry';
import { tetrisGameEngine } from './tetris-game-engine';
import { GameScore } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { User } from '../../entities/User';

const GAME_ENGINES: GameEngineRegistry = {
  TETRIS: tetrisGameEngine,
};

@Module({
  // User: 라우트의 OptionalJwtAuthGuard(JwtAuthGuard 상속)가 사용자 조회에 쓴다
  imports: [TypeOrmModule.forFeature([GameScore, GameReplay, User])],
  controllers: [GamesController],
  providers: [GamesService, GameSessionService, { provide: GAME_ENGINE_REGISTRY, useValue: GAME_ENGINES }],
  // main.ts가 Redis 클라이언트를 주입한다
  exports: [GameSessionService],
})
export class GamesModule {}
