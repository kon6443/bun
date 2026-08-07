# Task Tracker: 팀 단위 실시간 채팅 (저장 없음, 추후 저장 도입 예정)

> 작성일: 2026-06-19
> 브랜치: `feat-onam`
> 상태: **백엔드+프론트 구현 완료** (빌드/타입체크/적대적 코드리뷰 통과) — 수동 E2E·멀티레플리카 검증·배포 대기
> 참고 구현: `src/modules/fishing/`(백엔드 채팅) + `next-bun/src/app/fishing/components/ChatPanel.tsx`(프론트 채팅) — 동일 패턴 차용
> 연관 프로젝트: 프론트 `../next-bun` (Next.js 15 App Router)

---

## 📌 결정 사항 요약

| 항목 | 결정 | 근거 |
|------|------|------|
| Q1. UI 배치 | **하단 드로어/바텀시트** | 모바일 친화. 헤더 채팅 버튼 → 하단에서 슬라이드업. `TeamsPageLayout`(max-w-lg) 단일 컬럼 구조 개편 불필요 |
| Q2. 채팅 범위(스코프) | **팀 전체 단일 채팅방** | "팀단위 채팅" 요청에 정확히 부합. 기존 room `team-{teamId}` 그대로 재사용, 추가 룸 관리 불필요 |
| Q3. 메시지 안전장치 | **최소 (fishing과 동일)** — `@IsString @IsNotEmpty @MaxLength` 검증만, rate limit 없음 | fishing 채팅과 동일 최소 구현. 도배/공백 방지는 추후 필요 시 추가 (확장성 분석 P2 보류) |
| Q4. 저장 대비 페이로드 | **저장 호환 필드 미리 포함** — `messageId`, `teamId`, `userId`, `userName`, `message`, `timestamp` | 추후 DB 저장 도입 시 저장 로직만 추가하면 되도록. 프론트 재작업 최소화 |
| **기술 디테일** | | (코드/디폴트로 결정 — 사용자 확인 불요) |
| D1. teamId 전달 방식 | **소켓에 캐싱** (`client.data.teamId`) — dto로 받지 않음 | fishing의 `client._fishingMapId` 패턴 차용. 룸 미참여자 차단 자연스럽고 teamId 위조 불가 |
| D2. 브로드캐스트 방식 | **`server.to(room)` (본인 포함)** + 프론트 self-filtering | fishing 동일(`fishing.gateway.ts:278`). `CLAUDE.md`/프론트 `ChatPanel.tsx:80` self-filter 컨벤션 부합 |
| D3. timestamp 생성 | **서버에서 생성** (`new Date().toISOString()`) | 클라 시계 불신. 저장 도입 시에도 서버 시각이 SSOT |
| D4. messageId 값 | **지금은 클라 생성 `clientMsgId` 에코** → 저장 도입 후 서버 DB PK로 교체 | 저장 도입 시 서버가 PK 발급 후 clientMsgId로 클라 낙관적 메시지 교체 가능 |
| D5. XSS sanitize | **저장 전까진 백엔드 sanitize 없음** (fishing 동일) | 프론트가 React 텍스트 렌더(이스케이프 자동). 저장/HTML 렌더 도입 시 재검토 |
| D6. 메시지 최대 길이 | **200자 (fishing과 동일)** | Q3 "fishing과 동일" 결정 일관성. 업무 채팅 길이 부족 시 조정 |

---

## 개요

- **난이도**: 낮음 | **효과**: 중간 (팀 협업 UX) | **위험도**: 🟢 낮음 (기존 패턴 복제, 저장 없음 → DB/마이그레이션 영향 0)
- **선행**: 없음 (Redis Pub/Sub 멀티 레플리카 인프라 이미 구축됨)
- **프론트 영향**: 신규 컴포넌트 추가 + 타입/컨텍스트 확장 (기존 화면 회귀 위험 낮음)

