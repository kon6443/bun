#!/bin/sh
# inject-sibling-claudemd.sh — 형제 레포 규약의 조건부 주입
#
# 역할:    형제 레포(../<sibling>) 파일을 건드리는 도구 호출 직전에 그 레포의
#          CLAUDE.md 와, 대상 경로에 맞는 path-scoped rule(.claude/rules/*.md 의
#          paths: frontmatter)을 additionalContext 로 주입한다.
#          추가 디렉터리의 CLAUDE.md·rules 는 Claude Code 가 로드하지 않고,
#          @import·CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD 는 세션 시작 시
#          항상 로드하므로, "형제를 건드릴 때만" 을 이 훅으로 구현한다.
# 트리거:  .claude/settings.json › hooks.PreToolUse   → 인자 <sibling>
#          .claude/settings.json › hooks.SessionStart (compact|clear) → 인자 --reset <sibling>
# 입력:    stdin 훅 JSON — session_id, agent_id(서브에이전트일 때만), tool_input
# 출력:    {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":…}} 또는 무출력
# 실패:    언제나 exit 0 — 도구 호출을 절대 막지 않는다 (fail-open)
# 의존성:  jq (없으면 아무것도 하지 않는다)
# 출처:    bun/docs/tasks/tasks-claude-config.md C1 — 두 레포에 **동일 파일**로 둔다 (C2-5)
#
# 알아둘 것 (2026-09-23 실측):
#   - 주입이 약 1만 자를 넘으면 본문이 파일로 빠지고 앞 2KB 미리보기만 컨텍스트에 남는다.
#     그래서 SIBLING_MD_LIMIT 을 넘는 파일은 전문 대신 "지금 Read 하라" 지시로 대체한다.
#   - 서브에이전트의 도구 호출도 이 훅을 실행하고, 주입은 그 서브에이전트 컨텍스트로 간다.
#     마커를 agent_id 별로 나누지 않으면 서브에이전트가 메인 몫을 소비한다.

LIMIT="${SIBLING_MD_LIMIT:-9000}"   # 문자 수. 실측 상한(9,900 통과 / 15,088 잘림)보다 보수적으로

MODE=inject
if [ "${1-}" = "--reset" ]; then MODE=reset; shift; fi
NAME="${1-}"
[ -n "$NAME" ] || exit 0

INPUT=$(cat 2>/dev/null) || exit 0
[ -n "$INPUT" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null | tr -cd 'A-Za-z0-9._-')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // "main"' 2>/dev/null | tr -cd 'A-Za-z0-9._-')
[ -n "$SESSION_ID" ] || SESSION_ID=unknown
[ -n "$AGENT_ID" ] || AGENT_ID=main
MARK_DIR="${TMPDIR:-/tmp}/claude-sibling-md/$SESSION_ID/$AGENT_ID/$NAME"

# compact/clear 뒤에는 메인 컨텍스트의 주입분이 사라지므로 메인 마커만 지운다.
if [ "$MODE" = reset ]; then
  rm -rf "${TMPDIR:-/tmp}/claude-sibling-md/$SESSION_ID/main" 2>/dev/null
  exit 0
fi

BASE="${CLAUDE_PROJECT_DIR:-$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)}"
SIB=$(CDPATH='' cd -- "$BASE/../$NAME" 2>/dev/null && pwd) || exit 0
SIB_P=$(CDPATH='' cd -- "$SIB" 2>/dev/null && pwd -P) || SIB_P="$SIB"   # 심볼릭 링크를 거친 경로도 인정

