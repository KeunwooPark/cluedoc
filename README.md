# Cluedoc

An [Agent Skill](https://agentskills.io) that automatically documents a codebase as a set of interlinked, visual **papers** — one focused document per feature, organized as a capability tree and cross-referenced like a citation graph.

## Install

```bash
npx skills add KeunwooPark/cluedoc
```

That's it. The [`skills`](https://github.com/vercel-labs/skills) CLI auto-detects your agent — Claude Code, Codex, Cursor, and [many others](https://github.com/vercel-labs/skills#supported-agents) — and installs Cluedoc for it.

The skill itself lives in [`SKILL.md`](SKILL.md).

<details>
<summary>Manual install</summary>

### Manual install

Agent Skills are plain directories containing a `SKILL.md`. Clone this repo into your agent's skills folder:

```bash
# Per-user (available in every project)
git clone https://github.com/KeunwooPark/cluedoc.git ~/.claude/skills/cluedoc

# — or per-project (checked in with the repo)
git clone https://github.com/KeunwooPark/cluedoc.git .claude/skills/cluedoc
```

The directory name must be `cluedoc` to match the `name` field in the frontmatter. Any tool that supports the [Agent Skills specification](https://agentskills.io/specification) can load it this way.

</details>

## Use

Once installed, Cluedoc works mostly on its own. As you change code, it quietly keeps the docs in `.cluedoc/` in sync — updating the affected papers as features are added, changed, or removed. No command needed.

Call out `cluedoc` explicitly only when you want a **full pass**: scan the whole codebase and bring every paper up to date, e.g.:

> Run cluedoc over the whole repo and sync the docs.

The papers also serve as a reading map. When you ask how the system works — a feature, a flow, "where does X happen" — Cluedoc answers, then appends a short **Reading Guide**: the most relevant papers to read, ordered as a suggested sequence. (This only kicks in once a `.cluedoc/` folder exists.)

Either way, the papers live in a `.cluedoc/` folder at the repository root.

## License

[MIT](LICENSE)
