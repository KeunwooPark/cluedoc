#!/usr/bin/env bash
#
# Exercise the action without a runner, and without a model.
#
# Two halves. The shell steps decide, in bash, whether to run at all, what range
# to document, what to say to the agent and what to do with what it wrote — and
# every one of those is a branch that only fires on an event shape you cannot
# reproduce by pushing a commit. `extract.py` lifts the `run:` blocks straight
# out of action.yml so these run the same text the runner will, rather than a
# copy that drifts. The other half is engine/, whose provider is stubbed, so the
# agent loop is exercised end to end without a key or a network.
#
#   .github/tests/run.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 "$HERE/extract.py" "$ROOT/action.yml" "$WORK/steps" || exit 1
echo

rc=0
for suite in steps mode prompt commit comment; do
  STEPS="$WORK/steps" WORK="$WORK" bash "$HERE/$suite.sh" || rc=1
  echo
done

# The engine those steps invoke. Hermetic — the provider is a stub, so this
# needs no key and no network. Quiet when it passes, and the whole run when it
# does not, since a failure here is the one thing a summary line cannot explain.
echo "== engine =="
if node --test "$HERE/engine.test.mjs" > "$WORK/engine.log" 2>&1; then
  grep -E '^. (tests|pass|fail) ' "$WORK/engine.log" | sed 's/^/  /'
else
  rc=1
  sed 's/^/  /' "$WORK/engine.log"
fi
echo

echo "== docs =="
python3 "$HERE/links.py" "$ROOT" | sed 's/^/  /' || rc=1
echo

echo
if [ "$rc" = 0 ]; then echo "all suites passed"; else echo "FAILURES"; fi
exit "$rc"
