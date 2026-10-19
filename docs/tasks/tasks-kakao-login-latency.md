# 카카오 로그인 지연 조사

## 상태

- **조사일**: 2026-08-21
- **현재 상태**: **병목 위치 실측 확정** (`/api/auth/callback/kakao` = 794 ms, 체인의 74%) · ⚠️ **구간 계측(§5-2·5-3)은 코드만 작성되고 배포되지 않았다** (2026-10-16 확인, §9) · **원인 미확정**
- **다음 행동**: §9 재조사 결과를 따른다 — (1) 운영 Loki/Prometheus로 기존 `responseTime` 분포 판정(배포 불필요), (2) 계측 WIP 커밋·배포(사용자 승인 대기).
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

---

## 9. 2026-10-16 재조사 (백엔드 서브에이전트 + 프론트 세션 병렬, 조사만)

### 9-1. 문서 전제의 정정
- **§5-2·§5-3 "적용 완료"는 사실이 아니다.** 계측 코드는 두 레포의 미커밋 작업트리에만 있고 `origin/main`에서 `kakaoMs`·`login.backend` grep 0건. 따라서 §6-2b 쿼리는 결과 0건이고 "스파이크 1회 대기"는 성립하지 않았다.
- **운영 Next 런타임은 Bun이다** (`next-bun/Dockerfile:28` `CMD ["bun", "server.js"]`, 베이스 `oven/bun:1` 부유 태그). 이 문서는 Node를 암묵 전제했다.
- 인프라 변경: fs-01 **2 OCPU/12GB로 축소**(`docs/deploy.md:19`), Next 레플리카 **4**. §7의 "4 OCPU·Next 10"은 낡았다.
- `database.config.ts`의 `expireTime: 5`는 **Thin 모드 전용**이라 이 앱(thick 모드, `app.module.ts:74-79` `initOracleClient`)에서는 무효다(node-oracledb API 문서). 주석 "5분마다 연결 상태 체크"는 사실과 다르다.
- "콜드 커넥션 배제"는 **첫 커넥션에 한해서만 유효** — 헬스체크가 모든 레플리카에서 30초마다 DB ping을 한다(`infra/docker-stack.app.yml` healthcheck, `health.controller.ts:23-25`). 2·3번째 커넥션(5분 유휴 후 닫힘, poolTimeout 300)의 신규 생성 비용은 배제되지 않았다.

### 9-2. 새 가설 순위 (모두 추정 — 운영 데이터로 판정 전)
| 순위 | 가설 | 패턴 | 판정 관측 |
|---|---|---|---|
| 1 | 컨테이너 DNS 5초 타임아웃(Docker 내장 DNS + A/AAAA 병렬 질의 유실) — 카카오 DNS TTL이 3~5초(로컬 dig)라 드문 로그인은 매번 신규 조회(Next 3회 이상, Nest 1회) | 정상 + **정확히 5초 단위** | 백엔드 `responseTime` 4.9~5.6s 몰림, 브라우저 callback +5s 계단 |
| 2 | **Bun에서 next-auth 카카오 호출의 10초 timeout이 연결 단계에 안 걸린다** — openid-client `https.request({timeout})`는 Bun에서 소켓 연결 후에만 시작(로컬 실측: 무응답 IP에 Node 2.0s timeout / Bun 12s 무이벤트). 특정 카카오 LB IP 불통 시 상한 없음 | 10초 초과, 수십 초 | 브라우저 callback > 10s 회차 |
| 3 | fs-01 2 OCPU에서 Nest 3·Next 4·Caddy·Redis·모니터링이 limit 없이 경합 | 배포·cron과 겹칠 때 수백 ms~수 s | node_exporter CPU vs 느린 요청 시각 |
| 4 | 풀 확장 시 ATP mTLS 신규 커넥션 생성(동시성 있을 때만) | 1~수 s | 계측 후 `dbMs` |
| 5 | Swarm IPVS 유휴 연결 끊김(~900s)과 헤어핀 keep-alive 충돌 | 유휴 후 첫 로그인만 | Caddy 로그 upstream 소요 |
| 6 | 슬롯1 `handleCpuIntensiveLoop` 동기 루프(로컬 실측 276~280 ms/회) | 슬롯1만 0.3~0.6s | Prometheus `nodejs_eventloop_lag_max_seconds` by replica |
| — | 기존 순위 1·2(카카오 token/userinfo 편차, 백엔드 중복 검증)는 유지 | | |

### 9-3. 지연이 아니라 실패로 체감되는 것
- **로그인 스로틀 키 공유**: Next가 공인 도메인으로 백엔드를 호출(헤어핀)해 `X-Forwarded-For`가 모든 사용자에게 같은 서버 출구 IP가 된다(`custom-throttler.guard.ts:24-28`) → 로그인 라우트 한도(초당 2·분당 10, 레플리카별 인메모리, `throttle.constants.ts:8-11`)를 전 사용자가 공유. 동시 로그인 시 429 → 재시도로 "오래 걸림" 체감.
- 로그인 버튼 중복 클릭 방지 없음 + next-auth state 쿠키 1개 → 두 번 시작하면 먼저 시작한 callback이 `OAuthCallback` 실패.
- 회원가입 전용 프론트 경로는 없다(라우트 전수). 가입 체감 차이는 카카오 동의 화면 + 백엔드 INSERT뿐.

