#!/usr/bin/env bash
#
# Exercise action.yml's shell steps without a runner.
#
# The action decides three things in bash before the agent is ever invoked —
# whether to run at all, what range to document, and where the skill comes from
# — and every one of them is a branch that only fires on an event shape you
# cannot reproduce by pushing a commit. `extract.py` lifts the `run:` blocks
# straight out of action.yml so these run the same text the runner will, rather
# than a copy that drifts.
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
for suite in steps mode install commit comment; do
  case "$suite" in
    install) STEPS="$WORK/steps" WORK="$WORK" bash "$HERE/install.sh" "$ROOT" || rc=1 ;;
    *)       STEPS="$WORK/steps" WORK="$WORK" bash "$HERE/$suite.sh" || rc=1 ;;
  esac
  echo
done

echo "== docs =="
python3 "$HERE/links.py" "$ROOT" | sed 's/^/  /' || rc=1
echo

echo
if [ "$rc" = 0 ]; then echo "all suites passed"; else echo "FAILURES"; fi
exit "$rc"
