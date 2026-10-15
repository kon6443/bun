import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import { User } from '../../entities/User';
import { TeamChatService } from './team-chat.service';
import { ChatMessagesResponseDto, ChatReadStateResponseDto, GetChatMessagesQueryDto } from './team-chat.dto';
import { TeamChatBadRequestErrorResponseDto, TeamForbiddenErrorResponseDto } from './team-error.dto';

/**
 * 팀 채팅 REST — 이력·읽음 상태 조회 (docs/tasks/team-chat-persistence DESIGN §7)
 *
 * 전송·읽음 갱신은 소켓(`/teams` chatMessage·chatRead)으로 한다. 여기는 화면 진입·재연결 시 맞추는 조회만 둔다.
 */
@ApiTags('teams')
@Controller('teams')
export class TeamChatController {
  constructor(private readonly teamChatService: TeamChatService) {}

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/chat/messages')
  @ApiOperation({
    summary: '팀 채팅 이력 조회',
    description:
      'keyset 페이지. beforeId(과거 방향)·afterId(최신 방향)는 미포함이고 동시에 쓸 수 없다. ' +
      '둘 다 없으면 최신 limit개. 결과는 항상 오래된 것부터 정렬한다.',
  })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: ChatMessagesResponseDto })
  @ApiResponse({ status: 400, description: 'beforeId와 afterId를 함께 지정함', type: TeamChatBadRequestErrorResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async getChatMessages(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Query() query: GetChatMessagesQueryDto,
  ) {
    const data = await this.teamChatService.getMessages(teamId, user.userId, query);
    return { code: 'SUCCESS', data, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/chat/read-state')
  @ApiOperation({
    summary: '팀 채팅 읽음 상태 조회',
    description: '활성 멤버(본인 포함)별 마지막 읽은 메시지 ID, 내 안읽음 수, 팀 최신 메시지 ID',
  })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: ChatReadStateResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getChatReadState(@CurrentUser() user: User, @Param('teamId', ParseIntPipe) teamId: number) {
    const data = await this.teamChatService.getReadState(teamId, user.userId);
    return { code: 'SUCCESS', data, message: '' };
  }
}
