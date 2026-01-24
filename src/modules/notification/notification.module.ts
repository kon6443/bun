import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordController } from './discord.controller';
import { TelegramController } from './telegram.controller';
import { DiscordService } from './discord.service';
import { TelegramService } from './telegram.service';
import { Team } from '../../entities/Team';
import { TelegramLink } from '../../entities/TelegramLink';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Team, TelegramLink])],
  controllers: [DiscordController, TelegramController],
  providers: [DiscordService, TelegramService],
  exports: [DiscordService, TelegramService],
})
export class NotificationModule {}
