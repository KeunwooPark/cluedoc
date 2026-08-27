#!/usr/bin/env bash
# The sticky pull-request comment. Driven by run.sh.
#
# `gh` is stubbed rather than called: what matters here is the body it is handed
# and whether the step chose to create or to update, and neither needs GitHub.
STEPS="${STEPS:?run via .github/tests/run.sh}"
LAB="${WORK:?run via .github/tests/run.sh}/lab-comment"
pass=0; fail=0
rm -rf "$LAB"; mkdir -p "$LAB/bin"

ok()  { pass=$((pass+1)); printf '  ok   %-46s %s\n' "$1" "${2-}"; }
bad() { fail=$((fail+1)); printf '  FAIL %-46s %s\n' "$1" "${2-}"; }
inbody(){ grep -qF "$2" "$LAB/body.md" && ok "$1" || { bad "$1" "missing: $2"; cat "$LAB/body.md"; }; }

# Stub gh: records the call, answers the lookup from STUB_EXISTING, and copies
# whatever body it was handed so the assertions can read it.
cat > "$LAB/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$@" >> "$LAB/gh.log"
for a in "$@"; do
  case "$a" in
    -F) : ;;
    body=@*) cp "${a#body=@}" "$LAB/body.md" ;;
  esac
done
case "$*" in
  *--jq*) printf '%s' "${STUB_EXISTING:-}" ;;
esac
exit 0
STUB
chmod +x "$LAB/bin/gh"
export PATH="$LAB/bin:$PATH" LAB

export GITHUB_SERVER_URL="https://github.com" GITHUB_REPOSITORY="acme/app" PR=42
export SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
export PAPERS=".cluedoc/README.md
.cluedoc/auth/README.md"
export RUNNER_TEMP="$LAB"

run() { : > "$LAB/gh.log"; : > "$LAB/body.md"; bash "$STEPS/comment-on-the-pull-request.sh" > "$LAB/stdout" 2>&1; echo $?; }

echo "== comment =="

export STUB_EXISTING=""
rc=$(run)
[ "$rc" = 0 ] && ok "posts a comment" || { bad "posts a comment" "exit=$rc"; cat "$LAB/stdout"; }
grep -q 'POST repos/acme/app/issues/42/comments' "$LAB/gh.log" \
  && ok "no existing comment -> POST" || { bad "no existing comment -> POST"; cat "$LAB/gh.log"; }
inbody "carries the sticky marker" '<!-- cluedoc:action -->'
inbody "counts the papers" 'synced 2 paper(s)'
inbody "links at the docs commit, not the branch" \
  "https://github.com/acme/app/blob/${SHA}/.cluedoc/auth/README.md"
grep -q '/blob/main/' "$LAB/body.md" && bad "no branch links" || ok "no branch links"

export STUB_EXISTING="998877"
rc=$(run)
[ "$rc" = 0 ] && ok "updates in place" || bad "updates in place" "exit=$rc"
grep -q 'PATCH repos/acme/app/issues/comments/998877' "$LAB/gh.log" \
  && ok "existing comment -> PATCH" || { bad "existing comment -> PATCH"; cat "$LAB/gh.log"; }
grep -q 'POST repos/acme/app/issues/42/comments' "$LAB/gh.log" \
  && bad "does not also post a second comment" || ok "does not also post a second comment"

# One paper, to catch a plural-only format string.
export STUB_EXISTING=""
PAPERS=".cluedoc/README.md" run >/dev/null
inbody "single paper counts as one" 'synced 1 paper(s)'

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
