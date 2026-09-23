# Architecture & Key Files

## 모듈 구조
- `src/modules/team/` — 팀, 태스크, 댓글, 온라인유저 관리
- `src/modules/auth/` — Kakao OAuth + JWT 인증
- `src/modules/notification/` — Telegram, Discord 알림
- `src/modules/scheduler/` — 스케줄러 (Cron)
- `src/modules/fishing/` — 낚시 게임
- `src/modules/file-share/` — 파일 공유
- `src/modules/users/` — 사용자 관리

## 주요 파일
- `src/main.ts` — RedisIoAdapter 초기화 + OnlineUserService에 pubClient 주입
- `src/common/adapters/redis-io.adapter.ts` — Redis Socket.IO 어댑터 (pub/sub 2연결)
- `src/modules/team/online-user.service.ts` — Redis 온라인 유저 관리 (Hash/Set, TTL 1h)
- `src/modules/team/team.gateway.ts` — WS Gateway `/teams` 네임스페이스, room `team-{teamId}`
- `src/modules/notification/telegram.service.ts` — Telegram 봇 알림 (태스크 CRUD 시 발송)

## DB
- Oracle Autonomous DB (Free Tier)
- TypeORM — 엔티티: `src/entities/`
- 시각 컬럼: 전부 `timestamp with time zone`

## 날짜 처리 — UTC 저장, 표시 시점 변환
> 최종 확인: 2026-09-23 · 근거: `src/entities/**` 컬럼 타입, `Dockerfile:32`(`TZ=UTC`), `src/common/utils/date.utils.ts`(`timeZone: 'Asia/Seoul'`)
> **규약 SSOT는 [`.claude/rules/code-patterns.md`](../.claude/rules/code-patterns.md) §12**다. 여기는 요지만 둔다.
- 저장·처리는 UTC, 표시 단계에서만 로컬(KST) 변환 — 텔레그램 알림은 `formatDateTime()`이 `Asia/Seoul`로 포맷한다
- 🚫 `ORA_SDTZ` 설정 금지 · 🚫 `FROM_TZ()`에 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`)
- DTO: `@IsDate()` + `enableImplicitConversion` (class-transformer `@Type` 미사용)
- 이력: 2026-04-14 커밋 `2c86d73`이 옛 "투과 방식(변환 없음)"을 폐기했다. 이 문서는 2026-09-23에야 갱신됐다(playbook 클러스터 3)
