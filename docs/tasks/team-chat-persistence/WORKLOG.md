# 팀 채팅 저장 · 읽음 표시 · 안읽음 배지 — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## \|^### "`로 목차를 본 뒤 필요한 절만 읽는다.

## 2026-10-14 — 현황 조사

### 백엔드 (bun)
| 항목 | 현황 | 근거 |
|---|---|---|
| 채팅 핸들러 | 저장 없이 `server.to(room).emit(chatReceived)` | `src/modules/team/team.gateway.ts` `handleChatMessage` |
| messageId | `clientMsgId`를 그대로 돌려줌. 저장을 도입하면 DB PK로 바꾸기로 사전 설계 | `tasks-team-chat.md` D4 |
| 메시지 길이 | `@MaxLength(200)` | `team.gateway.dto.ts` `ChatMessageDto` |
| 멤버십 | `USER_TEAMS(TEAM_ID, USER_ID)` PK, `ACT_STATUS` 1=활성, `JOINED_AT` | `src/entities/TeamMember.ts` |
| 멤버 생성 지점 | 팀 생성(`insertTeam`), 초대 수락(신규 INSERT / 비활성 재활성화 UPDATE) — 둘 다 `dataSource.transaction` | `team.service.ts` |
| WS 에러 변환 | `WsExceptionFilter`는 `WsException`만 code를 살린다. HTTP 도메인 에러를 그대로 던지면 `WS_ERROR`(내부 오류)로 바뀐다 → 게이트웨이에서 `WsException`으로 변환해야 한다 | `src/common/filters/ws-exception.filter.ts` |
| TypeORM Oracle `affected` | `UpdateResult.affected = raw.rowsAffected` 지원 | `node_modules/typeorm/driver/oracle/OracleQueryRunner.js:182` |
| 유저 하드 삭제 | 없음 | `grep "delete(User\|userRepository.delete\|remove"` 0건 |

### 인프라
| 항목 | 값 | 근거 |
|---|---|---|
| DB | Oracle Autonomous(wallet, thick 모드), Always Free 20GB(사용자 확인) | README, 사용자 답변 |
| DB 커넥션 풀 | 레플리카당 `poolMax: 3` | `src/config/database.config.ts` |
| 앱 레플리카 | 3개, `update_config.order: start-first`(롤링 중 일시적으로 4개) | `infra/docker-stack.app.yml` |
| 앱 노드 | fs-01 ARM64 4 OCPU / 24GB — nest·next·redis·caddy가 함께 배치 | `docs/deploy.md` |
| Redis | `maxmemory 128mb`, `allkeys-lru`, AOF on | README "로컬 Redis 실행" |
| LOCAL·PROD DB | 같은 DB | CLAUDE.md |

### 프론트 (next-bun) — frontend-researcher 조사, 결론값은 원본에서 재확인
- 메시지는 컴포넌트 로컬 state. 패널은 항상 마운트되고 닫으면 렌더만 생략한다. 새로고침하면 사라진다 (`TeamChatPanel.tsx:42, 155`).
- dedup: `prev.some(m => m.id === payload.messageId)` — 서버 `messageId`가 `clientMsgId`와 같다는 전제 (`TeamChatPanel.tsx:91`, 재확인 완료).
- 입력 `maxLength={200}` (`TeamChatPanel.tsx:244`, 재확인 완료).
- 소켓 Provider는 `src/app/teams/[teamId]/layout.tsx:36`에서만 쓴다. 팀 목록 화면엔 소켓이 없다.
- 팀 목록: `GET /teams` → `TeamsDashboard.tsx`에서 `TeamSummary`로 매핑하며 필드를 버린다. 카드는 `TeamsClient.tsx` `TeamList`.
- 채팅 버튼: `TeamBoard.tsx:884` `IconButton`. 배지 prop 지원 여부는 미확인.
- 페이지네이션·무한 스크롤 선례 없음. 재연결 시 놓친 메시지 보정 없음. 전송 실패 감지 없음.

## 2026-10-14 — 부하 추정 방법과 결과

### 방법 (일반적인 절차)
1. **이벤트 하나의 비용을 분해한다** — 메시지 1건, 읽음 1건이 DB 쿼리·Redis 명령·소켓 전송을 각각 몇 번 일으키는지 센다.
2. **트래픽을 가정한다** — 현실값과 넉넉하게 잡은 최대치 두 가지.
3. **곱해서 초당 부하를 구하고 병목 자원의 한도와 비교한다** — DB 커넥션 풀, DB CPU·세션 한도, Redis 메모리, Node 이벤트 루프.
4. **출시 후 실측으로 확인한다** — 기존 Prometheus `ws_events_total`·`ws_event_duration`(이벤트별 라벨)과 Grafana. ⚠️ 부하 테스트(k6 등)는 LOCAL=PROD DB라 이 환경에선 돌리지 않는다.

### 이벤트당 비용
| 이벤트 | DB | Redis | 소켓 전송 |
|---|---|---|---|
| 메시지 전송 | 멤버십 SELECT 1 + 트랜잭션(INSERT 1 + 커서 UPDATE 1) | INCR 1 + Pub/Sub 1 | 팀 인원 N명 |
| 읽음 (debounce 1초) | 멤버십 SELECT 1 + 메시지 존재 SELECT 1 + 커서 UPDATE 1 | INCR 1 (+ 전진했을 때 Pub/Sub 1) | 전진했을 때만 N명 |
| 팀 목록 진입 | GROUP BY 1회 (내 팀 전부) | — | — |
| 채팅 패널 열기 | 이력 1 + read-state 1~2 | — | — |

### 넉넉한 최대치 시나리오
- 가정: 동시에 활발한 팀 10개, 팀당 초당 메시지 1건, 채팅창을 연 사람 팀당 5명 (실제 규모보다 훨씬 크게 잡음 — 초대 링크 누적 21건 수준, `AddTokenUniqueIndexes` 마이그레이션 실측)
- DB: 팀당 초당 (전송 3) + (읽음 5명 × 3) = 18쿼리 → 10팀 **약 180 qps**
- 수용량: 단순 PK·인덱스 쿼리 1건이 같은 리전 기준 수 ms → 커넥션 1개가 초당 수백 건, 풀 9개(3×3)면 **초당 천 건 이상**. 최대치에서도 10~20% 수준
- 소켓: 메시지 1건당 `chatReceived` 10명 + `chatReadUpdated` 최대 5회 × 10명 = 약 60건 전송 — Socket.IO에 무시할 수준
- Redis: 레이트 리밋 키는 10초 TTL, 유저당 2개, 키 하나 약 100바이트 → 수백 명이어도 수십 KB. 128MB 한도와 무관
- **결론**: 현재 인프라로 충분하다. 먼저 걸릴 수 있는 곳은 DB 커넥션 풀(9개)인데, debounce와 "전진했을 때만 브로드캐스트"로 읽음 이벤트를 줄여 둔다.

