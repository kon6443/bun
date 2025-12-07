import express from "express";
import { Request, Response } from "express";
import path from "path";
import fs from "fs";

const fileShareRouter = express.Router();

// 환경에 따라 공유할 파일 디렉토리 경로 설정
// 로컬: 프로젝트 최상단의 shared 폴더
// 배포: Docker 컨테이너의 /app/shared (볼륨 마운팅된 경로)
const isLocal = process.env.ENV?.toUpperCase() == "LOCAL";
const SHARED_DIR = isLocal 
  ? path.join(process.cwd(), "shared") 
  : "/app/shared";

// 디렉토리가 없으면 생성
if (!fs.existsSync(SHARED_DIR)) {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
}

/**
 * 공유 가능한 파일 목록 조회
 * GET /api/v1/files
 */
fileShareRouter.get("/", (req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(SHARED_DIR).map((filename) => {
      const filePath = path.join(SHARED_DIR, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        size: stats.size,
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        created: stats.birthtime,
        modified: stats.mtime,
      };
    });

    res.json({
      status: 200,
      message: "SUCCESS",
      directory: SHARED_DIR,
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
 * GET /api/v1/files/:filename
 */
fileShareRouter.get("/:filename", (req: Request, res: Response) => {
  try {
    const filename = req.params.filename;
    
    // 경로 탐색 공격 방지: 상대 경로(..) 제거
    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || filename.includes('..')) {
      return res.status(403).json({
        status: 403,
        message: "접근이 거부되었습니다.",
      });
    }
    
    const filePath = path.join(SHARED_DIR, safeFilename);
    
    // 절대 경로로 변환하여 SHARED_DIR 밖으로 나가는지 확인
    const resolvedFilePath = path.resolve(filePath);
    const resolvedSharedDir = path.resolve(SHARED_DIR);
    
    if (!resolvedFilePath.startsWith(resolvedSharedDir)) {
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

