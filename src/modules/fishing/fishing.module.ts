import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { FishingGateway } from './fishing.gateway';
import { FishingOnlineService } from './fishing-online.service';
import { FishingWsGuard } from './fishing-ws.guard';
import { User } from '../../entities/User';

@Module({
  imports: [
    // FishingWsGuard에서 User 엔티티 사용
    TypeOrmModule.forFeature([User]),
    ConfigModule,
  ],
  providers: [
    FishingGateway,
    FishingOnlineService,
    FishingWsGuard,
  ],
  exports: [FishingGateway, FishingOnlineService],
})
export class FishingModule {}
