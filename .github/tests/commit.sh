#!/usr/bin/env bash
# Staging, committing, pushing, and the paper-conflict rebase. Driven by run.sh.
#
# This is the step that decides whether `changed` is true, so every branch of it
# is a lie the workflow above would act on. The conflict cases in particular are
# unreachable from a normal test run: they need a remote that moved underneath
# the agent while it was working.
STEPS="${STEPS:?run via .github/tests/run.sh}"
LAB="${WORK:?run via .github/tests/run.sh}/lab-commit"
pass=0; fail=0
rm -rf "$LAB"; mkdir -p "$LAB"

ok()   { pass=$((pass+1)); printf '  ok   %-46s %s\n' "$1" "${2-}"; }
bad()  { fail=$((fail+1)); printf '  FAIL %-46s %s\n' "$1" "${2-}"; }
check(){ local got; got=$(grep -E "^$2=" "$LAB/out" | head -1 | cut -d= -f2-)
         [ "$got" = "$3" ] && ok "$1" "$2=$got" || bad "$1" "$2: want $(printf %q "$3") got $(printf %q "$got")"; }
checkgrep(){ grep -qF "$3" "$LAB/$2" && ok "$1" matched || { bad "$1" "no $(printf %q "$3") in $2"; cat "$LAB/$2"; }; }

# A bare remote with a seeded `main`, then a fresh clone of it — so the working
# clone has a real local `main` tracking `origin/main`, which is what the runner
# gets from actions/checkout and what the rebase path depends on.
fixture() { # fixture <dir>
  rm -rf "$LAB/origin.git" "$LAB/seed" "$LAB/$1" "$LAB/other"
  # `-b main` on the bare repo too: without it HEAD points at `master`, the
  # clone below finds no such ref, and it checks out nothing while still
  # exiting 0.
  git init -q --bare -b main "$LAB/origin.git"
  git init -q -b main "$LAB/seed"
  git -C "$LAB/seed" config user.email s@s; git -C "$LAB/seed" config user.name s
  mkdir -p "$LAB/seed/.cluedoc/auth"
  echo "seed" > "$LAB/seed/.cluedoc/README.md"
  echo "seed" > "$LAB/seed/.cluedoc/auth/README.md"
  echo "code" > "$LAB/seed/src.txt"
  git -C "$LAB/seed" add -A; git -C "$LAB/seed" commit -qm seed
  git -C "$LAB/seed" remote add origin "$LAB/origin.git"
  git -C "$LAB/seed" push -q origin main
  git clone -q "$LAB/origin.git" "$LAB/$1"
  git -C "$LAB/$1" config user.email t@t; git -C "$LAB/$1" config user.name t
}

# A second clone standing in for whoever pushed while the agent was working.
other_pushes() { # other_pushes <file> <content>
  rm -rf "$LAB/other"
  git clone -q "$LAB/origin.git" "$LAB/other"
  git -C "$LAB/other" config user.email o@o; git -C "$LAB/other" config user.name o
  mkdir -p "$(dirname "$LAB/other/$1")"
  printf '%s\n' "$2" > "$LAB/other/$1"
  git -C "$LAB/other" add -A
  git -C "$LAB/other" commit -qm other
  git -C "$LAB/other" push -q origin main
}

run() { # run <workdir>
  : > "$LAB/out"; : > "$LAB/summary"
  ( cd "$LAB/$1" && GITHUB_OUTPUT="$LAB/out" GITHUB_STEP_SUMMARY="$LAB/summary" \
      bash "$STEPS/commit.sh" ) > "$LAB/stdout" 2>&1
  echo $?
}

export INPUT_PUSH=true INPUT_COMMIT_MESSAGE="docs(cluedoc): sync papers" PATHS=.cluedoc BRANCH=main

echo "== commit =="

fixture w
echo "changed by the agent" > "$LAB/w/.cluedoc/auth/README.md"
run w >/dev/null
check "papers written -> changed" changed true
checkgrep "papers output lists the file" out ".cluedoc/auth/README.md"
sha=$(grep -E '^commit=' "$LAB/out" | cut -d= -f2-)
[ -n "$sha" ] && ok "commit sha reported" "${sha:0:8}" || bad "commit sha reported" "empty"
[ "$(git --git-dir="$LAB/origin.git" rev-parse main)" = "$sha" ] && ok "pushed to the remote" || bad "pushed to the remote"
git -C "$LAB/w" log -1 --format='%an' | grep -q 'github-actions\[bot\]' \
  && ok "committed as the bot" || bad "committed as the bot"

fixture w
run w >/dev/null
check "nothing written -> changed=false" changed false
check "nothing written -> no commit" commit ""
checkgrep "no-op says so" summary "no papers needed changing"

fixture w
echo "changed" > "$LAB/w/.cluedoc/README.md"
INPUT_PUSH=false run w >/dev/null
check "push=false still reports changed" changed true
check "push=false makes no commit" commit ""
[ "$(git -C "$LAB/w" rev-parse HEAD)" = "$(git -C "$LAB/w" rev-parse origin/main)" ] \
  && ok "push=false left history alone" || bad "push=false left history alone"
git -C "$LAB/w" diff --quiet -- .cluedoc && bad "push=false left the tree dirty" \
  || ok "push=false left the tree dirty"
