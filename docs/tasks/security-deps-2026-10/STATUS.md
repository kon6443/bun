# 의존성·런타임 보안 패치 (2026-10)

- **상태**: 🟡 진행 중 — 브랜치 수정·검증 완료, 커밋 대기 (사용자 지시 전 커밋하지 않음)
- **최종수정**: 2026-10-30

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드 | (이 세션) | `bun/.claude/worktrees/security-deps` | `fix-onam-security-deps-2026-10` (`origin/develop` `992a731`) |
| 프론트 | `next-bun-d5` | 프론트 세션이 보고 | `fix-onam-security-deps-2026-10` (`origin/develop`) |
| 같은 서버의 다른 프로젝트(nerd 모노레포) | `back-a3` | 그 레포 worktree | 그 레포 컨벤션 |

## 목표 & 수용 기준
- 무엇을: 운영 의존성의 critical·high 취약점을 **기능 변경 없이** 제거한다 — 같은 메이저 안의 패치·마이너 업과 범위 한정 `pnpm.overrides`만 쓴다
- 끝났다는 기준: `pnpm audit --prod` critical·high 0(남는 건 비해당 사유 명시), `pnpm ci:all` 통과(기준선 유지), 앱 코드 diff 0
- 비해당 확인: Node 런타임(운영 컨테이너 24.22.1 = 10-21 보안 릴리스 수정 버전), npm 웜(TanStack·Miasma·ChainDrop) — lockfile의 `keyv@4.5.4` 등은 악성 버전이 아니다

## 결정
- **Nest는 11.1.x 마지막 패치(`~11.1.29`)로 고정한다** — 11.2.x는 `IoAdapter`에 `logger` 필드가 추가돼 `RedisIoAdapter`(`src/common/adapters/redis-io.adapter.ts`)의 `private logger`와 타입 충돌(TS2415)한다. 코드 변경 없이 보안 수정(GHSA-36xv-jgw5-4q75, 11.1.18 이상)만 받으려고 `~`로 묶었다. 11.2 이상 업그레이드는 후속
- **typeorm은 0.3.28 유지** — 0.3.29~0.3.31에 동작 변경(update/delete의 빈·무효 where를 throw, `setFindOptions()` async 등)이 있고 Oracle 경로는 로컬에서 실검증할 수 없다. 남는 advisory 2건은 비해당: SQL 인젝션은 MySQL/MariaDB 한정(GHSA-9ggv-8w38-r7pm), 코드 인젝션은 dev CLI `migration:generate` 한정(GHSA-2rp8-mm9q-fp49)
- **socket.io 직접 의존성은 `^4.8.3` 유지** — `@nestjs/platform-socket.io`가 4.8.3을 정확 고정해 런타임 서버는 그 copy로 뜬다. 직접만 올리면 두 copy가 생기고 런타임은 그대로다. 취약점은 하위 `engine.io`(→6.6.11)·`socket.io-parser`(→4.2.7)·`ws`에 있어 그쪽만 올렸다
- 상위 패키지가 정확 버전으로 고정한 하위 의존성은 **취약 범위만 고른 override**로 같은 메이저 안에서 올린다: `multer@<2.5.0`, `ws@>=8.0.0 <8.21.0`, `js-yaml@>=5.0.0 <5.4.1`

## 결과 (백엔드)
- prod audit: critical 1 / high 27 / moderate 21 / low 5 → **critical·high 0** (moderate 2 = typeorm, 위 결정대로 비해당)
- 전체 audit: 96건 → 6건(typeorm moderate 2 + dev 전용 4: `@nestjs/cli` 내부 picomatch high·moderate, Windows 전용 esbuild low, 패치 없는 deepmerge low)
- `pnpm ci:all` 통과: lint 경고 6건(기준선 동일), 단위 1922/1922, E2E 307 통과·58 skip(Redis opt-in, 기준선과 같은 skip 수), build 통과

## 게이트
- 머지 전 차단: 없음
- 배포 직후 조치: 운영에서 WS 연결·HTTP 응답 스모크 확인
- 후속: Nest 11.2+/12 업그레이드(`RedisIoAdapter.logger` 정리 포함), `@nestjs/cli` 경유 dev 취약점, 서버 커널 CVE-2026-98432(수정 커널 미출시)
