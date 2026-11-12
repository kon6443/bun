# 포트리스(턴제 포격 대전) — 설계 초안

> 결정 근거는 DECISIONS.md(D-번호). 🟡 항목은 STATUS "미해결 질문"(Q 번호)과 연결된다. 결정이 바뀌면 이 문서를 먼저 고친다.
> 수치(맵 크기·데미지·턴 시간·포인트)는 초안 — 엔진 원본(F1) 플레이 테스트 후 확정한다.

## 0. 가능성 판정 — 가능
- 턴제라 실시간 동기화가 없다. 한 턴의 입력(이동·각도·파워·무기)만 오가고, 같은 결정적 엔진이 모든 클라이언트와 서버에서 같은 결과를 낸다
- 이미 있는 것: 방·로비·비밀번호·초대 링크·채팅·끊김 복귀(테트리스 대전), 결정적 엔진 원본(프론트)→백 사본 + 해시·골든 테스트 체계, 리플레이 저장·재생기·공유·OG·도전장, 포인트 원장·스킨 레벨
- 새로 만드는 것: 포격 엔진(정수 물리·지형 비트맵), 턴 매치 서버, 포격 렌더러·조작 UI, 탱크 스킨 카탈로그

## 1. 범위 (D-002)
- 1차: 2~4인 **개인전·팀전(2:2)** 친구 방 · 비로그인 전부 플레이 가능 · 경기 리플레이·공유 · 로그인 보상(포인트·탱크 스킨, D-003)
- 혼자 하기: 방 없이 바로 하는 **AI전**(비로그인 첫 진입용, 소켓 없음) — 1차 포함(D-007). 방식은 §2-1
- 싱글 랭킹(GAME_SCORES `FORTRESS`, 예: 데일리 사격장·AI 연승) — 2차(D-007)
- 비목표(1차): 자동 매칭·레이팅, 관전, 아이템 상점, 실시간(동시 턴) 모드, 3D

## 2. 게임 규칙 (초안)
- 판: 논리 좌표 정수(예: 가로 2048 × 세로 1024 px), 지형 = 1비트 비트맵. 맵은 seed로 생성(높이 함수) 또는 손맵 N개 중 선택
- 물리: 고정 틱(30 또는 60/초) **정수 고정소수점**, 중력·바람(턴마다 seed로 변경, 화면에 화살표). `Math.random`·`Date`·부동소수·삼각함수 런타임 계산 금지 → 각도별 sin/cos는 정수 표(테트리스 중력 표와 같은 방식)
- 턴: 이동(연료 한도) → 각도(정수 도)·파워(0~100 정수)·무기 선택 → 발사 → 포탄·폭발·지형 붕괴·낙하가 멈출 때까지 시뮬 → 다음 턴
- 턴 순서: 단순 순환, 팀전은 팀 교대(A~B~A~B, 팀 안에서는 순환) — D-007. 포트리스식 딜레이는 후속 후보
- 탱크: 1차 3~4종, 각 기본 무기 2 + 필살기 1(쿨다운). 체력·폭발 반경 거리 비례 데미지(정수), 맵 밖 낙하 즉사, 낙하 데미지
- 승리: 마지막 생존 개인/팀. 턴 상한(예: 30라운드) 넘으면 남은 체력 합으로 판정(서든데스 대신 — 경기 길이 상한)
- 엔진 경계: 엔진은 순수 TS(외부 import 없음, ES2020) — 원본 프론트, 백엔드 사본 + 매니페스트 해시 + 골든(테트리스·디펜스와 같은 규칙)

## 2-1. AI (D-007)
- 방식: 엔진이 화면 없이 결정적으로 빠르게 돌므로 **AI = 시뮬레이션 탐색**. 후보(각도 × 파워 × 무기, 예: 각도 5도 간격 × 파워 5 간격 ≈ 수백 발)를 엔진으로 미리 쏴 보고 "적 데미지 − 자기 피해" 최대인 발을 고른다. 바람·지형까지 정확히 계산되므로 허접하지 않다(오히려 너무 정확해 일부러 오차를 넣는다)
- 난이도: 하·중·상 = 탐색 후보 수 + seed 기반 각도·파워 오차 + 이동 사용 여부. 상급은 거의 백발백중이라 오차 하한을 둔다
- 연산: 브라우저에서만 돈다(서버 0). 한 발 시뮬은 포탄 비행 수백 틱 — 수백 발 탐색이 수십~수백 ms 예상, **F1 PoC에서 실측**해 크면 후보 축소·Web Worker·턴 연출 중 미리 계산
- 결정적: AI도 seed로만 판단 → 리플레이·나중의 싱글 랭킹(Q3) 서버 재현 가능
- 구현 난이도: 엔진이 있으면 중하(파일 2~3개). 엔진 없이 AI만 따로는 불가 — 그래서 F2는 F1 뒤

## 3. 매치 모델 — 서버 권위 턴 (테트리스 대전과 다름)
- 테트리스 대전은 "각자 자기 판을 시뮬, 사후 리플레이 검증". 포트리스는 판을 공유하므로 **서버가 턴마다 엔진을 돌려 결과를 확정**한다
  1. 서버 → 현재 턴 플레이어·마감 시각 방송
  2. 턴 플레이어 → `TURN_SUBMIT { turnNo, move, angle, power, weapon }`
  3. 서버: Lua로 턴 번호·순서·마감 확인 → `applyAction` + `stateHash` → state JSON·행동 로그 저장(Redis) → 전원에게 `TURN_RESOLVED { action, stateHash }` 방송. 마감 초과는 서버가 `skip`, 이탈·끊김 유예 초과는 서버가 `resign`을 행동 로그에 넣는다(§10)
  4. 클라이언트는 같은 입력을 자기 엔진에 넣어 애니메이션 재생, `stateHash`가 다르면 서버 스냅샷으로 재동기화(버그 탐지 로그)
- 턴 시간 초과·끊김(D-004 ✅): 마감이 지나면 그 턴 스킵(패스), 연속 3회 스킵이면 탈락. 끊김 10초 유예는 방 코어 그대로
- 타이머: 상태는 Redis, 로컬 `setTimeout`은 보조, 요청 시점 lazy 마감 판정이 기준(기존 대전 원칙 — 레플리카가 죽어도 진행)
- 경기 중 채팅: 허용(D-004 ✅)
- 검증 비용: 턴당 applyAction 최악 0.37ms(PoC, D-009) — 동기 처리, 워커 풀 불필요

