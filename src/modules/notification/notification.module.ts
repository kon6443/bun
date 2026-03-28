import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramController } from './telegram.controller';
import { DiscordService } from './discord.service';
import { TelegramService } from './telegram.service';
import { NotificationService } from './notification.service';
import { Team } from '../../entities/Team';
import { TelegramLink } from '../../entities/TelegramLink';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Team, TelegramLink])],
  controllers: [TelegramController],
  providers: [DiscordService, TelegramService, NotificationService],
  exports: [DiscordService, TelegramService, NotificationService],
})
export class NotificationModule {}
