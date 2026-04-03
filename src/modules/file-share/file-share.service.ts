import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileShare } from '../../entities/FileShare';

@Injectable()
export class FileShareService {
  private readonly logger = new Logger(FileShareService.name);

  constructor(
    @InjectRepository(FileShare)
    private readonly fileShareRepository: Repository<FileShare>,
  ) {}

  /**
   * shareId와 API Key를 함께 검증
   * @param shareId - 검증할 shareId
   * @param apiKey - 검증할 API Key
   * @returns 검증 성공 여부 (true: 성공, false: 실패)
   */
  async validateShareIdAndApiKey(shareId: string, apiKey: string): Promise<boolean> {
    if (!shareId || !apiKey) {
      return false;
    }

    try {
      const fileShare = await this.fileShareRepository.findOne({
        where: {
          shareId,
          apiKey,
        },
      });
      return !!fileShare;
    } catch (error) {
      this.logger.error('shareId와 API Key 검증 중 오류:', error);
      return false;
    }
  }
}