## 4. 방 — 테트리스 대전 방 코어 공용화 (D-001 #5)
- 공용화 방식(D-005 ✅ — A 채택):
  - (A) **공용 방 코어 추출**: `tetris-battle` 방 서비스에서 게임 무관 부분(CAS·토큰·비밀번호·로비·하트비트·준비·방장·강퇴·채팅·재대결)을 `src/modules/game-room/`으로 뽑고 테트리스·포트리스가 각자 매치 계층만 붙인다. 플레이어 부가정보(테트리스 스킨)는 게임별 opaque 필드로. **별도 리팩토링 슬라이스(F3)로 먼저**, 테트리스 대전 기존 테스트(방 서비스·매치·게이트웨이 spec)와 WS E2E를 무수정 통과하는 것이 게이트
  - (B) 복사 후 접두사·스킨 제거: 테트리스 무위험이지만 1,700줄 중복
- **F3 단계 분할**(방 서비스가 매치 lock·KO·스킨과 한 클래스 — `tetris-battle-room.service.ts` 1,710줄):
  - **F3a — 매치 무관 부품 추출(행동 변경 0)**: `src/modules/game-room/`에 ① 방 코드·비밀번호·playerToken·비밀번호 실패 잠금(`tetris-battle-room-tokens.ts` → 키 접두사 인자) ② 방 CAS 저장소(Lua `ROOM_CAS_SCRIPT`·load·compareAndSet·로비 ZSET·scan/sweep tail·로비 요약 캐시, 방 JSON 타입은 제네릭) ③ 텍스트 정책(`containsDisallowedChars`·방/플레이어 이름 검사·채팅 문장 준비) ④ 빈도 제한(`consumeRateLimit`, 한도 표 인자) ⑤ 하트비트·생존 확인 게이트 키. 테트리스 방 서비스는 이 부품을 쓰도록만 바뀌고 **Redis 키 문자열·Lua 본문·에러 코드·이벤트는 바이트 그대로**(배포 중 옛·새 레플리카가 같은 키를 읽는다)
  - **F3b — 라이프사이클 공용화(F4와 함께)**: 입장(4갈래)·이탈·준비·방장·강퇴·끊김·재대결을 공용 코어 + 게임별 매치 훅(`onLeaveDuringMatch`·`matchAlive`·`playerExtra`)으로. 훅 모양은 두 번째 소비자(포트리스 턴 매치)가 있어야 맞게 잡히므로 F4 설계와 같이 한다
  - 게이트(둘 다): 테트리스 대전 기존 spec **무수정** 통과 · `TETRIS_BATTLE_REDIS_TEST_PORT=6390` Redis E2E(skip 0 확인, lessons 2026-10-26) · WS E2E · 배선 spec(신규 모듈을 실제 import, lessons 2026-10-21) · `pnpm dev` 부팅 매핑 확인 · Redis 키 접두사 불변 단위 테스트
- 팀: 방 설정에 모드(개인/팀), 대기실에서 팀 선택(2:2), 시작 조건에 팀 균형 추가
- Redis 키 접두사 `fortress:` · namespace `/fortress`
- 프론트도 같은 결정: battle-ui(약 9.4천 줄)가 테트리스 namespace·엔진에 묶여 있어, (A)면 로비·대기실·초대·채팅·이모트·연결 배지를 소켓 타입 제네릭으로 분리(채팅·이모트·배지는 비용 작음), (B)면 수천 줄이 두 벌(WORKLOG 프론트 조사)

## 5. 결과·리플레이·공유
- 리플레이 = `{ engineVersion, config: MatchConfig, actions: Action[] }` (§10 — fire·skip·resign) — 서버가 턴 로그를 이미 갖고 있어 **클라이언트 제출이 필요 없다**(테트리스 대전의 제출·마감 흐름 생략)
- 경기 종료 시 서버가 결과·턴 로그를 DB 저장(신규 테이블 — 마이그레이션은 담당자 실행). 저장 크론 패턴(`pending-saves`, `TASK_SLOT===1`) 재사용
- 재생기: 같은 엔진에 턴 로그 → 재생/일시정지·배속·턴 단위 이동(테트리스 재생기보다 단순)
- 공유: 경기 링크 + OG 카드(game-share 구조), "최근 대전" 목록(테트리스 대전 P7 구조)

## 6. 화면 (프론트 조사 반영 — WORKLOG 2026-10-27)
- 1인용·기록 축은 디펜스 방식: `GameType`에 `fortress` 추가 + `GameUiConfig` + Generic 타입 → 랭킹·등록·공유·OG·재생기 조각·설정 틀·`ReloginButton`·`GameSurface`를 그대로 쓴다(수정 5~7·신규 4~5)
- 진입: `/games` 카드 → 포트리스 홈. 홈은 테트리스 개편안 위계를 따른다(D-002): 상단 바 → **플레이**(AI전 바로 시작 · 친구 방 만들기/코드로 참가) → 방 목록 → 내 탱크 한 줄 → 기록 탭(최근 대전 · 인기 리플레이) → 링크 줄(탱크 도감·포인트 내역)·소개 접기. 공용 게임 홈 컴포넌트 추출은 tetris-home 배포 뒤 F8
- 대전 화면(모바일 세로 우선): 월드 > 화면 카메라(팬·핀치 줌·포탄 추적), 지형 캔버스 부분 갱신, 하단 조작부(이동 ◀▶ · 드래그 조준 또는 각도 버튼 · 파워 게이지 길게 누르기 · 무기 · 발사), 턴 타이머·바람
- **새로 만드는 것(전례 0)**: 카메라·줌, 지형 파괴 렌더, 드래그 조준·파워 입력(`GamePad` 4슬롯·4방향과 안 맞음). 재사용: fixedStep·GameSurface·DPR·품질 자동 하향 패턴
- 엔진 규약: 디펜스 순수성 규칙 복제(ESLint·tokenScan·매니페스트·골든·버전 동결). 지형 `Uint8Array` 허용 여부는 F1에서 규칙 확정
- **F1 앞 PoC**: 지형 해시 비용·틱당 비용·리플레이 크기를 먼저 잰다(프론트 권고)

