import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import { User } from '../../entities/User';
import { TelegramService } from '../notification/telegram.service';
import { DiscordService } from '../notification/discord.service';
import { TeamService } from './team.service';
import { toLinkStatusForRole } from './team.mapper';
import {
  CreateTelegramLinkResponseDto,
  DeleteDiscordWebhookResponseDto,
  DeleteTelegramLinkResponseDto,
  DiscordStatusResponseDto,
  SaveDiscordWebhookDto,
  SaveDiscordWebhookResponseDto,
  TelegramStatusResponseDto,
} from './team-integration.dto';
import {
  TeamDiscordWebhookInvalidErrorResponseDto,
  TeamForbiddenErrorResponseDto,
  TeamNotFoundErrorResponseDto,
} from './team-error.dto';

/**
 * 팀 알림 연동 REST — 텔레그램·디스코드 (docs/tasks/refactor-perf-b-2026-11 B3)
 *
 * 연동 생성·해제는 MASTER·MANAGER만(requireManagerAccess), 상태 조회는 팀 멤버 누구나 하되
 * 연동 토큰·chatId·웹훅 URL은 관리자에게만 준다(toLinkStatusForRole). 경로·응답은 TeamController 시절과 같다.
 */
@ApiTags('teams')
@Controller('teams')
export class TeamIntegrationController {
  constructor(
    private readonly teamService: TeamService,
    private readonly telegramService: TelegramService,
    private readonly discordService: DiscordService,
  ) {}

  /**
   * MASTER/MANAGER 권한 체크 공통 메서드
   */
  private async requireManagerAccess(teamId: number, userId: number, errorMessage?: string): Promise<void> {
    await this.teamService.assertManagerAccess(
      teamId,
      userId,
      () => new TeamForbiddenErrorResponseDto(errorMessage || '팀 리더 또는 매니저만 이 작업을 할 수 있습니다.'),
    );
  }

  // ==================== 텔레그램 연동 API ====================

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/telegram/link')
  @ApiOperation({ summary: '텔레그램 연동 링크 생성' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: CreateTelegramLinkResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 텔레그램 연동을 할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.', type: TeamNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async createTelegramLink(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    await this.requireManagerAccess(teamId, user.userId);

    const result = await this.telegramService.generateLinkToken(teamId);
    return {
      code: 'SUCCESS',
      data: result,
      message: '',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/telegram/status')
  @ApiOperation({ summary: '텔레그램 연동 상태 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TelegramStatusResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.', type: TeamNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getTelegramStatus(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    // 팀 멤버 확인 — 연동 토큰·chatId는 관리자에게만 준다
    const member = await this.teamService.verifyTeamMemberAccess(teamId, user.userId);

    const status = await this.telegramService.getLinkStatus(teamId);
    return {
      code: 'SUCCESS',
      data: toLinkStatusForRole(status, member.role),
      message: '',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':teamId/telegram/link')
  @ApiOperation({ summary: '텔레그램 연동 해제' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: DeleteTelegramLinkResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 텔레그램 연동을 해제할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.', type: TeamNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async deleteTelegramLink(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    await this.requireManagerAccess(teamId, user.userId);

    await this.telegramService.unlinkTeam(teamId);
    return { code: 'SUCCESS', data: null, message: '' };
  }

  // ==================== 디스코드 연동 API ====================

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/discord/webhook')
  @ApiOperation({ summary: '디스코드 Webhook URL 저장' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiBody({ type: SaveDiscordWebhookDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: SaveDiscordWebhookResponseDto })
  @ApiResponse({ status: 400, description: '유효하지 않은 Webhook URL입니다.', type: TeamDiscordWebhookInvalidErrorResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 디스코드 연동을 할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.', type: TeamNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  @ApiCommonValidationResponse()
  async saveDiscordWebhook(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: SaveDiscordWebhookDto,
  ) {
    await this.requireManagerAccess(teamId, user.userId);

    // Webhook URL 유효성 검증
    const validation = await this.discordService.validateWebhookUrl(dto.webhookUrl);
    if (!validation.valid) {
      throw new TeamDiscordWebhookInvalidErrorResponseDto();
    }

    await this.discordService.saveWebhookUrl(teamId, dto.webhookUrl);
    return { code: 'SUCCESS', data: null, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/discord/status')
  @ApiOperation({ summary: '디스코드 연동 상태 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: DiscordStatusResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.', type: TeamNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getDiscordStatus(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    // 웹훅 URL은 관리자에게만 준다 (URL만 있으면 채널에 임의 게시 가능)
    const member = await this.teamService.verifyTeamMemberAccess(teamId, user.userId);

    const status = await this.discordService.getLinkStatus(teamId);
    return {
      code: 'SUCCESS',
      data: toLinkStatusForRole(status, member.role),
      message: '',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':teamId/discord/webhook')
  @ApiOperation({ summary: '디스코드 연동 해제' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: DeleteDiscordWebhookResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 디스코드 연동을 해제할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.', type: TeamNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async deleteDiscordWebhook(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    await this.requireManagerAccess(teamId, user.userId);

    await this.discordService.unlinkTeam(teamId);
    return { code: 'SUCCESS', data: null, message: '' };
  }
}
