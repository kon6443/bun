# FiveSouth Backend (NestJS)

NestJS 11 + TypeScript 백엔드. Oracle DB (TypeORM), Socket.IO + Redis Pub/Sub.

## Commands
- `pnpm dev` | `pnpm run build` (tsc) | Port: 3500, prefix `/api/v1`
- Swagger: `/api/v1/docs` (LOCAL only)

## Conventions
- Auth: Kakao OAuth + JWT — HTTP: cookie `access_token` 우선 → Bearer 헤더 | WS: `handshake.auth.token` → Bearer 헤더
- ValidationPipe: `transform: true`, `enableImplicitConversion: true`
- 날짜: UTC 저장, 로컬 표시 — DB 컬럼 전부 `TIMESTAMP WITH TIME ZONE`, ORA_SDTZ 설정 금지 (oracledb가 로컬 TZ 기반으로 Date 저장하므로 세션 TZ는 자동 일치시켜야 함)
- Oracle `FROM_TZ()` 사용 시 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`) 사용 (ORA-01805 방지)
- 프론트엔드 프로젝트: `../next-bun` (Next.js 15 App Router + Bun)

## Rules
- **추측/추론 금지**: 항상 코드, 로그, DB 데이터 등 근거 기반으로 작업. 확인 불가한 사항은 추측하지 말고 사용자에게 확인 요청
- **필요 시 요청**: 정보가 부족하거나 판단이 어려운 경우 반드시 사용자에게 질문. 임의로 결정하지 않음
- 코드에 있는 그대로 보고 판단 (추론/추측 금지)
- **검증 시 grep 전수 확인 필수**: 변경된 함수/API 이름으로 프로젝트 전체 grep 후 호출 위치 전수 파악. 파일 부분 읽기(offset/limit)로 "전체 정상" 판단 금지. 특히 중복 API 호출, useEffect 간 중복 패턴 교차 비교

## Active Work — Redis Pub/Sub 멀티 레플리카
- **구현 완료**, 테스트·배포 TODO → `docs/tasks-redis-pubsub.md` 체크리스트 순서대로 진행

## Docs
- 배포 & 인프라: `docs/deploy.md`
- 아키텍처 & 주요 파일: `docs/architecture.md`
- Redis Pub/Sub PRD: `docs/prd-redis-pubsub.md`
- Redis Pub/Sub Tasks: `docs/tasks-redis-pubsub.md`