### 저장 용량
- 메시지 1행 ≈ 본문(한글 30자 ≈ 90B) + clientMsgId 36B + 숫자·시각 약 35B + 행 오버헤드 → 약 170B. 인덱스 2개 약 100B → **메시지당 약 300B**
- 하루 1,000건 → 연 약 110MB · 하루 10,000건 → 연 약 1.1GB. 20GB 중 기존 데이터를 빼도 수십 년 분량
- 조치: 지금 보존 정책은 불필요. 월 1회 사용량을 확인하고 70%를 넘으면 보존 기간을 정한다. 확인 쿼리(읽기 전용, 담당자 실행):
  `SELECT segment_name, ROUND(SUM(bytes)/1024/1024, 1) AS mb FROM user_segments GROUP BY segment_name ORDER BY mb DESC;`

### 미확인
- Autonomous Always Free의 **동시 세션 한도** — 풀 합계는 평시 9개, 롤링 배포 중 12개(+마이그레이션·관리 도구). 한도는 콘솔·공식 문서로 확인이 필요하다 (STATUS Q9).

## 2026-10-14 — 구현 초안 (사용자 요청으로 중단, 유지)
- 작성: Entity 2개(`TeamChatMessage`, `TeamChatReadCursor`) + `database.config.ts` 등록, 마이그레이션 2개(멱등 + `COMMENT ON`), `src/common/constants/chat.constants.ts`(🟡 값 포함), `src/modules/team/chat-read-cursor.ts`(커서 전진·최신 ID·가입 시 초기화).
- 미작성: `TeamChatService`, 게이트웨이 변경, 컨트롤러·DTO, 초대 수락 연동, spec, 프론트.
- 검증: 아직 `pnpm ci:core`를 돌리지 않았다.
- 환경: worktree에 의존성이 없어 `pnpm install` 시도 → sandbox가 `.vscode/settings.json` 쓰기를 막아 실패. 원본 레포 `node_modules`를 심볼릭 링크로 연결했다(`.git/info/exclude`에 `/node_modules`, `.claude/worktrees/` 추가 — 로컬 전용).

## 2026-10-14 — 앱 노드 축소(2 OCPU / 12GB) 후 재평가와 감당 가능 트래픽

### 변경 사실
- 사용자 통보: fs-01이 4 OCPU / 24GB → **2 OCPU / 12GB**. `docs/deploy.md` 노드 표를 갱신했다(과거 태스크 문서의 4 OCPU 기록은 당시 이력이라 그대로 둠).
- 같은 노드에 Nest 3 레플리카 + **Next 10 레플리카**(`next-bun/infra/docker-stack.app.yml:27`) + Redis + Caddy. 두 스택 모두 CPU·메모리 limit 미선언(`grep resources` 0건).

### 감당 가능 트래픽 추정 (실측 전 추정치)
| 자원 | 한도 추정 | 근거·가정 |
|---|---|---|
| DB 커넥션 풀 | 이론 약 1,800 qps, 실사용 약 900 qps | 9커넥션 × 쿼리 1건 약 5ms 가정, 여유 50% |
| Autonomous DB (Always Free) | 수천 qps 이하 (미측정) | 단순 PK·인덱스 쿼리 기준. OCPU 고정 |
| Nest 3 레플리카 / 2 OCPU | 초당 수천 건 소켓 이벤트 | I/O 대기가 대부분이라 CPU보다 DB가 먼저 찬다 |
| Redis 128MB | 동시 접속 수만 명 수준 | 온라인 상태 약 300B/명 + 레이트 키 약 200B/명 |

- 환산: 메시지 1건 + 채팅창 연 사람 5명의 읽음 처리 = DB 약 18쿼리. 900 qps ÷ 18 = **서비스 전체 초당 약 50건 메시지**를 꾸준히 처리할 수 있다(하루 약 400만 건). 현실 트래픽(초당 1건 미만)의 수십~수백 배 여유.
- 2 OCPU 축소는 채팅에 문제가 되지 않는다. 먼저 차는 자원은 CPU가 아니라 DB 커넥션 풀이다.

### 채팅 외 관찰 (이 작업 범위 밖 — 후속)
- 2 OCPU에 Next 10 레플리카는 코어 수보다 프로세스가 훨씬 많다. Node는 프로세스당 1코어만 쓰므로 레플리카를 늘려도 처리량은 늘지 않고 메모리와 문맥 전환 비용만 는다. Next 레플리카를 2~4개로 줄이는 것을 별건으로 검토할 만하다.

### Redis 증설 판단
- 불필요(D-014). 증설 여부는 운영 Redis `INFO memory`의 `used_memory_human`으로 판단한다(담당자 실행 — `docker exec`가 필요해 AI는 실행하지 않음).

## 2026-10-14 — 세션 구성
- 프론트 세션 `next-bun-f1` 투입(D-015). next-bun worktree 생성: `next-bun/.claude/worktrees/chat-persistence`, 브랜치 `feat-chat-persistence`(base `feat-onam` `cfe6251`). sandbox가 next-bun `.git` 쓰기를 막아 sandbox 밖에서 생성했다. `next-bun/.git/info/exclude`에 `.claude/worktrees/`, `/node_modules` 추가(로컬 전용).

## 2026-10-14 — f1 온보딩 보고 (조사·계획, 코드 수정 없음)
- 확인 항목:
  - `IconButton`에 배지 prop 없음(`src/app/teams/components/IconButton.tsx:18-43`). 사용처 3곳
  - `TeamSummary` `{teamId,name,description,role}`(`src/types/team.ts:5`). 매핑은 `TeamsDashboard.tsx:16` 한 곳
  - `useAuthenticatedFetch`는 1회 조회 + refetch만 있음. 목록 배지에는 충분하고 채팅 이력에는 맞지 않음
