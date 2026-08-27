#!/usr/bin/env bash
# The skill install: what lands in .claude/skills/cluedoc. Driven by run.sh.
STEPS="${STEPS:?run via .github/tests/run.sh}"
ACTION="$1"
LAB="${WORK:?run via .github/tests/run.sh}/lab-install"
pass=0; fail=0
rm -rf "$LAB"; mkdir -p "$LAB/ws"
git -C "$LAB/ws" init -q

export GITHUB_ACTION_PATH="$ACTION" GITHUB_WORKSPACE="$LAB/ws"
bash "$STEPS/install-the-cluedoc-skill.sh" > "$LAB/stdout" 2>&1
rc=$?
[ "$rc" = 0 ] && { pass=$((pass+1)); echo "  ok   step exits 0"; } || { fail=$((fail+1)); echo "  FAIL step exit=$rc"; cat "$LAB/stdout"; }

D="$LAB/ws/.claude/skills/cluedoc"
[ -f "$D/SKILL.md" ] && { pass=$((pass+1)); echo "  ok   SKILL.md installed"; } || { fail=$((fail+1)); echo "  FAIL SKILL.md missing"; }

# the skill dir must be a skill, not a copy of the repo
for junk in action.yml README.md LICENSE .git .github docs examples; do
  if [ -e "$D/$junk" ]; then fail=$((fail+1)); echo "  FAIL $junk leaked into the skill dir"
  else pass=$((pass+1)); echo "  ok   $junk excluded"; fi
done

# frontmatter must survive intact — the name field is what the agent matches on
if head -12 "$D/SKILL.md" | grep -q '^name: cluedoc$'; then
  pass=$((pass+1)); echo "  ok   frontmatter name intact"
else fail=$((fail+1)); echo "  FAIL frontmatter name missing"; fi

if diff -q "$ACTION/SKILL.md" "$D/SKILL.md" >/dev/null; then
  pass=$((pass+1)); echo "  ok   SKILL.md byte-identical"
else fail=$((fail+1)); echo "  FAIL SKILL.md differs"; fi

if grep -qF '/.claude/skills/cluedoc/' "$LAB/ws/.git/info/exclude"; then
  pass=$((pass+1)); echo "  ok   skill dir git-excluded"
else fail=$((fail+1)); echo "  FAIL not added to .git/info/exclude"; fi

# and the exclude must actually work
: > "$LAB/ws/tracked.txt"
if git -C "$LAB/ws" status --porcelain | grep -q '.claude'; then
  fail=$((fail+1)); echo "  FAIL skill dir still shows in git status"
else pass=$((pass+1)); echo "  ok   skill dir invisible to git status"; fi

# no checkout: warn, do not fail
rm -rf "$LAB/ws2"; mkdir -p "$LAB/ws2"
GITHUB_WORKSPACE="$LAB/ws2" bash "$STEPS/install-the-cluedoc-skill.sh" > "$LAB/stdout2" 2>&1
rc=$?
if [ "$rc" = 0 ] && grep -qF '::warning::' "$LAB/stdout2"; then
  pass=$((pass+1)); echo "  ok   missing checkout warns instead of failing"
else fail=$((fail+1)); echo "  FAIL missing checkout: exit=$rc"; cat "$LAB/stdout2"; fi

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
