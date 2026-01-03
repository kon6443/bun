import { Module } from '@nestjs/common';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Team, TeamMember]), AuthModule],
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}

