# Oracle 타임존 이슈 수정

## 문제 요약

plain `TIMESTAMP` 컬럼에 시간대 정보가 없어, 서버 프로세스 TZ에 따라 날짜 해석이 달라짐.
상용(Docker TZ=UTC)과 로컬(Mac TZ=KST)에서 동일 데이터가 다른 시간으로 표시됨.
프론트엔드는 `getUTCHours()`로 UTC 표시 → 한국 사용자에게 9시간 과거로 보임.

## 확정된 원인 (2026-04-09 쿼리/API 확인)

### Oracle 환경
```
SESSIONTIMEZONE = Asia/Seoul  (DB 쿼리 툴 기준, Mac에서 접속)
DBTIMEZONE = +00:00 (UTC)
상용 Docker: TZ=UTC → 프로세스 TZ = UTC
로컬 Mac: TZ 미설정 → 프로세스 TZ = KST
```

### 컬럼 타입 불일치 (전수조사 완료)

**`TIMESTAMP(6) WITH TIME ZONE` (실제 DB) — 7개:**
- TEAMS.CRTD_AT
- TEAM_INVITATIONS.CRTD_AT
- TEAM_TASKS.CRTD_AT
- TEAM_TASKS.START_AT
- TEAM_TASKS.END_AT
- USERS.CREATED_DATE
- USER_TEAMS.JOINED_AT

**plain `TIMESTAMP(6)` (실제 DB) — 7개:**
- TASK_COMMENTS.CRTD_AT
- TASK_COMMENTS.MDFD_AT
- TEAM_INVITATIONS.END_AT
- TEAM_TASKS.COMPLETED_AT
- TEAM_TELEGRAM_LINKS.CRTD_AT
- TEAM_TELEGRAM_LINKS.END_AT
- TEAM_TELEGRAM_LINKS.USED_AT

**TypeORM 엔티티: 14개 컬럼 모두 `type: 'timestamp'`로 선언 — DB와 불일치.**

### DB DEFAULT 현황

| 엔티티 | 컬럼 | TypeORM default | DB DATA_DEFAULT |
|--------|------|----------------|-----------------|
| TeamTask | CRTD_AT | `CURRENT_TIMESTAMP` | (TypeORM이 설정) |
| TaskComment | CRTD_AT | `CURRENT_TIMESTAMP` | (TypeORM이 설정) |
| TeamInvitation | CRTD_AT | `CURRENT_TIMESTAMP` | (TypeORM이 설정) |
| TelegramLink | CRTD_AT | `CURRENT_TIMESTAMP` | (TypeORM이 설정) |
| Team | CRTD_AT | **없음** | `SYSTIMESTAMP` (DB DDL) |
| TeamMember(USER_TEAMS) | JOINED_AT | **없음** | `SYSTIMESTAMP` (DB DDL) |
| User | CREATED_DATE | **없음** | (서비스에서 `new Date()` 할당) |

### 실측 증거 (task 602, KST 16:54 = UTC 07:54에 생성)

**DB 저장값:**
| 항목 | 컬럼 타입 | DB 값 | 판정 |
|------|-----------|-------|------|
| Task 602 CRTD_AT | WITH TIME ZONE | `07:54:39 +00:00` | UTC 정상 |
| Comment 223 CRTD_AT | plain TIMESTAMP | `07:54:50` (no TZ) | UTC 값이지만 TZ 정보 없음 |
| Comment 221 CRTD_AT (이전) | plain TIMESTAMP | `15:15:51` | KST가 저장됨 |

**API 응답 (상용 GET /api/v1/teams/1/tasks/602):**
```json
"crtdAt": "2026-04-09T07:54:39.804Z"            // task - UTC ✓
"comments[0].crtdAt": "2026-04-09T07:54:50.726Z" // comment - UTC ✓
```

### WITH TIME ZONE 컬럼 offset 분포 (2026-04-09 전수조사)

