# 카카오 로그인 지연 조사

## 상태

- **조사일**: 2026-08-21
- **현재 상태**: **병목 위치 실측 확정** (`/api/auth/callback/kakao` = 794 ms, 체인의 74%) · **구간 계측 적용 완료**(§5-2·5-3) · 스파이크 재현 대기 · **원인 미확정**
- **다음 행동**: 스파이크 1회만 발생하면 §6-2 Loki 쿼리로 794 ms가 자동 분해된다. 그때까지 추가 수정 없음.
- **1차 조사 문서**: [`../next-bun/docs/KAKAO_LOGIN_ISSUE.md`](../../../next-bun/docs/KAKAO_LOGIN_ISSUE.md) (2026-01-27, 결론 "카카오 서버 측 문제로 제어 불가")
  → 본 문서는 그 결론을 **부분 정정**한다. 우리 코드에도 제거 가능한 홉이 있다(§4 순위 2·4).
- **조사 방식**: 서브에이전트 31개 오케스트레이션 — 4축(프론트/백엔드/인프라/웹검색) 병렬 조사로 가설 39건 수집 → 26건을 반증 검증(external·low confidence 13건 제외)

---

## 1. 결론

체감 지연의 지배적 구간은 **`GET /api/auth/callback/kakao` 단일 요청 안에 직렬로 묶인 외부 왕복 4회**다. **실측으로 확정됐다 — 이 요청 하나가 document 체인의 74%(794 ms / 1,077 ms)를 차지한다** (§3-1-B).

```
[클릭] providers→csrf→kakao                          167 ms (실측)
   ↓
[302] /api/auth/signin/kakao → 카카오 authorize        82 ms (실측)
[200] kauth.kakao.com 로그인/동의 화면                  80 ms (실측)
[302] authorize 재요청                                 70 ms (실측)
   ↓
[302] GET /api/auth/callback/kakao   ★★★             794 ms (실측) ← 74%
   ├ 1. kauth.kakao.com/oauth/token          (next-auth)
   ├ 2. kapi.kakao.com/v2/user/me            (next-auth)
   └ 3. POST 백엔드 /api/v1/auth/kakao       (await)
        └ 4. kapi.kakao.com/v1/user/access_token_info  ← 2번과 중복 검증, 타임아웃 없음
   ↓
[200] mypage                                          51 ms (실측)
[착지 후] Finish 324 ms (실측)
```

**카카오가 정상 응답한 케이스에서도 콜백 하나가 794 ms다.** §3-3의 백엔드 150~200 ms가 맞다면 카카오 2홉이 ~600 ms를 차지한다. 보고된 9초 스파이크는 이 794 ms가 카카오 지연 시 부풀어 오른 것으로 해석된다 (스파이크 자체는 §3-1 측정에서 미재현).

근거:
- 1·2번: `next-bun/node_modules/next-auth/providers/kakao.js:13-14`
- 3번: `next-bun/src/lib/auth.ts:72` (jwt 콜백에서 `await`)
- 4번: `bun/src/modules/auth/auth.service.ts:51-56` (호출부 `:122`), 타임아웃 상수 부재 — `bun/src/common/constants/external-api.constants.ts:2`

**4번은 2번이 이미 얻은 것과 동일한 `kakaoId`를 재조회하는 중복 검증이다.** 카카오가 느린 시점에는 같은 편차를 두 번 맞는다.

---

## 2. "next-auth와 카카오가 안 맞아서 느리다" 통설 판정

**사용 스택**: `next-auth ^4.24.11` (`next-bun/package.json:16`), `session.strategy: "jwt"` (`src/lib/auth.ts:26`), **DB adapter 없음**.

**판정: 조합 고유의 결함은 아니다. 단 "서버사이드 OAuth 구조를 택한 결과"라는 의미에서는 부분적으로 맞다.**

