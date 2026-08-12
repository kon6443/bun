# NestJS API 스로틀링(Rate Limiting) 완벽 가이드

## API 스로틀링이란?

**일정 시간 내 API 요청 횟수를 제한**하는 기술입니다.

```
유저 → 로그인 API 10번 호출 → 서버: 정상 처리
유저 → 로그인 API 11번째 → 서버: 429 Too Many Requests (차단)
→ 1분 후 다시 허용
```

### 왜 필요한가?

| 위협 | 스로틀링 없을 때 | 적용 후 |
|------|----------------|--------|
| 브루트포스 공격 | 비밀번호 무한 시도 가능 | 분당 N회 제한 |
| DDoS | 서버 자원 고갈 | 초과 요청 즉시 차단 |
| 크롤링/스크래핑 | 데이터 무단 수집 | 속도 제한 |
| API 남용 | 서버 과부하 → 정상 유저도 접속 불가 | 공정한 자원 분배 |

> **현업에서는 거의 필수**입니다. AWS, GitHub, Google API 등 모든 공개 API가 Rate Limiting을 적용하고 있고, 보안 감사에서도 확인하는 항목입니다.

---

## NestJS에서의 구현: @nestjs/throttler

NestJS는 공식 스로틀링 모듈 `@nestjs/throttler`를 제공합니다.

### 설치

```bash
pnpm add @nestjs/throttler
```

### 기본 설정 (글로벌)

```typescript
// app.module.ts
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      ttl: 60000,    // 60초 (1분)
      limit: 60,     // 분당 60회
    }]),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,  // 모든 API에 자동 적용
    },
  ],
})
export class AppModule {}
```

이 설정 하나로 **모든 API 엔드포인트에 분당 60회 제한**이 걸립니다.

### 특정 API에 다른 제한 적용 (오버라이드)

```typescript
// 로그인: 더 엄격하게 (분당 10회)
@Throttle({ default: { limit: 10, ttl: 60000 } })
@Post('auth/login')
async login() { ... }

// 검색: 더 느슨하게 (분당 200회)
@Throttle({ default: { limit: 200, ttl: 60000 } })
@Get('search')
async search() { ... }

// 헬스 체크: 제한 제외
@SkipThrottle()
@Get('health-check')
async healthCheck() { ... }
```

**우선순위: 엔드포인트 데코레이터 > 컨트롤러 데코레이터 > 글로벌 설정**

---

## 유저 식별 방식

스로틀링은 **"누구의 요청인지"** 식별해야 카운트할 수 있습니다.

### IP 기반 (기본)

```
유저 A (IP: 1.2.3.4) → 5번 호출 → 카운트: 5
유저 B (IP: 5.6.7.8) → 3번 호출 → 카운트: 3 (별도)
```

| 장점 | 단점 |
|------|------|
| 비로그인 API도 보호 가능 | 같은 Wi-Fi/회사 네트워크 = 같은 IP |
| 설정 간단 (기본값) | VPN/프록시 뒤의 유저 구분 불가 |

### userId 기반

```typescript
// 커스텀 Throttler Guard
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    // 로그인한 유저는 userId로, 아니면 IP로
    return req.user?.userId?.toString() || req.ip;
  }
}
```

| 장점 | 단점 |
|------|------|
| 유저별 정확한 카운트 | 로그인 필수 |
| 같은 Wi-Fi에서도 구분 가능 | 비인증 API에는 사용 불가 |

### 혼합 방식 (권장)

```
비인증 API (로그인, 회원가입) → IP 기반
인증 API (CRUD, 데이터 조회) → userId 기반
```

---

## 카운트 저장소

### 메모리 (기본)

```typescript
ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }])
// → 서버 메모리에 저장
```

- 서버 1대: 문제 없음
- **서버 2대 이상: 각 서버가 별도 카운트** → 실질적으로 제한이 2배로 느슨해짐
- 서버 재시작 = 카운트 초기화

### Redis (멀티 서버 환경)

```typescript
import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';

ThrottlerModule.forRoot({
  throttlers: [{ ttl: 60000, limit: 60 }],
  storage: new ThrottlerStorageRedisService('redis://localhost:6379'),
})
```

- **모든 서버가 카운트 공유** → 정확한 제한
- 서버 재시작해도 카운트 유지 (Redis TTL 만료까지)
- **Docker Swarm, Kubernetes 등 멀티 레플리카 환경이면 Redis 필수**

### 서버 부하

| 항목 | 부하 |
|------|------|
| 메모리 방식 | 거의 0 |
| Redis 방식 | 요청당 ~0.5ms (읽기/쓰기 1회) |

4 OCPU 서버 기준 **전혀 체감 불가**.

---

## 주요 옵션 정리

### ttl (Time To Live)