### 9-4. 판정 절차 (순서)
1. **배포 불필요** — 운영 Loki: `/api/v1/auth/kakao` `responseTime` 분포·5초 몰림·레플리카 편중·429 건수 / Prometheus: 이벤트 루프 지연·fs-01 CPU. 브라우저 §6-1b 반복으로 +5s 계단 vs 10s 초과 판별.
2. **배포 필요(승인 대상)** — 계측 WIP 배포 + next-auth callback 전체 소요 로그(카카오 2홉 서버 측 분리).
3. 원인 확정 후 수정 — DNS 옵션(`single-request-reopen` 등) / Next Node 런타임 전환 또는 연결 단계 abort / 내부 base URL(헤어핀 제거, 스로틀 키 문제도 해소) / 풀 고정 크기 / `oven/bun` 버전 고정.

## 10. 2026-10-16 사용자 결정과 진행 계획

### 10-1. 결정
| # | 항목 | 결정 | 비고 |
|---|---|---|---|
| D1 | 슬롯1 `handleCpuIntensiveLoop` | **유지** (의도된 OCI 유휴 회수 방지) | §9-2 순위 6 종결 |
| D2 | 로그인 버튼 중복 클릭 방지 | **진행** (프론트) | 클릭 즉시 비활성 + 로딩. 대상: 로그인 페이지 버튼, 팀 화면 `LoginButton` |
| D3 | 배포 직후 첫 로그인 모듈 예열 | **진행** (프론트) — 외부 호출 없이 next-auth 경로 모듈만 미리 로드 | 콜백·백엔드·카카오 호출 금지 |
| D4 | 유휴 연결 끊김(헤어핀 keep-alive) | **조사·테스트 후 진행** | 1안: 서버 사이드 백엔드 호출을 내부 주소(`prod_nest_app:3500`)로. 로그인 스로틀 키(§9-3) 영향 설계 필요 |
| D5 | 로컬에서도 가끔 느림 (사용자 관측) | 가설 재가중 | 로컬에는 Docker DNS·노드 CPU 경합이 없다 → 카카오·공용 Oracle ADB·next-auth 경로 쪽 비중 상승 |

### 10-2. 사용자 확인 대기
- Q1 운영 서버 읽기 전용 점검 — ssh 접속 승인됨(fs-01~03, 수정 금지). **ssh 키가 agent에 없어 접속 실패** → 사용자에게 `ssh-add` 요청 중
- Q2 계측 WIP(백엔드 `auth.service.ts`, 프론트 `src/lib/auth.ts`) 커밋·배포 여부 — 권장: 배포
- Q3 보안 업데이트 — next-auth 4.24.13(advisory critical 1·high 1·medium 1, 4.24.15에서 패치), next 15.3.8(critical 2·high 다수, 15.5.x에서 패치). 해당 여부·위험은 조사 중
- Q4 프론트 런타임 Bun→Node, 패키지 매니저 bun→pnpm 전환 여부 — 조사 결과 후 권고

### 10-3. 사실 (2026-10-16 확인)
- 백엔드: 패키지 매니저 **pnpm 8.15.9**(`package.json` packageManager), 런타임 **Node 24**(`Dockerfile` `node:24-bookworm-slim`, `CMD ["node", …]`)
- 프론트: 패키지 매니저 **bun**(`bun.lockb`), 런타임 **Bun**(`oven/bun:1`, `CMD ["bun","server.js"]`), next 15.3.8, next-auth 4.24.13, openid-client 5.7.1