git -C "$LAB/w" diff --cached --quiet && ok "push=false left nothing staged" \
  || bad "push=false left nothing staged"
export INPUT_PUSH=true

echo "== commit: what the agent must not touch =="

fixture w
echo "changed" > "$LAB/w/.cluedoc/README.md"
echo "the agent edited code" > "$LAB/w/src.txt"
run w >/dev/null
checkgrep "stray edits warn" stdout "outside .cluedoc/"
git -C "$LAB/w" show --stat --format= HEAD | grep -q 'src.txt' \
  && bad "stray edits stay out of the commit" || ok "stray edits stay out of the commit"
git -C "$LAB/w" show --stat --format= HEAD | grep -q '.cluedoc/README.md' \
  && ok "papers are still committed" || bad "papers are still committed"

fixture w
echo "changed" > "$LAB/w/.cluedoc/README.md"
echo "wired up" > "$LAB/w/AGENTS.md"
PATHS=-A run w >/dev/null
git -C "$LAB/w" show --stat --format= HEAD | grep -q 'AGENTS.md' \
  && ok "full bootstrap commits AGENTS.md" || bad "full bootstrap commits AGENTS.md"
PATHS=.cluedoc

echo "== commit: the remote moved =="

# Someone pushed an unrelated commit while the agent worked: plain rebase.
fixture w
other_pushes src2.txt "more code"
echo "changed by the agent" > "$LAB/w/.cluedoc/auth/README.md"
rc=$(run w)
[ "$rc" = 0 ] && ok "non-conflicting remote move rebases" || { bad "non-conflicting remote move rebases" "exit=$rc"; cat "$LAB/stdout"; }
check "still reports changed" changed true
git -C "$LAB/w" fetch -q origin
git -C "$LAB/w" show "origin/main:.cluedoc/auth/README.md" 2>/dev/null | grep -q 'changed by the agent' \
  && ok "the agent's paper reached the remote" || bad "the agent's paper reached the remote"
git -C "$LAB/w" show "origin/main:src2.txt" >/dev/null 2>&1 \
  && ok "the other commit survived" || bad "the other commit survived"

# Both sides rewrote the same paper: the remote's version wins and the next
# sync regenerates. This is the README's manual recipe, automated.
fixture w
other_pushes .cluedoc/auth/README.md "the other pull request's paper"
echo "this run's paper" > "$LAB/w/.cluedoc/auth/README.md"
rc=$(run w)
[ "$rc" = 0 ] && ok "paper conflict does not fail the run" || { bad "paper conflict does not fail the run" "exit=$rc"; cat "$LAB/stdout"; }
git -C "$LAB/w" fetch -q origin
git -C "$LAB/w" show "origin/main:.cluedoc/auth/README.md" | grep -q "the other pull request's paper" \
  && ok "the branch's version was kept" || bad "the branch's version was kept"
checkgrep "conflict explains the next sync" summary "next sync regenerates"
git -C "$LAB/w" status --porcelain | grep -q '^UU' && bad "rebase left no conflict behind" \
  || ok "rebase left no conflict behind"
[ -d "$LAB/w/.git/rebase-merge" ] || [ -d "$LAB/w/.git/rebase-apply" ] \
  && bad "rebase was finished" || ok "rebase was finished"

# The branch already said what this run was going to say, so the rebase leaves
# nothing of ours behind. `changed` must not claim a commit that does not exist.
fixture w
other_pushes .cluedoc/auth/README.md "identical prose"
printf '%s\n' "identical prose" > "$LAB/w/.cluedoc/auth/README.md"
rc=$(run w)
[ "$rc" = 0 ] && ok "superseded run does not fail" || bad "superseded run does not fail" "exit=$rc"
check "superseded -> changed=false" changed false
check "superseded -> no commit" commit ""
checkgrep "superseded says so" summary "superseded by main"

# A stray edit left in the working tree must not stop the rebase. Without this,
# an agent that touched one source file turns a recoverable race into a failed
# run — over a file that was never going to be committed.
fixture w
other_pushes src2.txt "more code"
echo "changed by the agent" > "$LAB/w/.cluedoc/auth/README.md"
echo "the agent also poked this" > "$LAB/w/src.txt"
rc=$(run w)
[ "$rc" = 0 ] && ok "stray edits do not block the rebase" || { bad "stray edits do not block the rebase" "exit=$rc"; cat "$LAB/stdout"; }
check "and the papers still land" changed true

# A conflict outside .cluedoc/ is a real conflict and must stop the run.
fixture w
other_pushes src.txt "theirs"
echo "ours" > "$LAB/w/src.txt"
echo "paper" > "$LAB/w/.cluedoc/README.md"
export PATHS=-A
rc=$(run w)
[ "$rc" != "0" ] && ok "conflict outside .cluedoc/ fails" "exit=$rc" || bad "conflict outside .cluedoc/ fails"
checkgrep "and says why" stdout "Cluedoc will not resolve that"
[ -d "$LAB/w/.git/rebase-merge" ] || [ -d "$LAB/w/.git/rebase-apply" ] \
  && bad "failed rebase was aborted" || ok "failed rebase was aborted"
PATHS=.cluedoc

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
