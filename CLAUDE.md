# FiveSouth Backend (NestJS)

## Stack & Dev
- NestJS 11 + TypeScript, Oracle DB (TypeORM), Socket.IO + Redis Pub/Sub
- Auth: Kakao OAuth + JWT — HTTP: cookie `access_token` 우선 → Bearer 헤더 | WS: `handshake.auth.token` → Bearer 헤더
- `pnpm dev` | `pnpm run build` (tsc) | Port: 3500, prefix `/api/v1` | Swagger: `/api/v1/docs` (LOCAL only)

## Active Work — Redis Pub/Sub 멀티 레플리카
- PRD: `docs/prd-redis-pubsub.md` | **Task 체크리스트**: `docs/tasks-redis-pubsub.md`
- **구현 완료**, 테스트·배포 TODO → tasks 파일 체크리스트 순서대로 진행

## Key Files
- `src/common/adapters/redis-io.adapter.ts` — Redis Socket.IO 어댑터 (pub/sub 2연결)
- `src/modules/team/online-user.service.ts` — Redis 온라인 유저 관리 (Hash/Set, TTL 1h)
- `src/modules/team/team.gateway.ts` — WS Gateway `/teams` 네임스페이스, room `team-{teamId}`
- `src/main.ts` — RedisIoAdapter 초기화 + OnlineUserService에 pubClient 주입

## Deploy
- push to `main` → GitHub Actions → `sys_express` 서비스 업데이트 (multi-arch amd64/arm64)
- Redis: `bash infra/setup-redis.sh` → `sys_redis` on `sys_default` network
- 서버 env 파일(`/home/ubuntu/desktop/deploy/sys/config/env/.env`)에 `REDIS_HOST=sys_redis` 필요
- 레플리카 확장: `docker service scale sys_express=2` (Redis 배포 완료 후)