### 10-4. 조사 결과 (2026-10-16, 서브에이전트 — 근거·출처는 대화 보고, 핵심만 기록)
- **next-auth v4 × 카카오 조합 고유 버그·버전 문제: 찾지 못함.** 4.24.14·4.24.15 릴리스 노트에 카카오·timeout·openid-client 수정 없음. AAAA 레코드 없음(IPv6 무관). 카카오 GSLB A 레코드 TTL 4초 실측.
- **확정 결함: Bun 1.4.x `node:http` 클라이언트 timeout 회귀** — [oven-sh/bun#41133](https://github.com/oven-sh/bun/issues/41133) (Open, 2026-10-16 확인). 응답 없는 호스트로 연결 중에는 timeout이 걸리지 않는다. openid-client(`https.request({timeout})`)가 이 경로라 운영(Bun)에서 카카오 LB IP 하나가 무응답이면 10초 상한이 없다(OS SYN 재시도 한계까지). 로컬 재현: Node 22 2.0s timeout / Bun 1.4.0 8s 무이벤트. 운영 Bun 정확 버전은 미확인(`oven/bun:1` 부유 태그).
- **로컬(dev)은 Node로 실행된다**(next bin shebang) → Bun 결함은 로컬 지연을 설명하지 못한다. 로컬·운영 공통 후보: 카카오 token/userinfo 편차, TTL 4초 DNS 매회 조회, 공용 Oracle ADB 커넥션 생성. 로컬 전용: `next dev` 온디맨드 컴파일.
- **보안**: next-auth 4.24.13 advisory 3건은 우리 앱 실질 미해당(EmailProvider·`getToken`·다중 provider 없음) — 그래도 저위험 패치라 4.24.15 권고. next 15.3.8은 **실제 해당 high 있음**(RSC Server Function DoS 3건, WebSocket upgrade SSRF) → 15.5.27 이상 권고(`eslint-config-next` 동반). critical AVIF RCE는 `next/image` 0건이라 저위험.
- **런타임 Node 전환**: 코드에 Bun 전용 API 0건. 변경점은 Dockerfile(빌드·런타임 단계)과 스택 healthcheck(`bun -e` → `node -e`, 같은 커밋 필수)뿐. **패키지 매니저 pnpm 전환은 런타임과 독립** — lockfile 재생성 시 `^` 범위 의존성 대량 상향 위험 → 별건 권고.
- 권고 순서: ①운영 `bun -v` 확인 → ②next-auth 4.24.15 → ③next 15.5.x → ④Node 런타임 전환 → ⑤계측 배포 후 Loki 분해. 각 단계 별도 배포·로그인 확인.

### 10-5. D3 예열 — 측정 후 보류 (2026-10-16)
- 운영과 같은 standalone 빌드(Bun 1.4.0, 로컬)에서 콜드 기동 5회 측정: 레플리카당 첫 인증 요청 콜드 비용 **약 70~190 ms**(signin 첫 요청 42~134 ms, 두 번째 3~9 ms). 운영 ARM 경합 시 2~3배 추정 — 그래도 수백 ms 상한.
- 보고된 3~9.5초 스파이크와 크기가 맞지 않고 배포 직후 레플리카당 1회에만 붙는다 → **구현 보류**(사용자 지시 "추천한다면 진행"에 따라 비추천으로 판정). 필요해지면 healthcheck에서 `/api/auth/csrf` 1회 호출이 최소안.

### 10-6. D4 유휴 연결 끊김 — 실측과 설계 결정 (2026-10-16)
- **로컬 실측(프론트 세션)**: 유휴 3초 뒤 FIN 없이 패킷을 버리는 프록시로 IPVS 유휴 만료를 흉내 냄 → **Bun fetch는 조용히 끊긴 풀 소켓을 재사용해 abort까지 멈춤(15 s)**, Node fetch(undici)는 서버 Keep-Alive 힌트·기본 4초로 소켓을 먼저 닫아 정상. `Connection: close`는 두 런타임 모두 해결(1~5 ms). Bun은 65초 유휴 뒤에도 소켓 재사용. 운영에서 실제로 걸리는지는 Caddyfile·OCI NAT 유휴 정책 미확인.
- 서버 사이드 백엔드 호출은 **1곳뿐**(`next-bun/src/lib/auth.ts` jwt 콜백 → `authService.postKakaoSignInUp`). 두 스택 모두 `sys_default` overlay.
- **결정 (bun-3b, 사용자 승인 범위 "충분한 조사·테스트 후 진행")**:
  - ① 로그인 백엔드 호출 `Connection: close` (런타임 무관 보험)
  - ② 서버 전용 base URL `SERVER_API_BASE`(런타임 env, 스택 `http://prod_nest_app:3500`, 미설정 시 `NEXT_PUBLIC_API` 폴백 = 즉시 롤백 수단)
  - ③ 사용자 IP 전달 — Next route handler를 AsyncLocalStorage로 감싸 Caddy가 붙인 `x-forwarded-for`(형식 검증)를 백엔드 요청 `X-Forwarded-For`로 전달. ②·③ 동시 배포 필수(헤어핀 폴백 시 Caddy가 덮어씀)
  - 백엔드: `CustomThrottlerGuard.getTracker`를 XFF 첫 값 → **`req.ip`**(`trust proxy 1`)로 교체 — 사용자별 스로틀 키 복원 + XFF 첫 값 위조로 한도 우회 차단(WORKLOG 백엔드 감사 M4 일부 해소)
- 남는 위험: Next 23000 포트가 외부 노출이면 Next에 직접 위조 XFF를 보내 로그인 스로틀 우회 가능(영향 낮음, 방화벽 확인 필요). 내부 DNS도 Docker 내장 DNS라 §9-2 가설 1은 남는다.

### 10-7. 구현 현황 (2026-10-16, 미커밋)
| 레포 | 브랜치 | 내용 | 검증 |
|---|---|---|---|
| bun | `feat-onam-login` | `CustomThrottlerGuard.getTracker` → `req.ip` + spec 4건 | unit 통과, E2E 97/97, lint 경고 7→6 |
| next-bun | `feat-onam-login` | D2 로그인 중복 클릭 방지(진입점 6곳 → 공통 1곳) · D4 ① `Connection: close` · ② `SERVER_API_BASE`+스택 env · ③ ALS로 사용자 IP → `X-Forwarded-For` | lint 경고 4(기준선), typecheck, test 22 files/269, build, standalone 스모크 |
- 상세 실측·회귀 절차: `next-bun/docs/tasks/kakao-login-latency-front.md`
- 배포 순서: 백·프 어느 쪽이 먼저 나가도 현재보다 나빠지지 않는다. 효과(사용자별 스로틀 키)는 둘 다 배포된 뒤.
- 미검증: 실제 카카오 콜백 경로의 XFF 전달·운영 overlay 내부 직행 — 배포 후 백엔드 로그 `req.ip`로 확인.
- 차단: 재부팅으로 ssh-agent가 비어 GitHub push·서버 접속 불가(사용자 `ssh-add` 대기).

### 10-8. 사용자 결정 추가 (2026-10-16)
- **next 패키지 업데이트: 진행 승인** ("필요하면 진행") — §10-4 권고대로 next-auth 4.24.15 → next·eslint-config-next 15.5.27 이상, 단계별 배포·로그인 확인. 로그인 개선(§10-7) 배포 이후 착수.
- **프론트 런타임 Bun→Node 전환**: 미결(사용자 답 대기).
- **프론트 패키지 매니저 bun→pnpm 전환: 이 태스크(§10의 모든 작업) 완료 직후 바로 착수** — 런타임과 독립 작업. 절차 초안: `bun install --yarn`으로 yarn.lock 생성 → `pnpm import`로 현재 버전 보존 → Dockerfile·CI(`setup-bun`·`bun install`·`bun run`)·`package.json` `ci:core`·레포 문서/규약(CLAUDE.md 명령어) 갱신 → 유령 의존성 점검 → 별도 브랜치·배포. 백엔드와 같은 pnpm 메이저로 맞출지 함께 결정.
- 스로틀 단위 전수조사 요청 → §11.

## 11. 스로틀 단위 전수조사 (2026-10-16)

### 11-1. 현재 구조 (코드 근거)
- 전역 `APP_GUARD` `CustomThrottlerGuard`(`app.module.ts`) — 모든 HTTP 라우트에 초당 5·분당 60(`THROTTLE_SHORT/LONG`). 예외: 로그인 `POST /auth/kakao`는 초당 2·분당 10(`auth.controller.ts:24`), `@SkipThrottle`은 health·main·telegram webhook 3곳뿐.
- 저장소: `ThrottlerModule.forRoot`에 storage 미지정 → **레플리카별 인메모리**(3레플리카 각자 카운트, 요청 분산에 따라 한도가 들쭉날쭉).
- 키(`getTracker`): `request.user`가 있으면 `user-{id}`, 없으면 IP. **그러나 전역 가드는 라우트의 `@UseGuards(JwtAuthGuard)`보다 먼저 실행된다** → `request.user`(설정 위치는 `jwt-auth.guard.ts:45` 한 곳)가 항상 비어 있어 **userId 분기는 죽은 코드** — 로그인 사용자 API도 전부 IP 기준.
- 경로별 실제 키:
  - 브라우저가 직접 부르는 API(팀·태스크·채팅 등): 브라우저 → Caddy → Nest → 키 = **사용자 실제 IP** (단, 같은 IP 뒤의 여러 사용자는 공유)
  - 로그인(`/auth/kakao`): 브라우저 → Next 서버가 공인 도메인으로 호출(헤어핀) → 키 = **Next 서버 출구 IP 하나** → **전 사용자가 초당 2·분당 10 공유**
  - WS(채팅 등): 이 가드 대상 아님. 채팅은 별도 Redis 레이트리밋(`team-chat.service.ts` `consumeRateLimit`, 사용자·팀 단위)
- (수정 전) IP 키는 XFF **첫 값**이라 요청자가 위조해 한도 우회 가능 → §10-6에서 `req.ip`로 교체(미배포).

### 11-2. 운영 실측 (fs-01 → Loki, 읽기 전용)
- 최근 30일 Loki: `res_statusCode=429` **0건**, 로그인 요청 **4건**(10-14, 백엔드 응답 61·174·183·208 ms, 전부 201). 현재 트래픽에서는 스로틀 공유 문제가 실제 429로 터진 기록은 없다. **백엔드 로그인 처리 시간도 정상** — 느림이 있었다면 Next 쪽 구간(카카오·DNS·Bun)이다(표본 4건 한계).
- 현재 백엔드 컨테이너 로그(20시간): 요청 48건, 429 0건.

### 11-3. 문제와 영향
| 문제 | 영향 | 발생 조건 |
|---|---|---|
| 로그인 키 = Next 서버 IP 공유 | 동시 로그인 몰리면 전원 429 | 초당 3명·분당 11명 이상(레플리카 분산 시 그 이상) |
| 로그인 사용자도 IP 키(userId 분기 죽음) | 같은 회사·학교 Wi-Fi·통신사 CGNAT 뒤 사용자들이 초당 5·분당 60을 공유 → 팀 화면 활발한 사용 시 429 | 같은 공인 IP 다수 사용자 |
| 인메모리 저장소 | 레플리카마다 따로 세어 한도가 정확하지 않음(최대 3배·불균일), 재시작 시 초기화 | 상시 |

### 11-4. 수정안 (사용자 결정 대기)
1. 로그인 경로 — §10-6(내부 주소 + 사용자 IP 전달 + `req.ip`)로 해소(구현 완료·미배포).
2. **로그인 사용자 키를 userId로**: `getTracker`에서 쿠키/Bearer 토큰을 `JwtService.verify`(서명 검증만, DB 조회 없음)로 확인해 `user-{id}`, 실패·부재 시 IP. 가드 실행 순서를 바꾸지 않고 해결. 위험 낮음(검증 실패 시 기존 동작).
3. **Redis 저장소**: 이미 쓰는 Redis에 throttler storage 연결 → 레플리카 공유 카운트. 새 의존성(`@nest-lab/throttler-storage-redis` 등) 필요 → Ask 대상.

### 11-5. 사용자 질문에 대한 확인 (2026-10-16)
- **HTTP 스로틀은 Redis를 쓰지 않는다.** 근거 2경로: `ThrottlerModule.forRoot([...])`(`app.module.ts:94-97`)에 storage 옵션 없음 / `package.json`에 throttler storage 패키지 없음(`@nestjs/throttler`만). Redis는 WS 어댑터·온라인 상태·**채팅 레이트리밋**에만 쓰인다.
- **로그인 사용자도 IP로 센다.** `user-{id}` 분기는 2026-04-06 `cb4ead4`(API 스로틀링 도입)에서 작성됐지만, 전역 가드(`APP_GUARD`)는 컨트롤러·라우트 가드(`@UseGuards(JwtAuthGuard)`)보다 **먼저** 실행된다(NestJS 가드 실행 순서: global → controller → route). `request.user`는 `jwt-auth.guard.ts:45`에서만 설정되므로 스로틀 시점에 항상 비어 있다 → 의도(아이디 기준)대로 동작한 적이 없다.
- **WebSocket**: HTTP 스로틀 대상이 아니다.
  - 팀 채팅: `chat:send` 20회/10초, `chat:read` 60회/10초 — **사용자·팀 단위, Redis 고정 윈도**(`chat.constants.ts:19-22`, `team.gateway.ts:302,372`). Redis 장애 시 통과(fail-open, 의도).
  - 팀 `joinTeam`·`leaveTeam`: 제한 없음.
  - 낚시(`/fishing`): `MOVE`·`CHAT_MESSAGE`·`CATCH_RESULT` 등 **서버 측 제한 없음**(클라이언트 throttle만) — 기등재 D30.
- **같은 와이파이(공인 IP 공유)는 의도된 동작**(사용자 확인). 로그인 경로만 사용자 IP로 고치면 나머지 비로그인 요청은 의도대로 동작한다.

### 11-6. 결정 (2026-10-16)
- 로그인 경로 사용자 IP 기준 — §10-6 구현으로 진행(완료·미커밋).
- **로그인 사용자 키를 userId로 (사용자가 원래 의도한 설정)** — 진행 여부 사용자 확인 대기(권장: 진행 — 토큰 서명만 검증, DB 조회 없음, 실패 시 IP).
- Redis 저장소 — 사용자 확인 대기(새 의존성).
- **커밋 정책: 이번 묶음은 작업을 모두 끝낸 뒤 리뷰하고 커밋한다(사용자 지시). 그 전까지 전부 미커밋.**
- **계측 WIP(2026-08-21 작성·미커밋)도 이번 묶음에 포함해 함께 커밋 대상** — 백엔드 `auth.service.ts`, 프론트 `src/lib/auth.ts`.
- 프론트 콜백 전체 소요 계측 설계(승인 대기): route 래퍼에서 `/api/auth/callback/kakao`만 1줄 — `tag: login.callback`(실패 `login.callback.error`, `Location`에 `/auth/error`·`error=`면 실패), 쿼리·쿠키·IP 미기록. 분해: 카카오 2홉 ≈ `login.callback.ms − login.backend.ms`. 상관 ID는 넣지 않는다.
- 프론트 계측 WIP 리뷰 지적 1건: 주석의 문서 상대경로 `../../bun/...` → `../../../bun/...` (리뷰 단계에서 수정).

## 12. 2026-10-16 결정 — 스로틀 정석화·프론트 런타임·콜백 계측

### 12-1. 사실 확인 (사용자 질문 "Redis Pub/Sub으로 공통으로 세고 있지 않나")
- **아니다.** HTTP 스로틀 카운트는 레플리카별 인메모리다. 근거 3경로:
  1. `ThrottlerModule.forRoot`(`app.module.ts:94-97`)에 `storage` 없음 → 기본 `ThrottlerStorageService`(Map + setTimeout, `node_modules/@nestjs/throttler/dist/throttler.service.js`)
  2. throttler 저장소 패키지 미설치(`package.json`에 `@nestjs/throttler`만)
  3. Redis 클라이언트는 `redis-io.adapter.ts`의 pub/sub 2개뿐이고, 이를 받는 곳은 `main.ts`의 `setRedisClient` 3곳(OnlineUser·FishingOnline·TeamChat)뿐 — 스로틀러는 없다
- Redis Pub/Sub은 **Socket.IO 이벤트를 레플리카 간에 중계**하는 용도(어댑터)이고 카운터 공유와 무관하다.
- **HTTP 전역 스로틀 가드는 WebSocket 이벤트에 걸리지 않는다** — 로컬 프로브(전역 `APP_GUARD` + 한도 2, WS 이벤트 4연속 → 4회 모두 정상 응답, 2026-10-16). WS 보호는 채팅 전용 Redis 레이트리밋뿐.

### 12-2. 결정 (사용자 지시)
| # | 항목 | 결정 | 담당 |
|---|---|---|---|
| T1 | HTTP 스로틀 카운터 | **Redis 공유 저장소로 전환**(정석). 새 의존성 없이 기존 ioredis(pub 클라이언트)로 `ThrottlerStorage` 구현 — Lua 원자 연산, Redis 미연결·지연 시 레플리카 인메모리로 폴백(채팅 레이트리밋과 같은 fail-open) | 백엔드 |
| T2 | 로그인 사용자 스로틀 키 | **userId 기준**(원래 의도) — 가드 안에서 액세스 토큰 서명만 검증(DB 조회 없음), 실패·부재 시 `req.ip` | 백엔드 |
| T3 | WS 채팅 레이트리밋 키 | **팀 단위 → 사용자(ID) 단위**로 — 여러 팀을 오가며 우회 불가 | 백엔드 |
| R1 | 프론트 런타임 | **Bun → Node 전환** 확정 | 프론트 |
| C1 | 카카오 로그인 콜백 전체 소요 로그 | **추가** (§11-6 설계) | 프론트 |
- 커밋 정책 유지: 이번 묶음 전체 완료 → 리뷰 → 커밋. next-auth·next 업데이트는 그 다음 단계, pnpm 전환은 이 태스크 완료 직후.

### 12-3. 구현 현황 (2026-10-16, 미커밋)
| 레포 | 항목 | 변경 | 검증 |
|---|---|---|---|
| bun | T1 Redis 스로틀 저장소 | 신규 `src/common/throttler/redis-throttler.storage.ts`(Lua 원자 고정 윈도+차단 키, ready 아님·200ms 초과·오류 시 인메모리 폴백), `app.module.ts` `storage`, `main.ts`에서 pub 클라이언트 주입 | 단위 6건(결과 변환·차단·미연결·부팅 직후·오류·타임아웃). **실 Redis 다중 인스턴스 공유 검증은 로컬 Docker 꺼짐으로 미실행** |
| bun | T2 로그인 사용자 userId 키 | `custom-throttler.guard.ts` 생성자 주입 + 토큰 서명 검증, 공용 `src/common/utils/access-token.utils.ts`(JwtAuthGuard와 같은 추출 규칙) | 단위 7건(쿠키·Bearer·위조 서명·만료·비로그인·XFF 위조·ip 없음) |
| bun | T3 채팅 레이트리밋 사용자 단위 | 키 `chat:rl:{action}:{userId}` (팀 합산), 주석·DESIGN.md 갱신 | team-chat 단위 25건 |
| bun | 전체 | | `pnpm ci:core` lint 에러 0·경고 6(기준 7에서 1 감소), unit 36 suites/766, build 0, E2E 9/97 |
| next-bun | C1 콜백 전체 소요 로그 | `route.ts` 래퍼 + `src/lib/loginTiming.ts` | 단위 4건 |
| next-bun | R1 Node 24 런타임 | Dockerfile(빌드·운영 `node:24-bookworm-slim`, bun은 의존성 설치용 바이너리만, `USER node`, `CMD node server.js`) + 스택 healthcheck `node -e …`(같은 커밋) + 워크플로 주석 | lint·typecheck·test 23/273. standalone Node 24 vs Bun 비교: 기동 448 vs 530 ms, 스모크 전부 200, RSS +25 MB/레플리카, #41133 재현 Node 2.0 s timeout, R1 회귀 Node 정상. **Docker 이미지 빌드는 로컬 데몬 꺼짐으로 미실행** |
- **T1 실 Redis 검증 (2026-10-16, 로컬 `bun-redis` 6380)**: 저장소 인스턴스 2개(레플리카 A/B 흉내)가 번갈아 increment → `A:1 B:2 A:3 B:4 A:5 B:6/BLOCK`(한도 5 공유), 차단 중 A도 차단(Retry-After 2 s), 차단·윈도 만료 후 B에서 1부터 재시작. 카운터 키 PEXPIRE 확인.

### 12-4. 다음 순서 (2026-10-16 사용자 지시)
1. 남은 구현: 프론트 Docker 이미지 실빌드 검증 + **next-auth 4.24.15 → next·eslint-config-next 15.5.x** (같은 브랜치, 별도 커밋 예정)
2. 리뷰 루프 — 백·프 각 세션 `/review` + 레포 전용 리뷰 스킬 + 독립 Opus 서브에이전트, 교차검증·수정을 상·중 0건까지 반복
3. 최종 리뷰 → 로컬 API·Playwright 실측(로그인은 사용자) → 커밋 → develop → main
4. 이 태스크 종료 직후 프론트 pnpm 전환(§10-8)

### 12-5. 리뷰 중 실측 (2026-10-16)
- **스로틀 키 통합 E2E 추가** `test/throttle-key.e2e-spec.ts` — 실제 DI(APP_GUARD + ConfigService + 저장소 주입)·`trust proxy 1` 위에서 3건: 같은 IP의 다른 로그인 사용자는 한도 분리 / XFF 첫 값 위조로 우회 불가 / 서명 위조 토큰은 IP 버킷. 이전 구현(XFF 첫 값)으로 되돌리면 2건 실패(뮤테이션 확인).
- **운영 포트 외부 노출**: 로컬에서 fs-01 공인 IP로 23000(Next)·23500(Nest)·9090 TCP 접속 → 모두 closed/filtered. Next 직접 접근으로 위조 XFF를 넣는 경로(§10-6 남은 위험)는 외부에서 닫혀 있다(관측 지점 1곳 기준).
- Caddy 버전 v2.11.7. 컨테이너의 `/etc/caddy/Caddyfile`은 기본 템플릿(26줄, reverse_proxy 주석뿐)이라 실제 라우팅 설정 위치는 미확인 — XFF 처리는 Caddy v2 기본(미신뢰 프록시의 XFF 무시, remote IP로 설정)으로 가정. 어느 쪽이든 `trust proxy 1`은 마지막(Caddy가 붙인) 값을 쓰므로 결론은 같다.

### 12-6. 백엔드 리뷰 루프 (2026-10-16) — 수렴
| 라운드 | A (메인 `/review`·review-flow) | B (독립 Opus) | 조치 |
|---|---|---|---|
| 1 | 스로틀 키 통합 E2E 공백 → `test/throttle-key.e2e-spec.ts` 추가(뮤테이션 2건 실패 확인) | 중 3·하 6: ①느리거나 조용히 끊긴 Redis에서 매 요청 +400 ms·로그 폭주 ②어댑터 클라이언트(`maxRetriesPerRequest:null`) 재연결 시 밀린 명령 일괄 재전송 → 엉뚱한 429 ③`api-http.md` rule이 XFF 첫 값을 지시 / 차단 해제 의미·D-007 문서·Lua 실검증 공백·EVAL 매회 전송·프론트 XFF 첫 값 | 스로틀 **전용 연결**(오프라인 큐·재전송 끔, `commandTimeout` 200 ms, keepAlive) + **5초 차단기**(경고 1회) + `defineCommand`, 차단 해제 시 카운터 리셋(Lua), rule·D-007·README 갱신, opt-in 실 Redis E2E `test/redis-throttler.redis.e2e-spec.ts`(`THROTTLE_REDIS_TEST_PORT`), 프론트에 XFF 마지막 값 전달 |
| 2 | — | **상·중 0**, 하 2(E2E 주석·타이머 정리) | 하 2 반영 |
- 최종: `pnpm ci:core` 경고 6·unit 767 통과·build 0 / E2E 10 suites 100 통과 + 2 skip(opt-in) / 실 Redis(6380) 5/5.

### 12-7. 프론트 Docker 실빌드·패키지 업데이트 (2026-10-16, 프론트 세션)
- **R1 Docker 실빌드(로컬 arm64, push 없음)**: 이미지 bun 306 MB → Node 320 MB(15.3.8) → 331 MB(15.5.28). 컨테이너: 런타임 node만·사용자 `node`·스택 healthcheck exit 0·`.next/cache` 쓰기 정상·health/providers/csrf/session/signin POST 200·OG 5종 200·로그 에러 0. 메모리(요청 55회 후) Node 89.7 MB(15.5 82.5 MB) vs bun 92.9 MB — 앞서 standalone 측정(+25 MB)과 달리 컨테이너 기준으로는 차이 미미.
- **next-auth 4.24.15**(lock만, 범위 `^4.24.11` 유지). "NEXTAUTH_URL 우선" 변경: 레포에 `AUTH_TRUST_HOST`·`VERCEL` 0건 → 서버 env에 없으면 동작 동일(서버 env 미확인). OAuth state 쿠키 provider 바인딩 → 배포 순간 진행 중이던 로그인 1회 실패(재시도로 해결, 릴리스 노트 명시).
- **next·eslint-config-next 15.5.28**(정확 고정). 15.5의 `.next/types/validator.ts`가 `pagesDir` 기준으로 src 여부를 판정(`next/dist/build/index.js:465`) → 루트 `pages/`(_app·_error, styled-jsx 회피용)와 `src/app` 혼재 구조에서 타입 검사 실패 → **`pages/` → `src/pages/` 이동 승인**(메인, 동작 무관·설정 참조 0건 확인). `next lint` deprecation 경고는 기록만.
- 프론트 `extractClientIp`를 XFF **마지막** 값으로 수정(백엔드 리뷰 B 지적).

### 12-8. 프론트 리뷰 루프 (2026-10-16, 프론트 세션) — 수렴
- R1: A(`/review` 상0·중0·하3, review-front 상0·중1·하8) · B(Opus 상0·중1·하6). CONFIRMED 중 2건 수정:
  - 초대 수락 페이지(버튼 훅 없음)에서 bfcache 복귀 시 모듈 잠금이 남아 다른 화면 로그인 버튼 영구 busy → `shared.ts` 모듈 레벨 `pageshow(persisted)` 리셋 + 회귀 테스트(수정 제거 시 실패 확인)
  - `serverFetch`가 env를 별칭으로 읽어 `NEXT_PUBLIC_API`가 빌드 시 인라인되지 않음 → standalone에서 `SERVER_API_BASE` 제거(롤백) 시 base `''`로 로그인 전부 실패 가능 → `process.env.X` 리터럴로 수정, 새 빌드 산출물에서 인라인 확인
  - 하: 초대 페이지 실패 후 1회 재시도, callbackUrl의 `error=`로 성공 콜백 오판(→ Location 경로로 판정), 문서·README 보정, "롤백은 이미지만이 아니라 스택 파일 단위"(healthcheck가 `node -e`라서) 기록
- R2(수정분만): A·B 상·중 0, 공통 하 1(`loginTiming`의 `new URL`이 route `finally`에서 throw 시 성공 응답을 500으로 바꿀 수 있음) → try/catch + 응답 보존 회귀 테스트
- B가 백엔드 계약 일치 확인: `trust proxy 1`/`req.ip`와 XFF 마지막 값 기준.
- **리뷰 중 발견한 기존 결함**: `authService.ts` 응답 형태 검증 실패 로그가 accessToken 포함 응답 전체를 출력 → 시크릿 로그 금지(레포 Never) 위반이라 이번 묶음에서 수정(메인 결정, `fix(auth)` 별도 커밋).
- 후속(기록만): 같은 화면 다른 LoginButton busy 잔존, disabled 버튼 포커스, `oven/bun:1`·`node:24` 태그 미고정, 카카오 취소(access_denied) 로그 분리, Caddy 앞 추가 프록시 단계 유무, 초대 페이지·route POST 테스트 공백.

### 12-9. 로컬 실측 (2026-10-16, 사용자 카카오 로그인 1회, 백·프 로컬 dev + 로컬 Redis 6380)
- **로그인 버튼 연타**: 50 ms 간격 4회 클릭 → `POST /api/auth/signin/kakao` 1회·카카오 authorize 이동 1회, 첫 클릭 직후 버튼 disabled.
- **구간 분해(첫 실측)**: 브라우저 콜백 **773 ms** (dev 모드) = Next 콜백 핸들러 `login.callback` **513 ms** + 그 밖(dev 온디맨드·브라우저) 260 ms. 핸들러 안: 백엔드 왕복 `login.backend` **208 ms** → 카카오 token+userinfo 2홉 ≈ **305 ms**. 백엔드 `totalMs` **175**(`kakaoMs` 79·`dbMs` 96·`writeMs` 0). 세 로그의 시각이 서로 맞는다(06:30:49.428 / .432 / .434). 정상 케이스 기저값이다.
- **로그인 백엔드 요청**: `connection: close`, `x-forwarded-for` 1개 값 전달 확인(로컬은 Next dev가 붙인 127.0.0.1).
- **토큰 로그 노출**: 프론트·백엔드 dev 로그에서 JWT(`eyJ`) 0건.
- **스로틀**: 로그인 사용자 토큰으로 동시 7회 → 200×5, 429×2(초당 5). 같은 IP의 비로그인 7회는 **별도 버킷**(401×5·429×2). Redis에 `throttle:*` 키 생성 확인.
- **회귀**: API 7/7(알림 채널 키 노출 0), 화면 28/0 — 3개 뷰포트 로드·넘침·뷰 전환·뒤로가기·`?tab=archive`·빠른 탭 전환·첫 로딩 탭 전환, **일반 사용 중 429 0건**(사용자 단위 초당 5 한도에서 화면 동작이 막히지 않음).
- 실측 후 dev 서버 종료·로그인 상태 파일 삭제.

## 13. 운영 배포 결과 (2026-10-19)
- 백엔드: #261(→develop)·#262(→main), 커밋 5개. 배포 run 39190262690 — `prod_nest_app: completed` 3/3. 운영 Redis에 `throttle:*` 키 생성(레플리카 간 공유 동작).
- 프론트: next-bun #341·#342, 커밋 9개. 배포 run 39190459396 — Node 24 이미지, 4/4 `Update completed`, 수렴 약 85초. 컨테이너 사용자 `node`, 메모리 레플리카당 55~57 MB(백엔드 78~79 MB), 노드 가용 8.4 GB.
- **운영 로그인 실측(사용자 로그아웃→로그인 1회, 02:38:22Z)**:

| 구간 | 운영 | 로컬(§12-9) |
|---|---|---|
| Next 콜백 핸들러 `login.callback` | 675 ms | 513 ms |
| ㄴ 카카오 token+userinfo 2홉 (= callback − backend) | ≈ 331 ms | ≈ 305 ms |
| ㄴ 백엔드 왕복 `login.backend` | 344 ms | 208 ms |
| 　ㄴ 백엔드 `totalMs` (kakao 152 · db 149 · write 0) | 301 ms | 175 ms |
| 　ㄴ Next↔Nest 네트워크 (= backend − totalMs) | **43 ms** | — |

  - 백엔드가 받은 로그인 요청: `host: prod_nest_app:3500`(내부 주소 직행 확인), `connection: close`, `x-forwarded-for`에 **사용자 공인 IP**(값은 기록하지 않음) → `req.ip` = 사용자 IP, 스로틀 키 사용자 단위 확인.
  - 배포 후 3시간: `login.callback.error`·`login.backend.error`·`OAuthCallback` 0건, 429 0건. `NEXTAUTH_URL` 관련 오류 없음(로그인 정상).
- 기존 경고 `Unsupported route path`는 배포 전 7일에도 16건 — 이번 변경과 무관.
- **남은 판정**: 간헐 스파이크는 이제 발생 시 위 세 로그로 자동 분해된다(§6-2b 쿼리 사용 가능). 다음 스파이크 관측 시 이 표와 비교.
- **다음 작업**: 프론트 패키지 매니저 bun → pnpm 전환(§10-8) 착수.
