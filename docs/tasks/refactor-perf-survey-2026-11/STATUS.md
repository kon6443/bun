# 백·프 리팩터링·성능 전수조사 (2026-11)

- **상태**: 🟢 완료 — A 등급(A1~A9) 운영 배포(백 #335·#336 `01afdf1`, 프 #413·#414 `47288dd`). B·C 등급은 별건 (2026-11-16)
- **브랜치**: 백 `refactor-onam-perf-a` (base `origin/develop` `3e8f900`) · 프 `refactor-onam-perf-a` (base `origin/develop` `41c8cb6`) · **최종수정**: 2026-11-16
- **관련 문서**: DECISIONS.md · WORKLOG.md (2026-11-16 절에 원표 전체)

## 세션·브랜치
| 역할 | 세션 | 위치 |
|---|---|---|
| 메인·백엔드·문서 | 이 세션 | `.claude/worktrees/refactor-survey` |
| 프론트 | `next-bun-fe` | `next-bun/.claude/worktrees/team-nickname` (브랜치 `refactor-onam-perf-a` — 디렉터리 이름만 예전 것) |

## 목표 & 수용 기준
- 무엇을: 백·프 전체에서 리팩터링·성능·견고성 개선 후보를 근거(파일:라인)와 함께 찾아 우선순위를 매긴다
- 끝났다는 기준: 후보마다 근거·영향·난이도·기등재 여부가 있고, 사용자가 착수 묶음을 고를 수 있는 등급표가 있다
- 비목표: 이 문서 단계에서의 코드 수정

## 지금 어디까지 (다음 세션이 여기서 이어간다)
- 완료: 전수조사(WORKLOG 2026-11-16 원표) · 착수 결정(D-002·D-003) · 백엔드 A1~A6 구현 + 단위 테스트 + 변이 검증 6/6 (WORKLOG "A 구현" 절)
- **다음 할 일**: 없음(A 완료). B·C 등급은 사용자가 고르면 새 태스크로 — 등급표가 출발점

## 진행 체크리스트 (A 등급)
- [x] A1 미사용 의존성 3개·Dockerfile `unzip` 제거
- [x] A2 낚시 소켓 빈도 제한·입력 상한·소켓 메시지 100KB 상한
- [x] A3 프레즌스 Redis 비ready 가드·낚시 fire-and-forget rejection 처리
- [x] A4 `removeSocket` Lua 원자화(팀·낚시)·낚시 맵 이동 시 이전 맵 정리
- [x] A5 관리자 확인 단일화(`TeamService.assertManagerAccess`)·`toErrorMessage` 59곳·team.service 정리
- [x] A6 포트리스 제출 1회 읽기·깨우기 타이머 마지막 것만
- [x] A7~A9 프론트 (next-bun-fe) — ci:core 통과, 리뷰 1라운드 두 리뷰어 확정 0, `/` First Load 182→114kB
- [x] 리뷰 루프 — 백 R3 두 리뷰어 확정 0(R1·R2 확정 수정), 프 R1 두 리뷰어 확정 0
- [x] 백 `ci:all` EXIT 0
- [x] 로컬 실 API·Playwright — 낚시 소켓 7/7, A5 실 API, Esc 2/2, 화면 6/6 (WORKLOG 검증 절)
- [x] 커밋·PR·배포 — 백 6커밋 #335→develop `4251497`, #336→main `01afdf1`, Deploy NestJS run 43830888407 success · 프 5커밋 #413 `3179c49`, #414 `47288dd`, Deploy Next run 43832314484 success
- [x] Redis 실검증: opt-in Redis E2E 6 스위트 68/68 (로컬 6380)

## 전제 — 실측 규모 (2026-11-16, `pnpm db:select`)
- USERS 10 · TEAMS 9 · TEAM_TASKS 188(팀 최대 98) · TASK_COMMENTS 84 · TEAM_CHAT_MESSAGES 130 · GAME_SCORES 157 · USER_POINT_LEDGER 80 · FORTRESS_PLAYERS 19
- → DB 인덱스·쿼리 수 항목은 **지금 체감 영향 없음**. 규모 트리거가 오면 착수(등급 C)
- 테트리스 리플레이 검증 실측: 프레임당 ~0.3µs → 상한 216,000프레임이어도 ~70ms (WORKLOG 2026-11-16)

## 등급표 (상세·근거는 WORKLOG 원표 번호)
### A — 작고 실익 있음 (S, 위험 낮음)
| ID | 쪽 | 항목 | 원표 |
|---|---|---|---|
| A1 | BE | 미사용 직접 의존성 `cors`·`discord.js`·`node-schedule` 제거 + Dockerfile `unzip` 제거 | 구조#1·#9 |
| A2 | BE | 낚시 소켓: 이동·상태·채팅 서버 빈도 제한, `fishName`·`pointId` `@MaxLength`, `size`·`weight` `@Max`, `maxHttpBufferSize` 하향 | 실시간#3 |
| A3 | BE | Redis 비ready 가드(`online-user`·`fishing-online`) + 낚시 `pipeline.exec()` catch | 실시간#4·#5 |
| A4 | BE | `removeSocket` 원자화(Lua) · 낚시 `joinMap` 이전 맵 정리 | 실시간#6·#12 |
| A5 | BE | 관리자 권한 확인 3곳 → `role.constants` 판정 재사용 단일화 · `toErrorMessage` 헬퍼(60곳) · team.service 주석 코드·중복 import | 구조#4·#5·#10 |
| A6 | BE | 포트리스: 행동마다 경기 JSON 3회 로드 → 1회 (`clearStaleDisconnect` 빠른 경로, load 재사용) · 마감 타이머 id별 1개 | 실시간#2(a)(b)·#8 |
| A7 | FE | 루트 레이아웃 배럴 import로 dnd-kit·react-colorful·socket.io가 전 페이지에 실림(layout gz 82KB 중) | 프론트#1 |
| A8 | FE | `SkinUpgradePanel` Esc가 설정 시트까지 닫음(preventDefault 누락) — **결함** | 프론트#2 |
| A9 | FE | 캔버스 DPR 상한 2(낚시·테트리스) · TaskDetail seq 가드 · 죽은 코드(심볼 7 + 파일 3) | 프론트#8·#14·#17 |

### B — 구조 개선 (M, 리뷰 루프 필요)
| ID | 쪽 | 항목 | 원표 |
|---|---|---|---|
| B1 | BE | JWT 검증·WS 토큰 추출 6곳 복제 → `access-token.utils` 단일화 (인증 경로) | 구조#2 |
| B2 | BE | tetris/fortress 방 서비스 잔여 복제(타입·`assertCanTakeOver`·`recordHeartbeat`) → `game-room` | 구조#3 |
| B3 | BE | `team.controller` 텔레그램·디스코드 6개 핸들러 → `team-integration.controller` | 구조#7 |
| B4 | BE | 로비 방송 목록 공유 캐시 · 하트비트 게이트 왕복 축소 · `joinTeam` Redis 왕복 합치기 · `TASK_SLOT` 판정 헬퍼 | 실시간#7·#9·#10·#11 |
| B5 | FE | TeamBoard가 채팅 컨텍스트 전체 구독 → 분리 + TaskCard·행 memo + 검색 `useDeferredValue` | 프론트#3·#4·#5 |
| B6 | FE | 서비스 6개의 `handleApiError` 동작 불일치 → 테스트 고정 후 단일화 | 프론트#10 |
| B7 | FE | 포트리스 타이머·충전 리렌더 분리 · 낚시 프레임마다 setCtx·Map 재생성 | 프론트#6·#7·#12 |
| B8 | FE | 게임 간 중복(재생기 키·키 대상·DPR 감시) · 텔레그램/디스코드 훅 공통화 | 프론트#15·#16 |
| B9 | BE+FE | 댓글 CRUD 뒤 상세 재조회 → 응답(`data: comment`)으로 부분 갱신 | 프론트 C3 |

### C — 규모 의존·보류 (트리거 시 착수)
- DB 인덱스(TEAM_TASKS·TASK_COMMENTS·USER_TEAMS(TEAM_ID)·TEAM_INVITATIONS·FORTRESS_PLAYERS(USER_ID)), GAME_SCORES 순위 인덱스에 IS_HIDDEN — 실측 인덱스 목록 WORKLOG
- 인증·WS 가드의 이벤트마다 USERS 조회(poolMax 3) — 캐시하면 비활성 반영 지연, 정책 결정 필요
- 인기 리플레이 `all` 캐시, 안읽음 COUNT 상한(계약), 포인트 SUM 합치기, 랭킹 `trophiesOf` 중복 조회, 목록 페이지네이션(D18 기등재)
- 리플레이 검증 워커 풀 이전(최악 ~70ms)
- 거대 컴포넌트 분리(TeamBoard·FortressMatch), 낚시 렌더러 오프스크린, 탱크 sprite 캐시, 타입 엄격화, E2E isolatedModules, `games.service.spec` 분리
- 트리거: 사용자·팀 규모가 10배 이상 / Prometheus 응답시간·풀 대기 상승 / 해당 화면을 다시 손댈 때

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 권장 디폴트 | 상태 |
|---|---|---|---|---|
| Q1 | 어느 묶음부터 착수할지 | 사용자 | A 전체 | ✅ D-002 |
| Q2 | `*.events.ts` 미사용 페이로드 타입·`ErrorCode`를 계약 문서로 둘지 | 사용자 | 둔다 | ✅ D-003 |
| Q3 | 낚시 상한 값 | 프론트 세션 | 프론트 실제 최대값 × 여유 | ✅ D-004 |

## 결정 요약 (본문은 DECISIONS.md)
- D-001 규모 의존 항목은 등급 C로 보류
- D-002 착수 범위 A 전체 · D-003 계약 문서 타입 유지 · D-004 낚시 상한·빈도 값 · D-005 포트리스 끊김 해제를 submit 안으로 · D-006 프레즌스 정리 경로는 끊김에도 명령 · D-007 낚시 맵 소속 변경 직렬화

## 검증 명령 (착수 시)
- BE `pnpm ci:core` → PR 직전 `pnpm ci:all` · FE `ci:core`(프론트 세션) · Playwright 회귀

## 후속 (이번 범위 밖)
- 팀 `leaveTeam`이 room 이탈 전에 Redis 정리를 기다림 · 팀 leave→join 경합 (R2 #4, base와 같음) → `refactor-perf-b-2026-11` D-006에서 처리(2026-11-18)

## 위험 & 롤백
- 조사 문서만 — 코드 영향 없음. 착수 묶음별 격리 커밋으로 revert 가능하게