| 통설의 주장 | 판정 | 근거 |
|---|---|---|
| next-auth×Kakao 조합 고유의 성능 결함이 있다 | **아니오** | v4 Kakao provider는 분기·재시도·폴백이 없는 22줄 설정 객체 — `providers/kakao.js:7-29`. 느려질 기계장치가 코드에 없다. GitHub 이슈·카카오 데브톡 검색에서 이 조합 고유 사례 0건 (검색 범위 내 부재이지 부존재 증명은 아님) |
| next-auth가 세션을 폴링해서 느리다 | **아니오** | `next-bun/src/app/components/SessionProvider.tsx:53` `refetchOnWindowFocus={false} refetchInterval={0}` — 폴링 타이머가 생성되지 않는다 (`node_modules/next-auth/react/index.js:469`) |
| 세션 접근마다 DB/API 왕복이 있다 | **아니오** | jwt 콜백의 백엔드 호출은 `src/lib/auth.ts:60` `if (user && account && account.provider === "kakao")` 가드 안 → **최초 로그인 1회만**. 이후는 `:105 return token`으로 단락. adapter 없음 → DB 세션 조회 0건 |
| middleware가 매 요청 세션을 검증한다 | **아니오** | `middleware.ts` 파일 자체가 없다. `.next/server/middleware-manifest.json`이 `{"middleware":{},"sortedMiddleware":[]}` |
| **서버사이드에서 token 교환 + userinfo가 직렬로 일어난다** | **예 (구조적 사실)** | `providers/kakao.js:11` `type:"oauth"` (OIDC 아님) → userinfo 홉이 항상 강제. 이 2홉이 콜백 응답을 블로킹하고 `src/lib/auth.ts:72`가 백엔드 왕복을 하나 더 얹는다 |

정확한 서술: **"next-auth가 느리다"가 아니라 "서버사이드 OAuth 플로우라서 카카오 응답 편차가 사용자에게 그대로 노출된다."** 프레이밍을 바꿔야 실제 수정 대상(중복 홉 제거·계측)이 보인다.

---

## 3. 실측 기록

### 3-1. 2026-08-21 Chrome DevTools (Preserve log ✅, Disable cache ❌, No throttling)

로그인 1회를 처음부터 기록. 필터를 두 번 바꿔 두 벌을 얻었다.

#### (A) `Fetch/XHR` 필터 — XHR 구간

| 요청 | Status | Size | Time | 판정 |
|---|---|---|---|---|
| `providers` | 200 | 0.2 kB | 56 ms | 클릭 전 XHR |
| `csrf` | 200 | 0.1 kB | 47 ms | 클릭 전 XHR |
| `kakao` | 200 | 0.6 kB | 64 ms | 클릭 전 XHR (소계 **167 ms**) |
| `session` | 200 | 0.9 kB | **48 ms** | `/api/auth/session` |
| `?_rsc=s1ke2` | 200 | 3.2 kB | 49 ms | RSC prefetch |
| `teams?_rsc=s1ke2` | 200 | 0.0 kB | 78 ms | RSC prefetch |
| `fishing?_rsc=s1ke2` | 200 | 3.0 kB | 56 ms | RSC prefetch |

페이지 로드: **Finish 324 ms** / DOMContentLoaded 168 ms / Load 233 ms / 10 of 69 requests, 595 kB transferred.

⚠️ `Fetch/XHR` 필터에는 **`/api/auth/callback/kakao`(document 타입)가 걸리지 않는다.** 이 필터만 보고 "콜백이 목록에 없다"고 판단하면 병목을 통째로 놓친다 — (B)로 필터를 바꿔야 한다.

#### (B) `Doc` 필터 — ★ 병목이 드러난 측정

| # | 요청 | Status | Type | Size | Time |
|---|---|---|---|---|---|
| 1 | `/api/auth/signin/kakao` → `authorize?client_id=…` | 302 | document / Redirect | 1.0 kB | 82 ms |
| 2 | `kauth.kakao.com` `login?continue=…` (로그인·동의 화면) | 200 | document | 4.0 kB | 80 ms |
| 3 | `authorize?client_id=…` (재요청) | 302 | document / Redirect | 0.8 kB | 70 ms |
| 4 | **`/api/auth/callback/kakao?code=…`** | 302 | document / Redirect | 0.7 kB | **794 ms** |
| 5 | `mypage` | 200 | document | 4.6 kB | 51 ms |
| | **합계** | | | | **1,077 ms** |

**확정된 것**
- **병목은 4번 단 하나 — 794 ms, 체인의 74%.** 예측한 위치와 일치한다 (§1)
- 카카오 authorize·동의 화면 왕복(1·2·3) = 232 ms → 카카오 자체는 이 시점에 정상
- 클릭 전 XHR 3회 직렬 = 167 ms → **가설 기각** (순위 6)
- `/api/auth/session` = 48 ms → **가설 기각** (순위 5)
- 착지 후 렌더·데이터 페치 = 324 ms → **가설 기각**