| 컬럼 | +00:00 | +09:00 | 합계 | 마이그레이션 |
|------|--------|--------|------|-------------|
| TEAM_TASKS.START_AT | 46 | 13 | 59 | +00:00만 -9h 보정 |
| TEAM_TASKS.END_AT | 53 | 11 | 64 | +00:00만 -9h 보정 |
| TEAM_TASKS.CRTD_AT | 116 | 2 | 118 | 불필요 (자동생성값) |
| TEAMS.CRTD_AT | 8 | 0 | 8 | 불필요 (자동생성값) |
| TEAM_INVITATIONS.CRTD_AT | 15 | 3 | 18 | 불필요 (자동생성값) |
| USERS.CREATED_DATE | 7 | 1 | 8 | 불필요 (서비스 new Date()) |
| USER_TEAMS.JOINED_AT | 16 | 0 | 16 | 불필요 (서비스 new Date()) |

**startAt/endAt만 마이그레이션 필요** — `buildTaskDatetime`의 Z suffix가 사용자 KST 입력을 UTC로 잘못 저장했기 때문.
나머지 CRTD_AT/CREATED_DATE/JOINED_AT는 자동생성값이므로 UTC 변환이 정확.

### 기존 데이터의 시간대 (실측 기반)

| comment | raw 값 | 생성 환경 | 저장된 TZ | 근거 |
|---------|--------|----------|----------|------|
| 221 | `15:15:51` | 로컬 Mac (TZ=KST) | KST | UTC 06:15 ≠ 15:15, KST 15:15 = 실제 시각 |
| 222 | `07:46:41` | 로컬 Mac (ORA_SDTZ=UTC 적용 후) | UTC | UTC 07:46 = KST 16:46 = 실제 시각 |
| 223 | `07:54:50` | 상용 Docker (TZ=UTC) | UTC | UTC 07:54 = KST 16:54 = 실제 시각 |

→ 상용(Docker TZ=UTC)에서 생성된 데이터는 UTC. 로컬 Mac에서 ORA_SDTZ 없이 생성된 오래된 데이터만 KST.

---

## 수정 계획

### Phase 1: DB 컬럼 마이그레이션

#### 1-A. plain TIMESTAMP → TIMESTAMP WITH TIME ZONE (7개)

Oracle은 데이터 있는 컬럼 타입 직접 변경 불가 → 임시 컬럼 → 복사 → 교체.

**변경 대상:**
1. TASK_COMMENTS.CRTD_AT (default: CURRENT_TIMESTAMP, NOT NULL)
2. TASK_COMMENTS.MDFD_AT (nullable)
3. TEAM_INVITATIONS.END_AT (NOT NULL)
4. TEAM_TASKS.COMPLETED_AT (nullable)
5. TEAM_TELEGRAM_LINKS.CRTD_AT (default: CURRENT_TIMESTAMP, NOT NULL)
6. TEAM_TELEGRAM_LINKS.END_AT (NOT NULL)
7. TEAM_TELEGRAM_LINKS.USED_AT (nullable)

**기존 데이터:** 상용 대부분 UTC → `FROM_TZ(col, 'UTC')` 일괄 처리. 로컬 테스트 데이터 일부 KST 혼재 가능 → 실서비스 영향 미미.

#### 1-B. startAt/endAt 기존 데이터 보정 (+00:00만)

`buildTaskDatetime`이 Z suffix를 붙여 전송 → 사용자의 KST 입력값이 UTC로 잘못 저장됨.
Phase 3에서 `getHours()` 전환 시 기존 데이터가 9시간 어긋나므로 보정 필요.

| 컬럼 | +00:00 건수 | +09:00 건수 | 처리 |
|------|-----------|-----------|------|
| START_AT | 46 | 13 (변경 불필요) | +00:00만 -9h |
| END_AT | 53 | 11 (변경 불필요) | +00:00만 -9h |

