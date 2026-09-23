#!/bin/sh
# PreToolUse 훅: 프론트엔드(../next-bun) 파일을 건드리는 도구 호출 직전에
# 그쪽 CLAUDE.md를 컨텍스트로 주입한다.
#
# 배경: permissions.additionalDirectories 로 등록한 디렉터리의 CLAUDE.md는
#       Claude Code가 자동 로드하지 않는다(공식 문서: "Never").
#       CLAUDE.md의 @import 는 세션 시작 시 항상 로드되어 백엔드 전용 작업에도
#       토큰을 낭비하므로, 실제로 프론트를 건드릴 때만 조건부로 주입한다.
#
# 실패해도 도구 호출을 막지 않는다 (항상 exit 0).

INPUT=$(cat 2>/dev/null) || exit 0
[ -n "$INPUT" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# 프론트 디렉터리 위치 (CLAUDE_PROJECT_DIR 기준, 폴백은 훅 파일 기준)
BASE="${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
FRONTEND_DIR=$(CDPATH= cd -- "$BASE/../next-bun" 2>/dev/null && pwd) || exit 0
FRONTEND_MD="$FRONTEND_DIR/CLAUDE.md"
[ -r "$FRONTEND_MD" ] || exit 0

# 도구 입력 중 "경로가 들어올 수 있는 필드"만 뽑아 검사한다.
# (tool_input 전체를 검사하면 파일 내용·치환 문자열에 걸려 오탐이 난다)
TARGETS=$(printf '%s' "$INPUT" | jq -r '
  [ .tool_input.file_path?
  , .tool_input.path?
  , .tool_input.notebook_path?
  , .tool_input.command?
  , (.tool_input.edits? // [] | .[]?.file_path?)
  ] | map(select(type == "string")) | join("\n")
' 2>/dev/null) || exit 0

case "$TARGETS" in
  *next-bun*) ;;
  *) exit 0 ;;
esac

# 세션당 1회만 주입한다. 단 /compact 로 주입분이 날아갈 수 있으므로
# 마커가 60분 이상 오래되면 다시 주입한다.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null | tr -c 'A-Za-z0-9._-' '_')
MARKER="${TMPDIR:-/tmp}/claude-frontend-claudemd-${SESSION_ID}"
if [ -f "$MARKER" ] && [ -z "$(find "$MARKER" -mmin +60 2>/dev/null)" ]; then
  exit 0
fi
: > "$MARKER" 2>/dev/null || true

HEADER="[자동 주입] 프론트엔드 프로젝트($FRONTEND_DIR)를 건드리는 도구 호출이 감지되었다.
아래는 해당 프로젝트의 CLAUDE.md 전문이다. 프론트 코드를 읽거나 수정할 때 이 규약을 따른다.
(백엔드 CLAUDE.md 라우팅 표의 프론트 항목은 이 훅으로 충족된다 — 별도로 다시 읽을 필요 없다.)

--- ${FRONTEND_MD} ---"

jq -n --rawfile md "$FRONTEND_MD" --arg header "$HEADER" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: ($header + "\n" + $md)
  }
}' 2>/dev/null || exit 0

exit 0
