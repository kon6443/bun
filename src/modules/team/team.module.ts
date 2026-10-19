import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { TeamController } from './team.controller';
import { TeamChatController } from './team-chat.controller';
import { TeamTagController } from './team-tag.controller';
import { TeamService } from './team.service';
import { TeamGateway } from './team.gateway';
import { OnlineUserService } from './online-user.service';
import { TeamChatService } from './team-chat.service';
import { TeamTagService } from './team-tag.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { TeamChatMessage } from '../../entities/TeamChatMessage';
import { TeamChatReadCursor } from '../../entities/TeamChatReadCursor';
import { TeamTag } from '../../entities/TeamTag';
import { TeamTaskTag } from '../../entities/TeamTaskTag';
import { AuthModule } from '../auth/auth.module';
import { WsJwtGuard } from '../../common/guards/ws-jwt-auth.guard';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter';

@Module({
  imports: [
    // Entity 등록 (User 추가: WsJwtGuard에서 사용)
    TypeOrmModule.forFeature([
      Team,
      TeamMember,
      TeamTask,
      TaskComment,
      TeamInvitation,
      User,
      TeamChatMessage,
      TeamChatReadCursor,
      TeamTag,
      TeamTaskTag,
    ]),
    AuthModule,
    ConfigModule,
  ],
  controllers: [TeamController, TeamChatController, TeamTagController],
  providers: [
    TeamService,
    TeamGateway, // NestJS 정석: Gateway를 Provider로 등록
    OnlineUserService, // Redis 기반 온라인 유저 관리
    TeamChatService, // 채팅 저장·읽음 커서 (원본 Oracle, Redis는 레이트 리밋만)
    TeamTagService, // 팀 태그 CRUD·재정렬 (태스크 연결은 TeamService + task-tags.ts)
    WsJwtGuard, // WebSocket 인증 Guard
    WsExceptionFilter, // WebSocket 예외 필터 (DI 기반)
  ],
  exports: [TeamService, TeamGateway, OnlineUserService, TeamChatService],
})
export class TeamModule {}