- 함정: 채팅 state가 `TeamChatPanel` 로컬이고 패널은 `TeamBoard`에만 마운트된다. 태스크 상세로 이동하면 메시지와 리스너가 사라진다 → layout 수준의 `TeamChatProvider`가 필요
- 계획 슬라이스: F1 형식 호환 dedup(먼저 배포 가능) / F2 상태를 Provider로 이동 / F3 이력 / F4 커서·숫자·chatRead / F5 명단 모달 / F6 배지 / F7 재연결 보정 / F8 검증
- Q2 판단: F1만 하면 옛·새 형식 모두 처리된다(약 20줄 + 테스트) → D-017
- 계약 제안 6건 → D-016(1~5 반영), D-018(memberJoined, Q11)
- 메인 재확인: 소켓 에러 이벤트는 `error`(f1의 `exception` 추정은 틀림). 초대 수락 시 emit 없음은 맞음
- Q3 프론트 영향: 4,000자면 한 줄 `<input>`(`TeamChatPanel:237`)을 textarea로 바꿔야 한다(Shift+Enter, 자동 높이)
- f1 추가 회신: 정정(`error` 이벤트)을 원본으로 확인함. 계획 보강 — 프론트 ERROR 핸들러(`TeamSocketContext.tsx:149-152`)가 모든 에러를 연결 에러 state로 넣는다. 그래서 `clientMsgId`가 있거나 `CHAT_*`인 에러는 채팅 컨텍스트로 넘겨 낙관적 메시지를 '전송 실패'로 표시하고 토스트를 띄운다. 연결 에러 state는 건드리지 않는다. `SocketErrorPayload.clientMsgId?`는 F1에 포함

## 2026-10-14 — write-behind(Redis 버퍼 → 주기적 DB 반영) 분석 → D-020

| 기준 | 직접 저장 (채택) | Redis 버퍼 + 주기 반영 |
|---|---|---|
| 유실 | COMMIT 후 전달이라 없음 | 반영 전에 Redis가 죽거나 키가 축출되면 사라짐. AOF `everysec`도 최대 1초 유실 가능. 운영 Redis는 `allkeys-lru` |
| 메시지 ID·순서 | DB IDENTITY 하나 | Redis INCR로 따로 발급 → 원본 둘 |
| 이력 조회 | DB만 | Redis(미반영분)와 DB를 합쳐야 함 |
| 운영 | 없음 | flush 작업 단일 실행(`TASK_SLOT`)·실패 재시도·중복 반영 방지 필요 |
| 얻는 것 | — | DB 왕복 감소(일괄 INSERT) |

- 업계: 메시지 원본은 "저장이 끝난 뒤 전달"이 원칙이다. 규모가 커지면 쓰기에 강한 분산 DB에 바로 쓰거나(Discord는 Cassandra → ScyllaDB에 메시지를 직접 저장한다고 공개함), 디스크에 기록되는 로그(Kafka 등)를 앞에 둔다. 메모리 캐시를 버퍼로 쓰는 방식은 유실돼도 되는 데이터(조회수·좋아요 카운터, 타이핑 중 표시, 로그 집계)에 쓴다.
- 부하: INSERT 1건은 수 ms다. 예상 트래픽(초당 1건 미만)에서는 DB 처리량의 1% 미만이다. write-behind는 쓰기가 DB 한계(초당 수천 건 이상)에 가까울 때 검토하는 최적화다.

## 2026-10-14 — 감당 가능 동시 사용자 환산

- 가정: 쿼리 평균 5ms(미측정), 커넥션 9개, 여유를 남겨 실사용 **약 900 qps**. 5인 팀, 전원 채팅창을 열어 둠. 읽음은 1초 debounce
- 1인당 DB 부하:
  - 메시지 1건 = 전송 3쿼리
  - 메시지 1건당 나머지 4명의 읽음 처리 = 4 × 3쿼리 = 12쿼리
  - 다만 한 사람의 읽음은 초당 최대 1회로 묶인다(debounce)

| 채팅 강도 (1인당) | 1인당 DB 부하 | 동시에 버티는 사용자 수 | 하루 메시지 환산 |
|---|---|---|---|
| 아주 활발: 10초에 1개 | 약 1.5 qps | **약 600명** | 600명 × 6개/분 → 약 500만 건/일(계속 유지 시) |
| 보통: 1분에 1개 | 약 0.25 qps | **약 3,600명** | — |
| 가끔: 5분에 1개 | 약 0.05 qps | 1만 명 이상 (먼저 다른 한계에 닿음) | — |

- 쿼리가 10ms면 위 수치의 절반이다. 수천 명 규모에서는 DB보다 Autonomous DB OCPU·세션 한도(Q9)를 먼저 확인해야 한다
- 소켓 연결 자체(동시 접속 수천 명)와 Redis(1MB 미만)는 이 범위에서 제약이 아니다
- 출시 후 확인 지표: `ws_event_duration{event="chatMessage"|"chatRead"}`. 평균이 50ms를 넘으면 D-020 재검토 순서를 따른다

## 2026-10-14 — 백엔드 S1~S5 구현과 검증

### 변경 파일 (bun worktree, 미커밋)
- 스키마: Entity `TeamChatMessage`·`TeamChatReadCursor`, 마이그레이션 2개(`migrations/17919603*`, CONTENT=CLOB), `src/config/database.config.ts`
- 채팅 신규: `src/modules/team/team-chat.service.ts`·`team-chat.controller.ts`·`team-chat.dto.ts`·`chat-read-cursor.ts`, `src/common/constants/chat.constants.ts`
- 기존 수정:
  - `team.gateway.ts` — 저장 후 전달, `chatRead`, `emitMemberJoined`
  - `team.gateway.dto.ts` — 4,000자 + 16,000바이트, `ChatReadDto`
  - `team.events.ts` — 이벤트 3개 + 페이로드
  - `team.controller.ts` — `GET /teams` `unreadChatCount`, 초대 수락 후 `memberJoined`
  - `team.service.ts` — 커서 초기화 3경로, `updateMemberStatus`를 트랜잭션으로
  - `team.module.ts`, `main.ts`(Redis 주입), `team-error.dto.ts`(`TEAM_CHAT_BAD_REQUEST`), `team.dto.ts`, `ws-exception.filter.ts`(`clientMsgId` 통과)
- 테스트:
  - 신규 `chat-read-cursor.spec.ts`, `team-chat.service.spec.ts`
  - 수정 `team.gateway.spec.ts`, `team.service.invite.spec.ts`, `team.service.member-status.spec.ts`, `ws-exception.filter.spec.ts`, `entity.factory.ts`(`createTeamChatMessage`)
  - E2E 3개(`team-gateway`·`team-access-control`·`team-invitation`)

