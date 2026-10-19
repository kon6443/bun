# 팀 채팅 저장 · 읽음 표시 · 안읽음 배지 — 설계와 동작 원리

> 이 문서는 동작 원리와 계약 초안을 설명한다. 각 선택의 이유는 `DECISIONS.md`(D-00N), 현재 진행 상황은 `STATUS.md`에 있다.
> 🟡 표시는 사용자 확인 전인 제안이다. 확정되면 이 문서를 고친다.

## 1. 테이블 두 개

```
TEAM_CHAT_MESSAGES                         TEAM_CHAT_READ_CURSORS
┌────────────┬──────┬──────┬──────────┐    ┌──────┬──────┬──────────────────────┐
│ MESSAGE_ID │ TEAM │ USER │ CONTENT  │    │ TEAM │ USER │ LAST_READ_MESSAGE_ID │
├────────────┼──────┼──────┼──────────┤    ├──────┼──────┼──────────────────────┤
│ 101        │ 7    │ A    │ 안녕      │    │ 7    │ A    │ 104                  │
│ 102        │ 7    │ B    │ 회의 언제? │    │ 7    │ B    │ 102                  │
│ 103        │ 7    │ A    │ 3시       │    │ 7    │ C    │ 103                  │
│ 104        │ 7    │ A    │ 확인 부탁  │    │ 7    │ D    │ (행 없음 = 0)         │
└────────────┴──────┴──────┴──────────┘    └──────┴──────┴──────────────────────┘
```

- `MESSAGE_ID`는 팀 안에서 커지기만 한다(D-003). 그래서 "104까지 읽었다"는 말은 "101~104를 모두 읽었다"와 같다.
- 커서는 **책갈피**와 같다. 멤버마다 "어디까지 읽었는지" 숫자 하나만 저장한다. 메시지마다 누가 읽었는지 기록하지 않는다(D-001).

## 2. 세 기능은 모두 같은 숫자로 계산한다

위 표 기준, 4명(A·B·C·D)이 있는 방에서:

| 기능 | 계산 | 예: 메시지 103 (보낸 사람 A) |
|---|---|---|
| (3) 안 읽은 인원 수 | 활성 멤버 중 `커서 < 메시지ID`인 사람 수. 보낸 사람은 제외 | B(102)·D(0) → **2** |
| (4) 누가 읽었나 | `커서 ≥ 메시지ID` → 읽음, 나머지 → 안 읽음 | 읽음: C · 안 읽음: B, D |
| (6) 내 안읽음 배지 | `메시지ID > 내 커서` AND 보낸 사람 ≠ 나 인 메시지 수 | B의 배지: 103·104 → **2** |

- (3)·(4)는 **프론트가 계산**한다. 서버는 멤버별 커서 목록(팀 인원 수만큼의 숫자)만 내려준다. 팀 인원이 적어서 메시지 50개 × 멤버 10명을 비교해도 계산량은 수백 번이다.
- (6)은 **서버가 계산**한다. 프론트는 과거 메시지를 다 갖고 있지 않기 때문이다. 쿼리는 `(TEAM_ID, MESSAGE_ID)` 인덱스에서 "내 커서 이후" 구간만 센다.

## 3. 실시간으로 숫자가 줄어드는 흐름

```
 B가 채팅창을 열어 103·104를 봄
   │
   ├─(소켓) chatRead { lastReadMessageId: 104 } ──▶ 서버
   │                                                │ 1. 레이트 리밋 확인 (Redis INCR)
   │                                                │ 2. B가 아직 활성 멤버인지 확인 (DB)
   │                                                │ 3. 104가 이 팀의 메시지인지 확인 (DB) ← 임의의 큰 값으로 미래 메시지까지 읽음 처리 방지
   │                                                │ 4. UPDATE 커서 SET 104 WHERE 커서 < 104  ← 뒤로 가지 않음
   │                                                │ 5. 실제로 바뀌었으면 팀 room에 알림
   ◀─(소켓) chatReadUpdated { userId: B, lastReadMessageId: 104 } ── room 전원 (Redis 어댑터가 다른 서버에도 전달)
   │
 모든 화면: B의 커서를 104로 바꾸고 숫자를 다시 계산 → 메시지 103의 "2"가 "1"로 줄어듦
```

- 메시지를 **보낸 사람은 그 메시지까지 읽은 것**으로 처리한다. 서버가 저장할 때 보낸 사람의 커서도 같은 트랜잭션에서 올린다. 프론트는 `chatReceived`를 받으면 보낸 사람의 커서를 그 메시지 ID로 올린다(별도 이벤트 없음).
- 🟡 **언제 "읽음"으로 보낼지**(Q4): 제안은 "채팅 패널이 열려 있고 브라우저 탭이 보이는 상태에서 최신 메시지까지"다. 프론트가 1초 단위로 모아서(debounce) 보낸다. 메시지가 올 때마다 바로 보내지 않는다.