`FishingGateway`의 채팅(`chatMessage` → `chatReceived`, 핸들러 약 16줄)과 프론트 `ChatPanel.tsx`가 "저장 없는 실시간 브로드캐스트" 패턴의 완성된 참조 구현이다. 본 작업은 이 패턴을 `TeamGateway`(`/teams`, room `team-{teamId}`)로 포팅하고, 프론트에 하단 바텀시트 채팅 UI를 추가한다. 멀티 레플리카 전파는 기존 `taskCreated`와 동일한 Redis adapter 경로를 타므로 별도 작업이 없다.

---

## 🏗️ 현황 (불변 팩트 — 작업 전 반드시 참조)

### 재사용 가능한 백엔드 자산 (`src/modules/team/`)
| 자산 | 위치 | 용도 |
|------|------|------|
| `WsJwtGuard` | `team.gateway.ts:122` (joinTeam에 적용 중) | 채팅 핸들러 인증에 그대로 재사용 |
| `getRoomName(teamId)` | `team.gateway.ts:360` (private) | `team-{teamId}` 룸 이름 생성 |
| `emitXxx` 헬퍼 패턴 | `team.gateway.ts:246~353` | S→C 브로드캐스트 public 메서드 패턴 |
| `WsExceptionFilter` | `team.gateway.ts:63` (`@UseFilters`) | 검증 실패 → `error` 이벤트 |
| `handleJoinTeam` | `team.gateway.ts:124` | 여기서 `client.data.teamId` 캐싱 추가 (D1) |

### 참조할 fishing 채팅 구현
| 요소 | 위치 |
|------|------|
| `handleChatMessage` 핸들러 | `fishing.gateway.ts:256~279` |
| `ChatMessageDto` (IsString/IsNotEmpty/MaxLength 200) | `fishing.gateway.dto.ts:41~46` |
| `CHAT_RECEIVED` 이벤트 상수 | `fishing.events.ts:28` |
| 브로드캐스트 `server.to(room).emit()` (본인 포함) | `fishing.gateway.ts:278` |

### 재사용 가능한 프론트 자산 (`next-bun`)
| 자산 | 위치 | 용도 |
|------|------|------|
| `TeamSocketContext` (/teams 연결·joinTeam·온라인 유저) | `src/app/teams/[teamId]/contexts/TeamSocketContext.tsx:105` | `emitChatMessage` 추가 지점 |
| `ChatPanel.tsx` (입력창+리스트+자동스크롤+self-filter) | `src/app/fishing/components/ChatPanel.tsx` | 팀 바텀시트로 복제 |
| `emitChatMessage` 예시 | `src/app/fishing/contexts/FishingSocketContext.tsx:359` | emit 함수 패턴 |
| 소켓 타입 정의 | `src/types/socket.ts` | 이벤트 상수/페이로드 추가 |
| 팀 보드 헤더(온라인 아이콘) | `TeamBoard.tsx` (온라인 아이콘 부근) | 채팅 토글 버튼 부착 위치 |

### 페이로드 설계 (Q4 / D3 / D4 반영)
```ts
// C→S : CHAT_MESSAGE
interface ChatMessagePayload {
  message: string;       // @IsString @IsNotEmpty @MaxLength(200)
  clientMsgId: string;   // @IsString @IsNotEmpty — 클라 생성, 낙관적 업데이트 키
}

// S→C : CHAT_RECEIVED
interface ChatReceivedPayload {
  messageId: string;     // 지금은 clientMsgId 에코 → 저장 도입 후 서버 DB PK
  teamId: number;        // 소켓 캐싱 값에서 채움
  userId: number;        // client.data.user.userId
  userName: string;      // client.data.user.userName
  message: string;
  timestamp: string;     // 서버 생성 ISO 문자열
}
```

---

## Phase 1: 백엔드 — TeamGateway 채팅 핸들러

> **목표**: `/teams` 네임스페이스에 `chatMessage` 수신 → 같은 팀 룸에 `chatReceived` 브로드캐스트. 저장 없음.

### 1-1. 이벤트 상수 + 페이로드 타입 (`src/modules/team/team.events.ts`)
- [ ] `CHAT_MESSAGE: 'chatMessage'`, `CHAT_RECEIVED: 'chatReceived'` 상수 추가
- [ ] `ChatMessagePayload`, `ChatReceivedPayload` 인터페이스 추가 (위 설계대로)

