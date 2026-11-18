/**
 * 연결 해제 정리(handleDisconnect)가 보낸 Redis 명령이 끝나기를 기다리는 시간 (밀리초).
 * 소켓 서버는 닫을 때 disconnect 핸들러를 기다려 주지 않는다(비동기 핸들러) — 핸들러의 두 번째 명령(조회 뒤 제거)이
 * Redis 종료보다 늦게 나가면 "Connection is closed"로 실패해 닫힌 탭이 온라인으로 남는다. 클러스터 안 Redis 왕복은 ms 단위라
 * 정리 2~4왕복에 넉넉하고, 스웜 종료 유예(stop_grace_period 기본 10초) 안에 들어간다.
 * Redis만 기다린다 — DB(TypeORM)는 app.close()의 shutdown 훅에서 이미 닫힌다. 지금 연결 해제 정리는 Redis만 쓴다
 */
export const SHUTDOWN_REDIS_DRAIN_MS = 1_000;

/**
 * 종료 순서 — 앱(소켓 서버 포함)을 먼저 닫고, 그 뒤 Redis 연결을 닫는다.
 *
 * 반대로 하면(예전 순서) 소켓 서버가 닫힐 때 ① Redis 어댑터의 구독 해제(punsubscribe·unsubscribe — 라이브러리가 await하지 않는다)가
 * 닫힌 연결에 나가 네임스페이스마다 Unhandled Rejection "Connection is closed"가 찍히고 ② 각 소켓의 연결 해제 정리(온라인 목록 제거·
 * 방 끊김 표시)가 전부 실패해, 배포할 때마다 그 레플리카에 붙어 있던 유저가 TTL까지 온라인으로 남는다.
 */
export async function closeAppThenRedis(
  app: { close(): Promise<void> },
  redis: { disconnect(): Promise<void> },
  drainMs = SHUTDOWN_REDIS_DRAIN_MS,
): Promise<void> {
  await app.close();
  if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
  await redis.disconnect();
}