## 4. 메시지 전송 흐름

```
 A: chatMessage { message, clientMsgId(UUID) } ──▶ 서버
                                                   │ 1. 레이트 리밋 (Redis)
                                                   │ 2. 활성 멤버 재확인 (DB)          ← 추방된 사람 차단 (D-006)
                                                   │ 3. 트랜잭션: INSERT 메시지 + A의 커서를 새 ID로
                                                   │    (같은 clientMsgId 재전송이면 기존 메시지를 돌려줌 — 유니크 제약)
 room 전원 ◀── chatReceived { messageId(DB), clientMsgId, userId, userName, message, timestamp }
```

- A의 화면은 보내는 즉시 임시 메시지를 띄워 둔다(낙관적 업데이트). 서버 응답이 오면 `clientMsgId`로 임시 메시지를 찾아 진짜 `messageId`로 바꾼다.

## 5. 화면에 들어올 때 (REST)

| 시점 | 호출 | 받는 것 |
|---|---|---|
| 팀 목록 진입 | `GET /teams` (🟡 Q5) | 팀마다 `unreadChatCount` |
| 팀 화면 진입·소켓 재연결 | `GET /teams/:teamId/chat/read-state` | 멤버별 커서 목록, 내 안읽음 수, 최신 메시지 ID |
| 채팅 패널 열기 | `GET /teams/:teamId/chat/messages?limit=50` | 최신 50개 + `hasMore` |
| 위로 스크롤 | `GET /teams/:teamId/chat/messages?beforeId=101&limit=50` | 101보다 앞의 50개 |

- 페이지 나누기는 **커서(keyset) 방식**이다. "몇 번째 페이지"(OFFSET) 대신 "이 ID보다 앞의 N개"로 조회한다. 새 메시지가 계속 들어와도 겹치거나 빠지는 메시지가 없고, 인덱스를 바로 타서 데이터가 쌓여도 속도가 그대로다.
- 팀 화면 밖에 있는 동안 온 메시지는 소켓으로 받지 못한다. 그래서 들어올 때와 재연결할 때 REST로 다시 맞춘다.
- 재연결·탭 복귀 때는 빠진 구간만 골라 채우지 않는다. 이력을 열어 둔 상태면 최신 페이지를 다시 받아 목록을 통째로 교체하고(전송 중인 내 메시지만 유지), 교체가 끝날 때까지 읽음 전송을 보류한다(D-024).

## 6. Redis와 DB의 역할 분담 (D-002)

| 데이터 | 저장소 | 이유 |
|---|---|---|
| 메시지, 읽음 커서 | **Oracle** | 영구 보존. 원본은 하나만 둔다 |
| 다른 서버로 이벤트 전달 | Redis Pub/Sub (기존) | 레플리카 3개가 같은 room 이벤트를 공유 |
| 도배 방지 카운터 | Redis `INCR` + `EXPIRE` | 10초 동안만 쓰고 버리는 값. 지워져도 문제없음 |
| 온라인 상태 (기존) | Redis | 휘발성 |
| 안읽음 수 캐시 | **두지 않음** | Redis가 `allkeys-lru`라 아무 키나 지워질 수 있다. DB 조회가 충분히 싸다 |

판단 기준: "지워지면 사용자에게 틀린 값이 보이는가?" 그렇다면 DB에 둔다. 지워져도 다시 만들 수 있거나 잠깐 쓰고 버리는 값이면 Redis에 둔다.

### 6-1. 언제 무엇이 어디에 저장되나 (D-014)

**채팅 메시지는 Redis에 저장하지 않는다.** "Redis에 모았다가 주기적으로 DB에 반영"하는 단계가 없다. 전송 순간 DB에 바로 쓴다.

```
 A가 전송
   │ ① Redis INCR chat:rl:send:{userId}   ← 10초짜리 카운터. 첫 INCR 때 EXPIRE 10초
   │ ② DB SELECT 멤버십
   │ ③ DB 트랜잭션: INSERT 메시지 + A의 커서 UPDATE → COMMIT   ← 이 시점에 원본 저장 끝
   │ ④ Redis PUBLISH (Socket.IO 어댑터)                       ← 다른 레플리카에 "방에 뿌려라" 전달. 저장 안 됨
   ▼
 레플리카 3대가 각자 연결된 방 멤버에게 chatReceived 전송
```

| 데이터 | 저장 시점 | 보관 기간 | 갱신 주기 |
|---|---|---|---|
| 메시지 (DB) | 전송 즉시, 동기 COMMIT | 영구 | — (수정 기능 없음) |
| 읽음 커서 (DB) | `chatRead` 수신 즉시(프론트가 약 1초 단위로 모아 보냄), 메시지 전송 시 보낸 사람 것 | 영구 | 이벤트가 올 때만 |
| 레이트 리밋 카운터 (Redis) | 이벤트마다 INCR | 10초 뒤 자동 삭제 | — |
| Pub/Sub 메시지 (Redis) | 발행 즉시 구독자에게 전달 | **저장 안 됨** | — |
| 온라인 상태 (Redis, 기존) | 접속·퇴장 시 | TTL 1~2시간 | 접속할 때마다 |
| 온라인 수 지표 (기존) | — | — | 60초 (TASK_SLOT=1 레플리카만) |