### 구현 중 발견
- 어댑터 Redis 클라이언트가 `maxRetriesPerRequest: null`이라 연결이 끊긴 동안 명령이 무한 대기한다(`redis-io.adapter.ts:33`). 레이트 리밋은 `status !== 'ready'`면 Redis에 묻지 않고 통과하게 했다. 기존 `OnlineUserService`도 같은 위험이 있는데, 이 작업 범위 밖이라 후속으로 둔다.
- `updateMemberStatus`의 UPDATE를 트랜잭션으로 옮기면서 기존 spec의 "update가 호출되지 않아야 함" 단정 4곳이 의미 없이 통과하게 됐다 → `manager.update` 기준으로 고쳤다.
- 소켓 DTO 검증 실패(`ValidationPipe`)는 `clientMsgId` 없이 `WS_ERROR`로 나간다 → DESIGN §7 알려진 한계.

### 검증
- `pnpm ci:all`(sandbox 밖) exit 0:
  - lint 0 errors / 경고 7(기준선 7, 증가 없음 — 남은 경고는 기존 `_error` 등)
  - 스텁 0
  - 단위 **710/710**(31 suites)
  - E2E **80/80**
  - build 통과
- 변이 확인: `advanceReadCursor`의 `LessThan` 조건을 지우면 `chat-read-cursor.spec` 2건이 실패한다 — "커서는 뒤로 가지 않음"이 테스트로 고정돼 있다.
- grep 전수 확인 완료: `ChatReceivedPayload`(낚시 쪽은 별도 타입) · `TeamChatService` · `initReadCursorAtLatest` · `emitMemberJoined` · `CHAT_READ_UPDATED` · `MEMBER_JOINED` · `unreadChatCount` · `updateMemberStatus`
- **미검증**:
  - 실제 Oracle 동작 — 마이그레이션 미실행이라 IDENTITY ORDER, CLOB 조회, `FETCH NEXT`, raw 별칭 대소문자를 확인하지 못했다
  - 2탭·멀티 레플리카 수동 확인
  - `GET /teams` 병합 — 서비스 spec(`getUnreadCounts`)만 있고 컨트롤러 단 테스트는 없다

## 2026-10-14 — f1 F1 완료 보고 (프론트, 미커밋)
- 변경:
  - `src/types/socket.ts` — `messageId: string|number`, `clientMsgId?`, `SocketErrorPayload.clientMsgId?`
  - `src/app/utils/teamChatUtils.ts` + 테스트 13건
  - `TeamChatPanel.tsx` — merge, 실패 표시, toast
  - `TeamSocketContext.tsx` — 채팅 에러를 연결 에러와 분리
- 검증: typecheck 0, lint 0 errors / 경고 4(기준선 4), test:run 56/56. build는 sandbox 차단으로 미실행. 2탭 수동 확인은 미검증
- 옛 백엔드에서 눈에 보이는 변화 1건: `CHAT_NOT_JOINED`가 오면 지금은 화면에 아무것도 안 보이지만, F1 이후로는 토스트가 뜬다(D-019 의도)
- 새로 정해야 하는 UI 7건 → STATUS Q12

## 2026-10-14 — 마이그레이션 실행 (담당자)
- 사용자가 `pnpm db:migrate:up` 실행 완료를 통보함. 확인 쿼리 결과는 아직 받지 못함
- worktree에는 `.env`가 없다(gitignore). 그래서 `.env` 심볼릭 링크를 두거나, 원래 폴더에 마이그레이션 파일을 잠깐 복사해 실행하는 두 가지 방법을 안내했다. 어느 쪽으로 실행했는지는 확인하지 않았다

## 2026-10-14 — f1 F2~F7 + D-022 완료 보고 (프론트, 미커밋)
- 변경: 수정 13 + 신규 6. 신규 파일:
  - `contexts/TeamChatContext.tsx` — layout 수준 상태: 이력, 커서, 배지, 보정
  - `ChatUnreadCount.tsx`, `ChatReadersModal.tsx`, `CountBadge.tsx`
  - `teamChatUtils` 확장
- 수정 요지:
  - `layout.tsx`가 `TeamChatProvider`로 감싼다
  - `TeamSocketContext`: JOIN_TEAM ack로 `roomJoinCount`를 센다. 보정 REST를 room 참가 뒤에 부르기 위해서다. `emitChatRead`를 추가했고, 연결이 끊긴 동안은 emit하지 않는다
  - `TeamChatPanel`은 표시와 스크롤만 맡는다
  - `IconButton`에 `badge` prop 추가
  - `TeamsClient` 카드 배지
  - `teamService`: chat REST 2개, `unreadChatCount`
- f1이 review-front 에이전트로 자체 리뷰를 받아 반영한 결함:
  - 이력을 열기 전에 소켓으로 받은 메시지 때문에 그 뒤 구간이 누락됨
  - 메시지가 0건인 상태에서 재연결하면 빈 구간 채우기를 건너뜀
  - 끊긴 동안 쌓인 emit이 joinTeam보다 먼저 나가 `CHAT_NOT_JOINED`가 남
  - 보드를 떠난 뒤에도 안 보이는 읽음 처리가 계속됨
  - 앞에 붙이기 기준점 문제
- f1 검증: typecheck 0, lint 경고 4(기준선), test:run 74/74
- **메인 재검증**: next-bun worktree에서 sandbox 밖으로 `bun run ci:core` → exit 0
  - test 74/74, `Compiled successfully`
  - lint 경고 4건 전부 `TeamBoard.tsx`의 기존 exhaustive-deps(:511·:679·:777·:794)
- 미검증: 실제 백엔드 연동, 2탭 실시간 숫자 감소, 모바일 백그라운드 복귀, iOS Safari textarea·배지
- 남은 위험(f1):
  - `clientMsgId` 없는 CHAT_* 에러(`chatRead` 거부)는 토스트 없이 `console.warn`만 남긴다
  - `myUnreadCount`는 로컬 근사라 ±1 오차가 날 수 있다. 다음 보정(재연결·탭 복귀) 때 서버 값으로 맞춰진다
  - 패널이 열려 있으면 빈 구간을 채우기 전에 latest까지 읽음으로 보낼 수 있다. 1초 안에 채워지고, Q4 정의상 허용 범위다

