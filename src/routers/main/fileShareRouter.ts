import express from "express";
import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import fileShareServiceInstance from "../../services/fileShareService";

const fileShareRouter = express.Router();

// 환경에 따라 공유할 파일 디렉토리 경로 설정
// 로컬: 프로젝트 최상단의 shared 폴더
// 배포: Docker 컨테이너의 /app/shared (볼륨 마운팅된 경로)
const isLocal = process.env.ENV?.toUpperCase() == "LOCAL";
const SHARED_BASE_DIR = isLocal 
  ? path.join(process.cwd(), "shared") 
  : "/app/shared";

/**
 * DB 기반 shareId와 API Key 인증 미들웨어
 * 쿼리 파라미터(?shareId=xxx&key=yyy) 또는 헤더(X-Share-Id, X-API-Key)로 전달
 * DB에서 shareId와 API Key 둘 다 매칭되는지 검증
 */
const apiKeyMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 쿼리 파라미터 또는 헤더에서 shareId와 API key 가져오기
    const shareId = (req.query.shareId as string) || (req.headers['x-share-id'] as string);
    const apiKey = (req.query.apiKey as string) || (req.headers['x-api-key'] as string);

    if (!shareId) {
      return res.status(401).json({
        status: 401,
        message: "인증이 필요합니다. shareId를 제공해주세요.",
      });
    }

    if (!apiKey) {
      return res.status(401).json({
        status: 401,
        message: "인증이 필요합니다. API key를 제공해주세요.",
      });
    }

    // DB에서 shareId와 API Key 둘 다 매칭되는지 검증
    const isValid = await fileShareServiceInstance.validateShareIdAndApiKey(shareId, apiKey);

    if (!isValid) {
      return res.status(401).json({
        status: 401,
        message: "인증 실패. shareId와 API key가 일치하지 않습니다.",
      });
    }

    // 인증 성공: shareId를 request에 저장
    (req as any).shareId = shareId;

    next();
  } catch (error) {
    console.error("shareId와 API Key 인증 중 오류:", error);
    return res.status(500).json({
      status: 500,
      message: "인증 처리 중 오류가 발생했습니다.",
    });
  }
};

// 기본 디렉토리가 없으면 생성
if (!fs.existsSync(SHARED_BASE_DIR)) {
  fs.mkdirSync(SHARED_BASE_DIR, { recursive: true });
}

/**
 * 공유 가능한 파일 목록 조회
 * GET /api/v1/files?shareId=donald&apiKey=YOUR_API_KEY
 * 또는 헤더: X-Share-Id: donald, X-API-Key: YOUR_API_KEY
 * shareId별로 자신의 디렉토리만 조회 가능
 */
fileShareRouter.get("/", apiKeyMiddleware, (req: Request, res: Response) => {
  try {
    const shareId = (req as any).shareId;
    const shareDir = path.join(SHARED_BASE_DIR, shareId);

    // shareId 디렉토리가 없으면 빈 배열 반환
    if (!fs.existsSync(shareDir)) {
      return res.json({
        status: 200,
        message: "SUCCESS",
        // directory: shareDir,
        files: [],
      });
    }

    const files = fs.readdirSync(shareDir)
      .filter((filename) => {
        // 디렉토리는 제외하고 파일만
        const filePath = path.join(shareDir, filename);
        return fs.statSync(filePath).isFile();
      })
      .map((filename) => {
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

    res.json({
      status: 200,
      message: "SUCCESS",
    //   directory: shareDir,
      files,
    });
  } catch (error: any) {
    res.status(500).json({
      status: 500,
      message: error.message || "파일 목록 조회 실패",
    });
  }
});

/**
 * 파일 다운로드
 * GET /api/v1/files/:filename?shareId=donald&key=YOUR_API_KEY
 * 또는 헤더: X-Share-Id: donald, X-API-Key: YOUR_API_KEY
 * shareId별로 자신의 디렉토리만 접근 가능
 */
fileShareRouter.get("/:filename", apiKeyMiddleware, (req: Request, res: Response) => {
  try {
    const shareId = (req as any).shareId;
    const filename = req.params.filename;
    
    // 경로 탐색 공격 방지: 상대 경로(..) 제거
    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || filename.includes('..')) {
      return res.status(403).json({
        status: 403,
        message: "접근이 거부되었습니다.",
      });
    }
    
    // shareId별 디렉토리 경로
    const shareDir = path.join(SHARED_BASE_DIR, shareId);
    const filePath = path.join(shareDir, safeFilename);
    
    // 절대 경로로 변환하여 shareId 디렉토리 밖으로 나가는지 확인
    const resolvedFilePath = path.resolve(filePath);
    const resolvedShareDir = path.resolve(shareDir);
    
    if (!resolvedFilePath.startsWith(resolvedShareDir)) {
      return res.status(403).json({
        status: 403,
        message: "접근이 거부되었습니다.",
      });
    }

    // 파일 존재 확인
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: 404,
        message: "파일을 찾을 수 없습니다.",
      });
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return res.status(400).json({
        status: 400,
        message: "파일이 아닙니다.",
      });
    }

    // 파일 스트리밍으로 전송 (대용량 파일 지원)
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Length", stats.size.toString());

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on("error", (error) => {
      console.error("파일 스트리밍 오류:", error);
      if (!res.headersSent) {
        res.status(500).json({
          status: 500,
          message: "파일 전송 중 오류가 발생했습니다.",
        });
      }
    });
  } catch (error: any) {
    res.status(500).json({
      status: 500,
      message: error.message || "파일 다운로드 실패",
    });
  }
});

export default fileShareRouter;