검증:
- task 601 `START_AT: 00:10 +09:00` = UTC 15:10 → `getHours()` KST = 00:10 ✓
- task 602 `START_AT: 16:54 +00:00` = UTC 16:54 → `getHours()` KST = 01:54 ✗ → -9h 보정 후 `07:54 +00:00` → KST 16:54 ✓

```sql
UPDATE TEAM_TASKS SET START_AT = START_AT - INTERVAL '9' HOUR
WHERE START_AT IS NOT NULL AND EXTRACT(TIMEZONE_HOUR FROM START_AT) = 0;

UPDATE TEAM_TASKS SET END_AT = END_AT - INTERVAL '9' HOUR
WHERE END_AT IS NOT NULL AND EXTRACT(TIMEZONE_HOUR FROM END_AT) = 0;
```

#### 1-C. ORA_SDTZ 설정 금지

~~`app.module.ts`의 `process.env.ORA_SDTZ = 'UTC'`~~ — **삭제됨**.
oracledb 드라이버가 JS Date를 저장할 때 로컬 시간 메서드(`getHours()` 등)를 사용하므로,
세션 타임존은 반드시 로컬 TZ와 일치해야 함. ORA_SDTZ를 설정하지 않으면 자동으로 일치.

### Phase 2: TypeORM 엔티티 타입 통일

**14개 전체** 컬럼: `type: 'timestamp'` → `type: 'timestamp with time zone'`

**참고:** TypeORM Oracle 드라이버에서 `'timestamp'`과 `'timestamp with time zone'` 모두 `DB_TYPE_TIMESTAMP`로 매핑되므로 런타임 동작 변화 없음. `synchronize: false`라 DDL도 미영향. 코드 정확성/문서화 목적의 변경.

| 파일 | 컬럼 | 현재 | DB 실제 |
|------|------|------|---------|
| Team.ts | crtdAt | `'timestamp'` | WITH TIME ZONE |
| TeamTask.ts | startAt, endAt, completedAt, crtdAt | `'timestamp'` | 3개 WITH TZ + 1개 plain→WITH TZ |
| TaskComment.ts | crtdAt, mdfdAt | `'timestamp'` | plain→WITH TZ |
| TeamMember.ts | joinedAt | `'timestamp'` | WITH TIME ZONE |
| TeamInvitation.ts | crtdAt, endAt | `'timestamp'` | 1개 WITH TZ + 1개 plain→WITH TZ |
| TelegramLink.ts | crtdAt, endAt, usedAt | `'timestamp'` | 전부 plain→WITH TZ |
| User.ts | createdDate | `'timestamp'` | WITH TIME ZONE |

### Phase 3: 프론트엔드 "UTC 저장, 로컬 표시" 전환

모든 UTC 메서드를 로컬 메서드로 통일. 전수조사 기반 변경 목록.

#### 3-1. dateUtils.ts (11개 함수)

| 함수 | 라인 | 변경 내용 |
|------|------|-----------|
| `daysBetween()` | 20-21 | `Date.UTC(s.getUTCFullYear()...)` → `new Date(s.getFullYear()...).getTime()` |
| `generateDateRange()` | 34,36,40 | `setUTCHours(0,0,0,0)` → `setHours(0,0,0,0)`, `setUTCDate/getUTCDate` → `setDate/getDate` |
| `normalizeDate()` | 52 | `setUTCHours(0,0,0,0)` → `setHours(0,0,0,0)` |
| `getLocalTodayAsUTC()` | 60-63 | `Date.UTC(...)` → `new Date(...)`. 함수명 → `getToday()`. 사용처: GanttChart.tsx:39 이름도 변경 |
| `getMonthDays()` | 122-123 | `Date.UTC(year, month, 1)` → `new Date(year, month, 1)` |
| `generateCalendarGrid()` | 135-136,141 | `Date.UTC()` → `new Date()`, `getUTCDay()`→`getDay()`, `getUTCDate()`→`getDate()` |
| `isWeekend()` | 184 | `getUTCDay()` → `getDay()` |
| `isToday()` | 197-199 | `getUTCFullYear/Month/Date()` → `getFullYear/Month/Date()` (양쪽 모두 로컬로 통일) |
| `buildTaskDatetime()` | 98 | `` `${date}T${t}:${seconds}Z` `` → `new Date(\`${date}T${t}:${seconds}\`).toISOString()` |
| `parseTaskDatetime()` | 107-109 | `toISOString()` 기반 → 로컬 컴포넌트 추출 (`getFullYear/Month/Date/Hours/Minutes`) |
| `getTodayKey()` | 69-75 | 변경 불필요 (이미 로컬 메서드 사용) |

