import { ApiProperty } from '@nestjs/swagger';

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

export class FileListResponseDto {
  @ApiProperty({ description: '상태 코드', example: 200 })
  status: number;

  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '파일 목록 데이터', type: FileListDataDto })
  data: FileListDataDto;
}