## 7. 로그인 유도 (D-003 ✅)
- 비로그인: AI전·친구 방·리플레이 전부 가능. 로그인 시: 포인트 적립 · 탱크 스킨 장착·강화(상대 화면·리플레이에도 보임) · 전적·승률 보관 · 이름 옆 배지
- 현황: 기조가 "로그인 없이도 가능", 적극 유도는 테트리스 스킨뿐(디펜스·랭킹·리플레이·대전엔 없음). 게스트에게 "로그인했다면 +N P" 대조 문구도 없다
- 노출 지점(포트리스): 결과 화면 게스트 분기 "로그인했다면 +N P · 전적 저장" · 대기실·경기 중 로그인 상대의 탱크 스킨·배지(보이는 차이) · 홈 "내 탱크" 한 줄(게스트는 "로그인하고 탱크 꾸미기") · 리플레이에도 스킨 고정
- 로그인 시점: 판 도중엔 막고(테트리스와 같은 "판이 끝난 뒤 로그인"), 경기 시작 시 로그인 상태만 인정 — 결과 화면 로그인 소급 없음(D-006 #7)

## 8. 포인트 (D-003 · D-006 ✅)
- 공용 원장 `USER_POINT_LEDGER`에 REASON `FORTRESS_MATCH` 추가(DB 변경 없음). `games.service.ts:445` 하드코딩은 건드리지 않고 포트리스 결과 저장 트랜잭션이 원장에 직접 1줄(REF_KEY = matchId:playerId 유니크로 중복 방지)
- 유효 경기의 "실제 발사"는 파워 1 이상 fire만 센다(파워 0 넘기기·스킵 제외, D-010)
- 적립·상한 규칙은 D-006(참가 20,000 · 승리 30,000 · KO 10,000×최대 3 · 유효 경기 조건 · 로그인 2명 이상 승리 보상 · 같은 상대 감쇠 · KST 일일 500,000 · USERS 행 잠금 직렬화)
- 원장 조회용 인덱스: 오늘 합계는 `(USER_ID, REASON, CRTD_AT)` 범위 — 기존 인덱스로 되는지 F7에서 실행 계획 확인

## 9. 위험
- 엔진 비결정성(정수 표·충돌 판정) → 서버·클라이언트 불일치. 대책: 골든 + stateHash 방송 + 재동기화
- 방 코어 추출이 배포된 테트리스 대전을 깨뜨림 → F3를 단독 슬라이스로, 기존 테스트 무수정 통과 게이트
- 1차 범위가 큼(다인원·팀) → 내부적으로 얇은 슬라이스로 쌓고 배포는 사용자 결정
- 포인트 파밍 → §8 상한·감쇠

## 10. 엔진 계약 v1 (백·프 공통 — 이 절이 정본, D-008)
- 위치: 원본 `next-bun/src/app/games/fortress/engine/` → 사본 `bun/src/modules/fortress/engine/`(F1b). AI `next-bun/src/app/games/fortress/ai/`는 순수성 규칙만 같고 **사본·매니페스트 대상 밖**(싱글 랭킹 Q3 때 재결정)
- 순수성: 디펜스 규약 복제(ESLint 글롭 `fortress/engine/**`·`fortress/ai/**`, tokenScan, 매니페스트 폴더 스캔, 골든, 버전 동결 `fortress/engine-versions/`, env `FORTRESS_GOLDEN_WRITE`·`FORTRESS_MANIFEST_WRITE`) + **typed array·ArrayBuffer 금지**. 비트 연산은 `random.ts`만
- 수치 척도: 좌표 서브픽셀 정수 ×1000, **30틱/초**, 각도 SIN 정수 표(0~90도, ×10000), 거리 `isqrt`, mulberry32·FNV-1a는 디펜스 `random.ts` 복제
- **지형 = 열별 고체 구간(span)**: `terrain.cols[x] = [top0, bottom0, top1, bottom1, …]` 정수 오름차순(동굴·오버행 가능). 폭발은 겹치는 열만 구간 빼기(반경 0 이하는 무동작), 충돌은 열 안 선형 탐색(열당 최대 8쌍이라 충분), 바뀐 열만 새 배열(구조 공유). 열당 구간 상한 8쌍(실측 최대 4쌍)
- **state는 순수 JSON**(정수·짧은 문자열·중첩 배열, 클래스·typed array·undefined 없음) — JSON 왕복 후 해시 동일(골든 고정). 서버 Redis 스냅샷·재동기화에 그대로 쓴다
- `MatchConfig { seed: uint32, mapId: 'hills'|'canyon', mode: 'ffa'|'team', players: [{ slot: 0..3, team: 0|1, tankId: 0..2 }] }` — ffa는 team 무시, 시작 순서·스폰은 seed로 엔진이 정함
- `createMatch(config) → { ok: true, state } | { ok: false, reason }` — 인원 2~4, team은 2:2, slot 중복 금지
- `applyAction(state, action) → { ok: true, state, events } | { ok: false, reason }` — **입력 state 불변**, 해시는 계산하지 않음
  - `{ kind: 'fire', move, angle, power, weaponId }` — 현재 턴 slot(`state.turn.slot`)의 행동. angle 절대 0~180(0=오른쪽, 90=위) · power 0~100 · move는 의도한 dx(px), |move| ≤ 이번 턴 연료(턴마다 초기화, 탱크별), 엔진이 1px씩 걸으며 경사·절벽·낙하 처리
  - `{ kind: 'skip' }` — 턴 마감 초과(서버만 넣음), 연속 3회면 탈락(D-004). **자발적 패스 없음**(파워 0 발사로 대신). `skips`는 연속 시간 초과 수 — 자기 턴의 fire(파워 0 포함)가 0으로 되돌린다(D-010)
  - `{ kind: 'resign', slot }` — 이탈·끊김 유예 초과. 자기 턴이 아니어도 서버가 정한 순서로 넣는다. 이미 탈락이면 ok:false(서버는 무시)
  - 실패 사유: `NOT_RUNNING` · `BAD_KIND` · `MOVE_RANGE` · `ANGLE_RANGE` · `POWER_RANGE` · `WEAPON_UNKNOWN` · `WEAPON_COOLDOWN` · `SLOT_NOT_ALIVE`
- state 주요 필드: `turn { no, slot, round }` · `tanks[slot] { x, y, hp, alive, fuel, cooldown, skips }` · `wind` −10~+10(다음 턴 값은 턴 종료 때 rng, 발사 전 화면 표시) · rng(uint32) · `result: { kind: 'ongoing' } | { kind: 'win', team?: 0|1, slots: int[] } | { kind: 'draw' }`
- 턴 순서: ffa는 시작 slot부터 생존 slot 오름차순 순환 · team은 A·B 교대, 팀 안 다음 생존자 순환, 1명 남아도 교대 유지(A1 B1 A1 B2 …). `round = floor(turn.no / 시작 인원) + 1`(D-009). `maxTurns`(= 30 × 시작 인원) 도달 시 남은 HP 합(team은 생존 팀원 합)으로 판정, 같으면 draw
- 데미지: 폭발 `floor(base × (r − d) / r)`(자기 피해 포함) · 낙하는 임계 높이 초과 px × 계수 · 바닥 밖 낙하 즉사 · 필살기 쿨다운은 자기 턴 N회
- 경계: 탄이 좌·우·아래로 벗어나면 소멸, 위는 계속 비행. `MAX_TICKS_PER_TURN`(초안 1800 = 60초, 이동+비행+정착) 초과 시 남은 탄 소멸·낙하 즉시 정착
- events(렌더러 전용, 해시 대상 아님, 서버 무시): 틱 표시 `move{path}` · `shot{projectileId, samples}` · `explode{x,y,r}` · `terrain{x0,x1}` · `damage{slot,amount}`(amount = 실제로 깎인 HP) · `fall{slot,path}`(비행 중 발밑이 파여도 낙하는 모든 탄이 끝난 뒤 한 번 정착 — D-010) · `death{slot, cause: 'hp'|'out'|'resign'|'skips'}`
- `stateHash(state) → hex8` — FNV-1a, 고정 순서 정수열(버전·턴·rng·바람·탱크 필드·열별 span 길이와 값)
- `simulateMatch(config, actions[]) → { ok: true, final, hashes[] } | { ok: false, reason, at }` — 리플레이·골든용, 리플레이 `turns[]` = action 목록
- `previewShot(state, input)` — 지형·상태를 확정하지 않고 첫 탄 착탄점·예상 피해만(AI 탐색 비용 절감, applyAction과 같은 탄도 코드)
- AI: `chooseTurn(state, slot, level: 0|1|2, seed) → action` — 하·중은 previewShot, 상은 applyAction까지
- 초안 상한: 월드 2048×1024 · 최대 4인 · 30라운드(`maxTurns = 30 × 시작 인원`) · 틱 상한 1800 · 열당 8쌍(실측 최대 4쌍)
- **구체화(D-009)**: 좌표는 탄만 ×1000, 탱크·지형 px 정수(y 아래로 증가) · **파워 0 = 탄 없이 턴 종료**(패스 대용) · `round = floor(turn.no / 시작 인원) + 1` · 데미지 d = 탱크 판정 원(반지름 9) 가장자리까지 · 남의 턴 기권은 턴·바람 유지, 현재 턴 기권은 턴 넘김 · 쿨다운은 자기 턴 종료 때 −1 · state 추가 필드 `mode·mapId·players·maxTurns·lastByTeam`, `tanks[slot]`(빈 slot null) · `simulateMatch` `at` = 행동 인덱스(설정 오류 −1, `CONFIG_REASON`) · 골든 형식 `{ name, config, actions, expected }` · 탄 충돌 3px 간격, 같은 틱은 탄 id 순
- **수치 확정(D-010)**: F1 5단계 플레이 조정값이 정본(엔진 `data.ts`·`constants.ts`, 표는 WORKLOG F1 5단계 절). 사본 `bun/src/modules/fortress/engine/` = 원본 바이트 동일, 매니페스트 `bun/src/modules/fortress/fortress-engine-manifest.json`
- **성능(PoC)**: applyAction 최악 0.37ms · stateHash 0.09ms · state JSON ≤ 25.6KB → 서버 턴 처리 동기, 워커 풀 불필요
- **PoC 측정 항목**(WORKLOG에 기록): 최악 무기 applyAction 시간·stateHash 시간·state JSON 크기(Redis 스냅샷)·4인 30라운드 리플레이 크기·AI 난이도별 chooseTurn 시간·열당 구간 수 분포·Node(백) 동일 측정

## 11. 소켓 계약 v1 (F4 — 백 정본 `src/modules/fortress/fortress.events.ts` 예정, D-011·D-012)
> 방·로비 부분은 테트리스 대전(`tetris-battle.events.ts`)과 이벤트명·ack 형태·에러 코드를 같게 두고, 포트리스 차이만 적는다.
- namespace `/fortress` · Redis 접두사 `fortress:` · ack `{ ok: true, data } | { ok: false, code, message }` · 방 코드·이름·비밀번호·채팅·이모트·하트비트·강퇴·재연결 토큰·자리 넘겨받기 규칙은 테트리스 대전과 같다(F3b 공용 코어)
- **RoomPlayer**: 공용 base(playerId·name·ready·connected·isGuest) + 게임별 값은 `extra` 하나 — 포트리스 `extra: { team: 0|1|null, tankId: 0..2, skin }`(ffa는 team null, skin은 F7 전까지 default). 테트리스 `skins`는 바이트 그대로(F3a 원칙)
- **방 생성 추가 필드**: `mode: 'ffa'|'team'` · `mapId: 'hills'|'canyon'|'random'` · `maxPlayers` 2~4(team은 4 고정). `'random'`은 **서버가 시작 때 실제 맵으로 정해** `config.mapId`에 넣는다(config에 'random'은 오지 않는다 — 엔진은 `MAP_IDS`만 받는다)
- **방장 `updateSettings { mode?, mapId?, maxPlayers? }`**(WAITING만, 바뀌면 전원 ready=false): 현재 인원보다 작은 maxPlayers는 `TOO_MANY_PLAYERS` · team으로 바꾸면 maxPlayers=4로 맞추고 입장 순서대로 team 0,1,0,1 자동 배정(인원이 4명이 아니어도 허용, 시작 때 `TEAM_UNBALANCED`) · ffa로 바꾸면 team null
- **대기실 추가**: `setTeam { team: 0|1 }`(team 모드만, 팀당 2명 초과면 `TEAM_FULL`) · `setTank { tankId: 0..2 }` — 둘 다 ready를 풀지 않는다(시작 조건과 무관)
- **시작 조건**: 연결된 플레이어 전원 ready(방장 제외) · ffa 2명↑ · team은 정확히 2:2(`TEAM_UNBALANCED`). 슬롯은 입장 순서로 0..n−1, 시작 순서·스폰은 seed로 엔진이 정한다
- **로비 전체 채팅**(D-016): 테트리스 대전 로비 채팅과 같은 계약(`joinLobbyChat`·`leaveLobbyChat`·`lobbyChat`·`lobbyChatMessage`·`LOBBY_CHAT_NOT_JOINED`), 채널·최근 기록은 `fortress:lobby-chat`로 분리(최근 50개·30분, 저장 안 함)
- **채팅**: 경기 중에도 전원 허용(D-004 — 테트리스는 탈락자만). 자발적 기권(`forfeit`)은 F4에 없다 — 경기 중 `leaveRoom` = 즉시 resign
- **엔진 버전**: `matchStarting`·`resync` ack의 `engineVersion`이 클라이언트 `ENGINE_VERSION`과 다르면 클라이언트는 "새로고침 필요"를 안내한다(배포 사이 엔진 변경)
- **TurnInfo** `{ seq, turnNo, slot, deadlineAt, turnMs, remainingMs }` — 턴 정보는 이 모양 하나. `seq` = 지금까지 적용된 행동 수(= 다음 행동의 actions 인덱스) · `deadlineAt`(ISO)은 서버 시계 기록용 · 남은 시간 표시는 **`remainingMs`**(서버가 보낼 때 계산, 기기 시계 무관)
- 서버 → `matchStarting { matchId, engineVersion, config: MatchConfig, slots: [{ slot, playerId, name, skin }], turn: TurnInfo, startInMs, startAt }`(skin = 시작 때 고정한 탱크 스킨 — resync·재연결 스냅샷 slots에도 같은 값. 경기 중 나가 roomState에서 빠진 참가자도 이 값으로 그린다, 2026-11-02) — 클라이언트는 `createMatch(config)`로 같은 첫 state를 만든다. **별도 `turnStarted` 이벤트는 없다**
- 클라이언트 → `turnSubmit { matchId, seq, move, angle, power, weaponId }`(`seq` = 받은 TurnInfo.seq) → ack `{}` 또는 `NOT_YOUR_TURN` · `TURN_MISMATCH`(seq가 다름 — 늦은 제출) · `TURN_EXPIRED` · `MATCH_NOT_STARTED`(시작 카운트다운 `startAt` 전 — D-021) · `ACTION_REJECTED`(엔진 reason을 message에) · `MATCH_NOT_FOUND` · `RATE_LIMITED`(방·플레이어당 10회/5초)
- 서버 → `turnResolved { matchId, seq, action, cause: 'player'|'timeout'|'leave'|'disconnect', stateHash, next: TurnInfo | null }` — `seq` = 이번 행동의 actions 인덱스(적용 후 행동 수 = seq + 1) · action은 엔진 Action 그대로(fire·skip·resign) · **남의 턴 resign도 이 이벤트**(턴 유지, next는 진행 중 턴 그대로·remainingMs 갱신) · next null = 경기 끝. 클라이언트는 `applyAction` 후 해시·`next.slot`(= `state.turn.slot`)·`seq`(= 내가 적용한 행동 수)를 비교 → 다르면 `resync`
- **제출이 남의 resign과 겹칠 때**(D-015): 서버는 seq 정의대로 `TURN_MISMATCH`. 클라이언트는 최신 턴이 (slot = 나 · turnNo 같음 · seq 증가)면 같은 입력을 최신 seq로 1회 재제출, turnNo·slot이 바뀌었으면 입력 폐기, 그 밖은 `resync`. resign의 `turnResolved`와 mismatch ack의 **도착 순서는 보장하지 않는다**(다른 레플리카 처리·어댑터 pub/sub) — mismatch 뒤 새 turnResolved를 잠깐(약 1초) 기다리고 없으면 resync
- 표시(프론트 몫): 연출 중 입력 잠금·타이머 숨김, 연출이 끝나면 수신 시각 + remainingMs 기준으로 남은 시간, 5초 이하 경고. `matchEnded`가 연출보다 먼저 와도 결과 화면은 연출 뒤
- 클라이언트 → `resync { matchId, seq?, clientHash? }` — 해시가 달라 요청할 때는 마지막으로 적용한 seq와 자기 해시를 싣는다(서버 버그 탐지 로그) → ack `{ engineVersion, config, actions[], stateHash, turn: TurnInfo | null }`. 재연결 `joinRoom` ack의 `rejoin.match`도 같은 모양. 액션 재적용으로 복원하고 state JSON은 보내지 않는다(엔진 결정적, 120턴 재적용 수십 ms)
- 서버 → `matchEnded { matchId, result: MatchResult, players: [{ playerId, name, slot, team, hp, damage, kos, place }], replay?: { id } }`(F6에서 replay id). 집계는 F2 결과 화면과 같다(준 피해 = 자기 턴 damage amount 합, KO = 자기 턴 hp·out 사망)
- **place**: team — 이긴 팀 2명 1위, 진 팀 2위 · ffa — 승자 1위, 나머지는 늦게 탈락할수록 높은 순위(같은 행동에서 함께 탈락하면 같은 순위) · 턴 상한 판정 — 생존자는 HP 높은 순(같으면 같은 순위), 탈락자는 그 아래 탈락 순 · ffa draw — 최고 HP 동점 생존자 공동 1위, 나머지는 같은 규칙(함께 죽어 끝나면 함께 1위) · team draw — 4명 모두 1위 · 같은 값은 같은 순위, 다음 순위는 건너뛴다(1, 1, 3). 구현 `fortress-match.rules.ts`
- **마감**: `turnMs` = 20초 + 연출 시간 + 지연 여유 2초. 연출 시간 = `ceil(eventsEndTick(events) / 30)`초, 상한 9초(엔진 이론 상한 60초, D-013). `eventsEndTick` = shot 시작 틱 + 샘플 수 − 1 · move 걸음 수 ÷ 3 올림(연출 기준 — 이동 중 추락사면 엔진 틱보다 최대 1 큼) · 나머지 t · 이벤트 없음 0, 연출 꼬리 제외. 여유 2초는 화면 연출 꼬리(최대 약 1.1초)와 네트워크 지연을 덮는다. `eventsEndTick`은 엔진 순수 함수(서버·프론트 같은 함수, D-012). 마감 지나면 서버가 `skip`(연속 3회 탈락). 20초는 F5 플레이테스트의 턴당 사용 시간 분포로 재조정
- **타이머**: 경기 JSON `fortress:match:{matchId}`(config·state·actions·deadlineAt·version, TTL) + 마감 ZSET `fortress:deadlines`. 처리한 레플리카가 로컬 `setTimeout` + `TASK_SLOT===1` 스위퍼(1초 주기 ZSET 범위 조회)가 레플리카 사망을 보완. 모든 마감 처리는 Lua CAS(seq·deadline 재확인)라 중복 실행돼도 1번만 적용. `turnSubmit`도 요청 시점에 마감을 lazy 판정
- **시작 순서(리뷰 B1, 2026-11-02)**: 경기 키는 마감 ZSET·타이머 **없이** 만들고, 방 CAS(PLAYING + match 참조)가 성공한 뒤에 마감을 건다(`activate`). 그 사이 레플리카가 죽으면 경기 키는 아무도 진행하지 않아 TTL로 사라진다 — 방 없는 경기가 스위퍼의 시간 초과 skip만으로 끝나 공개 목록에 저장되는 일을 막는다. 첫 마감은 경기가 아직 버전 1일 때만 건다(`MATCH_ACTIVATE_SCRIPT` — 그 사이 다른 레플리카가 행동을 적용했으면 그 CAS가 이미 마감을 썼다, 2차 리뷰). 방 CAS 뒤 마감 걸기가 실패하면 경기 키를 지우고 방을 WAITING·match 없음으로 되돌려 roomState를 알린다(`revertStart` — 아직 아무도 matchId를 모른다). 되돌리기도 실패하면 PLAYING·키 없는 방으로 남아 다음 생존 확인(로비 목록·입장·이탈·준비 때 15초 게이트)의 repairEndedMatch가 RESULT로 회수한다. 남은 한계: 방 CAS와 activate 사이 프로세스 사망(마이크로초 창)은 생존 확인의 lazy 처리가 마감을 다시 걸어 방에 붙은 정상 경기로 진행된다
- **끊김**: 경기 중 끊김 유예 **30초**(테트리스 10초 — 턴제라 앱 전환·카톡 공유 복귀를 허용) 초과 시 `resign`(cause `disconnect`). 유예 중 자기 턴은 정상 진행(마감 → skip)
- 에러 코드 추가: `NOT_YOUR_TURN` · `TURN_MISMATCH` · `TURN_EXPIRED` · `MATCH_NOT_STARTED` · `ACTION_REJECTED` · `TEAM_FULL` · `TEAM_UNBALANCED` · `TOO_MANY_PLAYERS`

## P. 구현 슬라이스 (Q 확정 후)
| # | 슬라이스 | 레포 | 게이트 |
|---|---|---|---|
| F0 | 기획·문서·결정 | 메인 | Q1~Q6 확정 |
| F1 | 포격 엔진 원본(정수 물리·지형·탱크·무기) + 골든 + 프로토타입 화면(로컬 2인 핫시트) | 프 | 골든·플레이 테스트, 수치 확정 |
| F1b | 엔진 사본 + 매니페스트·골든 spec | 백 | 바이트 동일 |
| F2 | AI전(소켓 없음) | 프 | Q2 |
| F3a | 방 부품 추출(행동 변경 0) | 백 | 기존 spec 무수정·Redis E2E·키 불변 |
| F3b | 방 라이프사이클 공용 코어 + 프 로비·대기실·채팅 제네릭 | 백·프 | F4와 함께, 같은 게이트 |
| F4 | 턴 매치 서버(개인·팀, 타이머·스킵) | 백 | WS E2E 다중 클라이언트 |
| F5 | 로비·대기실·대전 화면 연동 | 프 | 실서버 2~4탭 |
| F6 | 결과 저장·리플레이·공유·최근 대전 | 백·프 | 마이그레이션 실행(담당자) |
| F7 | 포인트 적립·탱크 스킨 | 백·프 | Q1 |
| F8 | 포트리스 홈(공용 게임 홈) | 프 | tetris-home 배포 후 |

## 12. F6 결과·리플레이 (초안)
> 테트리스 대전 결과 저장(`tetris-battle-result.service.ts`·`-browse.service.ts`, tetris-battle DESIGN §17·§19)을 따르되, 서버가 행동 로그를 이미 가져 **제출·검증 단계가 없다**(§5).

### 테이블 (마이그레이션 3개 — 1파일 1테이블, 실행은 담당자)
| 테이블 | PK | 컬럼 |
|---|---|---|
| `FORTRESS_MATCHES` | `MATCH_ID` VARCHAR2(16) | `ROOM_NAME` VARCHAR2(80) NULL 허용(배포 전 시작 경기) · `MODE` ffa/team · `MAP_ID` VARCHAR2(16) · `SEED` NUMBER(10) · `ENGINE_VERSION` NUMBER(5) · `PLAYER_COUNT` 2~4 · `TURNS`(끝난 턴 수 = 최종 `state.turn.no`) · `RESULT_KIND` win/draw · `WINNER_TEAM` 0/1/NULL(team 승리만) · `STARTED_AT`·`ENDED_AT`·`CRTD_AT` TIMESTAMP WITH TIME ZONE · `IS_HIDDEN` 0/1. 인덱스 `(CRTD_AT)`(최근 목록) |
| `FORTRESS_PLAYERS` | (`MATCH_ID`, `PLAYER_ID`) | `SLOT` 0~3 · `NAME` VARCHAR2(48) · `USER_ID` NULL 허용(게스트·탈퇴, FK USERS SET NULL) · `TEAM` 0/1/NULL(ffa) · `TANK_ID` · `HP` · `DAMAGE` · `KOS` · `PLACE` 1~4. FK 경기 CASCADE |
| `FORTRESS_REPLAYS` | `MATCH_ID` | `ENGINE_VERSION` · `REPLAY` BLOB(gzip JSON `{ config, actions, slots, stateHash }`) · `CRTD_AT`. FK 경기 CASCADE. 목록 조회가 LOB을 읽지 않게 분리(테트리스와 같은 이유) |

### 리플레이 id
- **replay id = matchId**(경기당 리플레이 1개). 경기 id는 시작 때 이미 있으므로 미리 발급할 것이 없고, 저장 전에도 `matchEnded.replay = { id: matchId }`를 실을 수 있다 — 계약 파일(`fortress.events.ts`)은 바꾸지 않는다(`replay?` 필드 이미 있음, 이제 항상 채움)
- 테트리스는 참가자별 리플레이(matchId + playerId)라 달랐다. 포트리스는 판 하나를 공유하므로 경기당 1개

### 저장 흐름 (멀티 레플리카)
1. 경기를 끝내는 행동의 CAS **직전**에 `fortress:pending-saves`(ZSET matchId → 처리 시각 ms)에 넣는다 — CAS 뒤에 넣으면 그 사이 레플리카가 죽을 때 저장 대기에서 빠진다. CAS에 지면 경기는 PLAYING이라 저장 쪽이 건너뛰고 나중에 다시 본다
2. CAS를 이긴 레플리카가 방송(`matchEnded` + replay id) 뒤 바로 저장을 시도한다(주 경로, 기다리지 않음)
3. 저장(정확히 1번): 완료 표시 `fortress:match:{id}:saved`(String, TTL 2시간)면 끝 → 진행 가드 `fortress:match:{id}:saving`(SET NX EX 120) → Redis 경기 JSON 읽기(ENDED만) → `dataSource.transaction`에서 경기 행이 이미 있으면 건너뜀, 없으면 경기·참가자·리플레이 INSERT → 완료 표시 → 저장 대기에서 뺀다. 실패하면 가드를 풀고 대기에 남긴다
3-1. 결과 조회 lazy 저장이 `busy`(다른 레플리카가 저장 중)면 404를 내지 않고 짧게(상한 있는 폴링) DB 행을 기다린다 — matchEnded 직후 조회가 저장 가드 창에 걸리는 경우(리뷰 A1, 2026-11-02)
4. 보완: 크론(30초, `ENV` QA·PROD + `TASK_SLOT=1` 2단 가드)이 지난 대기를 20개씩 다시 저장 · 결과 조회가 DB에 없으면 Redis의 끝난 경기를 그 자리에서 저장(lazy). 경기 키가 TTL로 사라졌으면 대기에서 뺀다
5. 동시 저장 경합(가드 TTL 만료 등)은 DB PK가 막는다 — 유니크 위반(ORA-00001)은 **경기 행이 실제로 있을 때만** "이미 저장됨"으로 본다(없으면 다시 던져 대기에 남긴다 — 참가자·원장 유니크 위반으로 경기가 조용히 빠지지 않게, 리뷰 A2). 탈퇴 사용자 FK 위반(ORA-02291)은 그 USER_ID만 비우고 1번 더(테트리스 L6)
6. F7 포인트: 같은 트랜잭션 안 `writeRows(manager, …)` 뒤에 원장 행을 붙일 자리(REF_KEY = matchId:playerId)

### 서버 저장 원본 추가 필드 (Redis `StoredMatch`, 계약 아님)
- `roomName` · `engineVersion`(시작 때 값) · `endedAt`(ms) · `slots[].userId`(로그인 유저, 게스트 null). 배포 전에 시작한 경기는 없을 수 있어 저장 때 기본값(NULL·현재 `ENGINE_VERSION`·저장 시각·null)

### REST (인증 없음 — 게스트 공개, 스로틀 초당 3·분당 60 = 테트리스 결과 조회와 같음)
| 라우트 | 응답 `data` | 에러 |
|---|---|---|
| `GET /fortress/matches?limit&cursor` | `{ items: [{ matchId, roomName, mode, mapId, playerCount, turns, result: { kind, team }, endedAt, players: [{ name, slot, team, place }] }], nextCursor }` — CRTD_AT DESC·MATCH_ID DESC 키셋, 기본 10·최대 20 | 422 cursor |
| `GET /fortress/matches/:matchId` | `{ matchId, roomName, mode, mapId, seed, engineVersion, playerCount, turns, result: { kind, team }, startedAt, endedAt, players: [{ playerId, name, slot, team, tankId, hp, damage, kos, place }] }` — 순위 오름차순, 같으면 slot | 404 `FORTRESS_MATCH_NOT_FOUND`(없음·숨김·진행 중) |
| `GET /fortress/matches/:matchId/replay` | `{ matchId, engineVersion, config, actions, slots: [{ slot, playerId, name }], stateHash }` — 클라이언트는 `simulateMatch(config, actions)` | 404 `FORTRESS_MATCH_NOT_FOUND` · `FORTRESS_REPLAY_NOT_FOUND` |
- 시각은 UTC ISO. userId는 응답에 싣지 않는다
- "내 최근 경기"는 테트리스 대전에 없어 1차 제외(필요하면 `IDX (USER_ID)` 추가와 함께 후속)

## 13. F7 포인트·탱크 스킨 (초안)
> D-003·D-006·D-010을 서버 데이터로 옮긴 것. 모호한 곳은 보수적으로(덜 주는 쪽) 정했고 ⚖️로 표시한다 — 사용자 확인 대상.

### DB — 변경 없음(마이그레이션 0)
- 포인트: 공용 원장 `USER_POINT_LEDGER`에 REASON **`FORTRESS_MATCH`**(CHECK는 형식만) · REF_KEY **`matchId:playerId`** · (USER_ID, REASON, REF_KEY) 유니크가 중복 적립을 막는다 · CRTD_AT = 결과 저장 트랜잭션 시각(경기 행 CRTD_AT과 같은 값)
- 탱크 스킨: 기존 `USER_SKIN_EQUIPS`·`USER_SKIN_LEVELS`에 SLOT **`FORTRESS_TANK`** 행(CHECK는 형식만). 강화 소비는 기존 `SKIN_UPGRADE`(REF_KEY `FORTRESS_TANK:아이템:목표레벨`) · 비용·레벨(Lv1~5)은 테트리스와 같은 `SKIN_LEVEL_COSTS`
- 카탈로그는 코드(`fortress-skins.ts`) — 아이템을 늘려도 DB 변경 없음. 프론트는 모르는 id를 default로 그린다(계약 `FortressTankSkin`)

### 적립 (결과 저장 트랜잭션 안 — §12 저장 흐름 6)
| D-006 | 서버 데이터 | 구현 |
|---|---|---|
| #1 참가 20,000 · 승리 30,000 · KO 10,000×최대 3 | 승리 = `state.result.kind==='win'`이고 `result.slots`에 포함(ffa 승자·턴 상한 판정 승자·이긴 팀 2명 — 죽은 팀원 포함) · KO = 집계 `kos`(matchEnded와 같은 값) | `fortress-points.rules.ts` |
| #2 유효 경기: 자기 턴 실제 발사 3회↑ · 경기 6턴↑ | 실제 발사 = 파워 ≥ 1 fire(D-010), 행동 로그를 엔진으로 재적용해 각 fire의 턴 주인 slot을 센다 · 6턴 = 진행한 턴 수 `playedTurns(state)` — 엔진은 승패를 낸 턴에서 `turn.no`를 올리지 않으므로(턴 상한 판정만 올린 뒤 끝남) 그 턴을 더한다(리뷰 B2, 2026-11-02). DB `TURNS`는 `turn.no` 그대로 | 미달이면 그 참가자 0(원장 행 없음) |
| #3 승리·KO는 로그인 2명↑ 경기만 | 로그인 = 경기 시작 때 `slots[].userId`(서로 다른 userId 수) | 미만이면 참가만 |
| #4 같은 상대 감쇠 | 조합 = 이 경기의 **나 외 로그인 참가자 userId 집합**(팀원 포함 ⚖️) · n번째 = KST 오늘 저장된 경기 중 내가 로그인으로 참가했고 조합이 같은 경기 수 + 1(유효·무효 모두 셈 ⚖️) | 1~3번째 100% · 4~5번째 **승리·KO 몫** 50%(내림) · 6번째부터 승리·KO 0 = 참가만 ⚖️. 조합이 비면(로그인 상대 없음) #3으로 이미 참가만 |
| #5 KST 일일 500,000 | 오늘(KST 00:00 이후 CRTD_AT) `FORTRESS_MATCH` 합계 | 남은 한도로 잘라 적립, 잘렸으면 MEMO에 "일일 상한 도달", 남은 한도 0이면 행 없음 |
| #6 USERS 행 잠금 직렬화 | 이 경기 로그인 참가자 USERS 행을 **userId 오름차순**으로 `FOR UPDATE`(교착 방지) 뒤 #4·#5를 읽는다 | 레플리카가 달라도 같은 사용자의 두 경기 저장이 줄 선다 · 강화(같은 행 잠금)와도 줄 선다 |
| #7 로그인 소급 없음 | 시작 때 `userId`만 본다 | 게스트 자리는 끝까지 0 |
- **기권자 ⚖️**: 자기 slot의 resign(이탈·끊김 유예 초과)이 행동 로그에 있으면 0 — 3발 쏘고 나가 상대에게 승리를 넘기는 파밍을 막는다
- 탈퇴(USERS 행 없음): 잠금 결과에 없으면 건너뛴다(§12 FK 재시도와 같은 결과)
- 멱등: 경기 행이 이미 있으면 트랜잭션 전체를 건너뛰고(§12) · 원장 유니크가 2중으로 막는다 · 같은 트랜잭션이라 경기 저장과 적립이 함께 커밋/롤백
- 계산 위치: 엔진 재적용(최대 수십 ms)은 트랜잭션 **밖**(toRecord), 잠금 뒤에는 합계·조합 조회와 INSERT만

### 결과 노출 — 계약 파일 변경 없음
- `matchEnded`는 저장 전에 방송되므로 적립액을 싣지 않는다(감쇠·상한은 저장 트랜잭션에서 정해진다)
- **`GET /fortress/matches/:matchId/points`**(로그인 전용, JwtAuthGuard) → `{ matchId, participant, earned, memo }` — participant = 내가 로그인으로 참가했는지, earned = 이 경기 원장 금액(없으면 0), memo = 내역(참가·승리·KO·감쇠·상한). 저장 전이면 그 자리에서 저장(§12 lazy). 404 `FORTRESS_MATCH_NOT_FOUND`
- 게스트 "로그인했다면 +N P" 문구용 수치는 프론트 상수(참가 20,000·승리 30,000·KO 10,000×3)로 — 서버 API 없음
- 포인트 내역(`GET /users/me/points/history`)의 `FORTRESS_MATCH`·`FORTRESS_TANK` 강화 줄은 `meta: null` — 화면은 `memo`로 표시(meta 유니온 확장은 프론트 협의 후속)
- 미검증: 오늘 합계·같은 조합 조회의 실행 계획(§8 인덱스 확인) — `db:select`는 EXPLAIN을 못 돌린다. 오늘 합계는 `UQ_USER_POINT_LEDGER_REF (USER_ID, REASON, …)` 앞부분, 같은 조합은 `IDX_FT_MATCHES_CRTD` + 참가자 PK를 탈 것으로 본다

### 탱크 스킨
- 카탈로그(`fortress-skins.ts`): slot `tank`(DB `FORTRESS_TANK`) — `default`(기본) + 무료 3종 `desert`·`arctic`·`neon` ⚖️(이름·시각은 프론트와 확정)
- REST(로그인 전용, 테트리스 `users/me/skins`와 같은 의미·에러): `GET /fortress/skins/me` → `{ equipped: { id, level }, points, maxLevel, levelCosts, items: [{ id, unlock, owned, equipped, level, nextCost }] }` · `PUT /fortress/skins/me { skinId }` 장착 · `POST /fortress/skins/me/upgrade { skinId, level }` 강화. 에러 `USER_SKIN_UNKNOWN` 422 · `USER_SKIN_NOT_OWNED` 403 · `USER_POINTS_INSUFFICIENT`/`USER_SKIN_LEVEL_MISMATCH` 409 · `USER_NOT_FOUND` 404 — 저장·강화 트랜잭션은 `UserSkinService`의 슬롯 공용 메서드(테트리스와 같은 코드)
- 흐름: **방 입장·생성·재연결** 때 게이트웨이가 계정 장착(`FORTRESS_TANK` + 레벨)을 읽어 신원에 붙인다(클라이언트 값은 받지 않는다, 게스트 default, 조회 실패면 새 자리 default·기존 자리 유지 — 테트리스 `enterIdentity`와 같다) → `StoredPlayer.skin` → `RoomPlayer.extra.skin` · **경기 중인 자리는 바꾸지 않는다**(화면·리플레이가 같은 스킨) · 경기 시작 때 `StoredMatchSlot.skin`에 고정 → 계약 `MatchSlot.skin`(matchStarting·스냅샷, 이탈자 표시용 — 2026-11-02) → 리플레이 본문 `slots[].skin` → `GET …/replay` `slots: [{ slot, playerId, name, skin }]`(F7 전 리플레이는 default로 채움). 엔진 `MatchConfig`는 건드리지 않는다
