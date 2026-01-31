import {
  Controller,
  Get,
  Param,
  Query,
  Headers,
  Res,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiHeader, ApiParam } from '@nestjs/swagger';
import { Response } from 'express';
import { FileShareService } from './file-share.service';
import { FileListResponseDto } from './file-share.dto';
import * as path from 'path';
import * as fs from 'fs';

const isLocal = process.env.ENV?.toUpperCase() == 'LOCAL';
const SHARED_BASE_DIR = isLocal ? path.join(process.cwd(), 'shared') : '/app/shared';

// 디렉토리 생성 헬퍼 함수
function ensureSharedDirectory() {
  if (!fs.existsSync(SHARED_BASE_DIR)) {
    try {
      fs.mkdirSync(SHARED_BASE_DIR, { recursive: true });
    } catch (error: any) {
      // 권한 오류 등은 무시 (실제 사용 시점에 다시 시도)
      if (error.code !== 'EACCES') {
        console.warn(`Failed to create shared directory: ${error.message}`);
      }
    }
  }
}

@ApiTags('files')
@Controller('files')
export class FileShareController {
  constructor(@Inject(FileShareService) private readonly fileShareService: FileShareService) {}

  @Get()
  @ApiOperation({ summary: '공유 가능한 파일 목록 조회' })
  @ApiQuery({ name: 'shareId', required: false })
  @ApiQuery({ name: 'apiKey', required: false })
  @ApiHeader({ name: 'x-share-id', required: false })
  @ApiHeader({ name: 'x-api-key', required: false })
  @ApiResponse({ status: 200, description: '성공', type: FileListResponseDto })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async getFiles(
    @Query('shareId') shareId?: string,
    @Query('apiKey') apiKey?: string,
    @Headers('x-share-id') headerShareId?: string,
    @Headers('x-api-key') headerApiKey?: string,
  ) {
    const finalShareId = shareId || headerShareId;
    const finalApiKey = apiKey || headerApiKey;

    if (!finalShareId) {
      throw new UnauthorizedException('인증이 필요합니다. shareId를 제공해주세요.');
    }

    if (!finalApiKey) {
      throw new UnauthorizedException('인증이 필요합니다. API key를 제공해주세요.');
    }

    const isValid = await this.fileShareService.validateShareIdAndApiKey(finalShareId, finalApiKey);

    if (!isValid) {
      throw new UnauthorizedException('인증 실패. shareId와 API key가 일치하지 않습니다.');
    }

    // 디렉토리 생성 시도
    ensureSharedDirectory();

    const shareDir = path.join(SHARED_BASE_DIR, finalShareId);

    if (!fs.existsSync(shareDir)) {
      return {
        code: 'SUCCESS',
        data: {
          files: [],
        },
        message: '',
      };
    }

    const files = fs
      .readdirSync(shareDir)
      .filter(filename => {
        const filePath = path.join(shareDir, filename);
        return fs.statSync(filePath).isFile();
      })
      .map(filename => {
        const filePath = path.join(shareDir, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          size: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          crtdAt: stats.birthtime,
          mdfdAt: stats.mtime,
        };
      });

    return {
      code: 'SUCCESS',
      data: {
        files,
      },
      message: '',
    };
  }

  @Get(':filename')
  @ApiOperation({ summary: '파일 다운로드' })
  @ApiParam({ name: 'filename', type: String })
  @ApiQuery({ name: 'shareId', required: false })
  @ApiQuery({ name: 'apiKey', required: false })
  @ApiHeader({ name: 'x-share-id', required: false })
  @ApiHeader({ name: 'x-api-key', required: false })
  @ApiResponse({ status: 200, description: '성공' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '접근 거부' })
  @ApiResponse({ status: 404, description: '파일을 찾을 수 없음' })
  async downloadFile(
    @Param('filename') filename: string,
    @Res() res: Response,
    @Query('shareId') shareId?: string,
    @Query('apiKey') apiKey?: string,
    @Headers('x-share-id') headerShareId?: string,
    @Headers('x-api-key') headerApiKey?: string,
  ) {
    const finalShareId = shareId || headerShareId;
    const finalApiKey = apiKey || headerApiKey;

    if (!finalShareId) {
      throw new UnauthorizedException('인증이 필요합니다. shareId를 제공해주세요.');
    }

    if (!finalApiKey) {
      throw new UnauthorizedException('인증이 필요합니다. API key를 제공해주세요.');
    }

    const isValid = await this.fileShareService.validateShareIdAndApiKey(finalShareId, finalApiKey);

    if (!isValid) {
      throw new UnauthorizedException('인증 실패. shareId와 API key가 일치하지 않습니다.');
    }

    // 디렉토리 생성 시도
    ensureSharedDirectory();

    // 경로 탐색 공격 방지
    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || filename.includes('..')) {
      throw new ForbiddenException('접근이 거부되었습니다.');
    }

    const shareDir = path.join(SHARED_BASE_DIR, finalShareId);
    const filePath = path.join(shareDir, safeFilename);

    // 절대 경로로 변환하여 shareId 디렉토리 밖으로 나가는지 확인
    const resolvedFilePath = path.resolve(filePath);
    const resolvedShareDir = path.resolve(shareDir);

    if (!resolvedFilePath.startsWith(resolvedShareDir)) {
      throw new ForbiddenException('접근이 거부되었습니다.');
    }

    // 파일 존재 확인
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('파일을 찾을 수 없습니다.');
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      throw new BadRequestException('파일이 아닙니다.');
    }

    // 파일 스트리밍으로 전송
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', stats.size.toString());

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('error', error => {
      console.error('파일 스트리밍 오류:', error);
      if (!res.headersSent) {
        res.status(500).json({
          code: 'INTERNAL_SERVER_ERROR',
          message: '파일 전송 중 오류가 발생했습니다.',
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
}
