# 작업 기록 — 테트리스 로비 전체 채팅

> append-only. 목차는 `grep -n "^## "`.

## 2026-10-27 — 백엔드 구현 (D-001)
- 기존 방 채팅(`prepareChat`·`ChatDto`·`containsDisallowedChars`·`consumeRateLimit`) 규칙을 재사용, 새 서비스 `src/modules/tetris-battle/tetris-lobby-chat.service.ts`(Redis는 main.ts가 주입) · 게이트웨이 `handleJoinLobbyChat`·`handleLeaveLobbyChat`·`handleLobbyChat` · events 계약·에러 코드 `LOBBY_CHAT_NOT_JOINED` · 빈도 `lobbyChatJoin`·`lobbyChat`·`lobbyChatIp`
- 프론트 계약 질문 1~8 반영(ack에 message, senderKey 기준, 재구독, 글자 규칙, RATE_LIMITED 재시도 시각 없음, NAME_* 코드, onlineCount, at)
- 검증: ci:core 단위 1864 · lint 경고 6 / E2E(Redis 포함) 363 pass·2 skip — 신규 WS E2E 7(구독·방송 대상·최근 대화·로그인 이름·구독 전 거부·나간 뒤·검증 5종)

## 2026-10-27 — 리뷰 1라운드
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 0 | 방 채팅 규칙 재사용·가드·ack 필터 배선 확인 |
| Opus 서브에이전트 | 2 (+추정 3) | ① 구독 때 최근 대화를 읽은 뒤 채널 입장 → 사이 메시지 유실 → 채널 먼저·id 중복 제거 ② 대기 중 끊긴 소켓 join → 어댑터에 남음 → `client.disconnected` 확인 + 최근 대화 실패 시 leave ③(추정) 구독 한도 소켓 단위뿐 → `lobbyChatJoinIp` 10초 30 추가 ④ 게스트 이름 사칭 → 프론트에 게스트 배지·텍스트 렌더 필수 통보 ⑤ HMAC 비밀 미설정 시 차단 키 불일치 → 운영 확인: 최근 2일 GAME_SCORES 30건 모두 IP_HASH 있음 = 설정됨 |
- 검증: ci:core 단위 1866 · lint 경고 6 / E2E(Redis 포함) 363 pass·2 skip

## 2026-10-27 — 리뷰 2라운드
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 0 | 1라운드 수정 재확인 |
| Opus 서브에이전트(새 컨텍스트) | 1 (Low) | 로비 채팅 3핸들러가 소켓별 큐(serialize) 밖 → join 처리 중 온 leave가 먼저 끝나 구독 상태로 남음 → 3핸들러를 같은 큐로, 순서 테스트 추가(join·leave·보내기 동시 → 나간 상태·NOT_JOINED). `!sender` 갈래 테스트 공백 보강 |
- 검증(2라운드 수정 후): ci:core 단위 1867 · lint 경고 6 / E2E(Redis 포함) 363 pass·2 skip

## 2026-10-27 — 리뷰 3라운드 (백엔드 종료)
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 0 | serialize 큐 공유·예외 시 큐 해제 확인 |
| Opus 서브에이전트(새 컨텍스트) | 0 | 참고(추정·낮음): `senderOf` DB 지연 시 같은 소켓 큐 뒤 끊김 처리 지연 — 기존 create·join(`boardSkinsOf`)과 같은 노출, 어댑터 room 정리는 큐와 무관. 재구독 중 최근 대화 실패면 기존 구독도 풀림 — 실패 ack로 재시도 복구 |

## 2026-10-27 — 프론트 구현·계약 보완·로그인 브라우저 검증
- 프론트 773d86d(feat-onam-tetris-chat): useLobbyChat(연결마다 join, id 합치기, 100개 상한) · LobbyChatPanel(게스트 배지·텍스트 렌더·senderKey 숨기기·이 브라우저만) · 로비 패널·홈 대전 카드 링크. 게이트 1889, 리뷰 3회차 두 리뷰어 0
- 프론트 질문 반영: ① join ack `me.senderKey` 추가(`senderKeyOf` — publish와 같은 `senderSubject`) — 새로고침 뒤 지난 내 글 알아보기 ② 형식 오류 코드는 `INVALID_PAYLOAD`(앞선 답의 VALIDATION_ERROR는 메인 오기, 정정) ③ join·leave·보내기는 소켓별 큐로 순서 보장(리뷰 2라운드 수정)
- 백엔드 검증(me.senderKey 후): ci:core 단위 1868 / E2E(Redis 포함) 363 pass·2 skip
- 메인 로그인 브라우저(375, 회원 = 로그인 Chrome · 게스트 = 별도 headless): 회원 글이 게스트 화면에 즉시 도착, 회원 이름 "개발자" 배지 없음 · 게스트 글에 "게스트" 배지, "들어올 때 2명", pageerror 0
