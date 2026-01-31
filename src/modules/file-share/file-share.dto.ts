import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

// ==================== Response DTOs ====================

export class FileInfoDto {
  @ApiProperty({ description: '파일명', example: 'example.pdf' })
  filename: string;

  @ApiProperty({ description: '파일 크기 (bytes)', example: 1024000 })
  size: number;

  @ApiProperty({ description: '파일 크기 (MB)', example: '0.98' })
  sizeMB: string;

  @ApiProperty({ description: '생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;

  @ApiProperty({ description: '수정일시', example: '2026-01-01T00:00:00.000Z' })
  mdfdAt: Date;
}

export class FileListDataDto {
  @ApiProperty({ description: '파일 목록', type: [FileInfoDto] })
  files: FileInfoDto[];
}

export class FileListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '파일 목록 데이터', type: FileListDataDto })
  data: FileListDataDto;
}
