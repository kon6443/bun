# 사용자 피드백 — 설계 정본

> 스키마·REST·한도의 정본. 결정 근거는 DECISIONS.md(D-번호). 🟡 결정이 확정되면 이 문서를 먼저 고친다.

## 1. 스키마 — `FEEDBACKS` (D-004·D-009·D-011·D-013)

마이그레이션 `migrations/1792553875000-CreateFeedbacks.ts`(멱등 가드 + 코멘트) · Entity `src/entities/Feedback.ts`.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `FEEDBACK_ID` | `NUMBER` IDENTITY | PK `PK_FEEDBACKS` | Entity `@PrimaryGeneratedColumn` |
| `USER_ID` | `NUMBER` | NOT NULL, FK `FK_FEEDBACKS_USER` → `USERS` ON DELETE CASCADE | 작성자 |
| `CATEGORY` | `VARCHAR2(20 BYTE)` | NOT NULL, CHECK `FEEDBACKS_CATEGORY_CK` | D-003 코드 |
| `TITLE` | `VARCHAR2(400 BYTE)` | NOT NULL | 100자 |
| `CONTENT` | `CLOB` | NOT NULL | 5,000자(DTO 검증) |
| `STATUS` | `VARCHAR2(20 BYTE)` | NOT NULL, DEFAULT `'RECEIVED'`, CHECK `FEEDBACKS_STATUS_CK` | |
| `ADMIN_REPLY` | `CLOB` | NULL | |
| `REPLIED_AT` | `TIMESTAMP(6) WITH TIME ZONE` | NULL | |
| `PAGE_PATH` | `VARCHAR2(2000 BYTE)` | NULL | 500자 |
| `USER_AGENT` | `VARCHAR2(2000 BYTE)` | NULL | 서버가 헤더에서 저장, 500자 절단 |
| `BUILD_SHA` | `VARCHAR2(40 BYTE)` | NULL | 7~40자 hex |
| `CRTD_AT` | `TIMESTAMP(6) WITH TIME ZONE` | NOT NULL, DEFAULT `CURRENT_TIMESTAMP` | UTC |
| `MDFD_AT` | `TIMESTAMP(6) WITH TIME ZONE` | NULL | 운영자 상태·답변 갱신 시각 |

- 인덱스 `IDX_FEEDBACKS_USER_ID (USER_ID, FEEDBACK_ID)` — 내 목록 keyset + 24시간 카운트(D-005).
- 수정·삭제 없음 → `IS_DELETED` 없음 (D-009). 테이블·전 컬럼 코멘트는 마이그레이션 `COLUMN_COMMENTS`가 정본.

### 1-2. 실행 · 운영자 갱신
- 실행은 담당자: `pnpm db:migrate:up` (이력 테이블에 기록된다 — 순수 SQL로 직접 실행하면 이력이 남지 않아 이후 `up`에서 다시 돌지만 멱등 가드로 no-op)
- 운영자 상태·답변 갱신(SQL): `UPDATE FEEDBACKS SET STATUS = 'DONE', ADMIN_REPLY = '…', REPLIED_AT = SYSTIMESTAMP, MDFD_AT = SYSTIMESTAMP WHERE FEEDBACK_ID = :id`

### 1-3. 확인 쿼리 (담당자 실행 후)
```sql
SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = 'FEEDBACKS' ORDER BY COLUMN_ID
SELECT COLUMN_NAME, COMMENTS FROM USER_COL_COMMENTS WHERE TABLE_NAME = 'FEEDBACKS'
```

## 2. REST (모두 `JwtAuthGuard`, 응답 `{ code, data, message }`)

| 메서드·경로 | 용도 | 성공 | 에러 |
|---|---|---|---|
| `POST /feedbacks` | 작성 | 201 | 401 · 422 `VALIDATION_ERROR` · 429 `FEEDBACK_RATE_LIMITED` |
| `GET /feedbacks/me?beforeId&limit` | 내 목록(최신순, keyset — team-chat 관례) | 200 | 401 · 422 |
| `GET /feedbacks/:feedbackId` | 내 상세(답변 포함) | 200 | 401 · 404 `FEEDBACK_NOT_FOUND`(남의 것 포함) |
- 수정·삭제 라우트 없음 (D-009). 목록 응답 `data: { items, hasMore }` (D-011-3)
- 응답 형태(D-014): `FeedbackListItem = { feedbackId, category, title, status, hasReply, createdAt }` · `FeedbackDetail = ListItem + { content, adminReply, repliedAt, pagePath }`. `userAgent`·`buildSha`는 응답에 싣지 않는다
- 429는 두 종류 — `FEEDBACK_RATE_LIMITED`(24시간 상한) · `TOO_MANY_REQUESTS`(라우트 스로틀 초당 1·분당 3)

### 2-1. 요청 `POST /feedbacks`
```
{ category: 'FEATURE'|'BUG'|'IMPROVEMENT'|'QUESTION'|'OTHER',
  title: string(1~100, trim),
  content: string(1~5000, trim),
  pagePath?: string(≤500), buildSha?: string(≤40) }
```
- `forbidNonWhitelisted` — 정의 외 필드는 422. 한도 값은 백엔드 상수 하나에 두고 프론트에 같은 값을 전달.

### 2-2. 한도
- 목록 `limit` 기본 20, 최대 50 · 작성 초당 1·분당 3건(`THROTTLE_FEEDBACK_*`) · 사용자당 24시간 20건(D-005). 상수는 `app.constants.ts`의 `FEEDBACK_*`

## 3. 운영자 알림 (D-008)
- 작성 커밋 후 디스코드(`FEEDBACK_DISCORD_WEBHOOK_URL`) · 텔레그램(`FEEDBACK_TELEGRAM_CHAT_ID`, 봇 `BOT_TOKEN_TELEGRAM`)으로 발송. env 없는 채널은 건너뜀. 실패는 로그만.
- 경로: `INotificationPort.notifyFeedbackChannel(content)` → `NotificationAdapter`가 env 대상으로 `sendMessageAsync`·`sendWebhookMessage` 호출, 실패는 `.catch` 로그 (D-014)
- 본문: `📮 새 피드백 · <카테고리 표시명>` / 제목(굵게) / `#ID · 이름 (userId N)` / `화면:`·`빌드:`(있으면) / 내용 인용(기존 `NOTIFICATION_QUOTE_MAX_LENGTH` 300자). 이스케이프는 기존 렌더러(`renderFeedbackTelegramHtml`·`renderFeedbackDiscordMarkdown`)가 한다
- 상태·답변 갱신은 담당자 SQL — 관리자 화면은 후속.

## 4. 프론트 (`next-bun-8b` 조사 — WORKLOG 프론트 조사 절, D-011)
- BNB `BottomNavBar.tsx` `navItems`에 5번째 탭 `/feedback`(항상 노출). 375·320px 라벨 실측 후 필요 시 단축
- `/feedback`: 비로그인이면 로그인 카드, 로그인이면 작성 폼(제목 `Input` · 내용 `TextArea` + 글자 수 카운터 · 카테고리 단일 선택 칩). 한도는 §2-1과 같은 값
- 내 피드백: 마이페이지 진입 링크 + 목록 화면(상태 배지 · 카테고리 · 작성일 로컬 시각 · "더 보기") + 상세(내용·운영자 답변) — 마이페이지에는 링크만, 목록·상세는 별도 화면 (D-012)
- `src/services/feedbackService.ts` 신설 · 빌드 SHA 주입(Dockerfile ARG + 워크플로 build-args)