#### 3-2. taskUtils.ts (9개 함수)

| 함수 | 라인 | 변경 내용 |
|------|------|-----------|
| `getDeadlineStatus()` | 40 | `end.getUTCFullYear/Month/Date()` → `end.getFullYear/Month/Date()` |
| `getDaysFromNow()` | 124 | `target.getUTCFullYear/Month/Date()` → `target.getFullYear/Month/Date()` |
| `filterByPeriod()` | 206 | `endDate.getUTCFullYear/Month/Date()` → `endDate.getFullYear/Month/Date()` |
| `formatCompactDateTime()` | 283-285 | `getUTCHours/Minutes/Month/Date()` → `getHours/Minutes/Month/Date()` |
| `formatShortDate()` | 301 | `timeZone: 'UTC'` 제거 |
| `formatDateWithYear()` | 318 | `timeZone: 'UTC'` 제거 |
| `formatFullDateTime()` | 338 | `timeZone: 'UTC'` 제거 |
| `formatDateKey()` | 349-351 | `toISOString().split('T')[0]` → 로컬 날짜 포맷 |
| `formatDateDisplay()` | 361 | `getUTCMonth/Date()` → `getMonth/Date()` |

#### 3-3. CalendarView.tsx (4곳)

| 라인 | 변경 내용 |
|------|-----------|
| 333 | `date.getUTCMonth()` → `date.getMonth()` |
| 348-351 | `date.getUTCDay()` → `date.getDay()` |
| 355 | `date.getUTCDate()` → `date.getDate()` |
| 486 | `popover.date.getUTCMonth()`, `getUTCDate()` → `getMonth()`, `getDate()` |

#### 3-4. GanttChart.tsx (6곳)

| 라인 | 변경 내용 |
|------|-----------|
| 39 | `getLocalTodayAsUTC()` → `getToday()` 호출 이름 변경 |
| 41 | `twoWeeksLater.setUTCDate(today.getUTCDate() + 13)` → `setDate/getDate` |
| 58 | `minDate.setUTCDate(minDate.getUTCDate() - 3)` → `setDate/getDate` |
| 59 | `maxDate.setUTCDate(maxDate.getUTCDate() + 3)` → `setDate/getDate` |
| 64 | `maxDate.setUTCDate(maxDate.getUTCDate() + ...)` → `setDate/getDate` |
| 186 | `timeZone: 'UTC'` 제거 (2곳 — startAt, endAt 툴팁) |

#### 3-5. TeamManagementSection.tsx (1곳)

| 라인 | 변경 내용 |
|------|-----------|
| 78-86 | `formatMemberDate()` 함수의 `timeZone: 'UTC'` 제거 |

#### 3-6. startAt/endAt 전송 방식 변경 (buildTaskDatetime)

```typescript
// 현재: "2026-04-09T16:54:00Z" → 서버에 UTC 16:54로 전달 (사용자 의도: KST 16:54)
return `${date}T${t}:${seconds}Z`;

// 변경: 브라우저가 로컬(KST)로 해석 후 UTC 변환하여 전송
return new Date(`${date}T${t}:${seconds}`).toISOString();
// → 브라우저 KST 16:54 → UTC 07:54 → "2026-04-09T07:54:00.000Z"
```