### 1-2. 입력 DTO (`src/modules/team/team.gateway.dto.ts`)
- [ ] `ChatMessageDto` 추가 — `message`: `@IsString @IsNotEmpty @MaxLength(200)`, `clientMsgId`: `@IsString @IsNotEmpty`
- 참고: `fishing.gateway.dto.ts:41~46` 와 동일 구조 + `clientMsgId` 1필드 추가

### 1-3. teamId 소켓 캐싱 (`team.gateway.ts` `handleJoinTeam`)
- [ ] `verifyTeamMemberAccess` 통과 후 `client.data.teamId = teamId` 저장 (D1)
- [ ] (선택) `handleLeaveTeam`에서 `client.data.teamId` 정리 — fishing은 정리 안 하나, leaveTeam 명시 시 일관성 위해 검토

### 1-4. 채팅 핸들러 추가 (`team.gateway.ts`)
- [ ] `@UseGuards(WsJwtGuard)` + `@UsePipes(new ValidationPipe({ transform: true }))` + `@SubscribeMessage(TeamSocketEvents.CHAT_MESSAGE)`
- [ ] `handleChatMessage(client, dto: ChatMessageDto)`:
  - `const teamId = client.data.teamId` — 없으면 즉시 `return` (룸 미참여자 무시, fishing `fishing.gateway.ts:264~265` 패턴)
  - `const { userId, userName } = client.data.user`
  - `const payload: ChatReceivedPayload = { messageId: dto.clientMsgId, teamId, userId, userName, message: dto.message, timestamp: new Date().toISOString() }`
  - `this.server.to(this.getRoomName(teamId)).emit(TeamSocketEvents.CHAT_RECEIVED, payload)` (본인 포함, D2)
- [ ] (선택) 기존 `emitXxx` 패턴과 일관되게 분리할지, fishing처럼 핸들러 내 직접 emit할지 — 핸들러 내 직접 emit 권장(단순)

### Phase 1 완료 조건
- [ ] `pnpm run build` (tsc) 통과
- [ ] 단일 인스턴스 로컬 기동 후 WS 클라이언트(또는 임시 스크립트)로 `joinTeam` → `chatMessage` 전송 → `chatReceived` 수신 확인
- [ ] `joinTeam` 없이 `chatMessage` 전송 시 무시(브로드캐스트 안 됨) 확인
- [ ] 비팀원 토큰으로 joinTeam 차단 확인 (기존 `verifyTeamMemberAccess` 동작)

---

## Phase 2: 프론트 — 하단 바텀시트 채팅 UI (`next-bun`)

> **목표**: 팀 보드에 채팅 토글 버튼 + 하단 바텀시트. 로컬 state로만 메시지 유지(저장 없음).

### 2-1. 타입 정의 (`src/types/socket.ts`)
- [ ] `TeamSocketEvents`에 `CHAT_MESSAGE`, `CHAT_RECEIVED` 상수 추가
- [ ] `ChatMessagePayload`, `ChatReceivedPayload` 인터페이스 추가 (백엔드와 동일 형태, 타입 미공유라 수동 정의)
- [ ] `ClientToServerEvents`에 `CHAT_MESSAGE`, `ServerToClientEvents`에 `CHAT_RECEIVED` 추가 → `TeamSocket` 제네릭 자동 적용

### 2-2. emit 함수 (`TeamSocketContext.tsx`)
- [ ] `emitChatMessage(message: string)` 추가 — `clientMsgId`(UUID) 생성 후 `socket.emit(CHAT_MESSAGE, { message, clientMsgId })`
- 참고: `FishingSocketContext.tsx:359`

### 2-3. 채팅 바텀시트 컴포넌트 (신규)
- [ ] `src/app/teams/[teamId]/components/TeamChatSheet.tsx` 신규 작성 — `ChatPanel.tsx` 참조
  - 로컬 `messages: ChatReceivedPayload[]` state (저장 없음, 새로고침 시 소실 — 의도)
  - `socket.on(CHAT_RECEIVED)` 구독, **self-filtering**: `payload.userId === currentUserId`면 본인이 보낸 메시지는 emit 시 로컬에 이미 추가했으므로 중복 방지 (또는 clientMsgId로 dedupe)
  - 자동 스크롤, 안 읽은 메시지 카운트 배지
  - 하단 바텀시트 레이아웃 (슬라이드업, 모바일 키보드/safe-area 대응)
  - 입력: Enter 전송, Escape/외부 클릭 닫기

