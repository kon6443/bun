# 결정 로그 — 테트리스 로비 전체 채팅

> append-only. 뒤집힌 결정은 새 항목에 `supersedes D-00N`.

## D-001 — 범위·저장·계약 (2026-10-27, 사용자 + 메인)
- **사용자**: "테트리스 온라인 전체 채팅, 저장 안 되도록" · 게스트도 작성 · 최근 50개만 잠깐 보여 주기 · 대전 로비 + 홈 입구
- **메인 설계**:
  - 기존 `/tetris-battle` namespace에 이벤트 추가(로비가 이미 이 소켓을 쓴다 — 연결 증가 없음). 채널 `tetris-battle:lobby-chat`, 방 목록 구독(`tetris-battle:lobby`)과 별개
  - c→s `joinLobbyChat` → ack `{ messages(오래된→최신, ≤50·30분), onlineCount(전 레플리카 fetchSockets, 실패 null), me }` · `leaveLobbyChat` · `lobbyChat { text, name? }` → ack `{ message }` + 채널 방송 `lobbyChatMessage`(보낸 사람 포함)
  - `LobbyChatMessage { id(UUID), senderKey, name, isGuest, text, at(ISO UTC) }`
  - 표시 이름: 로그인은 구독 때 계정 이름(랭킹 이름 정책 통과, 아니면 "회원")을 소켓에 둔다(메시지마다 DB 안 읽음, 보낸 name 무시). 게스트는 메시지마다 name — `checkPlayerName`(NAME_INVALID·NAME_FORBIDDEN)
  - 글자: 방 채팅과 같은 규칙(trim 후 1~100, 제어·bidi 문자·금칙어 → CHAT_FORBIDDEN)
  - 빈도: 보낸 사람(로그인 userId·게스트 IP) 10초 5개 + IP 10초 15개, 구독은 소켓 10초 5번. 재시도 시각은 주지 않는다
  - senderKey: HMAC-SHA256(GAME_IP_HASH_SECRET, 로그인 `u:{userId}` / 게스트 `ip:{ip}`) 앞 16자. 클라이언트 guestId는 쓰지 않는다(도배자가 바꿔 차단 회피). 한계: NAT 공유 게스트는 같은 키, IPv6 회전 시 바뀜
  - 최근 대화: Redis List `tetris-battle:lobby-chat:recent` — MULTI(LPUSH·LTRIM 50·EXPIRE 1800). 30분 필터는 join 응답에만. DB·로그에 본문을 남기지 않는다
  - 구독 전 보내기 → `LOBBY_CHAT_NOT_JOINED`(신규 코드). 재연결 시 자동 재구독 없음(클라이언트가 다시 join)
- 기각: REST 참여 수(홈 입구는 링크만) · 클라이언트 guestId 차단 키

## D-002 — 내 글은 오른쪽 말풍선 (2026-10-27, 사용자)
- **맥락**: 사용자 — "채팅에서 내가 보낸 것도 왼쪽에 나와서 헷갈린다. 내 채팅은 오른쪽에"
- **결정**: 로비 패널·홈 채팅 카드 모두 내 글은 오른쪽 정렬 강조 말풍선(이름 생략·시각 유지), 남의 글은 왼쪽(이름·게스트 배지·시각). "내 글" 판정은 기존 색 판정과 같은 기준(이번 화면에서 보낸 id · 회원 me.senderKey · 게스트 senderKey + 이름 일치). 스크린리더용 "나:" 구분 텍스트