## 2026-10-14 — 스키마 확인 (사용자 실행, 읽기 전용 스크립트)
- 스크립트: scratchpad `check-chat-schema.cjs`. `SET TRANSACTION READ ONLY`로 시작하고 끝나면 rollback한다. 메인이 파일을 쓰고 사용자가 `!`로 실행했다. AI는 DB에 접속하지 않았다(CLAUDE.md Never)
- 1~6 전부 PASS:
  - 테이블 코멘트 2, 컬럼 코멘트 11
  - 인덱스 `IDX_TEAM_CHAT_MESSAGES_TEAM(TEAM_ID, MESSAGE_ID)`·`UK_TEAM_CHAT_MESSAGES_CLIENT`·PK 2개 + CLOB용 `SYS_IL*`
  - 메시지 FK = NO ACTION, 커서 FK = CASCADE, `STATUS` CHECK
  - `CONTENT` CLOB, 모든 컬럼 NOT NULL
  - IDENTITY `ALWAYS`·`ORDER_FLAG=Y`·CACHE 20
- 7(마이그레이션 이력): 처음엔 스크립트 오류 `ORA-00904 "NAME"`가 났다. `TYPEORM_MIGRATIONS` 컬럼이 소문자 따옴표 식별자라서였다 → `"name"`으로 고쳐 재실행 → PASS(id 41·42)
- 최종 **7/7 PASS**. 두 테이블 모두 0행

## 2026-10-14 — 리뷰 1라운드 (백엔드)
- 리뷰어 셋을 서로 결과를 공유하지 않게 돌렸다:
  - 메인: review-flow, 프론트 계약 대조
  - Opus 서브에이전트: /review 절차, Oracle 특이점 9개를 typeorm 0.3.28 소스와 오프라인 SQL 생성으로 확인
- 확정 결함 → 수정:
  1. `ChatMessageDto.clientMsgId`가 `@MaxLength(64)`(글자 수)인데 컬럼은 `VARCHAR2(64 BYTE)`다 → `@IsByteLength(1, 64)`
  2. (서브에이전트 F2를 메인이 확정으로 승격) 배지 집계가 실패하면 기존 핵심 API인 `GET /teams` 전체가 500이 된다 → `getUnreadCountsOrEmpty`로 폴백(배지 0 + 경고 로그)
- 테스트 공백 보강: 신규 `test/team-chat.e2e-spec.ts` 11건
  - 새 REST 2개의 401(가드)·403(멤버십)
  - 400(`beforeId`+`afterId`)·422(limit 범위·타입·미허용 필드)
  - `GET /teams` 병합과 폴백
- 변이 확인: chat messages 라우트의 `@UseGuards(JwtAuthGuard)`를 지우면 E2E 3건이 실패한다(원복 확인, 가드 2개 유지)
- 문서: DESIGN §3에 chatRead의 "팀 메시지 존재 확인" 단계 추가
- 메인의 계약 대조 결과: 결함 없음
  - 소켓·REST 타입이 필드 단위로 일치한다
  - `session.user.userId: number`(`next-auth.d.ts:6`)
  - 스로틀 키가 `클래스-핸들러` 단위다(`@nestjs/throttler/dist/throttler.guard.js:149`) → 채팅 조회가 다른 API 한도를 같이 소모하지 않는다
- 후속(수정 안 함):
  - `getUnreadCounts` 실행계획 확인 → 필요하면 커버링 인덱스
  - read-state의 `Promise.all`이 풀 커넥션 2개를 쓴다(`poolMax: 3`)
  - chatRead의 Forbidden이 아닌 오류가 `WS_ERROR`로 나간다
  - `getReadState`가 `IS_ACTIVATED`를 거르지 않는다(지금은 0으로 만드는 경로가 없음)
  - 큰 빈 구간 채우기·빠른 스크롤 때 같은 라우트 스로틀(초당 5회)
  - `deploy.md` 노드 사양 변경은 별도 커밋
  - 커밋 본문에 API 계약 변경 명시
- 검증: `pnpm ci:all`(sandbox 밖) exit 0 — lint 0 errors / 경고 7(기준선), 단위 710/710, E2E **91/91**(+11), build 통과
- 수렴 판정: 수정이 있었으므로 2라운드 진행

## 2026-10-14 — 리뷰 1라운드 (프론트, f1 보고)
- 리뷰어 셋: f1 직접, review-front, Opus 독립. 확정 결함 5건을 모두 수정했다:
  1. 재연결 보정 중 소켓 메시지가 먼저 도착하면 빈 구간을 건너뛰고 못 본 메시지를 읽음 처리한다
  2. read-state 응답이 조회 도중 +1 된 안읽음 수를 덮어쓴다
  3. 응답을 못 받은 전송 메시지가 영구히 '보냄'으로 남는다
  4. 빈 팀에서 이력 조회 중 도착한 첫 메시지가 버려진다
  5. 재연결 후 room ack 전에 emit하면 `CHAT_NOT_JOINED`가 난다
- 메인 교차확인: 5번의 전제(백엔드 joinTeam이 멤버십 DB 조회 뒤에 teamId를 캐싱함)는 `team.gateway.ts` `handleJoinTeam`에서 맞다고 확인했다
- 검증(f1): typecheck 0, lint 경고 4(기준선), test:run 77/77. build는 미실행
- 후속:
  - 이력 첫 조회 실패 시 재시도 버튼 없음
  - 레이트 리밋 토스트 묶기
  - 터치 영역 44px 미만
  - 모달 Esc·포커스
  - aria-label 문구
  - 본인 다른 탭 일부 읽음 시 안읽음 과다
  - 보정 로직 jsdom 테스트 없음
- 수렴 판정: 수정이 있었으므로 2라운드 진행 중

## 2026-10-14 — 리뷰 2라운드 (백엔드) → **수렴**
- Opus 독립 리뷰어(새 컨텍스트): 확정 결함 **0건**. 1라운드 수정 4건(`clientMsgId` 바이트, `GET /teams` 폴백, E2E 11건, DESIGN §3)을 모두 재검증해 OK
- 리뷰어가 후속으로 남긴 "1라운드 수정을 고정하는 테스트 없음" → 신규 `team.gateway.dto.spec.ts` 9건
  - `clientMsgId` 64바이트 경계(한글 22자 거부·`a`×64 통과·×65 거부)
  - `message` 4,000자 경계, 공백만 있는 메시지
  - `ChatReadDto` 정수·양수
  - 변이 확인: `@IsByteLength(1, 64)`를 `@MaxLength(64)`로 되돌리면 1건이 실패한다(원복 확인)
- 검증: `pnpm ci:all`(sandbox 밖) exit 0 — lint 0 errors / 경고 7(기준선), 단위 **719/719**(32 suites), E2E **91/91**, build 통과

