# 게임 리플레이 공유 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-21 — 착수: 브랜치·worktree
- 두 레포: `git fetch . origin/main:develop`(bun `2684a28..65e1e03`, next-bun `5f75a80..f2e66ff`) → `worktree add -b feat-onam-game-share .claude/worktrees/game-share develop` · `.env` → `../../../.env` 링크. 원래 작업 트리 무변경
- games worktree 프론트 dev 서버(3000) 종료
- 프론트 조사 요청(`next-bun-8b`): 카카오 JS SDK·키 env 유무, 리플레이 페이지 metadata·OG, OG 이미지 선례·서버 조회 경로, 클립보드·Web Share 선례, 진입점 레이아웃, 추가 아이디어

## 2026-10-21 — 프론트 조사 결과 (`next-bun-8b`, 조사만, game-share @ f2e66ff)
- **카카오 JS SDK·JS 키 없음**: `Kakao.init|Kakao.Share|t1.kakaocdn` src·public 0건. env는 `KAKAO_CLIENT_ID`·`KAKAO_CLIENT_SECRET`(next-auth, `src/lib/auth.ts:13-14` — REST 키라 `Kakao.init` 불가). 공유에는 같은 카카오 앱의 **JavaScript 키** + [플랫폼 > Web] 도메인 등록 필요. 빌드 인라인 → Dockerfile ARG 주입(BUILD_SHA 방식). `next/script` 선례 0, CSP 설정 0(Caddy 헤더는 레포 밖 — 미확인)
- **리플레이 메타**: `replays/[scoreId]/page.tsx:5-8` 정적 `title` + noindex, OG는 `games/tetris/layout.tsx:9` 상속, canonical `/games/tetris` 상속, `metadataBase` 있음(`app/layout.tsx:26`). OG 이미지 선례는 정적 `ImageResponse`(fishing·teams·root), 동적 `generateMetadata`는 정적 데이터만. 서버 → 백엔드 호출은 `services/serverFetch.ts:16-19` 1곳
- **백엔드 결정 필요**: ① OG용 경량 기록 요약 조회(`GET /games/:gameType/scores/:scoreId`) — replay 응답은 inputs 포함 수~수백 KB ② Next 서버 발 호출은 모든 사용자가 같은 IP 키 → 리플레이 스로틀(초당 2·분당 30) 공유 트래픽·크롤러가 서로 막음 → 프론트 revalidate 캐시(기록 불변) 기본
- **UI 선례**: 클립보드 `InviteModal.tsx:35-45`(미지원 폴백 안내 포함), Web Share 0건, 토스트 react-hot-toast, 모달 `useDialog`
- **진입점**: 리플레이 헤더 오른쪽 h-11 아이콘 1개 공간 있음(`ReplayPlayer.tsx:230-245`) · 게임 오버 패널 등록 후 세로 스택에 1줄(`GameOverPanel.tsx:179-187`) · **랭킹 행은 320px에서 이름이 크게 잘려 비권장**(`RankingTable.tsx:37-58`) — ▶로 리플레이 들어가 공유
- **추가 아이디어**: 공유 문구 · utm(분석 도구 없어 생략 권장) · 숨김·없는 기록 링크(OG 폴백, notFound 금지) · 한글 폰트 번들(ImageResponse 기본 폰트 한글 없음 — 추정) · 도전장 `/games/tetris/play?challenge=` · 짧은 경로 `/r/:id` · 시작 위치 공유 `?t=초` · GIF·영상(비권장)

