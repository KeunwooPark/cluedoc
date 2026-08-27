# Cluedoc

An [Agent Skill](https://agentskills.io) that keeps a codebase understandable to humans while coding agents rapidly change it. Cluedoc treats a software system as a group of features and writes one visual **paper** per feature, organized as a capability tree and cross-referenced like a citation graph. It writes and maintains those papers as the code changes, so people can keep track of a system that now grows faster than they could read it line by line.

Fittingly, this project's landing page is itself one of these papers.

## Why

Coding agents have changed who writes software. Increasingly the human does not type the code; they direct agents that do, and codebases grow far faster than before. The scarce resource shifts from writing to understanding: when you did not write a line of it, and it changed again this morning, how do you know what the system does, or whether the next change is safe? Hand-written documentation cannot keep that pace, and a README rots the moment the agent moves on. Cluedoc closes the loop by putting the docs in the same hands as the code, so the agent writes and maintains human-readable documentation as it builds.

## Install

```bash
npx skills add KeunwooPark/cluedoc
```

That's it. The [`skills`](https://github.com/vercel-labs/skills) CLI auto-detects your agent (Claude Code, Codex, Cursor, and [many others](https://github.com/vercel-labs/skills#supported-agents)) and installs Cluedoc for it. The skill itself lives in [`SKILL.md`](SKILL.md).

<details>
<summary>Manual install</summary>

### Manual install

Agent Skills are plain directories containing a `SKILL.md`. Clone this repo into your agent's skills folder:

```bash
# Per-user (available in every project)
git clone https://github.com/KeunwooPark/cluedoc.git ~/.claude/skills/cluedoc

# or, per-project (checked in with the repo)
git clone https://github.com/KeunwooPark/cluedoc.git .claude/skills/cluedoc
```

The directory name must be `cluedoc` to match the `name` field in the frontmatter. Any tool that supports the [Agent Skills specification](https://agentskills.io/specification) can load it this way.

</details>

## Use

Cluedoc is an Agent Skill, so it runs through your coding agent rather than as a background daemon; there is no file watcher or git hook. Bootstrap a new repository with the `init` command:

> /cluedoc init

`init` does two things: it writes a shallow starter tree — a root paper plus one paper per top-level feature — so you begin with a real skeleton instead of an empty folder, and it wires a short sync-trigger block into your repo's agent-instructions file (`AGENTS.md`, or whichever your agent already uses) so future sessions are reminded to keep the docs in sync. To bootstrap without touching those files, run the skill plainly instead:

> /cluedoc

After that, the agent will often update the affected papers on its own as it edits code in a session. That proactive update is best-effort, not a guarantee: changes made outside the agent, or turns where it does not reach for the skill, will not be picked up. When you want a sure sync, before a commit or a full pass over the repository, call `cluedoc` by name:

> Run cluedoc over the whole repo and sync the docs.

Either way, the papers live in a `.cluedoc/` folder at the repository root. For hands-off updates, run it in CI — the [GitHub Action](#github-action) below does the same thing on every pull request, and bootstraps the tree itself if there is no `.cluedoc/` yet.

<a id="on-every-pull-request"></a>

## GitHub Action

Papers are a generated artifact derived from the code, so the way to automate them is the way you already automate a lockfile or a generated API client: let a bot write them into the pull request branch, so the docs are reviewed and merged atomically with the change that caused them.

```yaml
name: Cluedoc
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

jobs:
  cluedoc:
    uses: KeunwooPark/cluedoc/.github/workflows/cluedoc.yml@v1
    secrets:
      api_key: ${{ secrets.OPENAI_API_KEY }}
```

Add an `OPENAI_API_KEY` secret and that is the whole setup. The action works out the diff range from the event, so there is nothing to configure per repository and no `git diff` expression to write. Four ready-made workflows are in [`examples/`](examples/): [`cluedoc-pr.yml`](examples/cluedoc-pr.yml) syncs papers into the PR, [`cluedoc-main.yml`](examples/cluedoc-main.yml) syncs them after a merge, [`cluedoc-gateway.yml`](examples/cluedoc-gateway.yml) runs it against a gateway of your own, and [`cluedoc-composed.yml`](examples/cluedoc-composed.yml) uses the action directly, `KeunwooPark/cluedoc@v1`, for anyone who wants the papers without the bot commit.

If Changesets is the analogy that brought you here, note the difference: a changeset records intent that cannot be derived from the diff, which is why you write it by hand. A paper can be derived, so nothing needs to be declared — but papers are also mutable shared files rather than append-only ones, which is where the conflict question below comes from.

### Which model runs it

The action carries its own agent rather than wrapping someone else's, and that agent speaks one protocol: OpenAI chat completions. So `base_url` can be any endpoint that answers `POST /chat/completions` — a model vendor, a hosted router, a server on your own hardware, or a gateway you run, which is where per-repository budgets and request logging usually already live. Cluedoc never learns which model answered; it sends a name and a key and reads the reply.

```yaml
with:
  base_url: https://your-gateway.example/v1
  model: whatever-that-gateway-calls-it
```

Owning the agent also bounds it. It has six tools — read a file, list files, search, write, edit, `git diff` — and no shell, which matters because this job holds a token that can push to your repository. During a normal sync a write outside `.cluedoc/` is refused by the engine rather than merely discouraged in the prompt; `bootstrap: full` is the one mode that opens the rest of the tree, and only because you asked it to.

### Starting from nothing

Run it on a repository with no `.cluedoc/` and it bootstraps instead of syncing: a root paper plus one per top-level feature, the same shallow starter tree `/cluedoc init` writes.

It stops there. `init`'s second job wires a sync-trigger block into your `AGENTS.md`, and that is a different kind of edit from a generated paper — the argument for letting a bot commit papers unasked is that papers are *derived*, and an agent-instructions file is not. Run `/cluedoc init` locally for that, or pass `bootstrap: full` if you would rather the action did it.

### What you still decide

**Forks.** A pull request from a fork gets no secrets and a read-only token, so the agent cannot run at all. The action skips those rather than failing on them, which means fork contributions merge with stale papers unless you also run the `main` workflow to catch them on the way in. If you take outside contributions, run both.

**Diff noise.** Optionally add `.cluedoc/** linguist-generated=true` to `.gitattributes`, so papers collapse by default in the PR diff and reviewers expand only the ones they care about.

<details>
<summary>Two things the action handles, and why they needed handling</summary>

**The loop.** The bot's own commit updates the PR, which fires `synchronize`, which would run the workflow again. Path filters do not save you here: on `pull_request` events GitHub evaluates `paths-ignore` against the whole `base...head` diff, so a PR that still contains code files keeps matching no matter what the bot committed. The action pushes as `GITHUB_TOKEN` — a `synchronize` it causes creates a run that requires manual approval instead of starting on its own — and checks the event sender as a second guard.

**Conflicts.** Two open pull requests that touch the same feature will both rewrite that feature's paper and conflict, in generated prose. The action keeps the branch's version and lets the next sync regenerate, because the losing side is not lost work — it is work that will be redone from the code in a moment. That reasoning holds only inside `.cluedoc/`, so a conflict anywhere else stops the run for a human.

</details>

### Composing it

The action reports what it did, so Cluedoc can be a step in a job you already have rather than a bot that commits:

| Output | |
| --- | --- |
| `changed` | `true` when papers were written |
| `papers` | newline-separated paths |
| `commit` | SHA of the docs commit, empty when nothing changed |

With `push: false` the papers are left in the working tree and nothing is committed — see [`cluedoc-composed.yml`](examples/cluedoc-composed.yml), which opens a separate pull request with them instead.

### If it fails before it starts

Two things bite organizations rather than individuals, and neither is fixable from inside the action:

- **Action policy.** If your organization restricts which actions may run, allow `KeunwooPark/*` under Settings → Actions → General. Otherwise the run fails before its first step, with an error that does not obviously name the cause.
- **Pinning.** `@v1` is a moving tag. If your policy requires a pinned SHA, `uses: KeunwooPark/cluedoc@<sha>` works the same way — the engine reads the skill straight out of that checkout, so the papers, the prompt that wrote them and the agent that ran it all stay on the version you pinned.

On a self-hosted runner, one more: the engine is a dependency-free Node program, so the runner needs Node 18 or newer on `PATH`. GitHub's hosted runners already have it; if yours does not, add `actions/setup-node` before the action. There is nothing to `npm install` either way.

## How it works

**One paper per feature, organized as a hierarchy.** The unit of documentation is one feature. Features form a tree: large features contain smaller sub-features, and Cluedoc mirrors that hierarchy in the folder structure. Everything lives in a `.cluedoc/` folder at the repository root, where every feature is a folder and its paper is the `README.md` inside it. A feature is split only when it has distinct sub-capabilities that each deserve their own hero visual; the split is a judgment about capability, never a mirror of the code's directory layout, so the "monorepo vs. single-package" question never comes up.

**It builds progressively, driven by your code.** Cluedoc does not document the whole repository in one pass. When code changes, a single change can ripple up and down the feature hierarchy, so it updates parent and child papers alike. Upward, it scans where the changed code is used (its callers) to find the larger feature it belongs to; downward, it scans what the code uses (its callees) to find the collaborators worth documenting.

**Abstract prose, anchored to code.** Papers are about the code but never contain it. The prose stays abstract and human, with no snippets, symbols, or file paths. The link to the implementation lives in a `sources` list in the frontmatter, kept at the granularity of files so it survives ordinary refactors.

**Every paper has the same shape.** Each paper is YAML frontmatter followed by six sections, always in order: a hero visual, abstract, introduction, related work, description, and conclusion. Related Work is the connective tissue: every cross-paper link lives there, turning the docs into a citation graph you can traverse.

**It also guides your reading.** When you ask how the system works (a feature, a flow, "where does X happen"), Cluedoc answers, then appends a short **Reading Guide**: the two-to-five papers most worth reading, in a suggested order. This only kicks in once a `.cluedoc/` folder exists.

## How it compares

Cluedoc's closest relative is the [LLM-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern, where an LLM incrementally builds and maintains a persistent, interlinked wiki instead of re-reading raw sources at query time. Cluedoc is that pattern specialized for source code: it is driven by code changes rather than a curated corpus, prescribes one shape (a capability tree, one paper per feature, the six-section academic form), and stays in the loop as the agent edits code. It differs from tools like [DeepWiki-Open](https://github.com/AsyncFuncAI/deepwiki-open), whose wiki lives in an external app backed by a vector index that you host and regenerate on demand: Cluedoc's papers are plain Markdown under `.cluedoc/`, versioned with the code, with no server and no vector store. And unlike classic generators (Doxygen, Sphinx, JSDoc) that describe symbols one entry per function, Cluedoc explains features, one paper per capability, in language a designer would recognize.

## License

[MIT](LICENSE)
