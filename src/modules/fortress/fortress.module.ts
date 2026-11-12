import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FortressMatch } from '../../entities/FortressMatch';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { FortressReplay } from '../../entities/FortressReplay';
import { User } from '../../entities/User';
import { UserPointLedger } from '../../entities/UserPointLedger';
import { UsersModule } from '../users/users.module';
import { FortressGateway } from './fortress.gateway';
import { FortressMatchService } from './fortress-match.service';
import { FortressLobbyChatService } from './fortress-lobby-chat.service';
import { FortressResultController } from './fortress-result.controller';
import { FortressResultService } from './fortress-result.service';
import { FortressRoomService } from './fortress-room.service';
import { FortressPointsService } from './fortress-points.service';
import { FortressSkinController } from './fortress-skin.controller';
import { FortressSkinService } from './fortress-skin.service';
import { FortressWsGuard } from './fortress-ws.guard';
import { FortressWsExceptionFilter } from './fortress-ws-exception.filter';

/**
 * 포트리스 대전 (docs/tasks/fortress) — F4: 방·로비 + 서버 권위 턴 매치 · F6: 결과·리플레이 저장과 조회 REST · F7: 경기 포인트 적립·탱크 스킨.
 * Redis 클라이언트는 main.ts가 `FortressRoomService`·`FortressMatchService`·`FortressLobbyChatService`의 `setRedisClient`로 주입한다.
 */
@Module({
  imports: [
    // User: FortressWsGuard가 토큰 유저를 조회, 로비 채팅이 보낸 사람 이름을 조회(D-016), 결과 저장이 탈퇴 USER_ID를 확인. 나머지: 결과 저장(F6)
    // UserPointLedger: 경기 포인트 조회(F7)
    TypeOrmModule.forFeature([User, FortressMatch, FortressPlayer, FortressReplay, UserPointLedger]),
    ConfigModule,
    // F7: 공용 포인트 원장(UserPointService)·스킨 장착/강화(UserSkinService)
    UsersModule,
  ],
  controllers: [FortressResultController, FortressSkinController],
  providers: [
    FortressGateway,
    FortressRoomService,
    FortressMatchService,
    FortressResultService,
    FortressPointsService,
    FortressSkinService,
    FortressLobbyChatService,
    FortressWsGuard,
    FortressWsExceptionFilter,
  ],
  exports: [FortressRoomService],
})
export class FortressModule {}