### 2-4. 토글 버튼 + 마운트 (`TeamBoard.tsx`)
- [ ] 헤더(온라인 유저 아이콘 부근)에 채팅 토글 버튼 + 안 읽은 카운트 배지
- [ ] `TeamChatSheet` 마운트 (open/close state)

### Phase 2 완료 조건
- [ ] 프론트 타입체크/빌드 통과
- [ ] 두 브라우저 탭(같은 팀, 다른 유저) → A 전송 → B 수신 / A 화면 메시지 중복 없음(self-filter) 확인
- [ ] 바텀시트 모바일 뷰에서 키보드 올라올 때 입력창 가림 없음 확인

---

## Phase 3: 검증 & 마무리

### 3-1. E2E 수동 검증
- [ ] 같은 팀 2유저 실시간 송수신
- [ ] **멀티 레플리카**: (배포 후) 서로 다른 레플리카에 붙은 두 클라이언트 간 메시지 전파 확인 — 기존 `taskCreated`와 동일 Redis adapter 경로
- [ ] 룸 미참여/비팀원 차단
- [ ] Redis 장애 시: 채팅 무음 실패, 앱·HTTP 정상 (기존 graceful degradation)

### 3-2. 문서 업데이트
- [ ] `CLAUDE.md` Docs 목록에 본 파일 추가
- [ ] `MEMORY.md` Socket.IO Events 섹션에 `chatMessage`(C→S)/`chatReceived`(S→C) 추가
- [ ] (저장 도입은 별도 태스크) `tasks-team-chat-persistence.md` 신설 예정

---

## 리스크 & 롤백

| 리스크 | 가능성 | 영향 | 대응 |
|--------|--------|------|------|
| self-filtering 누락으로 본인 메시지 중복 표시 | 중간 | 낮음 | `clientMsgId` 기준 dedupe 또는 `userId === currentUserId` skip (프론트 `ChatPanel.tsx:80` 패턴) |
| 새로고침 시 메시지 소실을 사용자가 버그로 인식 | 중간 | 낮음 | 저장 미구현 명시. 추후 persistence 태스크로 해결 |
| rate limit 없어 도배 가능 | 낮음 | 낮음 | Q3 결정(최소). 문제 발생 시 Gateway 소켓별 throttle 후속 추가 |
| 바텀시트 모바일 키보드 가림 | 중간 | 중간 | viewport/safe-area CSS, `closeOnBeforeunload` 기존 패턴 활용 |
| MaxLength 200자 업무 채팅에 부족 | 중간 | 낮음 | D6 — 필요 시 상수 1곳 조정 |

### 롤백 전략
- Phase 1(백엔드) / Phase 2(프론트) 독립 커밋 분리
- 저장 없는 순수 브로드캐스트라 DB/마이그레이션 영향 0 → 코드 revert만으로 완전 롤백
- 백엔드 채팅 핸들러는 신규 이벤트라 기존 `joinTeam`/태스크 이벤트에 영향 없음 (단, `handleJoinTeam`의 `client.data.teamId` 캐싱 1줄 추가는 회귀 확인)

---

## 진행 상황 체크리스트

### Phase 1: 백엔드 ✅ (2026-06-19)
- [x] team.events.ts — CHAT_MESSAGE/CHAT_RECEIVED 상수 + ChatMessagePayload/ChatReceivedPayload
- [x] team.gateway.dto.ts — ChatMessageDto (`@Transform` trim 포함 → 공백-only 차단)
- [x] ws-jwt-auth.guard.ts — `AuthenticatedSocket.data.teamId?` 추가
- [x] handleJoinTeam — teamId 소켓 캐싱 / handleLeaveTeam — 정리
- [x] handleChatMessage 핸들러 (Prometheus 메트릭 + 미참여 시 `ERROR` emit)
- [x] `pnpm run build` (tsc) 통과
- [ ] 단일 인스턴스 송수신 수동 검증 (런타임)