#### 3-7. 변경 불필요 확인 (전수조사 근거)

| 항목 | 근거 |
|------|------|
| `getArchiveDaysLeft()` (taskUtils.ts:11) | `getTime()` ms 기반 계산, TZ 무관 |
| `useTeamInvite.ts:63-68` 초대 endAt | `setHours(23,59,59,999)` + `toISOString()` — 이미 로컬→UTC 올바르게 변환 |
| `TeamManagementSection.tsx:444` 만료 체크 | `new Date(endAt) < new Date()` — UTC Date 비교, TZ 무관 |
| 소켓 이벤트 `new Date(ISOstring)` 변환 | ISO 파싱은 항상 UTC, 변경 불필요 |
| `teamService.ts:385-391` joinedAt 변환 | `new Date(string)` 파싱, 변경 불필요 |

### Phase 4: CLAUDE.md 컨벤션 업데이트

프론트/백 모두: "UTC 저장, UTC 표시" → "UTC 저장, 로컬 표시"

### Phase 5: 백엔드 알림 포맷 업데이트

`date.utils.ts`의 `formatDateTime`: `timeZone: 'UTC'` → `timeZone: 'Asia/Seoul'`
(한국어 전용 앱이므로 KST 하드코딩 — 다국어 지원 시 재검토)

### Phase 6: 백엔드 안전성 개선 (선택)

| 위치 | 현재 | 권장 | 이유 |
|------|------|------|------|
| `telegram.service.ts:188` | `setHours(getHours() + 24)` | `setTime(getTime() + 24*60*60*1000)` | setHours는 로컬 TZ 기반, ms 연산이 안전 |
| `scheduler.service.ts:89` | `setDate(getDate() - 14)` | `setTime(getTime() - 14*24*60*60*1000)` | 동일 이유 |

Docker TZ=UTC에서는 현재도 정상 동작하므로 선택사항.

---

## CRUD 영향도 (전수조사 완료)

### 백엔드 `new Date()` 사용 위치 (14곳)

| 위치 | 라인 | 용도 | Docker TZ=UTC 안전 |
|------|------|------|-------------------|
| team.service.ts | 301 | `joinedAt` (팀 생성 MASTER) | ✓ |
| team.service.ts | 502 | `completedAt` (상태변경) | ✓ |
| team.service.ts | 659 | `mdfdAt` (댓글 수정) | ✓ |
| team.service.ts | 719 | `mdfdAt` (댓글 삭제) | ✓ |
| team.service.ts | 1023 | `now` (초대 만료 검증) | ✓ |
| team.service.ts | 1028 | `maxEndAt` (초대 상한) | ✓ (getTime 기반) |
| team.service.ts | 1124 | `now` (초대 만료 판정) | ✓ |
| team.service.ts | 1223 | `joinedAt` (초대 수락) | ✓ |
| telegram.service.ts | 187-188 | `endAt` (+24h) | ✓ (Phase 6 권장) |
| telegram.service.ts | 301 | `MoreThan(now)` (만료 검증) | ✓ |
| telegram.service.ts | 342 | `usedAt` (연동 완료) | ✓ |
| telegram.service.ts | 386 | `MoreThan(now)` (대기 조회) | ✓ |
| scheduler.service.ts | 88-89 | `cutoffDate` (-14일) | ✓ (Phase 6 권장) |
| auth.service.ts | 107 | `createdDate` (회원가입) | ✓ |

→ 모든 `new Date()` 사용 위치는 Docker TZ=UTC 환경에서 안전.

### 백엔드 `CURRENT_TIMESTAMP` 의존 위치 (4곳 + DB DDL 2곳)