**이 측정의 한계**
- **9초 스파이크가 재현되지 않았다.** 카카오 정상 응답 케이스다. 794 ms는 "정상일 때의 기저값"으로 읽어야 하고, 보고된 3,000~9,500 ms(§3-3)는 별도 재현이 필요하다.
- 794 ms의 **내부 분해(카카오 token / userinfo / 백엔드 / Oracle)는 브라우저에서 볼 수 없다.** 서버 측 계측(§5-2, §5-3) 또는 Loki(§6-2)가 필요하다.
- `Disable cache`가 꺼진 상태였다. 콜백은 캐시 대상이 아니라 4번 값에는 영향이 없지만, 착지 페이지 324 ms는 캐시 이득이 섞인 수치다.

### 3-2. 2026-08-21 Safari 웹 인스펙터 (실패 기록)

`Time`·`Transfer Size` 열이 전부 `—`, 합계 `0 B`. Safari 웹 인스펙터는 **인스펙터를 연 시점 이후의 요청만 계측**하므로, 로그인 후에 인스펙터를 열면 이름만 남고 타이밍이 없다. `callback/kakao`도 네비게이션으로 소실됐다.
→ **교훈: 측정은 로그인 시작 전에 DevTools를 먼저 열고 `Preserve log`를 켠 상태로 한다.**

### 3-3. 2026-01-27 1차 조사 (신뢰도 중)

[`KAKAO_LOGIN_ISSUE.md:29-34`](../../../next-bun/docs/KAKAO_LOGIN_ISSUE.md)의 구간별 수치가 유일한 서버 측 근거다.

| 구간 | 기록된 값 |
|---|---|
| NextAuth → 카카오 token endpoint | 200 ms ~ 9,000 ms (불안정) |
| NextAuth → 카카오 userinfo | 카카오 응답 의존 |
| 백엔드 `postKakaoSignInUp` | 150~200 ms (안정) |
| └ 카카오 `access_token_info` | 40~70 ms |
| └ DB 쿼리 `getUserBy` | 50~100 ms |

⚠️ **측정 환경(로컬/프로드)이 문서에 기재되어 있지 않다.** 디버깅 절차(`:103-107`)가 Next.js 개발 터미널 기준이라 로컬 측정 가능성이 높고, 그렇다면 프로덕션의 DNS·TLS·Caddy 비용이 빠져 있다. 이 수치를 프로덕션 근거로 인용할 때 주의한다.

---

## 4. 원인 순위표

| 순위 | 원인 | 레이어 | 근거 (file:line) | 추정 기여 | 수정 난이도 |
|---|---|---|---|---|---|
| 1 | 카카오 token + userinfo 2홉이 콜백 안에 직렬 | external | `next-bun/node_modules/next-auth/providers/kakao.js:13-14` · timeout 10s는 `next-bun/src/lib/auth.ts:15-17` | **콜백 전체 794 ms 실측 확정**(§3-1-B). 그중 카카오 2홉은 ~600 ms **추정**(§3-3의 백엔드 150~200 ms를 차감). 스파이크 시 200 ms~9,000 ms(§3-3, 환경 불명 → 신뢰도 중) | 상 (OIDC 전환 또는 SDK 방식 = 구조 변경) |
| 2 | 백엔드의 3번째 카카오 호출 `access_token_info` — userinfo와 **중복 검증**, **타임아웃 없음** | backend→external | `bun/src/modules/auth/auth.service.ts:51-56` · 호출부 `:122` · `bun/src/common/constants/external-api.constants.ts:2` | 정상 40~70 ms. 카카오 지연 시 **동일 편차가 한 번 더 가산** | 중 (제거는 신뢰 경로 필요 / 타임아웃 추가는 하) |
| 3 | 초대 수락 경로의 고정 1,500 ms 대기 | frontend | `next-bun/src/app/teams/invite/accept/page.tsx:36-39` | **정확히 1,500 ms, 100% 가산 (확정)** — 단 `/teams/invite/accept` 경로 한정으로 **일반 로그인 경로와 다르다** | **하** |
| 4 | Next 서버 → 백엔드 호출이 내부 DNS가 아닌 공인 도메인 헤어핀 | infra | `next-bun/.env.build:4` `NEXT_PUBLIC_API=https://fivesouth.duckdns.org` · `next-bun/src/services/FetchService.ts:328` · `next-bun/Dockerfile:12-13`(빌드 타임 인라이닝) | 수십~수백 ms **추정, 미측정** (DNS+TLS+Caddy 1홉, 로그인당 1회) | 중 (빌드 env 추가 + 재배포) |
| ~~5~~ | ~~하드 로드마다 `/api/auth/session` 왕복~~ | frontend | `next-bun/src/app/layout.tsx:62` | **실측 48 ms → 기각** (§3-1) | — |
| ~~6~~ | ~~`signIn()` 클릭 후 XHR 3회 직렬~~ | frontend | `node_modules/next-auth/react/index.js:200,234,246-251` | **실측 167 ms → 기각** (§3-1) | — |