```typescript
{ ttl: 60000 }  // 60초 = 1분
```

카운트가 리셋되는 시간 (밀리초). "이 시간 내에 limit 초과하면 차단".

### limit

```typescript
{ limit: 60 }  // 60회
```

ttl 동안 허용되는 최대 요청 수.

### blockDuration (선택)

```typescript
{ ttl: 60000, limit: 10, blockDuration: 300000 }
// 1분 내 10회 초과 → 5분간 완전 차단
```

제한 초과 시 추가 차단 시간. 기본값은 0 (다음 ttl 주기에 바로 허용).

### 여러 시간 단위 설정

```typescript
ThrottlerModule.forRoot([
  {
    name: 'short',
    ttl: 1000,     // 1초
    limit: 3,      // 초당 3회
  },
  {
    name: 'medium',
    ttl: 10000,    // 10초
    limit: 20,     // 10초당 20회
  },
  {
    name: 'long',
    ttl: 60000,    // 1분
    limit: 100,    // 분당 100회
  },
])
```

**세 조건을 동시에** 만족해야 통과. 하나라도 초과하면 차단. 이 패턴으로 순간 폭발(burst)과 지속적 남용을 동시에 방어.

---

## 현업 추천 설정값

| API 유형 | TTL | Limit | 근거 |
|---------|-----|-------|------|
| **글로벌 기본** | 60초 | 60~100회 | 일반 사용자 기준 충분 |
| **로그인/회원가입** | 60초 | 5~10회 | 브루트포스 방지 |
| **비밀번호 변경** | 60초 | 3~5회 | 보안 민감 |
| **파일 업로드** | 60초 | 10~20회 | 서버 리소스 보호 |
| **검색/조회** | 60초 | 100~300회 | 사용 빈도 높음 |
| **데이터 생성** | 60초 | 20~30회 | 남용 방지 |

> 정해진 표준은 없습니다. 서비스 특성에 맞게 조정하되, **로그인/인증 관련은 반드시 엄격하게** 설정.

---

## 429 응답 처리 (프론트엔드)

스로틀링에 걸리면 서버가 HTTP 429를 반환합니다:

```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "ThrottlerException: Too Many Requests",
  "timestamp": "2026-08-12T05:00:00.000Z"
}
```

> ⚠️ `ThrottlerException`은 NestJS 기본 `HttpException` 형태(`statusCode` + `message`)로 던져지지만, 이 프로젝트는 전역 `HttpExceptionFilter`가 모든 에러를 `{ code, message, timestamp }`로 통일합니다 — 응답 바디에 `statusCode` 필드는 **없습니다**. 429는 `code: 'TOO_MANY_REQUESTS'`로 매핑됩니다 (`src/common/filters/http-exception.filter.ts`의 상태코드 → 코드 맵). 따라서 프론트에서 바디의 `statusCode`를 보지 말고 **HTTP 상태(`response.status`) 또는 `code` 필드**로 분기해야 합니다.

응답 헤더에 유용한 정보가 포함됩니다:

```
X-RateLimit-Limit: 60        ← 최대 허용 횟수
X-RateLimit-Remaining: 0     ← 남은 횟수
Retry-After: 30              ← 30초 후 재시도 가능
```

프론트에서의 권장 처리:

```typescript
if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After');
  toast.error(`요청이 너무 많습니다. ${retryAfter}초 후 다시 시도해주세요.`);
}
```

---

## Docker Swarm/Kubernetes에서의 주의점

### 문제: 리버스 프록시 뒤의 IP

```
유저 → Nginx(프록시) → NestJS 서버
        IP: 10.0.0.1    ← 모든 유저가 같은 IP로 보임!
```

### 해결: X-Forwarded-For 헤더

```typescript
// main.ts
const app = await NestFactory.create(AppModule);
app.set('trust proxy', 1);  // 프록시 1단계 뒤의 실제 IP 사용
```

```typescript
// 커스텀 Guard에서 실제 IP 추출
protected async getTracker(req: Request): Promise<string> {
  return req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip;
}
```

---

## 요약

| 항목 | 내용 |
|------|------|
| **개념** | 일정 시간 내 API 요청 횟수 제한 |
| **필요성** | 보안(브루트포스), 안정성(과부하 방지), 공정성(자원 분배) |
| **NestJS 도구** | `@nestjs/throttler` (공식 모듈) |
| **식별 방식** | IP 기반 (기본) / userId 기반 (커스텀) |
| **저장소** | 메모리 (단일 서버) / Redis (멀티 서버) |
| **글로벌 설정** | 모든 API에 기본 적용 → 특정 API에서 오버라이드 |
| **현업 기본값** | 글로벌 분당 60~100회, 로그인 분당 5~10회 |
| **서버 부하** | 거의 없음 (Redis: 요청당 ~0.5ms) |
