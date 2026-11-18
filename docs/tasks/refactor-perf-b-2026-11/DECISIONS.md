# 리팩터링·성능 B 등급 — 결정 로그

> 새 결정은 맨 아래에 추가한다. 기존 항목은 고치지 않고, 뒤집힐 때는 새 항목에 `supersedes D-00N`을 쓴다.

## D-001 — B1~B9를 한 태스크로, 리뷰는 전부 끝낸 뒤 1회 (2026-11-16)
- **맥락**: A 등급 배포 후 남은 항목 보고에 사용자가 "B 진행. 추천대로"
- **결정**: 조사 등급표 B 전체(백 B1~B4, 프 B5~B9 — B9는 백엔드가 이미 댓글 수정 응답에 갱신된 댓글을, 삭제에 null을 주므로 프론트만)를 구현하고, 리뷰 루프(백·프 각 리뷰 스킬 + Opus 서브에이전트, 확정 0까지)는 모든 묶음이 끝난 뒤 한 번 돈다
- **근거**: 사용자 메시지 2026-11-16 · 리뷰 몰아서 1번(메모리 feedback-review-loop-method) · `team.controller.ts` 댓글 PATCH `data: comment`, DELETE `data: null`
- **영향**: 백 `refactor-onam-perf-b`, 프 `refactor-onam-perf-b`

