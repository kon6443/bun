import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [SchedulerService],
})
export class SchedulerModule {}


