import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordController } from './discord.controller';
import { DiscordService } from './discord.service';
import { TelegramService } from './telegram.service';
import { Team } from '../../entities/Team';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Team])],
  controllers: [DiscordController],
  providers: [DiscordService, TelegramService],
  exports: [DiscordService, TelegramService],
})
export class NotificationModule {}
