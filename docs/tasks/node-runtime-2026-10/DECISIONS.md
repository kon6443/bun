# Node 런타임 보안·고정 (2026-10) — DECISIONS

## D-001 Node 2026-10 보안 릴리스: 코드 수정 없음, 런타임 교체로 해결

- 백엔드(origin/main 5b88320): `dns`·`tls`·brotli 해제·`http.Agent`·`--build-snapshot`·`--permission` 사용 0건. 외부 `fetch`는 Kakao·Discord·Telegram 고정 HTTPS 호스트 3곳(`auth.service.ts`, `discord.service.ts`, `telegram.service.ts`). zlib은 gzip만. `randomUUID`·`randomInt`는 스냅샷 없이 사용 → CVE-2026-106074 비해당
- 프론트(next-bun 54265df, next-bun-0c 보고): 직접 사용 0건. 서버 fetch는 백엔드·Google Fonts 고정 호스트, next-auth v4 Kakao 토큰 교환이 기본 Agent 사용. `remotePatterns`·rewrites 없음
- 간접 경로(undici의 br 자동 해제, keep-alive)는 신뢰 호스트 장악이 전제 → 위험 낮음. 번들 undici·OpenSSL·c-ares·CA 갱신은 런타임 교체로만 해결

## D-002 Node 24 LTS 유지

- 26.x는 아직 LTS 아님, 이번 Low 2건은 26 전용. LTS 전환 뒤 별도 태스크로 검토

## D-003 Next 16 · Nest 12 메이저 업그레이드 보류

- Next 15.5.28 = npm `backport` 태그(15.5 라인 최신). 16은 `next lint` 제거·`next.config.ts`의 Next 내부 경로 import로 깨질 위험
- Nest 11.1.x → 12.2.0(2026-10-19)은 메이저. 이번 CVE와 무관. 필요 시 마이그레이션 조사 태스크로 분리

## D-004 Docker 베이스 이미지 패치 고정 + dependabot docker

- 떠다니는 `node:24-bookworm-slim`은 패치를 자동으로 받지만 운영 버전을 이미지에서 특정할 수 없다(이번에도 `docker exec`로 확인해야 했다)
- 고정의 대가(패치 놓침)는 dependabot docker 주간 PR로 상쇄. 메이저는 무시(LTS 전환은 사람이 결정)

## D-005 `express`(^4) · `swagger-ui-express` 제거

- `express` 직접 의존(2024-12 "installed bun and express" 커밋 유래)은 런타임 미사용: `src`의 `from 'express'`는 전부 타입(`Request`·`Response`·`NextFunction`), `express()`·`express.*` 호출 0건. 실제 HTTP 서버는 `@nestjs/platform-express`가 가져오는 express 5.2.1. 타입은 `@types/express` ^5가 제공(유지)
- `swagger-ui-express` import 0건. `@nestjs/swagger` 11은 `swagger-ui-dist`를 직접 의존
- 효과: lock에서 express 4 트리(body-parser 1.x·send 0.19·qs 등) 제거, express 4/5 이중 설치 해소