### Phase 2: 프론트 ✅ (2026-06-19)
- [x] socket.ts — 채팅 이벤트 상수/페이로드 + ClientToServer/ServerToClient 맵
- [x] TeamSocketContext — emitChatMessage (clientMsgId 생성·반환)
- [x] TeamChatPanel.tsx 신규 (바텀시트, OnlineUsersModal 스타일, clientMsgId dedup)
- [x] TeamBoard.tsx — CommentIcon 채팅 버튼 + 마운트 + FAB 숨김
- [x] `tsc --noEmit` + lint (변경 파일 경고 0) 통과
- [ ] 2탭 송수신 + 모바일 키보드 수동 확인 (런타임)

### Phase 3: 검증
- [x] 적대적 코드리뷰 (general-purpose agent) — 치명 결함 없음, 확정 결함 3건 수정 완료
- [ ] E2E (송수신/멀티 레플리카/차단/Redis 장애) — 런타임
- [x] CLAUDE.md Active Work / Docs 등록

---

## Results (2026-06-19 구현 완료)

### 변경된 파일
**백엔드** (`bun`)
- `src/common/guards/ws-jwt-auth.guard.ts` — `AuthenticatedSocket.data.teamId?` 추가
- `src/modules/team/team.events.ts` — CHAT_MESSAGE/CHAT_RECEIVED 상수 + 페이로드 2종
- `src/modules/team/team.gateway.dto.ts` — ChatMessageDto (`@Transform` trim)
- `src/modules/team/team.gateway.ts` — teamId 캐싱(join)/정리(leave) + handleChatMessage

**프론트** (`next-bun`)
- `src/types/socket.ts` — 채팅 이벤트/페이로드 타입
- `src/app/teams/[teamId]/contexts/TeamSocketContext.tsx` — emitChatMessage
- `src/app/teams/[teamId]/components/TeamChatPanel.tsx` — 신규 바텀시트
- `src/app/teams/[teamId]/TeamBoard.tsx` — 채팅 버튼 + 마운트

### 추가된 소켓 이벤트
- C→S `chatMessage` `{ message, clientMsgId }`
- S→C `chatReceived` `{ messageId, teamId, userId, userName, message, timestamp }`

### 검증 방법
- 백엔드 `pnpm run build`(tsc) 통과 / 프론트 `tsc --noEmit` 에러 0, lint 변경파일 경고 0
- 적대적 코드리뷰 1회 (general-purpose) → XSS·room 권한 격리 안전 확인, 확정 결함 3건 수정
- **미실행(런타임)**: 2탭 송수신, 멀티 레플리카 cross-instance, 모바일 키보드 — 배포/로컬 기동 후 필요

### 코드리뷰 반영 (수정 완료)
- **self-filter → clientMsgId dedup 전환**: 본인 메시지 이중표시(currentUserId undefined 시) + 다중 탭 비동기화 + React key 충돌을 한 번에 해소
- **백엔드 `@Transform` trim**: 공백-only 메시지 차단 (프론트 trim 우회 방어)
- **팀 미참여 소켓 채팅 시 `ERROR` emit**: 침묵 실패 제거 (error-recovery 규칙)

### 알려진 한계 / 후속 (스코프 외 — 의도적 보류)
- **추방 후 재검증 없음**: join 후 멤버 추방돼도 소켓 생존 시 채팅 가능. 기존 task 이벤트에도 동일한 아키텍처 전반 이슈 — 추방 시 소켓 강제 정리는 별도 태스크. (room 격리로 외부 유출은 없음)
- **닫으면 메시지 초기화 / 안 읽은 카운트 없음**: "저장 없음" 단계의 의도된 동작. 패널 상시 마운트 + 안 읽은 배지는 저장 도입과 함께 후속.
- **멀티 룸 잔류**: 1소켓이 여러 팀 join 시 이전 room leave 안 함 — 프론트가 1소켓=1팀이라 현재 미발생.

### 저장(persistence) 후속 태스크
- `tasks-team-chat-persistence.md` (신설 예정) — `messageId = clientMsgId` 에코 구조라 서버 DB PK 발급 후 교체 흐름으로 자연 연결
