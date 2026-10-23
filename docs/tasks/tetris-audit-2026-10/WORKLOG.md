# 테트리스 백·프 전수조사 — 작업 기록

## 2026-10-23 — 착수 · 범위 · 중복 유저 1차 확인

### 조사 범위 (백)
- 대전: `src/modules/tetris-battle/**` (room.service 1388줄 · match.store 608 · gateway 468 · result.service 380 · browse · verify · ws.guard · ws filter · events · dto · battle-engine/**) · `src/entities/TetrisBattle{Match,Player,Replay}.ts` · `migrations/179259142{3,4,5}000-*`
- 싱글: `src/modules/games/**` 중 테트리스 경로(tetris-engine/** · tetris-game-engine · game-engine.registry · game-session.service · games.service/controller/dto · ranking-period · player-name-policy)
- 테스트: 위 spec · `test/tetris-battle-*.e2e-spec.ts`(5개)

### 중복 유저 — 1차 코드 확인 (판정 전 가설)
입장 정체성은 **소켓·토큰** 기준이고 **userId 기준 중복 검사가 없다**.
- `tetris-battle-room.service.ts:491-510` — 토큰이 없고 이 소켓이 멤버가 아니면 무조건 새 `p{seq}` 추가. `newPlayer`(`:1220-1238`)는 `userId: who.userId`를 저장만 한다
- `:445` `isSameSocket`도 socketId 비교뿐

| # | 가설 | 근거 | 판정 |
|---|---|---|---|
| H1 | 같은 로그인 유저가 다른 탭·기기로 같은 방에 두 자리 | `:491-510` userId 검사 없음 | ⏳ S2 |
| H2 | 새로고침·초대 링크 재진입 등 **토큰 없이** 재입장 → 새 자리 + 이전 자리는 유령으로 남음(`connected=true`면 liveness 프로브 `:1150-1180` 전까지, `false`면 `DISCONNECT_GRACE_MS`까지 `:1202-1210`) → 같은 이름 2개·정원 소모 | 위 + 프론트 토큰 보관 방식 미확인 | ⏳ S2 · 프 확인 |
| H3 | 프론트가 join을 두 번 보냄(더블클릭·StrictMode 이중 effect·재연결 핸들러 재송신) | 같은 소켓이면 `:491` self 갈래로 흡수, **소켓이 바뀐 재송신**이면 H2와 같음 | ⏳ 프 확인 |
| H4 | 한 매치에 같은 userId 2명 → 결과 저장(`TetrisBattlePlayer`) 제약 위반·랭킹/기록 왜곡 | 미확인 | ⏳ S1 |

## 2026-10-23 — 프론트 중간보고(Q-a~Q-e) · 서버 답(B-1~B-3) · 게스트 중복

### 프론트 기준선 (`next-bun-40`, worktree `next-bun/.claude/worktrees/tetris-audit`, 브랜치 `fix-onam-tetris-audit`, base `be85e76`)
- `pnpm ci:core` 통과. lint 0 · typecheck 통과 · vitest 77 files / 744 tests(3 skipped) · build 성공. 경고는 "workspace root inferred" 1종(worktree lockfile 2개 때문, 코드 무관)

### 프론트 답 요지 (근거는 프론트 보고의 파일:라인)
- Q-a: 토큰은 **sessionStorage**에 `tetris:battle:${code}` 키로 저장(`battle-ui/lib/roomSession.ts:6,24`). 새로고침과 같은 탭 재진입에는 토큰이 실린다. **새 탭·초대 링크로 연 새 탭에는 토큰이 없다** → 새 자리. 탭 복제는 토큰을 복사한다
- Q-b **[H] 프론트 경로 확인**: 자동 재입장(`BattleRoom.tsx:60`)이 INVALID_PLAYER_TOKEN이 아닌 이유(TIMEOUT·DISCONNECTED)로 실패하면 폼이 뜬다(:62). 이때 수동 입장(`:73-74`)은 **저장된 토큰을 싣지 않는다** → 새 소켓이면 새 자리 + 유령. `autoTriedRef`(:53) 때문에 자동 재시도도 다시 일어나지 않는다. BattleRoom 테스트 없음
- Q-b 기타: sessionStorage가 막힌 환경은 재연결 실패 시 새 자리 [L]. 더블클릭·StrictMode·connect 재송신은 막혀 있음(재송신은 토큰을 실은 join)
- Q-c: 생성 후 다시 join하지 않음(create ack로 바로 입장)
- Q-d: 두 탭을 막는 장치 없음. 프론트에는 userId 개념이 없음(`types/tetrisBattleSocket.ts:91-99`)
- Q-e: 목록 key는 playerId, room 갱신은 교체(누적 없음). 화면의 중복 = 서버 players 안의 실제 두 자리. [L] `roomRef`가 렌더 때만 갱신돼 입장 ack 직후의 ROOM_STATE를 버릴 수 있음

### 서버 답 (메인 확인)
- B-1 같은 토큰 + 다른 소켓: 새 소켓이 자리를 넘겨받음(`room.service.ts:474-488`). 이전 소켓은 채널에서만 빠지고(`gateway.ts:405-406`) **알림이 없다** → 이전 탭은 화면이 멈추고, 이후 이벤트는 NOT_IN_ROOM
- B-2 같은 소켓 + 같은 토큰 반복: 멱등, 토큰 회전 없음(`:487`)
- B-3 같은 소켓 + 토큰 없음: 기존 자리를 돌려주고 토큰만 재발급(`:491-498`)

### 게스트(비로그인) 중복 — 사용자 추가 질문
- 서버가 아는 게스트 정체성은 `socketId`·`ip`뿐이다(`SocketIdentity` `:191-196`, `gateway.ts:394`). userId 기반 판정(H1 수정안)은 게스트에 적용할 수 없다
- IP 기준 판정은 쓸 수 없다. 같은 와이파이·통신사 CGNAT 뒤의 서로 다른 사람(친구 대전의 주 사용 형태)을 같은 사람으로 오판한다
- 검토 안 G-A: 토큰을 **localStorage**로 옮긴다. 같은 브라우저의 새 탭·초대 링크·재시작이 토큰 재연결로 같은 자리를 넘겨받는다. 로그인 여부와 무관하다. 프론트에 G-1~G-3 평가를 질의(두 탭 동시 활성 시 서로 넘겨받는 반복 · 이전 소켓 알림 필요 여부 · 기권 D-020·리플레이 토큰 L7 상호작용)
- 남는 한계(수용 후보): 게스트가 **다른 브라우저·시크릿 창·다른 기기**로 들어오면 서버로서는 다른 사람과 구별할 수 없다

## 2026-10-23 — 백엔드 S1 조사 결과 (서브에이전트 2개 + 메인 재확인)

- 범위 A: 방·매치·게이트웨이. room.service·match.store·gateway·guard·constants는 전부 읽음. result는 일부만 읽음
- 범위 B: 엔진·결과·싱글. `pnpm test -- --testPathPatterns 'tetris|games'` → 56 suite / 1313 통과
- 표시 규칙: **메인 재확인** = 메인이 원본 코드로 직접 다시 본 항목. 나머지는 서브에이전트 보고값이고 S2b 전에 확인한다
- 범위 A 에이전트는 worktree에 `node_modules`가 없어 테스트를 돌리지 못했다고 보고했다(범위 B는 실행 성공). S3 전에 worktree 의존성을 확인한다

### 중복 유저 판정
| # | 판정 | 요지 |
|---|---|---|
| H1 같은 userId, 소켓 2개 | **재현 가능(코드 추적)** · 스펙 없음 | `:491-510` 새 자리 추가. 같은 사람이 정원까지 채울 수 있다. 경기에서는 자기끼리 가비지를 주고받거나 한쪽 topOut으로 승리할 수 있다 |
| H2 토큰 없이 재입장 | **재현 가능(타이밍)** | 이전 자리 유지 시간: 정상 끊김은 10초(`DISCONNECT_GRACE_MS`). 비정상 끊김은 핑 만료(기본 약 45초, 설정 미확인) + 프로브(15초 게이트) + 10초로 최악 약 55초. 그동안 정원을 차지한다 → 2/2 방에서 본인이 ROOM_FULL. 방장이 유령 자리에 남을 수 있다(이양은 removePlayer 때만) |
| H3 같은 소켓 동시 join·create+join | **불가** · 스펙 있음 | 게이트웨이가 소켓별 큐로 직렬화(`gateway.ts:369-380`) |
| H4 방 A 소켓이 방 B로 join | 대체로 안전 · 스펙 있음 | 사전 검증 통과 후 B 커밋이 실패하면 어느 방에도 없게 된다(주석 `:413`이 수용한 창) |
| 결과 저장(같은 userId 2명) | 실패 없음, 2행 저장 | PK `(MATCH_ID, PLAYER_ID)`이고 USER_ID 유니크가 없다. 현재 USER_ID를 집계하는 소비처 없음(**메인 재확인**: `TetrisBattlePlayer` 참조는 database.config·browse·result·module뿐). 향후 전적 집계를 도입하면 이중 집계된다 |
| 게스트 | 서버 판정 불가 | 앞 절 참조. 토큰 localStorage 안(G-A) |

### 지적 표 — 백엔드 (BE-xx, 심각도 H/M/L)
| # | 심각도 | 분류 | 위치 | 요지 | 수정안 |
|---|---|---|---|---|---|
| BE-01 | H | bug | room.service `:491-510`, `:458-466` | H1·H2 — userId 중복 미검사 | 로그인 유저는 CAS 안에서 같은 userId 자리를 **넘겨받는다**(토큰 재연결 갈래와 같게. replacedSocketId·rotatedInMatches 포함). 사전 검증도 isSameSocket처럼 취급 · 보강: startMatch에서 userId 중복 거부 |
| BE-02 | M | bug | gateway `:405-406` | 자리를 넘겨받힌 이전 소켓에 알림이 없다 → 이전 탭 화면이 멈춘다. BE-01·G-A를 하면 빈도가 늘어난다 | 이전 소켓에 `replaced` 이벤트 전송(프론트 G-2 평가에 따름) |
| BE-03 | M | bug(누수) | room.service `:101-105`, scanLobby `:330-354` | 로비 ZSET은 쓰기마다 EXPIRE가 갱신되고, 사라진 방은 상위 200개(`LOBBY_SCAN_LIMIT`) 안에서만 ZREM한다. 200위 밖으로 밀린 코드는 남는다(**메인 재확인**: Lua·scanLobby 코드) | `ZREMRANGEBYSCORE`로 오래된 점수 정리(점수 의미 확인 후) |
| BE-04 | M | bug | room.service `:426-429` recoverMatch | afterCommit(채널 입장) 뒤 recoverMatch가 throw하면 커밋은 됐는데 오류 ack가 간다 | try/catch로 감싸 rejoin 없이 반환 |
| BE-05 | M | bug | room.service `:835-857` finishMatch | 방 CAS가 실패하면 삼켜서 매치는 ENDED인데 방은 PLAYING으로 남는다. 다음 활동까지 결과 화면이 안 온다 | 짧은 재시도 또는 일반 경로에서 repairEndedMatch |
| BE-06 | M | bug(신뢰성) | result.service `:264-305` | DB 저장은 전원 제출 또는 "마감 뒤 첫 제출·getMatch" 때만 일어난다. 스위퍼가 없다(**메인 재확인**: finalize 호출처는 result.service `:118,:153,:161`뿐). 아무도 안 부르고 Redis TTL 2h가 지나면 경기가 유실된다. 설계(D-0xx "마감 60초 후 1회")의 지연 트리거 한계다 | TASK_SLOT 가드 스위퍼 또는 프론트 결과 화면 폴링 확인(프 질의) |
| BE-07 | M | perf | verify.ts `:71-84` | 시뮬레이션(`:72`)이 frames 상한·topout frame 검사(`:81-84`)보다 먼저 돈다(**메인 재확인**). 측정: 골든 0.2~2.6ms, 최악 추정 90~220ms(외삽, 미실측) | 값싼 검사를 시뮬레이션 앞으로 옮긴다(판정 결과 동일) |
| BE-08 | M | perf | result.service `:122-149` · games.service `:177-185` | 같은 제출을 동시에 N개 보내면 claim(HSETNX)·GETDEL 전에 N번 시뮬레이션한다. 닫힘·저장 완료 확인도 시뮬레이션 뒤다 | 시뮬레이션 전 claim/NX 락, 닫힘 선검사 |
| BE-09 | M | perf | gateway `:443-456` · room `:287-296` | 방 변경마다 로비 전체 방송: 방 200개 HGET + JSON.parse + 상위 50개 reconcile. `listRooms` 레이트리밋 없음 | 로비 방송 디바운스·짧은 캐시, 방송 경로에서 reconcile 생략 |
| BE-10 | M | perf | room `:697`, `:1039` | lock 핫패스가 방 HGETALL + 전체 JSON.parse + 매치 EVAL로 2왕복 | 측정 후 결정(조기 최적화 금지). `HGET json`부터 |
| BE-11 | M | 정책 | result.service `:326` | 1명의 INVALID(seed 오류·클라이언트 버그 포함)로 경기 전체가 DISPUTED가 되어 모든 참가자의 기록이 숨겨진다 — **설계 결정**(tetris-battle DESIGN §17 `:219`)이라 결함이 아니다. 그리핑 여지는 있다 | 사용자 정책 질문(Q2) |
| BE-12 | L | bug(경계) | result.dto `:39-45` | das·arr에 범위 검증 없음 → 422가 아니라 INVALID 저장 → BE-11 경로로 DISPUTED | DTO에 Min/Max |
| BE-13 | L | bug | result.service `:294` | FK 위반을 `message.includes('ORA-02291')`로 판정. 영구 실패 시 백오프가 없다 | `errorNum === 2291` + 재시도 상한 |
| BE-14 | L | bug | match.store `:149-182` | 가비지 상한에 걸리면 cursor만 진행되고 공격이 조용히 사라진다(드문 경로) | 상한 판정을 cursor 갱신보다 앞에 |
| BE-15 | L | bug | ws.guard `:43-50` | userId를 첫 이벤트 때 확정하고 다시 보지 않는다. 연결 중 로그인·로그아웃하면 정체성이 낡는다 | rejoin 때 userId 갱신 |
| BE-16 | L | bug | result.service `:308`, `:352` | 제출 JWT의 userId가 입장 때 정체성을 덮어쓴다 | 입장 정체성 우선, 불일치는 무시 |
| BE-17 | L | 일관성 | room `:574`, `:675`, `:990`, `:1086` | 상태×이벤트 에러코드 불일치(RESULT에서 setReady가 MATCH_ALREADY_STARTED 등) | 상태×이벤트 표로 정리(API 계약 — 프론트 확인 필요) |
| BE-18 | L | 정합 | match.store `:62-96` | 시계 혼재: 앱 시계(endedAt·discAt)와 Redis TIME. 레플리카 간 수백 ms 차이 | 의도된 설계. 기록만 |
| BE-19 | M | refactor | room.service 전체(1388줄) | 로비·방·매치·레이트리밋·비밀번호·생존 확인이 한 파일에 있다. 클로저 narrowing 우회 `as` 캐스트(`:471,:515,:543,:602` 등) · KO 처리 패턴 5곳 중복(`:555,:704,:758,:914,:958`) · `requireMatchMember`의 반환 room 미사용 | 동작 변경 없이 단계 분리(비밀번호·레이트리밋·생존 확인 클래스 분리, `applyKnockOut` 헬퍼) |
| BE-20 | L | refactor | result.service `:127,:200` · games/result gzip 저장 중복 | 불필요한 `as` 캐스트, gzip+JSON 헬퍼 중복 | 서비스 계층 헬퍼만 공유(엔진 사본은 의도된 중복이라 유지) |
| BE-21 | L | 한계 | verify.ts 전체 | 서버 기록(sentLog·garbage 도착 frame 등)이 클라이언트 보고값이라, 보고와 리플레이를 함께 위조하면 통과한다. pieces·maxCombo는 서버 통계와 대조하지 않는다 | 대조 추가 또는 한계 문서화 |
- 제외: 비밀번호 오답 미복원(의도) · ABA(확률 0) · `mutateRoom` JSON 직렬화 반복(방 ≤4인, 영향 미미)

## 2026-10-23 — 프론트 G 평가(localStorage 안) · 메인 통합안 초안

### 프론트 평가 요지 (`next-bun-40`, 근거는 프론트 보고의 파일:라인)
- G-1: 저장소 접근은 `roomSession.ts` 3곳(:12/:24/:32)에 모여 있다. 호출부는 Context·BattleRoom·RoomStage. localStorage에는 TTL이 없어 키가 쌓인다. 자동 입장이 ROOM_NOT_FOUND를 받으면 키를 지우지 않는다(현재도 그렇다. 자가 치유됨)
- G-2: 서로 뺏는 무한 반복은 없다(넘겨받힌 소켓은 연결을 유지한 채 채널에서만 빠짐). 다만 재연결이 일어날 때마다 한 번씩 서로 뺏는다. 넘겨받힌 탭은 화면이 멈춘 것으로 보인다
- **G-3① [H]**: 경기 중 같은 브라우저 새 탭에서 초대 링크를 열면, 새 탭이 자리를 넘겨받은 뒤 "모르는 매치"로 보고 **즉시 기권**한다(`useBattleMatch.ts:441-448`, D-020). **지금도 탭 복제로 재현된다**(sessionStorage가 복사됨) → 기존 결함 FE 지적으로 등재
- G-3②: 리플레이 제출 토큰을 제출 시점에 저장소에서 읽는다(`RoomStage.tsx:40`) → 공유 저장소에서는 다른 탭이 바꾸거나 지운다 → 메모리 고정 필요
- G-3③: 공용 PC에서 토큰이 브라우저를 다시 시작해도 남는다(비밀번호 방 재입장) [L] → TTL로 완화
- G-3④: 넘겨받힌 탭이 뒤로가기하면 공유 토큰을 지운다 → compare-and-delete
- 프론트 권장 묶음: ① localStorage + savedAt TTL ② compare-and-delete ③ 제출 토큰 메모리 고정 ④ BroadcastChannel 보유 확인 ⑤ 서버 `sessionReplaced` 통지

### 메인 통합안 초안 (사용자 결정 Q1 대상, 미확정)
- 관찰: BE-01(로그인 userId 넘겨받기)도 G-3①과 **같은 기권 회귀**를 낳는다. 다른 기기에서도 일어나서 BroadcastChannel로는 막지 못한다
- 안 S(서버 게이트): "넘겨받기"(토큰 재연결 + 로그인 userId 일치)의 대상 자리가 **지금 연결된 소켓**을 갖고 있으면 서버가 바로 넘기지 않고 `SEAT_IN_USE`(가칭)로 응답한다. 클라이언트가 확인을 받은 뒤 `takeover: true`로 다시 보내면 넘겨받고, 이전 소켓에 `sessionReplaced`를 보낸다
  - 같은 탭의 재연결(Context connect 핸들러)과 새로고침(탭 sessionStorage에 "이 탭이 보유" 표시)은 `takeover: true`를 자동으로 싣는다 → 정상 재연결 UX는 그대로
  - 새 탭·초대 링크·다른 기기 → 확인 문구("다른 곳에서 참여 중이에요. 여기서 계속할까요? 경기 중이면 그쪽 판은 기권돼요")
  - 게스트: 토큰 localStorage(①②③)로 같은 브라우저를 덮고, 같은 게이트를 탄다. 다른 브라우저·기기는 구별 불가(수용)
  - BroadcastChannel(④)은 안 S가 있으면 선택 사항이 된다(서버가 기기 간에도 판정)
- API 계약 변경: join 요청 필드 `takeover`, 에러코드 `SEAT_IN_USE`, 서버→클라이언트 이벤트 `sessionReplaced` 추가 → 커밋 본문에 명시, 프론트 동시 배포 필요

## 2026-10-23 — 프론트 S1 최종보고(FE-01~24) · 안 S′ · 백 답(B-a~B-g)

- 기준: 프 worktree `next-bun/.claude/worktrees/tetris-audit` @ `be85e76`. 경로 약어 T=`src/app/games/tetris/`, BU=`T/battle-ui/`
- ✔ = 프론트 메인 세션이 원본 라인을 직접 재확인한 항목. 나머지는 프론트 서브에이전트 보고값

### 지적 표 — 프론트 (FE-xx)
| # | 심각도 | 분류 | 위치 | 요지 | 수정안 |
|---|---|---|---|---|---|
| FE-01 | H | 버그(중복) | BU/components/BattleRoom.tsx:73-74 | 자동 재입장이 TIMEOUT·DISCONNECTED로 실패한 뒤 폼에서 입장하면 토큰을 싣지 않는다 → 새 자리 + 유령. autoTriedRef(:53)로 자동 재시도도 없다 | 저장된 토큰을 싣는다 · 일시 오류는 자동 재시도 |
| FE-02 | M | 버그 | BU/hooks/useBattleMatch.ts:441-445 | 탭 복제(sessionStorage 복사) → 복제 탭이 자리를 넘겨받고, 모르는 매치라 기권 → 원래 탭의 판이 끝나고 안내도 없다 | 안 S/S′ |
| FE-03 | M | 버그 | BU/hooks/useBattleMatch.ts:157-171 ✔ | lock 거절을 일시 오류까지 영구 폐기한다 | 일시 오류(SERVICE_UNAVAILABLE·TIMEOUT)만 재전송(B-a) |
| FE-04 | M | 버그 | BU/hooks/useBattleMatch.ts:472-479 ✔ | rejoin.opponents[].alive 미반영 → 탈락한 상대가 생존으로 보이고 targetId가 죽은 상대를 가리킬 수 있다 | alive 반영 + targetId 재설정 |
| FE-05 | M | 성능·버그 | BU/hooks/useBattlePlay.ts:27, :186-190 ✔ | 백그라운드에서 복귀하면 rAF 1회에 최대 600틱 → lock·사운드·연출이 몰린다. 서버 LOCK_TOO_FAST 거절 위험(B-a) | catch-up 중 연출 끄기 · 송신 묶기 |
| FE-06 | M | 성능 | BU/components/BattleMatchViewer.tsx:76 ✔ (싱글 ReplayPlayer:180 동일) | 재생 중 뷰어 전체가 60Hz로 재렌더 | memo + frame state 스로틀 |
| FE-07 | M | 드리프트 | T/battle-engine/replay.ts:73 ✔ · constants.ts:11 | 대전 리플레이 헤더에 싱글 ENGINE_VERSION이 없다 → 싱글 규칙이 바뀌어도 통과한다. 백·프 사본 비교 장치 없음(B-f: 백에도 없음) | 헤더 버전 연동(계약 변경) · CI 비교 |
| FE-08 | M | 버그 | src/services/gameService.ts:141·165·225 ✔ | fetch에 timeout·signal이 없다 → 망이 멈추면 세션 발급·제출·조회가 영구 대기 | AbortSignal.timeout |
| FE-09 | M | 버그 | T/hooks/useTetrisPlay.ts:220 ✔ (대전 useBattlePlay 동일) | 키를 누른 채 일시정지 → 재개 후 repeat keydown 무시 | held에 없으면 press |
| FE-10 | M | 접근성 | T/components/TouchControls.tsx:67-70 ✔ | 회전·홀드·하드드롭이 키보드·스크린리더 click으로 동작하지 않는다 | onClick(e.detail===0) 병행 |
| FE-11 | M | 성능 | T/hooks/useTetrisPlay.ts:196 · ReplayPlayer:185 · TetrisCanvas:71-82 | 정지 상태에서도 매 rAF 전체 재그리기 | dirty 플래그 |
| FE-12 | L | 버그 | BU/contexts/BattleSocketContext.tsx:115, :247 | 입장 ack 직후 ROOM_STATE가 버려질 수 있다 | enterRoom에서 roomRef 즉시 대입 |
| FE-13 | L | 버그 | BU/contexts/BattleSocketContext.tsx:326 | ROOM_NOT_FOUND 때 저장 키를 지우지 않는다 | 함께 삭제 |
| FE-14 | L | 버그 | BU/contexts/BattleSocketContext.tsx:199-201 | 저장소가 막힌 환경에서 재연결마다 방에서 튕긴다 | 메모리 보관 병행 |
| FE-15 | L | 버그 | BU/components/EmoteBar.tsx:14-19 ✔ | 이모트 쿨다운이 언마운트로 초기화 · 타이머 미정리 | 상태를 부모로 |
| FE-16 | L | 버그 | BU/components/EmoteBubble.tsx:10-15 ✔ | 마운트할 때 지난 이모트를 다시 띄운다 | 마운트 이후 key만 |
| FE-17 | L→M | 경합 | BU/hooks/useBattleMatch.ts:505-507 | RESULT가 matchEnded보다 먼저 오면 "결과를 받지 못했어요"가 뜬다 — **서버에서 실제로 일어나는 순서**(BE-22) | 서버 순서 통일 + 짧은 대기 |
| FE-18 | L | 경합 | BU/hooks/useBattleMatch.ts:489-492 | 카운트다운 타이머가 상태를 다시 확인하지 않는다(B-d: 가능성 낮음) | 발화 시 status ref 확인 |
| FE-19 | L | 성능 | BU/components/MiniBoard.tsx:41-42 · MatchScreen.tsx:94 | 갱신마다 캔버스 재할당 · memo 없음 | 크기 변경 때만 · memo |
| FE-20 | L | 버그 | T/hooks/useTetrisPlay.ts:97-102 ✔ | "처음부터"를 누르면 준비 오버레이 뒤에 이전 판이 남는다 | reset에서 비우기 |
| FE-21 | L | 버그 | T/(fullscreen)/play/TetrisPlay.tsx:84-100 | 세션 요청 연타 시 늦은 응답이 최신 세션을 덮어쓴다 | requestIdRef |
| FE-22 | L | 기타 | 미재확인 묶음 9건 | sound voice throttle · dpr 미감지 · storage clear · 재생 슬라이더 충돌 · 미방문 구간 동기 시뮬 · sessionQuality 고착 · 트랙 순차 조회 · 기록 링크 조건 · sprite 문자열 키 | 항목별 한 줄 |
| FE-23 | L | 리팩토링 | rAF 고정 스텝 루프 4벌 · 입력 처리 2벌 | catch-up 상한이 100/100/10000/100으로 제각각 | useFixedStepLoop·inputController 추출 |
| FE-24 | L | 리팩토링 | BU/hooks/useBattleMatch.ts 514줄 · 상수·규칙 중복 | 한 훅에 역할이 몰려 있다 | useMatchOutbox·useReplaySubmit 분리 · 상수 import |
- 문제없음 확인: 소켓 on/off 쌍, 언마운트 타이머 정리, cancelled 가드, 싱글 rAF·키·blur·visibility·ResizeObserver·AudioContext 정리, 점수 제출 가드

### 안 S 평가 → 안 S′ (프론트 제안)
- S-1: "이 탭이 보유" 표시는 **탭 복제가 함께 복사**해서 FE-02가 남는다. 새로고침은 표시 대신 SEAT_IN_USE를 받으면 1.5~2초 뒤 한 번 더 재시도한다(이전 소켓의 disconnect 처리 대기). 같은 탭 재연결은 메모리 기준이라 안전하다
- S-2: 확인 후 넘겨받아도 **이어서 플레이할 수 없다** — 리플레이가 frame 0부터의 전체 입력을 요구하고, 그 입력은 이전 탭 메모리에만 있다. 넘겨받으면 기권이 맞다
- **안 S′**: 연결 중인 자리 + 방 PLAYING이면 넘겨받기를 거부(SEAT_IN_USE, takeover 수단 없음). WAITING·RESULT에서는 바로 넘겨받고 이전 소켓에 `sessionReplaced`. takeover 플래그·확인 UI·보유 표시가 필요 없다. 단점: 경기 중 폰이 꺼졌는데 소켓이 살아 있으면 최대 약 45초(B-e) 동안 다른 기기로 못 들어온다(그 판은 어차피 끊김 KO)
- 프론트 변경 규모(S′): 소켓 타입 · battleErrors · Context · BattleRoom · roomSession(localStorage+TTL+compare-and-delete) · RoomStage(제출 토큰 고정). 프로덕션 약 100~170줄 + 테스트

### 백 답 B-a~B-g (메인이 원본 확인)
- B-a: lock 레이트리밋 없음(`constants.ts:37-52`). 같은 seq = dup 성공, 역순 = INVALID_PAYLOAD 영구 거절, 서버 시계 대비 빠르면 LOCK_TOO_FAST(`match.store.ts:134-148`)
- B-b: rejoin.opponents = `{playerId, board, pending, alive}`(`events.ts:194`). 순위는 PLAYER_KO 이벤트로
- B-c: lock·topOut·leave 경로는 KO→MATCH_ENDED→ROOM_STATE. 생존 확인·lock 실패 경로(`notifyMatch` `room.service.ts:977-985`)는 **ROOM_STATE가 먼저** → BE-22
- B-d: 서버에 카운트다운 상태가 없다. PLAYING→WAITING 직행 없음
- B-e: 핑 옵션 미지정 → 기본 25s+20s
- B-f: 엔진 사본 바이트 비교 장치 없음 → BE-23
- B-g: 서버가 승자로 확정한 생존자의 리플레이에 로컬 탑아웃이 있으면 `SURVIVOR_TOPPED_OUT` INVALID(`verify.ts:81-82`) → 경기 전체 DISPUTED(BE-11). 프론트에 리플레이가 matchEnded 시점에서 잘리는지 질의 중 → BE-24(판정 대기)

### 추가 지적 — 백엔드
| # | 심각도 | 분류 | 위치 | 요지 | 수정안 |
|---|---|---|---|---|---|
| BE-22 | M | 버그 | room.service `:977-985` notifyMatch | 종료 방송 순서가 경로마다 다르다(ROOM_STATE(RESULT)가 MATCH_ENDED보다 먼저) → FE-17 | KO·MATCH_ENDED 먼저 보내도록 순서 통일 |
| BE-23 | M | 드리프트 | (장치 없음) | 엔진 사본 백·프 동기화 검사가 없다 | 백·프 공용 golden 해시를 CI에서 비교(FE-07과 묶음) |
| BE-24 | H? | 버그(판정 대기) | verify.ts `:81-83` | 생존자의 늦은 로컬 탑아웃·초과 frames → INVALID → DISPUTED | 프론트 답에 따라 클라이언트 절단 또는 서버가 endedAt 이후 무시 |

## 2026-10-23 — 사용자 제보 시나리오 분석 (탭 닫고 공유 링크로 재입장)
- 제보 원문: "1 원래 하던 탭에서 이어가기 버튼으로 이어감 / 2 모두가 다른판을 팠음 / 3 이 탭을 끔 / 4 공유된 링크로 다시 들어감"
- 해석(프론트 R-1~R-5 확인 대기): 경기 후 방 A에 남음 → 다른 사람은 모두 A를 떠나 새 방을 만듦 → U 혼자 A의 방장 → 탭을 닫음 → 새 탭에서 A 초대 링크로 들어감
- 서버 추적(메인, 원본 확인):
  - 3단계: 탭을 닫으면 `markDisconnected`(`room.service.ts:585-609`)가 U 자리를 `connected=false`로 바꾼다. 자리와 방장은 유지된다
  - 4단계: 새 탭은 sessionStorage가 비어 있어 토큰이 없다 → 폼 → 토큰 없는 join
    - **10초 안**: 사전 검증의 `pruneDisconnected` 뒤에도 유령 U가 남아 정원 검사를 통과한다 → 새 자리가 추가된다(`:507-510`) → **목록에 U가 두 번**(하나는 "연결 끊김"). 방장은 유령 쪽이라 시작할 수 없다(`:798`). 10초 뒤 다음 변경 때 유령이 빠지고 방장이 넘어온다
    - **10초 뒤**: 사전 검증은 통과하지만, `mutateRoom`이 먼저 정리하면 인원이 0이 되어 방을 삭제하고 ROOM_NOT_FOUND를 낸다(`:1084-1089`). 사용자는 방금 있던 방이 "없다"는 안내를 받는다
  - D-003 적용 후: 4단계 새 탭에 localStorage 토큰이 있어 토큰 재연결이 된다 → WAITING이면 같은 자리를 넘겨받는다(중복 없음, 방장 유지). 로그인 유저는 토큰이 없어도 userId로 넘겨받는다. 단, 10초 유예가 지난 뒤에는 자리가 이미 정리되어 방이 사라진다(현재 설계 그대로 — 혼자 남은 방을 닫으면 10초 뒤 삭제)

### 프론트 R-1~R-5 답 (`next-bun-40`, 기준 `be85e76`)
- **"이어가기" 문구는 프론트에 없다**(src 전체 grep 0건). 후보:
  - ① "재대결"(결과 화면, 방장만, REMATCH)
  - ② 경기 중 나가기 확인창의 "계속하기"(이벤트 없음)
  - ③ "연결 실패 · 다시 연결" 배지(저장된 토큰으로 JOIN → 같은 자리)
- 공유 링크 후보:
  - ① 방 초대 링크: 새 탭이면 토큰 없음 → 새 자리
  - ② 경기 기록 링크(`MatchRecordLinks.tsx:37`, **새 탭**으로 열림): 소켓이 없다. 이 화면의 "대전 로비로"를 거쳐 방에 들어가면 토큰이 없어 새 자리
- R-4: 3→4 경로로 새 자리가 생기는 것이 맞다. 이전 자리는 흐린 "연결 끊김" 카드로 보이고, 서버가 언로드를 늦게 받았으면(모바일 Safari 등) 최대 약 45초 동안 "연결된" 카드로 나란히 보인다. 방장 표시도 이전 카드에 남는다
- R-5 대안 경로: **"기록 보기" 새 탭 → 로비 → 방 입장** → 원래 탭과 새 탭 두 자리가 **모두 연결됨**으로 보인다(제보 단계와 가장 잘 맞는 대안)
- 판정: 어느 해석이든 원인은 같다 — 새 탭에 토큰이 없어 새 자리가 생기고, 서버는 userId·브라우저 기준 중복을 보지 않는다 → **D-003(P1)으로 모두 덮인다**(WAITING·RESULT에서는 새 탭이 넘겨받고 이전 탭은 통지)

### 추가 지적
| # | 심각도 | 분류 | 위치 | 요지 | 수정안 |
|---|---|---|---|---|---|
| FE-25 | M | 버그(중복) | BU/contexts/BattleSocketContext.tsx:335-341 · 서버 `gateway.ts:200-209` | LEAVE가 서버 커밋 전에 실패해도 프론트는 키·상태를 먼저 지운다. 소켓이 연결된 채 로비에 남으면 A에 "연결된" 유령 자리가 무기한 남는다. 생존 확인 프로브도 살아 있다고 판정한다(소켓이 A 채널에 남아 있음) | LEAVE 오류·TIMEOUT이면 재시도, 최종 실패 시 소켓 재연결 |
| FE-26 | L | 버그 | BU/contexts/BattleSocketContext.tsx:259-265 | 방에서 대전 밖으로 바로 이동하면 LEAVE·키 삭제 없이 disconnect만 한다 → 키가 남고, 유예 안에 다른 탭으로 들어오면 일시 중복 | provider cleanup에서 LEAVE 시도(최선 노력) |
| BE-25 | L | 개선 | room.service `:585-609` · `:1213-1218` | 방장이 끊겨도 실제 제거 전까지 이양하지 않는다 → 대기실 시작 불가 구간 | 대기 단계에서는 끊김 즉시 이양 검토(프 의견 대기) |

## 2026-10-23 — S3 백엔드 구현 완료 (P1~P6 + D-009~D-012) · 검증

### 반영 항목 (백)
| 묶음 | 항목 | 핵심 변경 |
|---|---|---|
| P1 | BE-01 · BE-02 · D-007 | `commitJoin` 자리 찾기 순서: 토큰 → 같은 소켓 → 로그인 userId → 새 자리(D-007은 userId → 소켓 순으로 적었으나, 같은 소켓이 자기 자리를 우선 지키도록 소켓을 먼저 본다 — 동작 차이는 "한 사람이 이미 두 자리"인 옛 데이터에서만). `assertCanTakeOver`(사전 검증·CAS 양쪽) → `SEAT_IN_USE`. 자리에 `tabId`·`heartbeat` 저장, 넘겨받으면 갱신. 게이트웨이가 이전 소켓에 `sessionReplaced` |
| D-009 | BE-06 · 유예 만료 | `scheduleWake`(unref 타이머, 테스트는 `setWakeScheduler`) · `sweepExpired`(대기: 정리·이양·방송 / 경기: KO sweep) · 결과 서비스가 `setMatchFinishedListener`로 마감 뒤 `finalizeIfDue` |
| D-010·D-012 | 온라인 표시 | `presencePing` 4초(`server.local`) · `heartbeat` → `tetris-battle:hb:{code}:{pid}` TTL 10초 · 방당 5초 게이트 판정 → 끊김 표시 + `disconnectSockets(true)` + 경기면 매치 끊김 기록 |
| D-011 | 강퇴 | `kickPlayer`(방장·WAITING/RESULT·`PLAYER_NOT_FOUND`·10회/10초) · 게이트웨이 `kicked` |
| P2 | BE-04 · BE-05 · BE-14 · BE-22 · BE-24(D-006) | 복구 실패 흡수 · 종료 반영 실패 시 1초 뒤 재시도 예약 · Lua 커서는 실제로 보냈을 때만 · `notifyMatch` 순서(매치 → 방) · 생존자 막판 탑아웃 수용(`lateTopOutFrom`) |
| P3 | BE-07 · BE-08 · BE-12 · BE-13 · D-004·D-008 | 프레임 대조를 시뮬 전에 · 검증 가드(`claimVerification` SET NX 30초) + 닫힘 선검사(이미 낸 사람은 409 우선) · DTO das·arr 범위 · FK 판정 `errorNum 2291` · DISPUTED 공개 + `disputed`·`verdict: INVALID` |
| P5 | BE-03 · BE-09 | 로비 인덱스 끝 정리(가장 오래된 20개 존재 확인) · 로비 방송 300ms 묶기 + 방송 경로 reconcile 생략 |
| P6 | BE-19 · BE-23 | 클로저 우회 `as` 캐스트 제거(결과 반환으로) · `applyKnockOuts` 헬퍼 · 토큰·비밀번호를 `tetris-battle-room-tokens.ts`로 분리(방 서비스 1675 → 약 1590줄) · 엔진 사본 해시 매니페스트 12개 + 대조 테스트(프론트와 해시 일치 확인) |
- 하지 않음(근거): BE-10(lock 2왕복) — 측정 없이 최적화하지 않는다(engineering §6) · BE-20(gzip 한 줄 헬퍼 공유) — `games` 모듈을 건드리지 않는 선행 경계(tetris-battle D-003)와 이득이 맞지 않는다 · BE-15~18·BE-21 — 보류(D-005)
- DB 변경 없음(Entity·마이그레이션 무수정 — DISPUTED 값은 기존 CHECK 그대로). `games` 모듈 무수정

### 검증 (백)
- `pnpm ci:core`: lint 0 errors / 경고 6(기준선 6과 같음) · 단위 57 suites **1374** 통과 · build 성공
- `TETRIS_BATTLE_REDIS_TEST_PORT=6380 pnpm ci:all`(sandbox 밖, 로컬 `bun-redis` 6380): 스텁 0 · E2E 18 suites **281 통과 · 2 skip** · build 성공
- 실제 Redis 대전 E2E: 105/105 — 경기 중 다른 탭 `SEAT_IN_USE`, 같은 탭 넘겨받기 + 이전 소켓 `sessionReplaced`·가비지 미수신 확인
- 방어 제거 시 실패 확인: userId 넘겨받기·`SEAT_IN_USE`를 끄면 새 테스트 8개 실패
- 미검증: 2레플리카 간 `sessionReplaced`·`kicked`·`disconnectSockets` 전달(어댑터 경로, 운영에서 확인) · 실기기 백그라운드 탭 presencePing 응답

## 2026-10-23 — 일괄 리뷰(D-014) 백엔드 R1

| 리뷰어 | 확정 | 내용 → 조치 |
|---|---|---|
| review-flow(메인) | 3 | ① Swagger·에러 DTO 설명에 "DISPUTED는 404"가 남음 → 정정 ② 선행 DESIGN §16·§17 계약 문서 미갱신 → §16-a 추가·§17 공개 정책 표기 ③ 하트비트 키가 playerId 단위라 넘겨준 옛 탭의 답이 새 소켓 생존으로 세짐 → 소켓 단위 키 + 테스트 · (질의) 서버가 끊으면 클라이언트가 자동 재연결하지 않음 → 프론트가 "io server disconnect" 직접 재연결 수정(프 R1) |
| Opus | 1 M + 5 L | M: 하트비트 판정에서 매치 반영이 실패하면 소켓을 끊지 않아 좀비 상태 → 끊기·깨우기를 커밋 직후로, 매치 반영은 catch · L: 재연결 경로에서 RESULT가 matchEnded보다 먼저 → notifyMatch로 순서 고정·반환 match 비움 · L: 결과 화면에서 userId 넘겨받기가 매치 토큰 해시를 바꿔 원래 탭 제출 403 → userId 갈래는 자리 토큰만 · L: RESULT 전이 뒤 끊긴 자리 정리 깨우기 없음 → finishMatch에서 예약 · L: 검증 진행 중 409가 "이미 제출"로 오인됨 → 503(프론트 replaySubmit이 503 재시도 확인 `replaySubmit.ts:27,39-41,65-66`) · L: `disconnectSockets(true)`가 같은 연결의 다른 namespace까지 닫음 → `false` · 참고: 종료 재시도 무한 → 상한 3회 |
- 그 밖: 새 모듈 이름 `*-credentials.ts`가 sandbox 시크릿 읽기 차단(`**/credentials*`)에 걸려 리뷰어가 못 읽음 → `tetris-battle-room-tokens.ts`로 변경 · 전체 단위 테스트 간헐 실패(비밀번호 scrypt 반복 테스트 5초 초과, 병렬 CPU 경합) → 해당 5개 테스트 제한 시간 30초, 4회 연속 1379/1379
- 방어 제거 시 실패 확인: 하트비트 순서·userId 토큰 수정을 되돌리면 새 테스트 3개 실패
- 검증: `pnpm ci:core` 통과(lint 0 errors / 경고 6 · 1379 · build)

## 2026-10-23 — 일괄 리뷰 백엔드 R2

| 리뷰어 | 확정 | 내용 → 조치 |
|---|---|---|
| review-flow(메인) | 0 | 새 심볼 호출처 전수(`recordHeartbeat`·`kickPlayer`·`setSocketEvictor`·`setMatchFinishedListener`·`claimVerification`·`isClosed` — 게이트웨이·결과 서비스만) · R1 수정 2·3이 토큰 갈래와 맞는지 확인 |
| Opus | 7 L | #1 생존 확인 유령에 깨우기 없음 → 예약 추가 · #2 매치 끊김 기록 실패 시 회수 안 됨 → 깨우기가 방의 끊긴 시각으로 채움(`ensureDisconnectedAt`, 있으면 덮지 않음) · #3 같은 소켓 갈래가 R1 #3을 다시 엶 → 수용(D-015) · #4 결정 로그·주석이 코드와 반대 → D-015 + 주석 정정 · #5 DESIGN·스펙 주석 옛 문구 → 정정 · #6 재시도 상한 테스트 없음 → 추가(가드 제거 시 실패 확인) · #7 BE-14 부작용 → 수용(D-015) |
- 검증: 대전 단위 387/387

## 2026-10-23 — 추가 요청: 경기 중 채팅(D-016) · 모바일 조작 조사(D-017·D-018)
- 백: `prepareChat`이 PLAYING에서 매치 Hash 생존 여부로 판정(생존자 MATCH_ALREADY_STARTED, 탈락자·매치 종료 뒤 허용) · 테스트 3개 · DESIGN §16 표·§16-a 갱신 · `ci:core` 1386 통과
- 프(`next-bun-40`): 탈락·관전 중 판 아래 채팅 목록·입력(`ChatPanel.tsx` 공용화), 생존자는 왼쪽 위 자막 2줄 4초(`ChatTicker.tsx`, pointer-events-none) · +4 테스트(839)
- 모바일 조작 조사(프): 버튼 `TouchControls.tsx:14-25`(왼쪽 ◀▼▶ 반복, 오른쪽 홀드·↺·↻·⤓ 2×2 — 하드드롭이 회전 옆), 크기 48~64px, 싱글·대전 공용, DAS/ARR는 개인 설정(엔진 autoShift), 진동은 싱글의 고정·게임오버만, 리플레이는 프레임별 동작 코드만 기록 → 입력 방식은 결정성에 영향 없음. 비교안 ①크기·배치 ②제스처 ③진동 ④터치 DAS/ARR(비권장) ⑤위치 설정 ⑥하드드롭 실수 방지 → 사용자 선택 ①+⑥(자리 분리)

## 2026-10-23 — 실서버 Playwright 검증 (S4)
- 환경: 백 :3500 = tetris-audit worktree `dist`(REDIS_PORT=6380, 메인 `.env` 심볼릭 링크) · 프 :3000 = 프론트 tetris-audit worktree `pnpm dev`(NEXT_PUBLIC_API=http://localhost:3500, 사용자가 만든 `.env` 링크) · 사용자 지시로 기존 :3500(디펜스 bun-62, 통보함)·:3000(다른 세션 Next) 종료 · Playwright는 scratchpad `playwright-core@1.58` + 캐시 chromium_headless_shell-1228, 게스트 4브라우저
| 시나리오 | 결과 |
|---|---|
| S1 같은 브라우저 새 탭(초대 링크) | ✅ 새 탭이 넘겨받음(1/4), 원래 탭 "다른 탭이나 기기에서 이 방에 들어가 여기서는 나왔어요" + "이 탭에서 계속하기" |
| S4 탭 닫고 링크 재진입 | ✅ 같은 자리(1/4), 중복 없음 |
| S5 강퇴 | ✅ 대상 로비 이동 + 토스트 "방장이 방에서 내보냈어요", 방 3/4 |
| S2 경기 중 같은 브라우저 새 탭 | ✅ 경고 "다른 탭이나 기기에서 이 방의 경기를 하고 있어요…", 원래 탭 경기 계속 |
| S7 탈락 후 | ✅ "3위 · 남은 경기를 보고 있어요" + 채팅 입력 · 생존자 자막 표시 · 상대 판 확대/"내 화면으로"·Esc 복귀 |
| S6 브라우저 닫기 | ✅ 상대 미니보드 회색 점(접근성 이름 "하나 오프라인") |
| D-018 모바일 버튼 | ✅ 320·375px 싱글, 375px 대전 — scrollWidth = 뷰포트, 화면 밖 버튼 0, 하드드롭 분리 |
- 발견(L): 320px 싱글 상단 라벨이 한 글자씩 꺾임("점/수"·"나가/기") → 프론트 수정 요청
- 미검증: 실기기(모바일 키보드 올라올 때 채팅 입력), 카카오 로그인 사용자의 다른 기기 넘겨받기(게스트로만 검증), 하트비트 반쯤 열린 소켓(네트워크 단절) — 단위·실제 Redis E2E로만 확인
