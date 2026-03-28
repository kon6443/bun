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
- 날짜 컬럼: Oracle `TIMESTAMP` (timezone-naive)

## 날짜 처리 (투과 방식 — UTC+0)
- 원칙: 사용자 입력값 = 저장값 = 표시값 (변환 없음)
- 프론트: Z suffix 필수 (`"2026-03-27T14:00:00Z"`), `timeZone: 'UTC'`로 표시
- 백엔드: Dockerfile `TZ=UTC`, Oracle DBTIMEZONE `+00:00`
- API 응답: `toISOString()` (UTC)
- 텔레그램 알림: `formatDateTime()` → `timeZone: 'UTC'` (프론트와 동일, 변환 없음)
- `src/common/utils/date.utils.ts` — `formatDateTime()` (텔레그램 알림용 포맷)
- DTO: `@IsDate()` + `enableImplicitConversion` (class-transformer `@Type` 미사용)