| 엔티티 | TypeORM default | 비고 |
|--------|----------------|------|
| TeamTask.crtdAt | `CURRENT_TIMESTAMP` | ORA_SDTZ=UTC로 UTC 보장 |
| TaskComment.crtdAt | `CURRENT_TIMESTAMP` | 동일 |
| TeamInvitation.crtdAt | `CURRENT_TIMESTAMP` | 동일 |
| TelegramLink.crtdAt | `CURRENT_TIMESTAMP` | 동일 |
| Team.crtdAt | 없음 (DB: `SYSTIMESTAMP`) | ORA_SDTZ=UTC로 UTC 보장 |
| TeamMember.joinedAt | 없음 (DB: `SYSTIMESTAMP`) | 팀 생성 시 MASTER 멤버만 해당 |

### 프론트엔드 날짜 처리 (CRUD별)

| CRUD | 처리 | Phase 3 영향 |
|------|------|-------------|
| 태스크 생성 | `buildTaskDatetime` (tasks/new:55-56) | 3-6에서 처리 |
| 태스크 수정 | `buildTaskDatetime` + `parseTaskDatetime` (TaskDetailPage:306-307, 523-526) | 3-1, 3-6에서 처리 |
| 댓글 표시 | `formatCompactDateTime` (TaskDetailPage:690) | 3-2에서 처리 |
| 초대 만료일 표시 | `formatFullDateTime` (TeamManagementSection:480) | 3-2에서 처리 |
| 초대 생성일 표시 | `formatFullDateTime` (TeamManagementSection:481) | 3-2에서 처리 |
| 텔레그램 만료일 표시 | `formatFullDateTime` (TelegramSection:114) | 3-2에서 처리 |
| 멤버 가입일 표시 | `formatMemberDate` (TeamManagementSection:361) | 3-5에서 처리 |
| 초대 endAt 전송 | `useTeamInvite.ts:63-68` (`toISOString`) | 변경 불필요 |
| 초대 만료 체크 | `TeamManagementSection:444` (Date 비교) | 변경 불필요 |
| 소켓 날짜 수신 | `new Date(ISOstring)` (TeamBoard, TaskDetailPage) | 변경 불필요 |

---

## 완료 기준 (DoD)
- [x] Oracle 세션/DB 타임존 확인
- [x] 전체 컬럼 타입 전수조사 (14개)
- [x] 전체 WITH TIME ZONE offset 분포 전수조사
- [x] DB DEFAULT 현황 확인 (Team: SYSTIMESTAMP, TeamMember: SYSTIMESTAMP)
- [x] 실측 데이터로 원인 확정 (API 응답 + DB 쿼리)
- [x] 상용/로컬 환경별 차이 원인 확정
- [x] 백엔드 CRUD 전수조사 (new Date 14곳 + CURRENT_TIMESTAMP 6곳)
- [x] 프론트엔드 CRUD 전수조사 (변경 30곳 + 불필요 5곳)
- [x] Phase 1: DB 컬럼 마이그레이션 (7개 타입 변경 + startAt/endAt 99건 보정)
- [x] Phase 1 hotfix: FROM_TZ 'UTC' 리전 → '+00:00' 오프셋 변환 (ORA-01805 해결)
- [x] Phase 1 hotfix2: ORA_SDTZ 제거 (oracledb가 로컬 TZ 기반 Date 저장 → 세션 TZ 불일치 해결)
- [x] Phase 2: TypeORM 엔티티 타입 통일 (7개 파일 14개 컬럼)
- [x] Phase 3: 프론트 로컬 표시 전환 (dateUtils 10함수 + taskUtils 9함수 + 컴포넌트 11곳)
- [x] Phase 4: CLAUDE.md 컨벤션 업데이트 (프론트/백 모두)
- [x] Phase 5: 백엔드 알림 포맷 업데이트
- [ ] Phase 6: 백엔드 안전성 개선 (선택)
- [ ] 상용 배포 후 시간 표시 정상 확인
