---
paths:
  - "src/**/*.ts"
---

# 백엔드 공통 구조

> `src/`의 `.ts`를 읽으면 항상 로드된다. 파일 종류별 상세 규약은 아래 지도의 rule이 해당 파일을 읽을 때 함께 로드된다.

## rule 지도 — 파일 종류 → 규약

| rule | 로드되는 파일 | 다루는 것 |
|---|---|---|
| `core.md` (이 파일) | `src/**/*.ts` | 계층, 디렉토리, 외부 연동, 멀티 레플리카 |
| `api-http.md` | 컨트롤러·DTO·`common/{guards,filters,pipes,decorators,dto,constants}`·`main.ts`·`app.module.ts` | 에러, 입력 검증, 인증/인가, 응답·Swagger, 스로틀 |
| `data-access.md` | `*.service.ts`·`src/entities/`·`src/config/` | Repository 주입, 쿼리 스타일, 트랜잭션, 스케줄러 |
| `datetime.md` | Entity·서비스·`common/utils`·`config`·마이그레이션 | UTC 저장, Oracle TZ 함정 |
| `realtime-ws.md` | `*.gateway.ts`·`common/adapters`·`*online*.service.ts` | Gateway, Redis 어댑터, 온라인 상태 |
| `schema-migrations.md` | `src/entities/`·`migrations/`·`migration-datasource.ts` | Entity 선언 함정, 마이그레이션 작성 |
| `testing.md` | `*.spec.ts`·`test/`·`__spec__/` | mock·factory, E2E DB 차단, 에러 경로 단정 |

## 계층 — Repository 클래스 없음

- **Controller → Service → TypeORM Entity**. 별도 Repository 클래스를 만들지 않는다.
- 로직이 커지면 협력 서비스로 분리한다 (예: `online-user.service.ts`, `fishing-online.service.ts`). DB 접근 방식은 같다.
- 횡단 관심사는 `src/common/` 아래 용도별 디렉토리(`guards`, `filters`, `pipes`, `middleware`, `decorators`, `adapters`, `port`, `metrics`, `logger`, `constants`, `enums`, `dto`, `utils`)에 둔다.

### Path Aliases (`tsconfig.json`)

```typescript
@/*         → src/*
@entities/* → src/entities/*
@modules/*  → src/modules/*
@common/*   → src/common/*
@config/*   → src/config/*
```

## 외부 연동 — Port/Adapter

- `src/common/port/notification.port.ts`처럼 인터페이스 + DI 토큰(Symbol)을 정의하고 구현체를 모듈에서 바인딩한다.
- 새 외부 연동(HTTP API·메신저·스토리지)은 이 패턴을 따른다. 서비스 본문에 외부 HTTP 호출을 직접 늘리지 않는다.

## 멀티 레플리카 전제

- 앱은 여러 레플리카로 뜬다(`infra/docker-stack.app.yml`). 프로세스 메모리의 상태·타이머·`@Cron`은 레플리카마다 따로 돈다.
- 공유 상태는 Redis에, 한 번만 돌아야 하는 작업은 `TASK_SLOT` 가드(`data-access.md` 스케줄러 절)로.
