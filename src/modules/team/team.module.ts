import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { TeamGateway } from './team.gateway';
import { OnlineUserService } from './online-user.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { AuthModule } from '../auth/auth.module';
import { WsJwtGuard } from '../../common/guards/ws-jwt-auth.guard';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter';

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
    OnlineUserService, // Redis 기반 온라인 유저 관리
    WsJwtGuard, // WebSocket 인증 Guard
    WsExceptionFilter, // WebSocket 예외 필터 (DI 기반)
  ],
  exports: [TeamService, TeamGateway, OnlineUserService],
})
export class TeamModule {}