## 2026-10-21 — 결정 · S1 백엔드 기록 요약 API
- 사용자 답변: 카톡 = A(SDK 버튼) + B(기본 공유 시트) → D-006 · 추가 기능은 ② 미리보기 카드만 → D-007(D-004·D-005 1차 제외) · 메인 판단 D-008(요약 API + 프론트 캐시 10분, 스로틀 면제 없음)
- S1: `GET /games/:gameType/scores/:scoreId` — `GamesService.getScore`(숨김 제외 1건 + 전체 순위), `getReplay`와 공통 `findVisibleScore`로 정리(IP_HASH·USER_ID 미조회), `rankOf`에는 `{ scoreId, score }`만 넘김. Swagger 200·400·404·500, `GameScoreSummaryResponseDto`. README games 모듈 설명 갱신
- 검증: build ✅ · games 단위 83/83(+3) · E2E games 31/31(+4: 200 형태·없음 404·모르는 게임 404·숫자 아님 400)
- 프론트 S2 지시(`next-bun-8b`): 공유 메뉴(카톡·복사·더보기) · SDK 지연 로드·키 없으면 숨김 · Dockerfile·워크플로 `NEXT_PUBLIC_KAKAO_JS_KEY` · generateMetadata·opengraph-image(serverFetch, revalidate 600, 실패 폴백)

## 2026-10-21 — S2 프론트 구현 (`next-bun-8b`, 미커밋)
- 공유 메뉴 `components/ShareMenu.tsx`(모바일 하단 시트·sm 이상 대화상자, useDialog, 버튼 48px·닫기 44px) — [카카오톡] SDK init 성공 시만 · [링크 복사] InviteModal 패턴 · [더보기] Web Share 지원 시만(AbortError 무토스트). 메뉴 열림 중 재생기 단축키 정지
- 리플레이 헤더 공유 버튼(h-11, `aria-label="리플레이 공유"`). SDK `https://t1.kakaocdn.net/kakao_js_sdk/2.8.4/kakao.min.js` + 공식 SRI(sha384, 프론트가 CDN 파일로 재계산 일치), 키 있을 때만 lazyOnload, 실패 시 버튼 숨김
- 빌드 주입: Dockerfile `ARG NEXT_PUBLIC_KAKAO_JS_KEY=""` + 워크플로 build-args `NEXT_PUBLIC_KAKAO_JS_KEY=${{ secrets.KAKAO_JS_KEY }}` — **GitHub Actions 시크릿 이름 `KAKAO_JS_KEY`**(사용자 등록 필요, 없으면 카톡 버튼만 숨김)
- 미리보기: `generateMetadata`(title·description·og url·canonical 리플레이 경로, noindex 유지, 실패 시 일반 메타) · `opengraph-image.tsx` 1200×630 · 서버 조회 `services/gameServerService.ts`(serverFetch, revalidate 600, 3초 타임아웃, 실패 null)
- **발견**: next/og 기본 폰트는 라틴 전용 — 한글은 렌더 중 Google Fonts에서 받음(네트워크 없으면 렌더 예외, 실측). 조치: 카드 글자만 Google Fonts `text=` subset(하루 캐시·3초 타임아웃), 실패 시 ASCII 카드(한글 이름 숨김)로 외부 의존 없이 렌더. 렌더 4종 육안 확인. **운영 컨테이너의 Google Fonts egress 여부는 미확인** — 배포 후 OG 이미지로 확인(없으면 ASCII 카드)
- 프론트 검증: typecheck·lint 0 · test 505(+24) · build ✅(메인, sandbox 밖)
- 백엔드 리뷰 R1 시작(review-flow + Opus 병행), 프론트 리뷰 루프(review-front + Opus) 진행 중

## 2026-10-21 — 백엔드 리뷰 R1 (review-flow + Opus) — 종료
- 두 리뷰어 모두 확정 결함 0(수정 없음) → 백엔드 루프 종료. 확인: 라우트 충돌 없음(POST scores·GET scores/:id·GET .../replay·rankings), 숨김 제외(조회·rankOf), IP_HASH·USER_ID 미조회·미노출, 순위 = 랭킹 목록 규칙, getReplay 리팩터 동작 보존, Swagger, 테스트가 방어를 고정. review-flow `ci:core` 통과(단위 972, lint 경고 6). E2E 31/31은 메인이 sandbox 밖에서 통과
- 프론트 확인 요청(Opus 지적): Next fetch 캐시(revalidate 600)가 429·5xx 응답을 저장하면 미리보기가 10분간 폴백 카드로 고정 → `next-bun-8b` 리뷰 루프에서 확인·대응