> 순위 1·2·4는 전부 **추정**이다. §6 측정을 먼저 돌리기 전에 손대는 것을 권하지 않는다.

### 병렬화 검토 결과 — **불가** (2026-08-21 판정, 재검토 불필요)

"카카오 호출들을 `Promise.all`로 묶으면 되지 않나"는 이 코드에서 성립하지 않는다. `postKakaoSignInUp`(`bun/src/modules/auth/auth.service.ts`)의 모든 단계가 **앞 단계의 반환값을 인자로 받는 진짜 직렬 의존**이다.

```
getKakaoId(accessToken) ─→ kakaoId
                              ↓ (kakaoId 없이는 WHERE 절을 만들 수 없다)
                    getUserBy({kakaoIds:[kakaoId]}) ─→ user
                              ↓ (user 유무로 가입/로그인 분기)
                    userSignUp() 또는 user.userId ─→ userId
                              ↓ (userId 없이는 서명할 payload가 없다)
                    issueAccessToken({userId})
```

`Promise.all`로 감싸도 실제 동시성은 0이고 코드만 복잡해진다.

**next-auth 쪽 ①②와 ③의 병렬화도 불가**: ②(userinfo)와 ③(백엔드)은 둘 다 ①(token 교환)의 결과에만 의존하므로 이론상 동시 실행이 가능하지만, ③은 jwt 콜백에서 실행되고 **next-auth는 ②가 끝난 뒤에야 jwt 콜백을 호출**한다(profile을 인자로 넘기기 위해). 라이프사이클을 우회하려면 provider의 `userinfo.request`를 커스텀해 그 안에서 백엔드를 부르는 식이 되는데, 인증 경로에 해킹을 넣는 대가가 이득보다 크다.

### 인덱스 검토 결과 — **불필요** (2026-08-21 판정)

`USERS.KAKAO_ID`에 인덱스가 없는 것은 사실이나(`bun/migrations/1784781522301-Init.ts:25,30-31`), 프로덕션 화면에서 확인된 **등록 사용자 번호가 #43**이다. 이 규모에서는 full table scan도 1 ms 미만이고, 실제로 계측 전 추정치도 `dbMs` 50~100 ms(§3-3)로 카카오 구간의 1/10 이하다. 마이그레이션을 만들 근거가 없다 — `dbMs`가 실측으로 튀는 것이 확인되면 그때 재검토한다.

### 반증으로 배제된 가설 (기여 0 ms)

DB 인덱스 부재 · 커넥션 풀 `poolMax:3` · 콜드 커넥션 · TypeORM 자동 트랜잭션 · `find` vs `findOne` · socket.io 초기화 · 세션 폴링 · middleware · TeamBoard 중복 fetch · Caddy replicas — 각 항목은 반증 근거와 함께 검증 단계에서 기각됐다.

---

## 5. 수정 후보

### 5-1. [난이도 하 · 확정 이득 1,500 ms] 초대 수락 고정 대기 제거

`next-bun/src/app/teams/invite/accept/page.tsx:36-39`

```tsx
// AS-IS
setSuccess(true);
setTimeout(() => {
  router.push(`/teams/${response.data.teamId}`);
}, 1500);

// TO-BE — 성공 피드백은 토스트로, 이동은 즉시
toast.success("팀 초대를 수락했습니다.");
router.push(`/teams/${response.data.teamId}`);
```

- 대기 중 표시되던 성공 화면(`:111-127`)이 사라지므로 **순수 성능 수정이 아니라 UX 결정을 포함**한다. 성공 화면을 유지해야 하면 최소한 성공 직후 `router.prefetch(...)`를 호출해 1,500 ms를 목적지 페치와 겹치게 한다(현재 이 경로에 prefetch 0건).
- 회귀 위험: `acceptTeamInvite` 호출처는 `page.tsx:31` 한 곳뿐 (grep 전수 확인).