## 2026-10-14 — 리뷰 2라운드 (프론트, f1 보고)
- 확정 결함 6건을 모두 수정했다:
  1. 보정 완료를 `connected`로 판정해 ack 전에 gap을 해제한다 → room 참가 세대(`getRoomJoinGeneration`)로 판정
  2. 최신 페이지로 다시 시작할 때 소켓 수신분을 버린다
  3. `clientMsgId`를 사용자 구분 없이 병합한다 → `userId` 조건 추가
  4. '전송 실패' 판정 effect가 수신분을 덮어쓴다 → 함수형 갱신
  5. 보정 REST가 실패하면 gap이 남아 읽음이 막힌다 → 지수 재시도 최대 5회
  6. 팀을 떠날 때 마지막 읽음이 유실된다 → `useLayoutEffect` 정리에서 flush
- 메인 교차확인: 3번의 전제(백엔드 멱등 키 = `(TEAM_ID, USER_ID, CLIENT_MSG_ID)`)는 `UK_TEAM_CHAT_MESSAGES_CLIENT`와 스키마 확인 결과로 맞다
- 검증(f1): typecheck 0, lint 경고 4(기준선), test:run 79/79. 보정 경쟁 조건은 코드 추적으로만 판정(jsdom 없음, 수동 재현 미검증)
- 수렴 판정: 미수렴 → 3라운드(상한) 진행 중
- 메인 관찰: 재연결 보정 로직이 1·2라운드 연속으로 결함을 냈다. 3라운드에서도 수렴하지 않으면 리뷰를 반복하기보다 단순화(재연결 시 최신 페이지 재조회로 목록을 갈아끼우기)를 사용자에게 제안한다

## 2026-10-14 — 리뷰 3라운드 (프론트) → 상한 도달, 미수렴
- 확정 결함 2건 수정:
  - room 참가 전에 시작한 이력 조회의 gap 미표시
  - 실패·미확인 메시지가 맨 아래에 고정되어 시간 역순으로 보임 → anchor 배치
- 추세: 5 → 6 → 2. 모두 빈 구간 채우기 장부의 경계 조건이다
- 사용자에게 선택지 3개를 설명했다 → 단순화 선택(D-024)

## 2026-10-14 — D-024 단순화 + 재리뷰 2라운드 (프론트, f1 보고)
- 구현:
  - `replaceWithLatestPage`(순수 함수 + 테스트 4건)
  - `isSyncPending` 동안 읽음 보류
  - 교체 epoch로 오래된 `loadOlder` 결과 폐기
  - fillGap·gapFrom·hasGap·room 참가 세대 삭제
- 라인 수: TeamChatContext 609 → 591줄(−148/+130, 리뷰 수정 포함), TeamSocketContext −14
- 재리뷰 1R 확정 2건:
  - 이력 로딩 중 보낸 메시지의 anchor가 0
  - 로컬 커서가 앞선 보정 분기에서 배지가 부풂
- 재리뷰 2R 확정 2건:
  - 멤버 재활성화가 접속자 전원의 목록을 교체함 → `replaceList: false`
  - 보정 중 들어온 멤버 이벤트가 오래된 스냅샷에 덮임 → 보정 후 1회 재조회
- 메인 관찰: D-024 이후 결함은 더 이상 빈 구간이 아니라, 커서·멤버 이벤트·anchor처럼 상태 기계의 다른 축에서 나온다. 591줄짜리 상태 기계에 context 테스트(jsdom)가 없어, 리뷰어가 매 라운드 새 타이밍 조합을 찾는 구조다
- 남은 후속 중 오판 성격인 것: 끊긴 동안 50개를 넘게 쌓이면, 저장된 내 메시지도 페이지 밖이라 '전송 실패'로 보인다(위로 스크롤해 로드되면 복구)
- 검증(f1): typecheck 0, lint 경고 4(기준선), test:run 85/85
- **메인 재검증**: next-bun worktree에서 sandbox 밖으로 `bun run ci:core` → exit 0
  - test 85/85, `Compiled successfully`
  - lint 경고 4(기준선)
  - 원래 폴더 `node_modules`는 이 시점에 복구돼 있었다

## 2026-10-14~15 — 실측 (로컬 서버 + Playwright 브라우저 2개)

### 환경
- 원래 폴더의 서버(bun 3500, next-bun 3000)를 종료하고 worktree에서 다시 띄웠다(사용자 지시). shrimp(3010·3510)는 건드리지 않았다
- 백엔드: `REDIS_HOST=localhost REDIS_PORT=6380 pnpm dev`
  - 6379는 mobisell 개발용 Redis(`mobisell-back-redis-dev`)가 쓰고 있어서 키 충돌을 피해 `bun-redis`를 6380으로 띄웠다(사용자 실행)
  - `.env`는 바꾸지 않고 실행 시 환경변수로만 포트를 넘겼다
- 프론트: worktree에서 `bun run dev`
  - 원래 폴더의 `node_modules`가 두 번 비워졌다(다른 세션이 작업 중인 것으로 추정)
  - 링크 대신 worktree에 `bun install --frozen-lockfile`로 따로 설치했다
  - `.env` 링크는 사용자가 만들었다
- 브라우저: scratchpad에 `playwright-core` 1.64.0을 받았다(프로젝트 의존성 아님). Chromium 2개를 프로필 분리로 띄웠다
  - 메인 계정 userId 1: CDP 9224 (9222는 사용자의 다른 Chrome이 쓰고 있었다)
  - 테스트 계정 userId 43: CDP 9223
  - 로그인은 사용자가 했다. 토큰은 브라우저 안에서만 쓰고 출력하지 않았다
- 팀: `/teams/1`(test11, 사용자 지정). 처음 만든 `[테스트] 채팅 실측`(teamId 141)과 1회용 초대 링크가 운영 DB에 남아 있다 → 사용자에게 정리 여부 문의
- ⚠️ 실측 메시지가 운영 DB에 저장됐다(test11 팀, message 1~44 범위). 정리 대상

