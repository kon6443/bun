import { Injectable } from '@nestjs/common';

@Injectable()
export class DiscordService {
  private baseUrl = 'https://discord.com/api';

  async sendMessage({
    discordId,
    message,
  }: {
    discordId: string;
    message: string;
  }): Promise<void> {
    if (!discordId || !message) {
      console.warn('[DISCORD] sendMessage(): !discordId || !message');
      return;
    }
    console.log('service discordId:', discordId);
    console.log('service message:', message);
    console.log('baseUrl:', this.baseUrl);
    console.log('DISCORD_BOT_TOKEN:', process.env.DISCORD_BOT_TOKEN);
  }
}