### 5-2. ✅ 적용 완료 — 백엔드 구간 타이머

`bun/src/modules/auth/auth.service.ts` `postKakaoSignInUp` 내부에 4구간 계측을 넣었다. 로그 1줄에 전 구간을 담아 Loki 쿼리 1개로 분해되게 했다.

| 필드 | 재는 구간 |
|---|---|
| `kakaoMs` | `getKakaoId` — 카카오 `access_token_info` 왕복 |
| `dbMs` | `getUserBy` — Oracle SELECT |
| `writeMs` | 신규 가입 시 INSERT (기존 사용자는 ~0) |
| `totalMs` | 서비스 진입~응답 직전 |
| `isNewUser` | 신규 가입 경로 여부 |

실제 출력 형태 (QA/PROD JSON stdout):

```json
{"kakaoMs":620,"dbMs":8,"writeMs":0,"totalMs":628,"isNewUser":false,
 "context":"AuthService","msg":"카카오 로그인 구간 측정"}
```

**이 형태가 되는 근거** (이 프로젝트 최초의 구조화 로깅 사례라 확인함):
`@nestjs/common/services/logger.service.js:53-58`이 `optionalParams.concat(this.context)`로 context를 **마지막에** 붙이고, `nestjs-pino/Logger.js:48-59`가 **마지막 항목을 context, 나머지를 msg**로 해석한 뒤 `Object.assign(objArg, message)`로 객체 필드를 top-level에 병합한다. 그래서 `logger.log({...}, '메시지')` 한 줄이 위 JSON이 된다.
`redactSensitiveData`는 `req.headers`/`res.headers` serializer에만 걸리므로(`logger.module.ts:78,84`) 이 필드들은 마스킹되지 않는다 — **반대로 민감정보를 넣으면 마스킹도 안 되니 숫자·boolean만 유지한다.**

⚠️ **타임아웃은 넣지 않았다.** 성공하는 요청의 지연을 1 ms도 줄이지 않고, 바꾸는 것은 "느린 성공 → 빠른 실패"뿐이다. 현재 상한은 프론트 10초 abort(`next-bun/src/services/authService.ts:55`)가 이미 잡고 있다. p99 없이 임계값을 3초로 잡으면 지금 성공하는 로그인이 502로 바뀐다. **`kakaoMs` 분포를 본 뒤 값을 정한다.** 타임아웃 도입은 API 계약 변경(502 신설)이라 `CLAUDE.md` **Ask 대상**이다.

**한계**: 성공 경로만 로그가 남는다. 실패는 `HttpExceptionFilter` + pino-http `responseTime`으로 총 소요만 보이고 구간 분해는 안 된다.

### 5-3. ✅ 적용 완료 — 프론트 백엔드 왕복 타이머

`next-bun/src/lib/auth.ts` jwt 콜백의 `postKakaoSignInUp` 호출을 감쌌다. **성공·실패 양쪽에 로그를 남긴다** — 타임아웃(10초 abort)으로 끝나는 스파이크가 가장 잡고 싶은 케이스이기 때문이다.

```json
{"level":"info", "time":"2026-08-21T08:26:11.031Z","tag":"login.backend",      "ms":178,  "msg":"백엔드 로그인 왕복 측정"}
{"level":"error","time":"2026-08-21T08:26:21.035Z","tag":"login.backend.error","ms":10004,"msg":"백엔드 로그인 왕복 실패"}
```

⚠️ **`level`·`time` 필드는 장식이 아니다** — Promtail 파이프라인이 요구하는 계약이다(`bun/infra/promtail/promtail-config.yml:39-54`):
- `json` stage가 `level`/`time`/`msg`를 추출 → `labels: level:`로 **level을 레이블 승격**(46-47) → `timestamp: source: time, format: RFC3339Nano`로 **로그 시각을 결정**(52-54)
- 두 필드가 없으면 level 레이블이 누락되고 timestamp가 로그 발생 시각으로 잡히지 않는다. **그러면 §5-3b의 프론트↔백엔드 시각 대조가 어긋나 계측 목적 자체가 무너진다.**
- 값 형태는 백엔드 PROD와 일치시켰다 — `logger.module.ts:140-141`의 `formatters: { level: (label) => ({ level: label }) }`가 문자열 label을 내므로 `"info"`/`"error"`를 쓴다(숫자 30이 아니다). 기존 레이블 값과 같아 카디널리티가 늘지 않는다.

