import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { FileShareService } from './file-share.service';
import { FileShare } from '../../entities/FileShare';
import { createFileShare } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';

describe('FileShareService', () => {
  let service: FileShareService;
  let fileShareRepository: MockRepository<FileShare>;

  beforeEach(async () => {
    fileShareRepository = createMockRepository<FileShare>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileShareService,
        { provide: getRepositoryToken(FileShare), useValue: fileShareRepository },
      ],
    }).compile();

    service = module.get<FileShareService>(FileShareService);
  });

  describe('validateShareIdAndApiKey', () => {
    it('shareId와 apiKey가 모두 일치하면 true를 반환해야 함', async () => {
      const fileShare = createFileShare({ shareId: 'share-1', apiKey: 'key-1' });
      fileShareRepository.findOne.mockResolvedValue(fileShare);

      const result = await service.validateShareIdAndApiKey('share-1', 'key-1');

      expect(result).toBe(true);
      expect(fileShareRepository.findOne).toHaveBeenCalledWith({
        where: { shareId: 'share-1', apiKey: 'key-1' },
      });
    });

    it('일치하는 레코드가 없으면 false를 반환해야 함', async () => {
      fileShareRepository.findOne.mockResolvedValue(null);

      const result = await service.validateShareIdAndApiKey('share-1', 'wrong-key');

      expect(result).toBe(false);
    });

    // 빈 값은 DB를 조회할 필요조차 없다 — 조회 호출이 없다는 것까지 검증한다
    it.each([
      ['shareId 없음', '', 'key-1'],
      ['apiKey 없음', 'share-1', ''],
      ['둘 다 없음', '', ''],
    ])('%s → DB 조회 없이 false', async (_desc, shareId, apiKey) => {
      const result = await service.validateShareIdAndApiKey(shareId, apiKey);

      expect(result).toBe(false);
      expect(fileShareRepository.findOne).not.toHaveBeenCalled();
    });

    it('DB 조회가 실패하면 예외를 전파하지 않고 false를 반환해야 함', async () => {
      // 파일 공유는 인증 경계이므로 장애 시 "차단"으로 수렴해야 한다
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      fileShareRepository.findOne.mockRejectedValue(new Error('ORA-12541: TNS:no listener'));

      const result = await service.validateShareIdAndApiKey('share-1', 'key-1');

      expect(result).toBe(false);
    });
  });
});
