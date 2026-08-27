#!/usr/bin/env bash
# The prompt handed to the engine. Driven by run.sh.
#
# This step is two heredocs inside a YAML block scalar, which is a place where
# indentation, quoting and interpolation can each fail silently — a terminator
# that does not land in column zero, a backtick the shell runs, a `${VAR}` that
# reaches the model verbatim. None of those show up until a real run, and by
# then the model has already been paid to read the mistake.
STEPS="${STEPS:?run via .github/tests/run.sh}"
LAB="${WORK:?run via .github/tests/run.sh}/lab-prompt"
pass=0; fail=0
rm -rf "$LAB"; mkdir -p "$LAB"

run() {
  : > "$LAB/out"
  RUNNER_TEMP="$LAB" GITHUB_OUTPUT="$LAB/out" \
  bash "$STEPS/prompt.sh" > "$LAB/stdout" 2>&1
  echo $?
}

want() { # want <name> <pattern>
  if grep -qF "$2" "$LAB/cluedoc-prompt.md"; then pass=$((pass+1)); printf '  ok   %-46s matched\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %-46s no %q in prompt:\n%s\n' "$1" "$2" "$(cat "$LAB/cluedoc-prompt.md")"; fi
}
absent() { # absent <name> <pattern>
  if grep -qF "$2" "$LAB/cluedoc-prompt.md"; then
    fail=$((fail+1)); printf '  FAIL %-46s unwanted %q in prompt:\n%s\n' "$1" "$2" "$(cat "$LAB/cluedoc-prompt.md")"
  else pass=$((pass+1)); printf '  ok   %-46s absent\n' "$1"; fi
}

echo "== prompt =="

export JOB2="Do NOT do Job 2."

# ---- sync, with a range ------------------------------------------------------
MODE=sync RANGE="origin/main...HEAD" run >/dev/null
want "sync names the skill"            "Use the Cluedoc skill"
want "sync passes the range"           "origin/main...HEAD"
want "sync points at the git_diff tool" "calling git_diff"
want "sync keeps the progressive rule" "update only the papers"
absent "sync does not claim a shell"   "git diff --name-only"

if grep -qE '^file=.*/cluedoc-prompt\.md$' "$LAB/out"; then
  pass=$((pass+1)); printf '  ok   %-46s matched\n' "prompt path is an output"
else
  fail=$((fail+1)); printf '  FAIL %-46s out was:\n%s\n' "prompt path is an output" "$(cat "$LAB/out")"
fi

if grep -qF "::group::Cluedoc prompt" "$LAB/stdout"; then
  pass=$((pass+1)); printf '  ok   %-46s matched\n' "prompt is echoed to the log"
else
  fail=$((fail+1)); printf '  FAIL %-46s not grouped in the log\n' "prompt is echoed to the log"
fi

# ---- sync, whole repository --------------------------------------------------
MODE=sync RANGE="" run >/dev/null
want "empty range says there is none"  "There is no diff range"
absent "empty range invents no range"  "git_diff with that range"

# ---- bootstrap ---------------------------------------------------------------
MODE=bootstrap RANGE="" run >/dev/null
want "bootstrap runs init"             "init"
want "bootstrap asks for Job 1"        "Do Job 1"
want "bootstrap stops at one level"    "Do not recurse"
want "bootstrap carries the job2 text" "Do NOT do Job 2."
absent "bootstrap is not the sync text" "progressive rule"

JOB2="Also do Job 2 — wire the sync trigger into the agent-instructions file." \
  MODE=bootstrap-full RANGE="" run >/dev/null
want "full bootstrap carries its job2" "Also do Job 2"

# ---- the failure modes the heredoc invites -----------------------------------
# A `${VAR}` that survives into the prompt is a variable the runner never
# expanded, and the model reads it as literal text.
for mode in sync bootstrap; do
  MODE=$mode RANGE="origin/main...HEAD" run >/dev/null
  absent "no unexpanded variable ($mode)" '${'
  # Backticks in an unquoted heredoc are command substitution: the prompt would
  # silently contain the *output* of whatever was between them.
  absent "no backtick ($mode)"            '`'
done

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