> 참고: 기존 `console.error` 3건(`src/lib/auth.ts`)은 JSON이 아니라 같은 문제를 갖고 있다. Promtail은 non-JSON 라인을 drop하지 않고 raw로 수집하므로(설정 37-38행 주석) 손실은 없지만 시각·레이블은 부정확하다. 이번 변경 범위 밖으로 둔다.

Promtail이 `prod_next_app` stdout을 이미 수집한다(`promtail-config.yml:15-24`, `deploy.mode: global`). 적용 전 이 컨테이너 로그에는 `console.error` 3건뿐이라 **Next 구간 지연 데이터가 0**이었다.

### 5-3b. 이 두 계측으로 794 ms가 3층으로 분해된다

계측을 넣은 진짜 이유. 세 값의 차이가 곧 각 구간의 비용이다.

| 알고 싶은 것 | 계산 |
|---|---|
| 카카오 token + userinfo 2홉 (순위 1) | 브라우저 `callback/kakao` − 프론트 `login.backend.ms` |
| **헤어핀 왕복 비용 (순위 4)** | 프론트 `login.backend.ms` − 백엔드 `totalMs` |
| 카카오 중복 검증 ④ (순위 2) | 백엔드 `kakaoMs` |
| Oracle (배제 확인) | 백엔드 `dbMs` |

즉 **순위 4의 "추정 수십~수백 ms"를 실측으로 바꿀 수 있다.** 별도 `docker exec`(§6-3) 없이도 값이 나온다.

### 5-4. [난이도 중 · 추정 수십~수백 ms] 서버 전용 내부 base URL 분리

`next-bun/src/services/FetchService.ts:328`이 `process.env.NEXT_PUBLIC_API` 하나만 쓰고, `Dockerfile:12-13`에서 빌드 타임에 인라이닝되어 **런타임 env로는 못 고친다**. 두 스택 모두 `sys_default` 오버레이에 있어(`bun/infra/docker-stack.app.yml:6-7`, `next-bun/infra/docker-stack.app.yml:6-7`) 내부 DNS `prod_nest_app:3500` 직행이 가능하다.

```ts
const serverBase = process.env.SERVER_API_BASE ?? process.env.NEXT_PUBLIC_API ?? '';
export const serverFetchInstance = new FetchClient(serverBase);
```

`authService.ts:58`의 `postKakaoSignInUp`만 이 인스턴스를 쓰게 한다 (서버 사이드 `backendFetch` 사용처는 이 1곳뿐 — grep 전수 확인). `SERVER_API_BASE`는 `NEXT_PUBLIC_` 접두사가 아니라 런타임 주입이 가능하고 번들에 박히지 않는다.

이득은 **미측정**이다. 홉이 로그인당 1회뿐이라 상한이 정해져 있고 "9.5초 스파이크"를 설명할 크기는 아니다. 5-3 계측에서 백엔드 왕복이 수백 ms 이상 나올 때만 착수 가치가 있다.

### 5-5. [착수 금지 — 검토만] 중복 카카오 검증 제거

`auth.service.ts:51`의 `access_token_info`는 NextAuth가 `/v2/user/me`로 이미 얻은 것과 동일한 `kakaoId`를 다시 받아온다. 단순 삭제는 "클라이언트가 보낸 accessToken을 검증 없이 신뢰"가 되어 **보안 강등**이다. Next 서버↔Nest 사이 신뢰 경로(내부망 + 서비스 토큰)를 먼저 만든 뒤에만 검토한다.

---

## 6. 다음 측정 절차

### 6-1. ✅ 완료 — Chrome DevTools 브라우저 측 분해 (§3-1)

절차(재현용): 로그아웃 → 로그인 페이지에서 **DevTools를 먼저 열고**(F12) Network → **`Preserve log` 체크** → **필터 `Doc`** → 카카오 로그인 클릭 → `callback/kakao` 행의 `Time` 확인.

결과: **콜백 794 ms / 체인 1,077 ms.** 병목 위치 확정, 순위 5·6 기각. 브라우저에서 더 얻을 것은 없다.

### 6-1b. 남은 재현 과제 — 스파이크 포착

§3-1은 카카오 정상 케이스다. 보고된 3,000~9,500 ms를 잡으려면 같은 절차를 **시간대를 달리해 수 회 반복**하고, 느린 회차의 `callback/kakao` `Time`을 기록한다. 확장 노이즈를 빼려면 시크릿 창(Wappalyzer 등이 요청을 주입한다)에서 한다.

