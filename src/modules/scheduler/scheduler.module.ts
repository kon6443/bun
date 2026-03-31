import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { TeamTask } from '../../entities/TeamTask';

@Module({
  imports: [TypeOrmModule.forFeature([User, TeamTask])],
  providers: [SchedulerService],
})
export class SchedulerModule {}




