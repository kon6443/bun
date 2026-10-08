---
paths:
  - "src/**/*.gateway.ts"
  - "src/common/adapters/**/*.ts"
  - "src/**/*online*.service.ts"
---

# 실시간 — WebSocket Gateway·Redis

- namespace는 `/teams`(`team.gateway.ts`)와 `/fishing`(`fishing.gateway.ts`) 둘이다. room은 `team-{teamId}`.
- 멀티 레플리카 브로드캐스트는 `RedisIoAdapter`(`src/common/adapters/redis-io.adapter.ts`)가 맡는다 — pub/sub 2연결, `lazyConnect: true` + `maxRetriesPerRequest: null`(redis-adapter 필수 옵션).
- Redis 연결이 실패해도 앱은 기동한다 (HTTP 정상, WS 프레즌스만 중단).
- 온라인 상태는 **프로세스 메모리에 두지 않는다** — Redis Hash/Set + TTL (`online-user.service.ts`, `fishing-online.service.ts`). Redis 클라이언트는 `main.ts`가 `setRedisClient(redisAdapter.getPubClient())`로 수동 주입한다(DI 아님).
- 같은 유저의 여러 탭은 소켓 집합으로 관리하고 `wasAlreadyOnline`으로 중복 입장/퇴장 알림을 막는다.
- ⚠️ `joinTeam` 같은 room 진입 핸들러에 인증·멤버십 검증이 빠지면 **누구나 임의 팀 room의 이벤트를 수신한다** (실제 결함 전례 — playbook 클러스터 1).
- WS 에러는 `src/common/filters/ws-exception.filter.ts`가 처리한다.
- 입력 검증은 핸들러마다 `@UsePipes(new ValidationPipe({ transform: true }))`를 붙인다 — 이 pipe의 옵션에는 `whitelist`·`forbidNonWhitelisted`가 없다. 신규 핸들러도 같은 형태로 붙이고 페이로드는 DTO로 받는다.

## 신규 WS 이벤트 체크리스트

- [ ] 핸들러에 WS Guard 부착 + 팀 멤버십 검증
- [ ] `@UsePipes(new ValidationPipe({ transform: true }))` + 페이로드 DTO
- [ ] 상태는 Redis에 (인메모리 금지)
- [ ] 프론트(`../next-bun`) 이벤트명·페이로드와 1:1 대조 (스킬 `next-bun`)