## D-002 — `TASK_SLOT` 미설정은 리더가 아니다 (2026-11-16)
- **맥락**: 단일 실행 판정이 4곳에서 다르다 — `Number(...) || 1`(scheduler·두 결과 서비스: 미설정 = 리더), `!== '1'`(포트리스 스위퍼: 미설정 = 아님), `Number(?? 0) === 1`(온라인 지표: 미설정 = 아님). 스택 YAML이 `{{.Task.Slot}}`을 주입하므로 운영에선 같지만, 주입이 빠지면 `|| 1` 쪽 크론이 모든 레플리카에서 돈다(조사 실시간#11)
- **결정**: `isLeaderReplica()` 헬퍼 하나 — `TASK_SLOT`이 정확히 `'1'`일 때만 true. 미설정·빈 값·숫자 아님은 false(안전 기본값: 주입이 빠지면 아무도 안 돌 뿐 중복 실행은 없다)
- **근거**: 스케줄러·결과 서비스는 ENV 화이트리스트(QA·PROD)도 함께 보므로 로컬·테스트에선 원래 돌지 않는다 — 미설정 = 리더가 실제로 쓰이던 경로가 없다. 중복 실행(부하·로그)보다 미실행(스위퍼·lazy 경로가 회수)이 안전하다
- **버린 대안**: 미설정 = 리더(단일 프로세스 가정) — 주입 누락 시 모든 레플리카 중복 실행이라는 원래 위험이 남는다
- **영향**: `scheduler.service.ts`·`fortress-result.service.ts`·`tetris-battle-result.service.ts`·`fortress-match.service.ts`·`online-user.service.ts`. 운영 동작 불변(주입값 1은 그대로 리더)

## D-003 — 로비 목록 공유 캐시는 하지 않는다 (2026-11-17)
- **맥락**: 조사 실시간#7 — 방 변경마다 레플리카별로 로비 목록(방 최대 200개 HGET + 파싱)을 다시 만들어 방송한다. 레플리카 공유 단기 캐시(수백 ms)가 후보였다
- **결정**: 캐시를 두지 않고 지금의 레플리카별 300ms 디바운스만 유지한다
- **근거**: 캐시를 공유하면 레플리카 A가 캐시한 직후 레플리카 B에서 생긴 변경을 B의 방송이 캐시(옛 목록)로 내보낼 수 있다 — 마지막 변경이 다음 변경 전까지 로비에 안 보이는 결함이다. 무효화를 붙이면 방 변경 CAS마다 키를 지워야 해 복잡도가 이득보다 크다. 실측 규모(방 수 한 자릿수)에선 200개 상한에 닿지 않아 비용이 작다
- **버린 대안**: 버전 키로 무효화하는 캐시 · 로컬 구독자 0이면 방송 생략(어댑터가 다른 레플리카 소켓에 전달하므로 안전하지 않다)
- **영향**: B4 범위에서 제외. 방 수가 수십을 넘으면 C 등급으로 재검토

## D-004 — `TASK_SLOT` 미설정 = 리더 아님으로 감사 M6을 닫는다 (2026-11-17)
- **맥락**: D-002 적용 중 스케줄러 spec이 "미설정이면 1로 간주해 실행"을 고정하고 있었다. 이는 `backend-audit-2026-10` 원표 M6("값이 없으면 1로 간주해 단일 실행 작업이 중복 실행될 수 있음")으로 지적된 동작이다
- **결정**: spec을 D-002 정책으로 바꾼다(미설정·숫자 아님 → 실행 안 함). M6은 이 변경으로 해소
- **근거**: `infra/docker-stack.app.yml` `TASK_SLOT: "{{.Task.Slot}}"` — 운영·QA 스택은 항상 주입하므로 운영 동작은 그대로다

## D-005 — 종료는 앱(소켓 서버) 먼저, Redis는 정리 대기 뒤 (2026-11-18)
- **맥락**: dev watch 재시작마다 ioredis "Connection is closed" Unhandled Rejection(앱 프레임 없음). `main.ts` shutdown이 `redisAdapter.disconnect()`(quit) → `app.close()` 순서였고 `enableShutdownHooks()`도 동시에 앱을 닫았다. `@socket.io/redis-adapter` 8.3.0 `close()`가 punsubscribe·unsubscribe를 await 없이 부른다 — 이미 quit한 연결이라 네임스페이스마다 거부가 버려진다(오프라인 재현: quit 뒤 두 호출 → UNHANDLED 2건). 같은 이유로 각 소켓의 연결 해제 정리(팀·낚시 온라인 제거, 게임 방 끊김 표시)가 전부 실패한다 — 배포마다 그 레플리카에 붙어 있던 유저가 TTL(소켓 집합 1시간, 재입장마다 갱신)까지 온라인으로 남는다(정리 스윕 없음)
- **결정**: `closeAppThenRedis(app, adapter)` — `app.close()`(훅·소켓 서버·http) → `SHUTDOWN_REDIS_DRAIN_MS`(1초) → Redis quit. `enableShutdownHooks()`는 제거(훅은 `app.close()`가 부른다, 이중 close 경합 제거)
- **근거**: Nest `close()` = destroy 훅 → beforeShutdown → dispose(소켓 → http) → shutdown 훅. socket.io `close()`는 소켓 `_onclose`를 먼저 동기로 불러 정리 명령이 Redis 종료 전에 출발한다. 정리의 두 번째 왕복(조회 뒤 제거)은 대기 1초 안에 끝난다
- **버린 대안**: 진행 중 정리 작업을 추적해 기다리기 — 게이트웨이마다 추적 장치가 필요해 복잡도 대비 이득이 작다(남는 경우: 종료 순간 Oracle 대기 중인 입장 뒤에 줄 선 정리 — 드묾)
- **영향**: `main.ts`, `common/utils/graceful-shutdown.ts`. SIGHUP·SIGQUIT는 훅 없이 기본 종료(스웜·dev는 SIGTERM·SIGINT)

## D-006 — 팀 소켓 소속 변경을 소켓별로 직렬화 (2026-11-18)
- **맥락**: 조사 후속 "leaveTeam이 room 이탈 전에 Redis 정리를 기다림 · leave→join 경합". 프론트는 leaveTeam을 보내지 않고 팀마다 새 연결, connect마다 joinTeam 1회(프론트 세션 `TeamSocketContext.tsx:140-154·290-302`). 실제로 나는 경합은 **joinTeam이 멤버십·표시 이름 조회(DB)를 기다리는 사이 끊김** — 연결 해제 정리가 먼저 끝나고 뒤이어 죽은 소켓이 등록돼 유령 온라인(스윕 없음)
- **결정**: 낚시(D-007)와 같은 소켓별 큐로 join·leave·disconnect를 직렬화, 큐 안 join 시작 시 끊긴 소켓이면 등록하지 않음. 방어 경로: 다른 팀 입장 시 이전 팀부터 정리(Redis 미준비면 등록 정리는 건너뜀 — 오프라인 큐에서 입장이 멈추지 않게), leaveTeam은 room·캐시를 먼저 정리하고 지금 팀일 때만 온라인 등록을 지운다
- **근거**: 경합 조합마다 가드보다 겹침 제거가 단순(survey D-007과 같은 근거). 단위 테스트 9건 + 변이 7건 검출
- **영향**: `team.gateway.ts`, `online-user.service.ts`(`isReady`). 이벤트·ack 계약 불변

## D-007 — Redis가 끊긴 채 종료하면 quit 대신 바로 끊는다 (2026-11-18)
- **맥락**: D-005 브라우저 수준 검증 중 Redis 미기동으로 SIGTERM → `quit()`이 오프라인 큐(maxRetriesPerRequest: null)에서 재연결을 기다려 강제 종료 타이머(30초)까지 멈추고 exit 1. 예전 순서도 같다(스웜 10초 SIGKILL)
- **결정**: `RedisIoAdapter.disconnect()` — 클라이언트 status가 `ready`면 `quit()`(보낸 명령 처리 뒤 닫기), 아니면 `disconnect()` + warn 로그
- **근거**: 구독 모드에서도 status는 ready(ioredis `Redis.js:261-269`) — 정상 경로는 quit 그대로. 실측 종료 약 1.1초, Unhandled Rejection 없음
- **버린 대안**: 그대로 두기 — 종료 순간 끊긴 Redis에 정리 명령이 전달될 수는 있지만 종료가 30초 멈추고 스웜에선 어차피 10초에 SIGKILL
