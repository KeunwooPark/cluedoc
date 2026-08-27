#!/usr/bin/env bash
# Which entry point a repository gets: sync, bootstrap, or nothing. Driven by run.sh.
STEPS="${STEPS:?run via .github/tests/run.sh}"
LAB="${WORK:?run via .github/tests/run.sh}/lab-mode"
pass=0; fail=0
rm -rf "$LAB"; mkdir -p "$LAB"

run() {
  : > "$LAB/out"; : > "$LAB/summary"
  GITHUB_OUTPUT="$LAB/out" GITHUB_STEP_SUMMARY="$LAB/summary" \
  bash "$STEPS/mode.sh" > "$LAB/stdout" 2>&1
  echo $?
}
check() {
  local got; got=$(grep -E "^$2=" "$LAB/out" | head -1 | cut -d= -f2-)
  if [ "$got" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-46s %s=%s\n' "$1" "$2" "$got"
  else fail=$((fail+1)); printf '  FAIL %-46s %s: want %q got %q\n' "$1" "$2" "$3" "$got"; fi
}
checkgrep() {
  if grep -qF "$3" "$LAB/$2"; then pass=$((pass+1)); printf '  ok   %-46s matched\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %-46s no %q in %s\n' "$1" "$3" "$2"; fi
}

echo "== mode =="
export GITHUB_WORKSPACE="$LAB/ws"

# a repository that has papers
rm -rf "$GITHUB_WORKSPACE"; mkdir -p "$GITHUB_WORKSPACE/.cluedoc"
echo "# root" > "$GITHUB_WORKSPACE/.cluedoc/README.md"
INPUT_BOOTSTRAP=auto run >/dev/null
check "existing .cluedoc/ syncs" mode sync
check "sync stages only papers" paths .cluedoc

# an empty .cluedoc/ is not an initialised repository
rm -rf "$GITHUB_WORKSPACE"; mkdir -p "$GITHUB_WORKSPACE/.cluedoc"
INPUT_BOOTSTRAP=auto run >/dev/null
check "empty .cluedoc/ bootstraps" mode bootstrap

# no .cluedoc/ at all
rm -rf "$GITHUB_WORKSPACE"; mkdir -p "$GITHUB_WORKSPACE"
INPUT_BOOTSTRAP=auto run >/dev/null
check "absent .cluedoc/ bootstraps" mode bootstrap
check "auto bootstrap stages only papers" paths .cluedoc
checkgrep "auto bootstrap forbids Job 2" out "Do NOT do Job 2"
checkgrep "auto bootstrap names the files to leave alone" out "AGENTS.md"

INPUT_BOOTSTRAP=full run >/dev/null
check "full bootstrap" mode bootstrap-full
check "full bootstrap stages everything" paths -A
checkgrep "full bootstrap asks for Job 2" out "Also do Job 2"

INPUT_BOOTSTRAP=skip run >/dev/null
check "skip" mode skip
checkgrep "skip explains itself" summary "bootstrap is set to skip"

rc=$(INPUT_BOOTSTRAP=nonsense run)
if [ "$rc" != "0" ]; then pass=$((pass+1)); printf '  ok   %-46s exit=%s\n' "unknown bootstrap value fails" "$rc"
else fail=$((fail+1)); printf '  FAIL %-46s exited 0\n' "unknown bootstrap value fails"; fi
checkgrep "unknown value lists the valid ones" stdout "Expected auto, full or skip"

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
