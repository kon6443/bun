import { AppDataSource } from "../database/data-source";
import { FileShare } from "../entities/FileShare";

class FileShareService {
  constructor() {}

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
      const fileShareRepository = AppDataSource.getRepository(FileShare);
      
      // shareId와 apiKey 둘 다 매칭되는지 확인
      const fileShare = await fileShareRepository.findOne({
        where: { 
          shareId,
          apiKey,
        },
      });
      return !!fileShare;
    } catch (error) {
      console.error("shareId와 API Key 검증 중 오류:", error);
      return false;
    }
  }
}

const fileShareServiceInstance = new FileShareService();
export default fileShareServiceInstance;

