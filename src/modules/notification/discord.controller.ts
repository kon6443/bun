import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiCookieAuth } from '@nestjs/swagger';
import { DiscordService } from './discord.service';
import { SendMessageDto } from './dto/send-message.dto';
import { DiscordResponseDto, SendMessageResponseDto } from './dto/response/discord-response.dto';

@ApiTags('discord')
@ApiCookieAuth('cookieAuth')
@Controller('discord')
export class DiscordController {
  constructor(private readonly discordService: DiscordService) {}

  @Get()
  @ApiOperation({ summary: '디스코드 기본 api' })
  @ApiResponse({ status: 200, description: '성공', type: DiscordResponseDto })
  getDiscord() {
    return { message: 'DISCORD ROUTER' };
  }

  @Post(':discordId/message')
  @ApiOperation({ summary: '디스코드 discordId 별 메세지 전송 api' })
  @ApiParam({ name: 'discordId', type: String, description: 'discordId(고유PK)' })
  @ApiResponse({ status: 200, description: '성공', type: SendMessageResponseDto })
  @ApiResponse({ status: 400, description: '나쁜 요청' })
  @ApiResponse({ status: 401, description: '유효하지 않은 앱키나 토큰으로 요청' })
  @ApiResponse({ status: 404, description: '해당 자원을 찾을 수 없음' })
  @ApiResponse({ status: 500, description: '내부 서버 오류' })
  async postDiscordMessage(
    @Param('discordId') discordId: string,
    @Body() sendMessageDto: SendMessageDto,
  ) {
    await this.discordService.sendMessage({
      discordId,
      message: sendMessageDto.message,
    });
    return { message: 'SUCCESS' };
  }
}
