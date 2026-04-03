import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MainController } from './main.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [MainController, HealthController],
})
export class MainModule {}




