# 게임 리플레이 공유 — 설계 정본

> 결정 근거는 DECISIONS.md(D-번호). 결정이 바뀌면 이 문서를 먼저 고친다.

## 1. 백엔드 — 기록 요약 조회 (D-008)
- `GET /games/:gameType/scores/:scoreId` · 인증 없음 · 전역 스로틀
- 200 `data = { rank, scoreId, playerName, score, detail, durationMs, createdAt }` — 랭킹 항목과 같은 형태, `rank`는 전체 기간 순위(숨김 제외)
- 404 `GAME_NOT_FOUND`(모르는 게임) · `GAME_SCORE_NOT_FOUND`(없음·숨김) · 400(`scoreId` 숫자 아님)
- IP_HASH·USER_ID는 싣지 않는다. 리플레이 API(`.../replay`)는 이 요약 + 재생 데이터

## 2. 프론트 — 공유 (D-002·D-006·D-007)
- 진입점: 리플레이 재생기 헤더 오른쪽 공유 아이콘 버튼(44px) 1개 → 공유 메뉴(모달·바텀시트, 포커스·Esc)
- 메뉴: [카카오톡] (SDK 준비됐을 때만) · [링크 복사] · [더보기] (`navigator.share` 지원 시만)
- 공유 URL: `{SITE_URL}/games/tetris/replays/{scoreId}` (절대 경로, 쿼리 없음)
- 공유 문구: "{이름}님의 테트리스 {점수}점 ({줄}줄 · 레벨 {L}) — 리플레이 보기"
- 링크 복사: 클립보드 성공·실패 토스트, 미지원 환경 안내(InviteModal 패턴)
- 카카오: `NEXT_PUBLIC_KAKAO_JS_KEY` 있을 때만 리플레이 화면에서 SDK 지연 로드(버전·integrity 고정, 카카오 공식 문서 값), `Kakao.isInitialized()` 확인 후 init. `Kakao.Share.sendDefault({ objectType: 'feed', content: { title, description, imageUrl: 기록 OG 이미지 절대 URL, link: { mobileWebUrl, webUrl } }, buttons: [{ title: '리플레이 보기', link }] })`
- 키 없음·로드 실패·init 실패 → 카카오톡 버튼 숨김(나머지는 동작)

## 3. 프론트 — 기록 미리보기 카드 (D-003·D-008)
- `replays/[scoreId]`: `generateMetadata` — title "{이름}님의 테트리스 {점수}점 | 리플레이", description, openGraph(url = 리플레이 URL), canonical은 리플레이 URL로 덮어씀, noindex 유지
- 미리보기 이미지: 고정 route handler `replays/[scoreId]/og/route.tsx`(URL `/games/tetris/replays/{id}/og`) — route group `(fullscreen)` 안의 `opengraph-image`는 Next가 해시 접미사를 붙여 카카오 imageUrl이 404가 되므로(프론트 R1) group 밖 고정 경로. 1200×630 `ImageResponse` — 이름·점수·줄·레벨·시간·전체 순위. `cache-control` 기록 있음 600초·실패 60초(ImageResponse 기본 1년 immutable 덮어씀). og:image·twitter·카카오 imageUrl이 같은 경로
- 한글: 카드 글자만 Google Fonts subset(런타임), 실패 시 영문 카드 (D-009)
- 카카오 스크래퍼: `next.config` `htmlLimitedBots`에 `kakaotalk-scrap` 추가 — Next 15.5가 목록 밖 UA에는 async 메타를 head 밖으로 스트리밍하므로
- 데이터: 서버에서 `serverFetch`로 §1 요약 조회, `revalidate: 600`
- 조회 실패(404·네트워크): 일반 테트리스 메타·이미지로 폴백, `notFound()` 금지

## 4. 검증
- 백엔드: 단위·E2E(요약 200·숨김 404·민감 필드 없음) · ci:all
- 프론트: 단위(공유 메뉴 분기·복사·Web Share 유무·SDK 없음 숨김) · build
- Playwright: 공유 버튼 → 메뉴 → 링크 복사(클립보드 값) · OG 메타 태그(og:title·og:image) · OG 이미지 200 PNG · 없는 기록 폴백
- 실기기(사용자): 카톡 공유 카드 · 모바일 기본 공유 시트
