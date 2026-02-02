import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { TeamGateway } from './team.gateway';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { AuthModule } from '../auth/auth.module';
import { WsJwtGuard } from '../../common/guards/ws-jwt-auth.guard';

@Module({
  imports: [
    // Entity 등록 (User 추가: WsJwtGuard에서 사용)
    TypeOrmModule.forFeature([Team, TeamMember, TeamTask, TaskComment, TeamInvitation, User]),
    AuthModule,
    ConfigModule,
  ],
  controllers: [TeamController],
  providers: [
    TeamService,
    TeamGateway, // NestJS 정석: Gateway를 Provider로 등록
    WsJwtGuard, // WebSocket 인증 Guard
  ],
  exports: [TeamService, TeamGateway], // 다른 모듈에서 Gateway 사용 가능
})
export class TeamModule {}
