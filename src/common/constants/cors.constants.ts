/**
 * CORS 허용 Origin 목록
 *
 * HTTP 및 WebSocket 모두에서 사용되는 전역 CORS 설정입니다.
 * 새로운 Origin을 추가할 때는 이 파일만 수정하면 됩니다.
 */
export const ALLOWED_ORIGINS: string[] = [
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:3500',
  'http://127.0.0.1:3000',
  'https://fivesouth.duckdns.org',
];
