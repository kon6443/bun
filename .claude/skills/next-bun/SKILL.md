---
name: next-bun
description: 프론트엔드 레포(../next-bun, Next.js)가 백엔드 API·소켓 이벤트를 어떻게 쓰는지 확인하거나, 백엔드 응답·에러 코드·이벤트를 바꿀 때 프론트 영향을 대조할 때 사용한다. 파일을 열기 전 설계 단계에서도 먼저 부른다. 프론트 규약 로드 절차와 계약 접점을 안내한다.
---

<!-- paths frontmatter 를 일부러 쓰지 않는다: 스킬 paths 도 이 레포 루트 기준 glob 이라
     ../next-bun/** 를 매칭하지 못한다. 넣으면 자동 발동이 영구히 죽는다 (mobisell-back F39 와 같은 판단).
     출처: docs/tasks/tasks-claude-config.md C3-6 -->

# 프론트(`../next-bun`) 작업 절차

## 1. 규약 먼저 로드
- `../next-bun` 파일을 건드리면 훅이 프론트 `CLAUDE.md`를 자동 주입한다. **설계 단계라 아직 파일을 안 열었다면** 지금 읽는다:
  ```
  Read ../next-bun/CLAUDE.md
  ```
- UI·NextAuth 규칙은 `../next-bun/.claude/rules/`(`ui.md`·`nextauth.md`)에 있고 해당 프론트 파일을 건드리면 훅이 주입한다. 설계 단계라면 필요한 것만 직접 읽는다. 진단·작업 절차는 그 문서의 라우팅 표가 가리키는 `../next-bun/docs/assistant_*.md`.

## 2. 계약 접점 — 백엔드를 바꾸면 여기서 프론트가 깨진다
값의 SSOT는 이 레포 `.claude/rules/code-patterns.md`다. 바꾸기 전에 프론트 쪽 사용처를 grep한다.

| 접점 | 백엔드 SSOT | 프론트 사용처 |
|---|---|---|
| 성공 응답 `{ code, data, message }` | §7 | `../next-bun/src/services/teamService.ts` |
| 에러 `{ code, message, timestamp }` · 에러 `code` 값 | §4 · `src/modules/*/*-error.dto.ts` | `teamService.ts`의 `ApiError`·`ErrorCode` |
| 요청 DTO 필드 (`forbidNonWhitelisted`) | §5 | 서비스 호출부의 요청 바디 — 필드를 지우거나 이름을 바꾸면 프론트 요청이 **422 `VALIDATION_ERROR`** |
| 인증 쿠키 `access_token` · WS `handshake.auth.token` | §6 | `../next-bun/src/lib/auth.ts` |
| 소켓 이벤트명·페이로드 · room `team-{teamId}` | §9 | `../next-bun/src/types/socket.ts` (프론트는 self-event를 걸러낸다) |
| 날짜 (UTC 저장, 표시 시점 변환) | §12 | 프론트 표시 로직 |

- 에러 코드·상태코드를 바꾸면 **API 계약 변경**이다 — 커밋 본문에 프론트 대응 필요 여부를 적는다(CLAUDE.md Ask 표).

## 3. 수정 범위
- 이 세션의 주 레포는 **백엔드**다. 프론트 파일 수정은 사용자가 명시적으로 요청했을 때만.
- 프론트는 **별도 git 레포**다 — 커밋도 따로 한다.
- 조사가 여러 파일에 걸치면 `frontend-researcher` 에이전트에 맡긴다.
