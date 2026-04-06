import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { FishingGateway } from './fishing.gateway';
import { FishingOnlineService } from './fishing-online.service';
import { FishingWsGuard } from './fishing-ws.guard';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter';
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
    WsExceptionFilter, // WebSocket 예외 필터 (DI 기반)
  ],
  exports: [FishingGateway, FishingOnlineService],
})
export class FishingModule {}