### 결과
| 항목 | 결과 |
|---|---|
| 비로그인 채팅 REST 2개·`GET /teams` | 401 `AUTH_UNAUTHORIZED` |
| Swagger에 채팅 경로 2개 | 노출됨 |
| 메인 전송 → 테스트 채팅 버튼 배지 | `팀 채팅 (1)`, 아이콘 위 빨간 배지 |
| 메인 화면 내 메시지 옆 "1" | 표시됨 |
| 테스트가 채팅창을 열면 | 메인 화면 "1"이 사라지고 테스트 배지도 해제. 서버 커서 `1:1 43:1` |
| 상대가 채팅창을 열어 둔 상태에서 보내면 | "1"이 0.5초 안에 사라짐(0.5초 간격 3건으로 확인) |
| 읽음 확인 명단 창 | "안 읽음 (1) 권오남 / 읽음 (0) 없음". 보낸 사람은 명단에서 빠짐 |
| 새로고침 후 이력 | 유지 |
| 날짜 구분선 | "2026년 10월 14일 수요일" |
| 이력 API keyset | 최신 2개 `[2,3]`+더 있음, `beforeId` 이전 `[1]`+끝. 400 `TEAM_CHAT_BAD_REQUEST` |
| read-state 타입 | 전부 number |
| 팀 목록 배지 | `GET /teams` `unreadChatCount: 1`, 카드 오른쪽 위 빨간 원 |
| 여러 줄·4,000자 | 줄바꿈 3줄 보존. 4,001자는 입력창 `maxLength`에서 4,000으로 잘림 |
| 도배 방지(22개 연속) | 20개 저장, 2개는 '전송 실패' + 토스트 "메시지를 너무 빠르게 보내고 있습니다…" |
| 오프라인 → 메인 전송 → 온라인 | 오프라인 동안은 안 보이고, 재연결 후 보정으로 표시. 커서 `1:26 43:26` |
| **연속 전송 순서** | ❌ 서버 ID 순서가 보낸 순서와 다름(22개: `1 2 6 3 7 …`, 15개: `… 8 10 9`) → D-025 |

### 결함과 조치
- 원인: 같은 소켓의 이벤트를 동시에 처리하는데, 핸들러보다 먼저 실행되는 `WsJwtGuard`가 이벤트마다 DB를 조회해 거기서 순서가 섞인다
- 1차 시도: 서버 핸들러에 소켓별 큐를 넣고 spec 3건 추가, 변이 확인까지 했다 → 실측에서 여전히 `… 8 10 9`. 가드 단계에서 이미 섞이기 때문이다 → **되돌렸다**(gateway spec 56/56, 가드 diff 없음)
- 결정: 프론트 전송 대기열(한 소켓당 전송 1건만 진행, D-025) → f1에 지시함
- 관찰(결함 아님): 22개를 한꺼번에 보내는 동안 상대 화면의 "1"이 몇 초 늦게 사라졌다. 사람이 치는 속도에서는 0.5초 안에 반영된다
- 후속(프론트): 도배 방지로 실패한 메시지가 연속 전송 묶음의 맨 위(전송 시점 anchor)에 표시된다. 대기열 도입 뒤 다시 확인한다

### 미검증
- 초대 수락에 따른 `memberJoined`와 가입 시 커서 초기화: test11 팀은 두 계정이 이미 멤버라 이 경로를 타지 않는다. 단위·E2E 테스트로만 검증됨
- 멀티 레플리카(로컬은 1개)

## 2026-10-15 — D-025 프론트 전송 대기열 + 재실측
- f1 구현:
  - `src/app/utils/chatOutbox.ts`(`ChatOutbox`, 테스트 8건): 소켓당 1건만 진행. echo, 에러, 10초 타임아웃 중 하나를 받으면 다음 건으로 넘어간다. 끊긴 동안은 대기하고, 진행 중이던 1건은 재전송 없이 미확인 처리한다
  - `emitChatMessage`는 끊김이나 room 참가 전이면 false를 돌려준다
  - 쓰지 않게 된 `getUnconfirmedClientMsgIds` 삭제
  - f1 검증: typecheck 0, lint 경고 4, test:run 91/91
- 재실측:
  - 15건 연속 전송: 서버 ID 순서 = 보낸 순서 = 화면 순서 `1 … 15`, 실패 0 ✅
  - 오프라인에서 3건 입력: 서버 저장 0 → 온라인 복귀 뒤 `1 2 3` 순서로 저장, 실패 0, 메인 화면에 3건 모두 표시 ✅
  - 회귀: 메인이 채팅창을 열어 둔 상태에서 테스트 화면의 "1"이 사라짐 ✅
- 메인 재검증: next-bun worktree에서 sandbox 밖으로 `bun run ci:core` → exit 0
  - test 91/91, build `Compiled successfully`, lint 경고 4(기준선)
- ⚠️ 교훈: dev 서버가 같은 worktree에서 돌고 있는데 `bun run ci:core`(`next build`)를 실행해 `.next`가 덮어써졌고, dev 서버가 500을 냈다 → dev 서버를 재시작해 복구(`/teams`, `/teams/1` 200). dev 서버가 떠 있을 때는 build를 돌리지 않거나 끝난 뒤 dev를 재시작한다
- f1이 남긴 후속:
  - 대기 중인 메시지는 팀 화면을 떠나면 사라진다(끊긴 상태에서 보내고 바로 이탈한 경우). 대기 표시나 이탈 경고 필요
  - room 참가가 계속 실패하면 대기 건이 '전송 중'으로 남는다
  - 10초 타임아웃 뒤 늦게 저장된 건은 echo로 실패 표시가 풀리지만 실패 토스트는 이미 떠 있다
  - 연타하면 저장이 RTT 간격으로 순차 진행된다(말풍선은 즉시 보임)

## 2026-10-15 — 신규 멤버 가입 실측 (teamId 141)
- 가입 전: 메인이 3건 전송(latest 65), 멤버 `1:65`
- 테스트 계정 초대 수락 201 → 커서 `43:65` 즉시 초기화 ✅(D-004·D-012)
  - 메인 화면에서 이전 메시지 옆 "1"이 생기지 않음 ✅
  - 테스트 `GET /teams` 141 `unreadChatCount 0` ✅
  - 테스트가 이전 대화 3건을 열람할 수 있음 ✅
- 메인이 새로 보낸 메시지에 "1" 표시 → `memberJoined`가 메인 화면에 반영됨 ✅(D-018). 테스트가 읽은 뒤 사라짐 ✅
- 측정(3번 질문 근거): 15건 연속 전송이 첫 저장부터 마지막 저장까지 8,736ms, 건당 평균 624ms(264~1,263ms)
  - 로컬 PC → 원격 ADB 왕복이 포함된 값이다(메시지당 DB 왕복 약 5회: 가드 사용자 조회·멤버십·INSERT·커서 등)
  - 운영 서버는 같은 리전이라 이보다 빠를 것으로 예상되지만 미측정이다