**판정 규칙**
- 느린 회차의 콜백이 3,000 ms 이상 → 순위 1·2·4 확정, 서버 계측(§5-2·5-3)으로 내부 분해
- 반복해도 800 ms 내외에서 안정 → 스파이크는 특정 조건(카카오 측 시점·특정 LB IP·아웃바운드 정책)에 국한. §7의 방화벽 항목을 본다

### 6-2. Loki로 백엔드 구간 분리 (추가 배포 불필요)

Grafana → Explore → Loki. pino-http가 이미 `responseTime`을 남긴다(`bun/src/common/logger/logger.module.ts:133-153`, autoLogging 제외는 health-check/metrics뿐 `:146-151`). 실제 라인 형태(`bun/logs/app.1.log`):

```
{"msg":"request completed","responseTime":7,"req":{"url":"/api/v1/auth/kakao"},"res":{"statusCode":422},"context":"HTTP"}
```

```logql
quantile_over_time(0.95,
  {service="prod_nest_app"} | json
  | req_url="/api/v1/auth/kakao"
  | msg="request completed"
  | unwrap responseTime [5m])
```

> `msg="request completed"` 필터를 빼면 `HttpExceptionFilter`가 남기는 responseTime 없는 라인이 섞인다. 숫자 비교 연산자는 앞뒤 공백 필수([`tasks-logging.md:430`](tasks-logging.md)).

**해석**: 6-1이 9초인데 이 p95가 200 ms면 → 카카오 token/userinfo 확정(순위 1). 이 p95도 크면 → 아래 6-2b로 한 단계 더 분해.

### 6-2b. ★ 구간 분해 쿼리 (5-2·5-3 계측 적용 후 사용 가능)

**백엔드 4구간** — 어느 구간이 스파이크를 만드는지 한 화면에서 본다:

```logql
quantile_over_time(0.95, {service="prod_nest_app"} | json | context="AuthService" | unwrap kakaoMs [30m])
quantile_over_time(0.95, {service="prod_nest_app"} | json | context="AuthService" | unwrap dbMs    [30m])
quantile_over_time(0.95, {service="prod_nest_app"} | json | context="AuthService" | unwrap totalMs [30m])
```

**느린 회차만 골라 보기** (스파이크 원인 특정에 가장 유용):

```logql
{service="prod_nest_app"} | json | context="AuthService" | totalMs > 2000
```

**프론트 왕복** — 헤어핀 비용 계산용:

```logql
quantile_over_time(0.95, {service="prod_next_app"} | json | tag="login.backend" | unwrap ms [30m])
{service="prod_next_app"} | json | tag="login.backend.error"
```

**판정 규칙**

| 관측 | 결론 |
|---|---|
| `kakaoMs`만 튄다 | 순위 2 — 카카오 중복 검증이 스파이크를 증폭 중. §5-5 신뢰 경로 검토 착수 가치 있음 |
| 프론트 `ms` − 백엔드 `totalMs`가 수백 ms | 순위 4 확정 — §5-4 내부 DNS 전환 착수 |
| `callback/kakao` − 프론트 `ms`가 대부분 | 순위 1 — 카카오 token/userinfo. 우리 코드로는 못 줄인다. OIDC 활성화(§7) 검토 |
| `dbMs`가 튄다 | 예상 밖. Oracle 조사로 전환 (§7) |

### 6-3. 헤어핀 실비용 (⚠️ 사용자 승인 필요 — `docker exec`)

```bash
docker exec <next-container> sh -c \
 'curl -o /dev/null -sS -w "dns:%{time_namelookup} conn:%{time_connect} tls:%{time_appconnect} total:%{time_total}\n" https://fivesouth.duckdns.org/api/v1/health-check'
docker exec <next-container> sh -c \
 'curl -o /dev/null -sS -w "conn:%{time_connect} total:%{time_total}\n" http://prod_nest_app:3500/api/v1/health-check'
```

두 값의 차가 순위 4의 실제 비용이다. DB 미접속·읽기 전용이지만 컨테이너 exec이므로 승인 후 실행.

---

## 7. 미확인 사항

