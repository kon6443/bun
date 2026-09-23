#!/bin/sh
# test-inject-sibling-claudemd.sh — inject-sibling-claudemd.sh 픽스처 회귀 테스트
#
# 실행: sh .claude/hooks/test-inject-sibling-claudemd.sh   (종료 코드 0 = 전부 통과)
# 실제 레포 대신 임시 디렉터리에 bun/next-bun 이름 그대로 가짜 트리를 만든다.
# "bun" 이 "next-bun" 의 부분문자열이라는 함정을 그대로 재현하기 위해서다.
# 출처: bun/docs/tasks/tasks-claude-config.md C1-4 (V1·V2·V3·V5) · C1-5 · C2-5

HOOK="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/inject-sibling-claudemd.sh"
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq 없음"; exit 0; }

T=$(mktemp -d "${TMPDIR:-/tmp}/sibling-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
export TMPDIR="$T/tmp"; mkdir -p "$TMPDIR"
B="$T/node/bun"; F="$T/node/next-bun"
mkdir -p "$B/.claude/rules" "$F/src" "$B/src"
printf '# FRONT-MD\n' > "$F/CLAUDE.md"
printf '# BACK-MD\n' > "$B/CLAUDE.md"
printf -- '---\npaths:\n  - "src/**/*.ts"\n  - "test/**/*.ts"\n---\n# BACK-RULE-CODE\n' > "$B/.claude/rules/code-patterns.md"
printf -- '---\npaths: ["docs/**/*.md"]\n---\n# BACK-RULE-DOCS\n' > "$B/.claude/rules/docs.md"
printf '# BACK-RULE-ALWAYS\n' > "$B/.claude/rules/always.md"

PASS=0; FAIL=0
# run <세션 레포> <형제 이름> <session> <agent|-> <tool_input JSON>
run() {
  if [ "$4" = "-" ]; then a=""; else a=",\"agent_id\":\"$4\""; fi
  printf '{"session_id":"%s"%s,"tool_input":%s}' "$3" "$a" "$5" \
    | CLAUDE_PROJECT_DIR="$1" sh "$HOOK" "$2" \
    | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null
}
# check <이름> <출력> <기대 부분문자열 | "-"(무출력 기대)> [없어야 할 부분문자열]
check() {
  if [ "$3" = "-" ]; then
    if [ -z "$2" ]; then ok=1; else ok=0; fi
  else
    case "$2" in *"$3"*) ok=1 ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = 1 ] && [ -n "${4-}" ]; then
    case "$2" in *"$4"*) ok=0 ;; esac
  fi
  if [ "$ok" = 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1"; echo "  got: $(printf '%s' "$2" | head -c 300)"; fi
}

# ── V1: 매칭 / 비매칭 (백엔드 세션 → 프론트 형제) ─────────────────────
check "V1 절대경로 Read"          "$(run "$B" next-bun s1 - "{\"file_path\":\"$F/src/a.tsx\"}")" "FRONT-MD"
check "V1 상대경로 Bash"          "$(run "$B" next-bun s2 - '{"command":"ls ../next-bun/src"}')" "FRONT-MD"
check "V1 Glob pattern만 (F2)"    "$(run "$B" next-bun s3 - '{"pattern":"../next-bun/src/**/*.tsx"}')" "FRONT-MD"
check "V1 Grep 검색어 next-bun"   "$(run "$B" next-bun s4 - '{"pattern":"next-bun","path":"src"}')" "-"
check "V1 커밋 메시지 grep"       "$(run "$B" next-bun s5 - '{"command":"git log --grep next-bun"}')" "-"
check "V1 자기 레포 파일"         "$(run "$B" next-bun s6 - "{\"file_path\":\"$B/src/main.ts\"}")" "-"
check "V1 연속 슬래시 경로"         "$(run "$B" next-bun s8 - "{\"file_path\":\"$T//node/next-bun//src/a.tsx\"}")" "FRONT-MD"
check "V1 Edit content 오탐 없음" "$(run "$B" next-bun s7 - "{\"file_path\":\"$B/x.md\",\"new_string\":\"../next-bun/a\"}")" "-"

