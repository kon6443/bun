import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { TelegramService, TelegramUpdate } from './telegram.service';
import { TelegramWebhookDto, TelegramWebhookResponseDto } from './dto/telegram-webhook.dto';

@ApiTags('telegram')
@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  /**
   * 텔레그램 Webhook 엔드포인트
   * 텔레그램 Bot API에서 설정한 webhook URL로 이벤트가 전송됩니다.
   * 
   * 처리하는 이벤트:
   * - my_chat_member: 봇이 그룹에 추가/제거될 때
   * - message: /start 명령어 처리 (연동 토큰 검증)
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '텔레그램 Webhook 수신' })
  @ApiBody({ type: TelegramWebhookDto })
  @ApiResponse({ status: 200, description: '처리 완료', type: TelegramWebhookResponseDto })
  @ApiResponse({ status: 500, description: '서버 오류' })
  async handleWebhook(@Body() update: TelegramUpdate): Promise<TelegramWebhookResponseDto> {
    try {
      const result = await this.telegramService.handleWebhook(update);
      return result;
    } catch (error) {
      console.error('[TELEGRAM] Webhook 처리 오류:', error);
      // 텔레그램은 200 OK를 받아야 재시도하지 않음
      return { success: false, message: '처리 중 오류 발생' };
    }
  }
}