## 2026-10-21 — 프론트 리뷰 루프 · 실검증
- **프론트 리뷰**(review-front + Opus): R1 차단 1(카카오 imageUrl 404 — route group `(fullscreen)` 때문에 `opengraph-image`에 해시 접미사 → 고정 route `/og`로 이동) + 제안 반영(OG cache-control 600/60, og:site_name, 링크 텍스트 표시, 폰트 예산 6초, Script onLoad·onReady init, `htmlLimitedBots`에 kakaotalk-scrap) · R2 1(route.tsx `OG_SIZE` export — 메인 build에서 먼저 발견, lib로 이동) · R3 두 리뷰어 0 → 종료. 프론트 test 507·typecheck·lint 0. Next 데이터 캐시는 200만 저장(`patch-fetch.js:624`) — 429·5xx 고정 없음 확인
- **프론트 build**: 1차 ✅ → R1 반영본 ❌(`"OG_SIZE" is not a valid Route export field` — 깨끗한 상태의 tsc로는 안 잡힘) → 수정본 ✅
- **실검증**(운영 빌드 `next start` 3000 + 백엔드 dev 3500 Redis 6380):
  - 처음 요약 API가 `Cannot GET` → 원인: 이전 Redis 장애 실측 때 띄운 games worktree 백엔드가 3500을 3.5시간 점유(종료 누락), 새 서버는 바인드 실패. 해당 프로세스 종료 후 재기동
  - 요약 API 200 · `/replays/3/og` 200 PNG `max-age=600`(한글 카드 육안 확인 — 순위·이름·점수·줄·레벨·시간) · 없는 기록 `/og` 200 `max-age=60` · 페이지 title·og:title "권오남_OnamKwon님의 테트리스 282점 | 리플레이" · og:description · og:image `…/replays/3/og` · 카카오 스크래퍼 UA에도 head 안에 메타
  - Playwright 14/14(데스크톱·모바일): 공유 버튼 ≥44px · 메뉴 열림 · 카카오 버튼은 SDK 로드와 일치(로컬 키 없음 → 숨김) · 링크 복사 클립보드 = `https://fivesouth.duckdns.org/games/tetris/replays/3` · 토스트 · Esc 닫힘·포커스 복귀 · 페이지 오류 0. 모바일 하단 시트 육안 확인
- **백엔드 ci:all**: 1차 E2E 2건 실패(dev 서버 종료 직후 실행) → 즉시 재실행 E2E 164/164 + ci:all 재실행 전부 통과(lint 0/경고 6 · 단위 972 · E2E 164·2 skip · build). 1차 실패 테스트 이름은 출력이 남지 않아 **미확인** — 동시 종료 중 포트 충돌로 추정(확정 아님). README 기준선 갱신
- 미검증: 실제 카카오톡 공유 카드(JS 키·도메인 등록 후 사용자 실기기), 모바일 기본 공유 시트 실기기, 운영 Google Fonts egress(D-009 — 배포 후 운영 `/og`로 확인)

