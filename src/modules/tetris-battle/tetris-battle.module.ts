import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { TetrisBattleMatch } from '../../entities/TetrisBattleMatch';
import { TetrisBattlePlayer } from '../../entities/TetrisBattlePlayer';
import { TetrisBattleReplay } from '../../entities/TetrisBattleReplay';
import { TetrisBattleResultController } from './tetris-battle-result.controller';
import { TetrisBattleResultService } from './tetris-battle-result.service';
import { TetrisBattleGateway } from './tetris-battle.gateway';
import { TetrisBattleRoomService } from './tetris-battle-room.service';
import { TetrisBattleWsGuard } from './tetris-battle-ws.guard';
import { TetrisBattleWsExceptionFilter } from './tetris-battle-ws-exception.filter';

/**
 * 테트리스 대전 (docs/tasks/tetris-battle) — `src/modules/games/`와 분리된 신규 모듈(DECISIONS D-003).
 * Redis 클라이언트는 main.ts가 `TetrisBattleRoomService.setRedisClient`로 주입한다.
 */
@Module({
  imports: [
    // User: TetrisBattleWsGuard·OptionalJwtAuthGuard가 토큰 유저를 조회. 나머지: 경기 후 검증 결과 저장(P5)
    TypeOrmModule.forFeature([User, TetrisBattleMatch, TetrisBattlePlayer, TetrisBattleReplay]),
    ConfigModule,
  ],
  controllers: [TetrisBattleResultController],
  providers: [
    TetrisBattleGateway,
    TetrisBattleRoomService,
    TetrisBattleResultService,
    TetrisBattleWsGuard,
    TetrisBattleWsExceptionFilter,
  ],
  exports: [TetrisBattleRoomService],
})
export class TetrisBattleModule {}
