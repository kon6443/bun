# Deploy

## CI/CD
- push to `main` → GitHub Actions → `sys_express` 서비스 업데이트 (multi-arch amd64/arm64)

## Redis
- `bash infra/setup-redis.sh` → `sys_redis` on `sys_default` network
- 서버 env 파일(`/home/ubuntu/desktop/deploy/sys/config/env/.env`)에 `REDIS_HOST=sys_redis` 필요

## 레플리카 확장
- `docker service scale sys_express=2` (Redis 배포 완료 후)

## Docker
- Dockerfile: `node:20-bullseye-slim` 기반, 멀티 스테이지 빌드
- `ENV TZ=UTC` 명시 — 모든 날짜는 UTC로 저장/처리, 표시 단계에서만 KST 변환