# 경로가 들어올 수 있는 필드만 본다 (content·new_string 은 제외 — 오탐 방지).
TARGETS=$(printf '%s' "$INPUT" | jq -r '
  [ .tool_input.file_path?, .tool_input.path?, .tool_input.notebook_path?
  , .tool_input.pattern?, .tool_input.command?
  , (.tool_input.edits? // [] | .[]?.file_path?)
  ] | map(select(type == "string")) | join("\n")
' 2>/dev/null) || exit 0
[ -n "$TARGETS" ] || exit 0

# 형제 루트 기준 상대경로 목록. 절대경로 또는 ../<name> 으로 시작하는 토큰만 인정한다.
# (부분문자열 매칭 금지 — "bun" 은 "next-bun"·"bun run" 에 걸린다)
RELS=$(printf '%s\n' "$TARGETS" | awk -v sib="$SIB" -v sibp="$SIB_P" -v name="$NAME" '
  {
    n = split($0, tok, /[[:space:]"'"'"'=;|&()<>]+/)
    for (i = 1; i <= n; i++) {
      t = tok[i]
      gsub(/\/\/+/, "/", t)   # a//b → a/b (pwd 는 정규화된 경로만 돌려준다)
      if (t == sib || t == sibp || t == "../" name) { print "."; continue }
      if (index(t, sib "/") == 1)        { print substr(t, length(sib) + 2); continue }
      if (index(t, sibp "/") == 1)       { print substr(t, length(sibp) + 2); continue }
      if (index(t, "../" name "/") == 1) { print substr(t, length(name) + 5); continue }
    }
  }')
[ -n "$RELS" ] || exit 0

mkdir -p "$MARK_DIR" 2>/dev/null || exit 0
CONTEXT=""

append() {
  CONTEXT="${CONTEXT}${CONTEXT:+

}$1"
}

# 파일 하나를 주입하거나, 이번 주입의 누적 크기가 상한을 넘으면 Read 지시로 대체한다.
# (파일별이 아니라 누적으로 본다 — 잘림은 주입 전체 크기에 걸린다)
TOTAL=0
emit_file() { # $1=파일 경로 $2=설명
  len=$(LC_ALL=en_US.UTF-8 wc -m < "$1" 2>/dev/null | tr -d ' ')
  len=${len:-0}
  if [ $((TOTAL + len)) -gt "$LIMIT" ]; then
    append "--- $1 ($2, ${len}자 — 주입 상한 ${LIMIT}자 초과) ---
⚠️ 전문을 주입하지 않았다. 형제 레포 파일을 읽거나 고치기 전에 **이 파일을 지금 Read 도구로 전부 읽는다.**"
  else
    TOTAL=$((TOTAL + len))
    append "--- $1 ($2) ---
$(cat "$1")"
  fi
}

# 1) 형제 CLAUDE.md — 에이전트당 1회
if [ -r "$SIB/CLAUDE.md" ] && [ ! -e "$MARK_DIR/CLAUDE.md" ]; then
  : > "$MARK_DIR/CLAUDE.md" 2>/dev/null
  emit_file "$SIB/CLAUDE.md" "형제 레포 CLAUDE.md"
fi

# 2) 형제 path-scoped rules — 규칙별 1회. paths: 없는 규칙은 상시 규칙이므로 CLAUDE.md 와 함께 넣는다.
if [ -d "$SIB/.claude/rules" ]; then
  for rule in "$SIB"/.claude/rules/*.md; do
    [ -r "$rule" ] || continue
    rname=$(basename "$rule")
    [ -e "$MARK_DIR/rule-$rname" ] && continue
    # frontmatter 의 paths 값을 한 줄에 하나씩. 목록형(- "a")과 인라인형(["a","b"]) 모두.
    globs=$(awk '
      NR == 1 && $0 != "---" { exit }
      NR > 1 && $0 == "---" { exit }
      /^paths:/ { inpaths = 1; sub(/^paths:[[:space:]]*/, ""); if ($0 != "") print; next }
      inpaths && /^[[:space:]]*-/ { print; next }
      inpaths && /^[^[:space:]]/ { inpaths = 0 }
    ' "$rule" | tr ',' '\n' | sed 's/[][]//g; s/^[[:space:]]*-[[:space:]]*//; s/["'"'"']//g; s/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$')
    hit=0
    if [ -z "$globs" ]; then
      hit=1
    else
      # glob 근사: {a,b} → *, ** → *. 과매칭은 토큰 비용뿐이고 누락은 규약 누락이라 넓게 잡는다.
      # set -f: 아래 for 가 패턴을 현재 디렉터리 파일명으로 확장하지 않게 한다.
      set -f
      for g in $(printf '%s\n' "$globs" | sed 's/{[^}]*}/*/g; s/\*\*\/*/*/g'); do
        for r in $RELS; do
          # shellcheck disable=SC2254
          case "$r" in $g) hit=1; break 2 ;; esac
        done
      done
      set +f
    fi
    if [ "$hit" = 1 ]; then
      : > "$MARK_DIR/rule-$rname" 2>/dev/null
      emit_file "$rule" "형제 레포 rule"
    fi
  done
fi

[ -n "$CONTEXT" ] || exit 0

HEADER="[자동 주입] 형제 레포($SIB)를 건드리는 도구 호출이 감지되었다.
아래는 그 레포의 규약이다. 형제 레포 파일을 읽거나 고칠 때 이 규약을 따른다.
(이 세션 레포의 CLAUDE.md 라우팅 표에 있는 형제 항목은 이 주입으로 충족된다.)"

jq -n --arg ctx "$HEADER

$CONTEXT" '{
  hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: $ctx }
}' 2>/dev/null

exit 0
