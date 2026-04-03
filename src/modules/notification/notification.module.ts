import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramController } from './telegram.controller';
import { DiscordService } from './discord.service';
import { TelegramService } from './telegram.service';
import { NotificationAdapter } from './notification.adapter';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { Team } from '../../entities/Team';
import { TelegramLink } from '../../entities/TelegramLink';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Team, TelegramLink])],
  controllers: [TelegramController],
  providers: [
    DiscordService,
    TelegramService,
    NotificationAdapter,
    { provide: NOTIFICATION_PORT, useExisting: NotificationAdapter },
  ],
  exports: [DiscordService, TelegramService, NOTIFICATION_PORT],
})
export class NotificationModule {}