# ── V1 역방향 (프론트 세션 → 백엔드 형제): 'bun' 부분문자열 함정 ──────
check "역 next-bun 경로는 bun 아님" "$(run "$F" bun r1 - "{\"file_path\":\"$F/src/a.tsx\"}")" "-"
check "역 bun run 명령"             "$(run "$F" bun r2 - '{"command":"bun run test:run"}')" "-"
check "역 절대경로 백엔드"          "$(run "$F" bun r3 - "{\"file_path\":\"$B/src/app.module.ts\"}")" "BACK-MD"
check "역 cd ../bun && pnpm"        "$(run "$F" bun r4 - '{"command":"cd ../bun && pnpm lint"}')" "BACK-MD"

# ── C1-5: 형제 path-scoped rules ────────────────────────────────────
o=$(run "$F" bun p1 - "{\"file_path\":\"$B/src/x.ts\"}")
check "C1-5 src/*.ts → code rule"      "$o" "BACK-RULE-CODE" "BACK-RULE-DOCS"
check "C1-5 paths 없는 rule은 상시"    "$o" "BACK-RULE-ALWAYS"
check "C1-5 docs md → docs rule만"     "$(run "$F" bun p2 - "{\"file_path\":\"$B/docs/a.md\"}")" "BACK-RULE-DOCS" "BACK-RULE-CODE"
check "C1-5 같은 rule 재주입 없음"     "$(run "$F" bun p1 - "{\"file_path\":\"$B/src/y.ts\"}")" "-"
check "C1-5 나중에 docs rule만 추가"   "$(run "$F" bun p1 - "{\"file_path\":\"$B/docs/b.md\"}")" "BACK-RULE-DOCS" "BACK-MD"

# ── V2: 서브에이전트가 메인 몫을 소비하지 않는다 (F1) ────────────────
check "V2 서브에이전트 1회차"   "$(run "$B" next-bun s9 agentA "{\"file_path\":\"$F/a\"}")" "FRONT-MD"
check "V2 메인은 여전히 주입"   "$(run "$B" next-bun s9 - "{\"file_path\":\"$F/a\"}")" "FRONT-MD"
check "V2 메인 2회차는 생략"    "$(run "$B" next-bun s9 - "{\"file_path\":\"$F/b\"}")" "-"

# ── V3: compact/clear 리셋은 메인만 ──────────────────────────────────
printf '{"session_id":"s9"}' | CLAUDE_PROJECT_DIR="$B" sh "$HOOK" --reset next-bun
check "V3 리셋 후 메인 재주입"      "$(run "$B" next-bun s9 - "{\"file_path\":\"$F/c\"}")" "FRONT-MD"
check "V3 서브에이전트 마커 유지"   "$(run "$B" next-bun s9 agentA "{\"file_path\":\"$F/c\"}")" "-"

# ── V5: 상한 초과 → Read 지시로 대체 ────────────────────────────────
python3 -c "print('# BIG\n' + '가'*9500)" > "$F/CLAUDE.md"
o=$(run "$B" next-bun s10 - "{\"file_path\":\"$F/a\"}")
check "V5 큰 파일은 Read 지시"   "$o" "Read 도구로 전부 읽는다" "가가가가"
printf '# FRONT-MD\n' > "$F/CLAUDE.md"

# ── fail-open: 비정상 입력에도 exit 0 ────────────────────────────────
printf 'not json' | CLAUDE_PROJECT_DIR="$B" sh "$HOOK" next-bun >/dev/null 2>&1; rc1=$?
printf '' | CLAUDE_PROJECT_DIR="$B" sh "$HOOK" >/dev/null 2>&1; rc2=$?
if [ "$rc1" = 0 ] && [ "$rc2" = 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: fail-open ($rc1,$rc2)"; fi

# ── C2-5: 형제 레포의 같은 파일과 동일한가 (두 벌 드리프트 방지) ──────
# 형제 레포가 체크아웃돼 있지 않으면 건너뛴다.
HOOK_DIR=$(dirname -- "$HOOK")
REPO=$(CDPATH='' cd -- "$HOOK_DIR/../.." && pwd)
for sib in bun next-bun; do
  other=$(CDPATH='' cd -- "$REPO/../$sib" 2>/dev/null && pwd) || continue
  [ "$other" = "$REPO" ] && continue
  [ -d "$other/.claude/hooks" ] || continue
  for f in inject-sibling-claudemd.sh test-inject-sibling-claudemd.sh; do
    if cmp -s "$HOOK_DIR/$f" "$other/.claude/hooks/$f"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: C2-5 $f 가 형제 레포($other)와 다르다 — 두 레포에 같은 파일을 둔다"; fi
  done
done

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