## 2026-10-21 — 카카오 설정(사용자) · 로컬 카카오 확인
- 사용자 완료: [앱] > [플랫폼 키] > [JavaScript 키] > JavaScript SDK 도메인에 운영·`http://localhost:3000` 추가(기존 JS 키) · [제품 링크 관리] > [웹 도메인] 등록 · 로컬 `next-bun/.env`에 `NEXT_PUBLIC_KAKAO_JS_KEY` · GitHub **Environment `prod` 시크릿** `KAKAO_JS_KEY`(레포 시크릿 아님 — 빌드 job의 `environment: prod` 선언 여부를 `next-bun-8b`에 확인 요청)
- 로컬(프론트 dev — 키는 빌드 인라인이라 재기동): SDK 2.8.4 로드 200 · `Kakao.isInitialized() === true` · 메뉴 [카카오톡]·[링크 복사]·[더보기] · console 오류 0
- [카카오톡] 클릭 → 팝업이 `accounts.kakao.com/login/`(키·도메인 오류 페이지 아님) — 공유 요청은 수락, 실제 카드 전송·모양은 로그인된 실기기에서 확인 필요(사용자)
- 근거 문서: 카카오 디벨로퍼스 앱 설정 문서(JavaScript SDK 도메인 · 제품 링크 관리 > 웹 도메인 — 둘 다 필요)
- GitHub 시크릿 위치 정정: 처음엔 백엔드 레포(`kon6443/bun`) prod 환경에 등록돼 있었음(프론트 빌드가 못 읽음 — `gh secret list --env prod`로 확인) → 사용자가 bun에서 삭제, **next-bun prod 환경에 `KAKAO_JS_KEY` 등록**(12:33). 확인: next-bun prod 7개(KAKAO_JS_KEY 포함), bun prod 6개(원래대로). 빌드 job `deploy`가 `environment: prod` 선언(`oci_build_and_deploy_next.yml:62-66`) — 워크플로 수정 불필요(프론트 확인)

## 2026-10-21 — 최종 라운드 (사용자 지시: "내가 사용하던 방식으로 백프 모두 리뷰 및 테스트까지 전부 진행. 브라우저 레벨 테스트까지")
- **백엔드**(review-flow + Opus): 둘 다 확정 결함 0. Opus 실서버 GET: `/scores/3` 200(키 7개, ipHash·userId·inputs·seed 0건) · 999999 404 · abc 400. review-flow: build ✅ · games 83/83 · eslint 0. 참고(결함 아님): `docs/tasks/games/DESIGN.md` API 표에 요약 엔드포인트 없음 — 정본은 game-share DESIGN §1
- **프론트**(review-front + Opus, 새 리뷰어 2명): 둘 다 확정 결함 0, 파일 수정 없음. typecheck·lint 0 · test 507. 제안(미반영·후속): 카카오 sendDefault 실패 분기 테스트 1건 · twitter:title 접미사 · OG 렌더 예외 시 헤더 선행 가능성(추정, 미확정)
- **스로틀 키 확인**(프론트 질의): `@nestjs/throttler` 6.5.0 `throttler.guard.js:148-151` — 키 = Class·handler·throttler·tracker → **라우트별 버킷**. Next 서버 호출(tracker = 컨테이너 IP)은 요약 API 버킷만 소모, 로그인 콜백 등과 분리. 캐시 안 된 조회 분당 60 초과 시에만 폴백 카드(60초) — 수용(D-008 유지)
- **브라우저(Playwright, 프론트 dev + 카카오 키)**: 공유 14/14(카카오 init·[카카오톡] 버튼·복사 클립보드·토스트·Esc·포커스·오류 0, 데스크톱·모바일) · 더보기·AbortError·없는 기록(안내·공유 버튼 없음) 4/4 · 카카오 팝업 → `accounts.kakao.com/login`(키·도메인 오류 없음) · OG 메타·`/og` 200 PNG
- **회귀**: games UI 29/29 · 실API 24/24. 1차 실패 2건은 **테스트 스크립트 레이스**: ① 게임 오버 순간 하드드롭 버튼이 사라져 30초 대기(실패 스크린샷 = GAME OVER 정상 화면) → 탭 타임아웃 2초로 ② 이후 더 높은 점수 등록으로 첫 기록 순위가 밀림 → 마지막 등록과 비교. 세션 발급 429 상태에서도 모바일 플레이 시작·가상 버튼 정상(가설 반증 실측)
- 백엔드 ci:all(직전 실행 그대로 — 이후 백엔드 코드 변경 없음): lint 0/경고 6 · 단위 972 · E2E 164 · build ✅