- 정리: 실측 메시지는 정리하지 않는다(사용자 결정). 141 팀은 테스트 계정이 멤버인 상태로 남아 있다

## 2026-10-15 — 멀티 레플리카 재현 + 모바일 화면 크기 실측
### 멀티 레플리카 (로컬 2 인스턴스)
- 인스턴스 1: 3500(`pnpm dev`). 인스턴스 2: 3501(`EXPRESS_PORT=3501 REDIS_HOST=localhost REDIS_PORT=6380 node -r tsconfig-paths/register dist/main.js`). 같은 Redis 6380 사용
  - 2번은 watch 없이 dist를 그대로 실행했다(두 watch가 같은 dist를 동시에 쓰는 것을 피하려고)
- socket.io-client 스크립트로 확인했다. 메인 토큰 → 3500, 테스트 토큰 → 3501. 토큰은 브라우저 세션에서 메모리로만 가져왔다
  - 3500에서 보낸 `chatMessage` → 3501의 테스트가 `chatReceived` 수신(messageId 67), 3500 본인 echo 일치 ✅
  - 3501의 `chatRead` → 3500의 메인이 `chatReadUpdated {userId:43, lastReadMessageId:67}` 수신 ✅
  - 반대 방향(3501 → 3500) 메시지 ✅
  - 같은 유저가 3500·3501에 나눠 21건 → `CHAT_RATE_LIMITED` 2건. 레이트 리밋 카운터가 Redis로 인스턴스 간 합산된다 ✅

### 모바일 화면 크기 (Chromium 390×844 — Safari 엔진·실기기 키보드는 미재현)
- 채팅 버튼 배지 `19`가 아이콘 오른쪽 위에 겹쳐 표시된다 ✅
- 7줄 입력 시 textarea 높이 136px에서 멈추고 내부 스크롤이 생긴다 ✅. 가로 넘침 0px ✅
- 채팅창을 열면 맨 아래로 스크롤된다(데스크톱·모바일 모두 남은 거리 0px) ✅
- 온라인 표시: 두 탭이 test11 보드에 있을 때 "2명" ✅. 앞서 본 "1명"은 메인 탭이 다른 화면에 있던 시점이었다
- 오인 정정: "모바일 배지 확인용"이 test11에 없었던 것은 결함이 아니다. 메인 탭이 141 팀 보드에 있는 상태에서 스크립트가 입력해 141 팀에 저장됐다(messageId 88). test11에 다시 보내니 정상 저장(89)

### 커밋 전 확인 불가
- iOS Safari 실기기(엔진·가상 키보드), 운영 환경 응답 속도 → 배포 후 확인

## 2026-10-15 — 커밋 전 마지막 프론트 리뷰 (D-025 포함) + 최종 검증
- f1 리뷰 2라운드(직접 + review-front + Opus 독립). 확정 결함 2건을 수정했다:
  1. 보정 도중 끊긴 건을 보정 시작 전의 스냅샷으로 '실패' 오판 → resync 시작 시 판정 대상(`judgeable`)을 스냅샷해 그 건만 판정
  2. 재시도 타이머가 처음 실패한 요청의 옵션(`replaceList:false`)만 잡아 둔다 → 실패한 요청들의 교체 의도를 합치고, 교체가 끝날 때까지 읽음 보류를 유지
  - 함께 고친 것: 이미 저장이 확인된 메시지에는 타임아웃 실패 표시와 토스트를 띄우지 않는다
  - 2라운드에서도 1건이 나와 엄밀한 기준으로는 미수렴. 두 결함 모두 끊김·재시도가 겹치는 저확률 경계 조건이다
- 신규 후속:
  - 끊긴 채 탭 복귀로 시작한 보정이 저장 중인 건을 오판할 수 있다(상태는 자가 복구, 토스트만 남음)
  - 보정 교체로 확정된 진행 중 건을 outbox가 settle하지 않는다(echo가 유실된 경우에만 다음 건이 최대 10초 대기)
  - 팀 전환 시 read-state 1회 추가 호출
- 회귀 실측(수정 후 코드): 15건 연속 전송 순서 일치 ✅, 오프라인 3건 → 재연결 후 순서대로 저장 ✅, "1" 해제 ✅
- 최종 검증:
  - 프론트: dev 서버를 내린 뒤 `bun run ci:core` exit 0 — test 92/92, build `Compiled successfully`, lint 경고 4(기준선)
  - 백엔드: `pnpm ci:all` exit 0 — lint 0 errors / 경고 7(기준선), 단위 719/719, E2E 91/91, build

## 2026-10-15 — 프론트 리뷰 재개 → 수렴 (사용자: "수정이 있었으니 리뷰 계속")
- A1: 확정 결함 1건 — 교체 재시도 5회를 다 쓴 뒤 read-state만 하는 보정이 성공하면 읽음 보류가 풀려, 교체되지 않은 목록에서 읽음이 처리됐다
  - 조치: 교체를 요청한 보정이 성공하면 교체 의도 플래그를 해제하고, 보류는 "재시도 타이머 없음 그리고 교체 의도 없음"일 때만 푼다
  - 직전 수정 3건(judgeable·교체 의도 합치기·타임아웃 가드)은 review-front·Opus 모두 결함 0건으로 판정
- A2: **확정 결함 0건(수렴)** — f1 직접 리뷰 + review-front + 새 Opus 모두 0건. A1 이후 코드 변경 없음
- 신규 후속(효율·초저확률):
  - 첫 openChat에서 최신 페이지·read-state 중복 조회
  - 끊긴 동안 50건을 넘으면 오래된 대기 메시지가 목록 맨 위로 감
  - 스냅샷 사이에 늦게 수신된 남의 메시지로 안읽음 −1(다음 보정에서 바로잡힘)
  - REST 5회 연속 실패 + 패널을 열어 둔 상태면 자동 회복 없음(닫았다 열면 풀림)
  - 세션 만료 직후 재시도에서 교체 의도가 사라짐(재참가로 회복)
- 최종 검증:
  - 프론트: dev를 내린 상태에서 `bun run ci:core` exit 0 — test 92/92, build `Compiled successfully`, lint 경고 4(기준선)
  - 회귀 실측(dev 재기동 후): 15건 연속 전송 순서 일치 ✅, 오프라인 3건 → 재연결 후 순서대로 저장 ✅
  - 회귀 실측(처음부터 다시): 메인 전송 → "1"과 `팀 채팅 (1)` 표시 → 테스트가 열면 둘 다 해제, 커서 `1:127 43:127` ✅