| 항목 | 왜 코드로 못 정하나 | 확인 방법 |
|---|---|---|
| 카카오 서버 실제 응답 시간 | 이 구간 계측이 0건. §3-3이 유일한 근거인데 측정 환경 미기재 | §6-1 + 5-3 로그 |
| ~~Oracle 쿼리 실소요 · `USERS` 행 수~~ | **부분 해소** — 행 수는 프로덕션 화면의 "등록된 사용자 번호 #43"으로 추정 확보(§4 인덱스 검토). 실소요는 5-2의 `dbMs`가 다음 로그인부터 남긴다 | 6-2b 쿼리 |
| 프로덕션 `NODE_ENV` 값 | `bun/src/config/database.config.ts:18`이 `NODE_ENV === 'development'`로 쿼리 로깅을 켜는데, env 파일이 레포 밖(`infra/docker-stack.app.yml:7-8`)이고 `src/config/env.validation.ts:19-59`에 NODE_ENV 검증이 없다 | 서버 `.env` 확인. `development`면 판정 기준을 검증되는 `ENV`(LOCAL/QA/PROD)로 교체 |
| Caddyfile 실물 | 공개 레포 정책상 미커밋(`docs/deploy.md:35-38`). 인용된 라우팅은 [`tasks-monitoring.md:373-375`](tasks-monitoring.md)의 문서 스냅샷 | 서버에서 확인. `log` 지시어가 켜져 있으면 Promtail이 이미 수집 중이라 `{service="infra_caddy"}`로 upstream 지연이 보인다 |
| fs-01 CPU 경합 | ARM64 4 OCPU 노드 한 대에 Next 10 replicas(`next-bun/infra/docker-stack.app.yml:27`) + Nest 3(`bun/infra/docker-stack.app.yml:26`) + Caddy + Redis, **전부 CPU/메모리 limit 미선언**. 텔레메트리 미조회 | Grafana node_exporter. Prometheus에 HTTP 지연 히스토그램이 없어(`bun/src/common/metrics/metrics.module.ts:21-27`은 WS/Redis 5종뿐) 지연 상관은 Loki로 본다 |
| 카카오 앱 OIDC 활성 여부 | 개발자 콘솔 설정이라 코드로 알 수 없다. 켜면 userinfo 홉(순위 1의 절반)을 제거할 수 있다 | 카카오 개발자 콘솔 |
| 카카오 아웃바운드 방화벽 방식 | 인프라 영역. 데브톡 사례(도메인 허용 + 카카오 LB 다중 IP → 일부 IP만 60초 타임아웃)에 해당하면 "간헐적으로만 매우 느림" 패턴이 설명된다 | 서버 아웃바운드 정책 확인 |
| `next-bun/src/lib/auth.ts:89`의 rate limit 분기 | `errorMessage.includes("rate limit")`인데 카카오는 `code:-10` 형태로 응답한다 — 죽은 분기일 가능성 | 실제 카카오 에러 응답 1회 캡처 |
| 프로덕션 번들 크기 | `.next/`가 dev(turbopack) 산출물이라 측정 불가. 소스 레벨로는 `TeamBoard.tsx:8-12`가 뷰 컴포넌트 4개를 정적 import(실제 렌더는 1개), 전체 `next/dynamic` 사용 1곳 | `bun run build`로 first-load JS 실측 |

---

## 8. 부수 발견 (지연과 무관, 정리 대상)

- `next-bun/src/app/hooks/useTeamData.ts`(326줄)는 `hooks/index.ts:11`에서 export되지만 **소비 컴포넌트 0건**. TeamBoard가 자체 구현으로 대체했고 로직이 이미 어긋나 있다(discord 조회 누락).
- `next-bun/src/app/components/TeamBoard.tsx:512` Effect B에 `sessionStatus` 가드가 없어 하드 로드 시 `getTeamTasks`가 2회 발화한다. **병렬이라 지연 기여는 없으나** 불필요한 요청이다.
- 문서 불일치: [`docs/deploy.md:9`](../deploy.md)의 `infra_caddy replicas 2` vs 실제 `infra/docker-stack.yml:28` `1`. [`tasks-monitoring.md:6`](tasks-monitoring.md) 헤더가 "미진행"인데 체크리스트는 배포 완료.
- `bun/src/modules/auth/auth.controller.ts:28`이 `@ApiResponse({ status: 200 })`인데 실제는 201. 프론트는 `response.ok`로 받으므로(`next-bun/src/services/authService.ts:67`) 무해하며, `:26-27`에 그 취지의 주석이 이미 있다.