**참고 — 캐시 패턴과 쓰지 않은 이유**
- cache-aside(조회 시 캐시 확인, 없으면 DB 조회 후 저장)·write-through(DB와 캐시에 동시에 쓰기)·write-behind(캐시에 먼저 쓰고 나중에 DB 반영)가 대표적이다.
- write-behind는 DB 쓰기가 너무 많을 때 쓰는데, Redis가 죽거나 키가 지워지면 데이터가 사라진다. 이 서비스는 DB 쓰기가 적어 쓸 이유가 없다.
- 나중에 조회가 느려지면 read-state에 짧은 TTL의 cache-aside를 붙이는 것이 다음 단계다(D-014 재검토 조건).

## 7. 계약 초안 (D-016 반영. 🟡 Q2·Q11 결정에 따라 바뀔 수 있음)

| 방향 | 이벤트 / 경로 | 페이로드 |
|---|---|---|
| C→S | `chatMessage` (기존) | `{ message, clientMsgId }` |
| S→C | `chatReceived` (변경) | `{ messageId: number, clientMsgId, teamId, userId, userName, message, timestamp }` |
| S→C | `error` (기존 이벤트, 채팅 거부 시 필드 추가) | `{ code, message, timestamp, clientMsgId? }` — 채팅 거부면 `clientMsgId`를 실어 낙관적 메시지를 '실패'로 바꿀 수 있게 한다 |
| C→S | `chatRead` (신규) | `{ lastReadMessageId: number }` |
| S→C | `chatReadUpdated` (신규) | `{ teamId, userId, lastReadMessageId }` — 커서가 실제로 전진했을 때만 |
| S→C | `memberJoined` (🟡 Q11) | `{ teamId, userId, userName, lastReadMessageId }` — 초대 수락으로 가입·재가입했을 때 |
| HTTP | `GET /teams/:teamId/chat/messages` (신규) | 아래 규칙 |
| HTTP | `GET /teams/:teamId/chat/read-state` (신규) | `{ latestMessageId, myLastReadMessageId, myUnreadCount, members: [{ userId, userName, lastReadMessageId }] }` |
| HTTP | `GET /teams` (필드 추가) | 각 항목에 `unreadChatCount: number` |

**messages 조회 규칙**
- query: `beforeId?`, `afterId?`(둘 중 하나만), `limit?`(기본 50, 최대 100). 둘 다 없으면 최신 `limit`개를 준다.
- `beforeId`·`afterId`는 **미포함(exclusive)**. `beforeId=101`이면 101은 빠진다.
- 응답 `{ messages, hasMore }`. `messages`는 **오래된 것부터** 정렬한다.
- `hasMore`: 요청한 방향(`beforeId`·기본 = 더 과거, `afterId` = 더 최신)에 메시지가 더 남아 있으면 true. 서버가 `limit + 1`개를 조회해 판정한다.
- `afterId`는 계약에 남겨 두지만 프론트는 쓰지 않는다. 재연결 때는 최신 페이지로 목록을 교체한다(D-024).

**read-state 규칙**
- `members`는 **활성 멤버만, 본인 포함**. 커서 행이 없으면 `lastReadMessageId: 0`.
- 메시지가 없으면 `latestMessageId: 0`(null 아님).

**에러 코드 (`error` 이벤트)**
| code | 언제 | `clientMsgId` |
|---|---|---|
| `CHAT_NOT_JOINED` | 팀 room 미참여 소켓의 `chatMessage`·`chatRead` | `chatMessage`만 |
| `CHAT_RATE_LIMITED` | 전송 20회/10초 초과 | 있음 |
| `CHAT_FORBIDDEN` | 활성 멤버가 아님(추방·비활성 후 살아 있는 소켓) | `chatMessage`만 |
| `CHAT_SEND_FAILED` | DB 저장 실패 등 서버 오류 | 있음 |
- `chatRead`가 레이트 리밋을 넘으면 **에러 없이 무시**한다. 커서는 증가만 하므로 다음 `chatRead`가 최댓값을 다시 실어 온다.
- 알려진 한계: DTO 검증 실패(4,000자 초과 등)는 `ValidationPipe` 예외라 `WS_ERROR` + 일반 메시지로 나가고 `clientMsgId`가 없다. 프론트 입력창 `maxLength`가 1차 방어다.

**타입 보장**: `messageId`·`lastReadMessageId`·`latestMessageId`·`unreadChatCount`는 JSON number다. Oracle 결과를 `Number()`로 변환하고 spec에서 `typeof === 'number'`로 단정한다.
