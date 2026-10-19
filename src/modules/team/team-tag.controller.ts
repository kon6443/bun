import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import { User } from '../../entities/User';
import { TeamGateway } from './team.gateway';
import { TeamTagService } from './team-tag.service';
import {
  CreateTeamTagDto,
  DeleteTeamTagResponseDto,
  ReorderTeamTagsDto,
  TeamTagListResponseDto,
  TeamTagResponseDto,
  UpdateTeamTagDto,
} from './team-tag.dto';
import {
  TeamForbiddenErrorResponseDto,
  TeamTagDuplicateErrorResponseDto,
  TeamTagLimitExceededErrorResponseDto,
  TeamTagNotFoundErrorResponseDto,
  TeamTagOrderConflictErrorResponseDto,
} from './team-error.dto';

/**
 * 팀 태그 REST (docs/tasks/team-task-tags DESIGN.md §2·§3)
 *
 * 활성 팀원 누구나 생성·수정·삭제·재정렬한다. 변경은 room `team-{teamId}`에 소켓으로 알린다.
 * 태스크에 태그를 붙이는 것은 태스크 생성·수정 API의 `tagIds`로 한다(TeamController).
 */
@ApiTags('teams')
@Controller('teams')
export class TeamTagController {
  constructor(
    private readonly teamTagService: TeamTagService,
    private readonly teamGateway: TeamGateway,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/tags')
  @ApiOperation({ summary: '팀 태그 목록 조회', description: 'sortOrder, tagId 오름차순. 각 태그의 사용 태스크 수(taskCount) 포함' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TeamTagListResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getTags(@CurrentUser() user: User, @Param('teamId', ParseIntPipe) teamId: number) {
    const tags = await this.teamTagService.getTags(teamId, user.userId);
    return { code: 'SUCCESS', data: tags, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/tags')
  @ApiOperation({ summary: '팀 태그 생성', description: '목록 맨 뒤에 추가된다' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiBody({ type: CreateTeamTagDto })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: TeamTagResponseDto })
  @ApiResponse({ status: 400, description: '팀 태그 한도(100개) 초과', type: TeamTagLimitExceededErrorResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 409, description: '같은 이름의 태그가 이미 있음 (대소문자 무시)', type: TeamTagDuplicateErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async createTag(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: CreateTeamTagDto,
  ) {
    const tag = await this.teamTagService.createTag({ teamId, userId: user.userId, dto });

    this.teamGateway.emitTagCreated(teamId, {
      teamId,
      tagId: tag.tagId,
      tagName: tag.tagName,
      tagColor: tag.tagColor,
      sortOrder: tag.sortOrder,
      createdBy: user.userId,
    });

    return { code: 'SUCCESS', data: tag, message: '' };
  }

  // 'order'는 PUT 전용이고 ':tagId' 라우트에는 PUT이 없어 경로가 겹치지 않는다
  @UseGuards(JwtAuthGuard)
  @Put(':teamId/tags/order')
  @ApiOperation({
    summary: '팀 태그 순서 변경',
    description: '팀의 전체 태그 ID를 새 순서로 보낸다. 현재 팀 태그 집합과 다르면 409 — 목록을 다시 받아 재시도한다',
  })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiBody({ type: ReorderTeamTagsDto })
  @ApiResponse({ status: 200, description: 'SUCCESS (재정렬된 전체 목록)', type: TeamTagListResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 409, description: '그사이 태그가 추가·삭제되어 목록이 다름', type: TeamTagOrderConflictErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async reorderTags(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: ReorderTeamTagsDto,
  ) {
    const tags = await this.teamTagService.reorderTags({ teamId, userId: user.userId, tagIds: dto.tagIds });

    this.teamGateway.emitTagsReordered(teamId, {
      teamId,
      tagIds: tags.map((tag) => tag.tagId),
      updatedBy: user.userId,
    });

    return { code: 'SUCCESS', data: tags, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':teamId/tags/:tagId')
  @ApiOperation({ summary: '팀 태그 수정 (이름·색)' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'tagId', description: '태그 ID', type: Number })
  @ApiBody({ type: UpdateTeamTagDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TeamTagResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '태그를 찾을 수 없음 (다른 팀 태그 포함)', type: TeamTagNotFoundErrorResponseDto })
  @ApiResponse({ status: 409, description: '같은 이름의 태그가 이미 있음 (대소문자 무시)', type: TeamTagDuplicateErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async updateTag(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('tagId', ParseIntPipe) tagId: number,
    @Body() dto: UpdateTeamTagDto,
  ) {
    const tag = await this.teamTagService.updateTag({ teamId, tagId, userId: user.userId, dto });

    this.teamGateway.emitTagUpdated(teamId, {
      teamId,
      tagId: tag.tagId,
      tagName: tag.tagName,
      tagColor: tag.tagColor,
      sortOrder: tag.sortOrder,
      updatedBy: user.userId,
    });

    return { code: 'SUCCESS', data: tag, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':teamId/tags/:tagId')
  @ApiOperation({ summary: '팀 태그 삭제', description: '하드 삭제 — 붙어 있던 모든 태스크에서도 제거된다' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'tagId', description: '태그 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: DeleteTeamTagResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.', type: TeamForbiddenErrorResponseDto })
  @ApiResponse({ status: 404, description: '태그를 찾을 수 없음 (다른 팀 태그 포함)', type: TeamTagNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async deleteTag(
    @CurrentUser() user: User,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('tagId', ParseIntPipe) tagId: number,
  ) {
    await this.teamTagService.deleteTag({ teamId, tagId, userId: user.userId });

    this.teamGateway.emitTagDeleted(teamId, { teamId, tagId, deletedBy: user.userId });

    return { code: 'SUCCESS', data: null, message: '' };
  }
}
