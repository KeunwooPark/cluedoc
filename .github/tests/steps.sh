#!/usr/bin/env bash
# preflight and scope, against synthetic event payloads. Driven by run.sh.
STEPS="${STEPS:?run via .github/tests/run.sh}"
LAB="${WORK:?run via .github/tests/run.sh}/lab"
pass=0; fail=0

rm -rf "$LAB"; mkdir -p "$LAB"

# ---- build a throwaway repo with a real base/head history -------------------
REPO="$LAB/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
echo one > "$REPO/a.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm base
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" checkout -q -b feature
echo two > "$REPO/b.txt"; git -C "$REPO" add -A; git -C "$REPO" commit -qm feat
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
# a bare "origin" so `git fetch origin +refs/heads/main:...` resolves
git init -q --bare "$LAB/origin.git"
git -C "$REPO" remote add origin "$LAB/origin.git"
git -C "$REPO" push -q origin main feature

ev() { printf '%s' "$1" > "$LAB/event.json"; echo "$LAB/event.json"; }

run() { # run <script> <expect-exit>  ; env comes from caller
  : > "$LAB/out"; : > "$LAB/summary"
  GITHUB_OUTPUT="$LAB/out" GITHUB_STEP_SUMMARY="$LAB/summary" \
  bash "$STEPS/$1.sh" > "$LAB/stdout" 2>&1
  echo $?
}

check() { # check <name> <key> <expected>
  local got; got=$(grep -E "^$2=" "$LAB/out" | head -1 | cut -d= -f2-)
  if [ "$got" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-46s %s=%s\n' "$1" "$2" "$got"
  else fail=$((fail+1)); printf '  FAIL %-46s %s: want %q got %q\n' "$1" "$2" "$3" "$got"; fi
}

checkgrep() { # checkgrep <name> <file> <pattern>
  if grep -qF "$3" "$LAB/$2"; then pass=$((pass+1)); printf '  ok   %-46s matched\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %-46s no %q in %s:\n%s\n' "$1" "$3" "$2" "$(cat "$LAB/$2")"; fi
}

echo "== preflight =="

export GITHUB_REPOSITORY="acme/app" GITHUB_EVENT_NAME=pull_request
GITHUB_EVENT_PATH=$(ev '{"pull_request":{"head":{"repo":{"full_name":"someone/app"}},"draft":false},"sender":{"login":"alice"}}') \
  run preflight >/dev/null
check "fork PR skips" skip true
checkgrep "fork PR explains itself" summary "comes from a fork"

GITHUB_EVENT_PATH=$(ev '{"pull_request":{"head":{"repo":{"full_name":"acme/app"}},"draft":true},"sender":{"login":"alice"}}') \
  run preflight >/dev/null
check "draft PR skips" skip true

GITHUB_EVENT_PATH=$(ev '{"pull_request":{"head":{"repo":{"full_name":"acme/app"}},"draft":false},"sender":{"login":"alice"}}') \
  run preflight >/dev/null
check "same-repo ready PR runs" skip false

GITHUB_EVENT_PATH=$(ev '{"pull_request":{"head":{"repo":{"full_name":"acme/app"}},"draft":false},"sender":{"login":"github-actions[bot]"}}') \
  run preflight >/dev/null
check "bot-sender PR skips" skip true

export GITHUB_EVENT_NAME=push
GITHUB_EVENT_PATH=$(ev '{"sender":{"login":"github-actions[bot]"}}') run preflight >/dev/null
check "bot-sender push skips" skip true
GITHUB_EVENT_PATH=$(ev '{"sender":{"login":"alice"}}') run preflight >/dev/null
check "human push runs" skip false

GITHUB_EVENT_NAME=workflow_dispatch GITHUB_EVENT_PATH=$(ev '{"sender":{"login":"alice"}}') \
  run preflight >/dev/null
check "workflow_dispatch runs" skip false

echo "== scope =="
cd "$REPO" || exit 1
export INPUT_SCOPE=""

export GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=main
GITHUB_EVENT_PATH=$(ev '{}') run scope >/dev/null
check "PR range" range "origin/main...HEAD"
check "PR not empty" empty false
checkgrep "PR scope is logged with its range" stdout "in origin/main...HEAD"

export GITHUB_EVENT_NAME=push GITHUB_SHA="$HEAD_SHA"
GITHUB_EVENT_PATH=$(ev "{\"before\":\"$BASE_SHA\"}") run scope >/dev/null
check "push range" range "$BASE_SHA..$HEAD_SHA"

GITHUB_EVENT_PATH=$(ev '{"before":"0000000000000000000000000000000000000000"}') run scope >/dev/null
check "new branch falls back to full tree" range ""
check "full tree is not 'empty'" empty false
checkgrep "full tree says so" stdout "Cluedoc scope: the whole repository"

INPUT_SCOPE=all GITHUB_EVENT_PATH=$(ev '{}') run scope >/dev/null
check "scope: all -> full tree" range ""
INPUT_SCOPE="$BASE_SHA..HEAD" GITHUB_EVENT_PATH=$(ev '{}') run scope >/dev/null
check "explicit scope wins" range "$BASE_SHA..HEAD"

INPUT_SCOPE='no-such-ref..HEAD' GITHUB_EVENT_PATH=$(ev '{}') rc=$(run scope)
if [ "$rc" != "0" ]; then pass=$((pass+1)); printf '  ok   %-46s exit=%s\n' "bad explicit scope fails" "$rc"
else fail=$((fail+1)); printf '  FAIL %-46s exited 0\n' "bad explicit scope fails"; fi
checkgrep "bad scope names the input" stdout "Check the 'scope' input"

# a range with no changes at all
export GITHUB_EVENT_NAME=push
GITHUB_EVENT_PATH=$(ev "{\"before\":\"$HEAD_SHA\"}") GITHUB_SHA="$HEAD_SHA" INPUT_SCOPE="" \
  run scope >/dev/null
check "no changed files -> empty" empty true
checkgrep "no changed files explains itself" summary "no files changed"

echo "== scope: shallow checkout =="
SHALLOW="$LAB/shallow"
git clone -q --depth 1 "file://$LAB/origin.git" --branch feature "$SHALLOW" 2>/dev/null
cd "$SHALLOW" || exit 1
export GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=main INPUT_SCOPE=""
GITHUB_EVENT_PATH=$(ev '{}') rc=$(run scope)
if [ "$rc" != "0" ]; then pass=$((pass+1)); printf '  ok   %-46s exit=%s\n' "shallow checkout fails" "$rc"
else fail=$((fail+1)); printf '  FAIL %-46s exited 0\n' "shallow checkout fails"; fi
checkgrep "shallow error names fetch-depth" stdout "fetch-depth: 0"

echo
echo "pass=$pass fail=$fail"
[ "$fail" = "0" ]
