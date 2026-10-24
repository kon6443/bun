# 리플레이 조회수·시청시간 — 결정 로그

> 현황은 [STATUS.md](STATUS.md). 결정이 바뀌면 여기에 새 항목을 추가하고 이전 항목에 `→ D-xxx로 대체`를 단다.

## D-001 저장 — 일별 집계 테이블 하나, 누적은 SUM

- **결정**: `GAME_REPLAY_VIEW_STATS`(SCORE_ID, BUCKET_START[KST 00:00], GAME_TYPE, VIEW_COUNT, WATCH_MS). 기록 × 하루 1행. 누적 값은 저장하지 않고 SUM으로 읽는다.
- **검토한 대안**
  - `GAME_SCORES.VIEW_COUNT` 컬럼: 가장 단순하지만 "이번 주 많이 본" 질의를 할 수 없다. 1차 구현을 이 방식으로 썼다가 기간별 인기 요구가 들어와 실행 전에 교체했다.
  - 조회 이벤트 로그(조회 1회 = 1행): 분석 자유도는 가장 높지만 행이 조회 수만큼 늘고, 화면에 필요한 건 일 단위 합뿐이다.
  - 누적 컬럼 + 일별 테이블 병행(현업에서 흔함): 읽기는 빠르지만 두 곳의 값이 어긋날 수 있다. 랭킹 목록은 최대 100건이라 `IN + GROUP BY` 한 번이면 충분해 병행하지 않는다. 느려지면 그때 누적 컬럼을 추가한다.
- **공용화**: TETRIS·DEFENSE 단일 플레이 기록이 모두 `GAME_SCORES`라 테이블 하나로 두 게임을 다룬다. 복합 FK (SCORE_ID, GAME_TYPE)가 게임 종류 일치를 강제한다. 테트리스 대전 리플레이(`TETRIS_BATTLE_REPLAYS`, 키 matchId+playerId)는 이번 범위가 아니다. 대전에 붙일 때는 경기 단위로 따로 센다.
- **랭킹 테이블과 분리한 이유**: 조회할 때마다 갱신되는 행을 순위 조회·등록 테이블과 섞지 않는다(GAME_REPLAYS 분리 D-013과 같은 취지).

## D-002 어뷰징 방지 — 프론트 하루 1회 + 서버 IP 상한

- 브라우저당 하루 1회는 **프론트 localStorage**(`view:{game}:{scoreId}:{KST 날짜}`)가 거른다. 운영에서 프론트와 API의 오리진이 다를 수 있어 서버 쿠키로는 보장하지 못한다(프론트 세션 확인: 브라우저 호출이 `credentials: 'same-origin'`).
- 서버는 우회(스크립트 반복 호출)의 상한만 건다. `game:view:{scoreId}:{IP 해시}` INCR, 첫 기록부터 24시간 TTL(EXPIRE NX), **5회**(`GAME_VIEW_DAILY_LIMIT_PER_VIEWER`)까지 반영한다. 같은 IP 뒤에 여러 사람(NAT)이 있을 수 있어 1이 아니다.
- Redis를 못 쓰면 상한 없이 반영한다(fail-open). 조회수는 부가 기능이다.
- `GET .../replay`에서 세지 않는다. 그 응답에는 `Cache-Control: public, max-age=60`(games-polish BD-06)이 붙어 있어 재방문이 서버에 오지 않기 때문이다. 집계는 별도 `POST .../views`로 받는다.

## D-003 집계 대상 — 재생 API와 같은 공개 규칙

- 숨김·없음·공개 전 보드(DEFENSE 진행 중 주간)는 views·watch 모두 404로 막고 집계하지 않는다.

## D-004 시청시간 — 벽시계, 증분 하트비트, 쿼리 파라미터

- 기준은 **재생이 진행된 벽시계 시간**이고 배속을 곱하지 않는다. 4배속을 리플레이 시간으로 세면 인기순이 왜곡된다. 숨은 탭은 rAF가 멈춰 자동으로 빠진다.
- 보고 방식: 프론트가 30초마다 **증분**을 보내고, 탭이 숨겨지거나 화면을 떠날 때 남은 분을 flush한다. 증분이라 재전송돼도 누적이 두 번 되지 않는다.
- `POST .../watch?ms=` 형태로 **쿼리**로 받는다. 본문 없는 POST는 CORS 단순 요청이라 preflight가 없고, 페이지가 닫히는 순간의 keepalive·sendBeacon 요청도 나간다.
- 1회 상한은 2분(`GAME_WATCH_REPORT_MAX_MS`)이다. 시청자(IP 해시)별 24시간 누적 상한은 `max(리플레이 길이 × 3, 1분)`이다. 0.5배속 완주가 길이의 2배라 배수를 2보다 크게 잡았다.

## D-005 인기 목록 — 보드 단위, 기간 안 합

- `GET /games/:gameType/popular-replays?period=daily|weekly(기본)|all&sort=views(기본)|watch&board&limit(기본 10)`
- 기간 안 일별 행의 SUM으로 정렬하고, 같으면 SCORE_ID가 작은 기록이 위다. `rank`는 이 목록 안의 순서다(점수 순위가 아님).
- 항목에는 누적(`viewCount`·`watchMs`)과 기간 값(`periodViewCount`·`periodWatchMs`)을 같이 싣는다.
- 재생을 공개하지 않는 보드는 빈 목록이다. 링크를 내주면 재생이 404가 되기 때문이다.
- 시청순은 총합으로 정렬한다. 조회당 평균은 표본이 적은 기록(1회 조회 + 긴 시청)이 위로 튀어서 쓰지 않는다. 긴 리플레이가 유리해지는 문제는 시청자별 하루 상한이 누른다. 평균 시청시간은 화면에서 `periodWatchMs / periodViewCount`로 계산해 보여줄 수 있다.

## D-006 집계 날짜 키는 KST 날짜 문자열 `STAT_DATE` (supersedes D-001의 BUCKET_START)

- **경위(2026-10-24)**: 담당자가 마이그레이션 1차 실행에서 `ORA-02329`로 실패했다. `TIMESTAMP WITH TIME ZONE`은 PK에 쓸 수 없다. CREATE TABLE이 통째로 거부돼 생성된 것이 없고 이력도 없다(`db:select`로 확인).
- **결정**: `STAT_DATE VARCHAR2(10)` = KST 날짜 `'YYYY-MM-DD'`(`kstDateOf`). 형식 CHECK(`REGEXP_LIKE`)와 PK (SCORE_ID, STAT_DATE), 인덱스 (GAME_TYPE, STAT_DATE)를 둔다.
- **대안을 버린 이유**: 시간대 없는 TIMESTAMP·DATE는 oracledb가 세션 시간대 기준으로 저장한다. 로컬 실행(KST 맥)과 운영(UTC 컨테이너)이 같은 DB에 서로 다른 값을 쓰게 된다. 날짜 문자열은 0 채움 고정 폭이라 문자열 비교가 곧 날짜 순서이고, 데일리 보드 키(`daily-YYYY-MM-DD`)와도 같은 규칙이다.
- 기간 필터는 `STAT_DATE >= kstDateOf(periodStart)`로 한다.
