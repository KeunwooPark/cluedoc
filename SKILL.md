---
name: cluedoc
description: Automatically document a codebase as a set of interlinked, visual "papers". Use proactively after making code changes to keep the docs in .cluedoc/ in sync — updating the papers for features that were added, changed, or removed — without being asked. Also use when the user explicitly wants to generate or fully re-sync documentation for a repository (monorepo or single-package). Run the `init` command (e.g. "cluedoc init") to bootstrap a new repository: it writes a shallow starter tree of papers and wires a sync-trigger block into the repo's agent-instructions file. Additionally, whenever the user asks a question about how the system works and .cluedoc/ papers exist, append a short "Reading Guide" to the answer pointing at the most relevant existing papers to read.
license: MIT
metadata:
  author: keunwoo
  version: "0.2.0"
---

# Cluedoc

Cluedoc automatically documents a repository by writing a set of **papers** — one focused document per **feature** of the system. Papers are richly visual and cross-reference each other, so a reader can start anywhere and follow links to the context they need.

Cluedoc has **one mode**, not two. It organizes papers by **capability**, not by code layout — one unified feature tree spans the whole repository regardless of how the code is packaged. This is why the usual "monorepo vs. single-package" distinction never comes up: Cluedoc does not detect or branch on repo shape. A capability that lives in its own package appears as a feature next to the capabilities it builds on, and a `sources` list (see below) can freely point across package boundaries. Whether the repo is one package or twenty, the documentation is the same kind of capability tree.

## Papers Are Features, Organized as a Hierarchy

The unit of documentation is **one feature**. Features form a hierarchy: large features contain smaller sub-features. Cluedoc mirrors this hierarchy in the folder structure — **higher-level features live in higher folders, lower-level (finer-grained) features live deeper**.

**Where splitting stops (the one-paper rule).** Split a feature into sub-features when it has distinct sub-capabilities that each deserve their own hero visual and description. Stop when a feature can be fully explained in a single focused paper. This is a judgment about *capability*, not a mirror of the code's directory structure.

**Layout.** Everything lives in a `.cluedoc/` folder at the repository root. Every feature — leaf or parent — is a **folder**, and its paper is a `README.md` inside that folder. Sub-features are subfolders.

```
.cluedoc/
├── README.md                  ← ROOT paper: the whole repository/app
├── authentication/
│   ├── README.md              ← the "Authentication" feature paper
│   ├── login/
│   │   └── README.md          ← sub-feature: "Login"
│   └── session-management/
│       ├── README.md          ← sub-feature: "Session Management"
│       └── token-refresh/
│           └── README.md      ← deeper sub-feature: "Token Refresh"
└── billing/
    └── README.md
```

The **root paper** (`.cluedoc/README.md`) is the entry point for the whole repository. It follows the same paper structure as any other, and its Related Work lists the top-level features as children.

Making every feature a folder (even leaves) keeps the structure uniform and lets a leaf grow sub-features later without any rename. Folder names are slugs: lowercase the feature title, replace spaces with hyphens, strip non-alphanumeric characters.

## How Cluedoc Builds Docs — Progressively, Both Directions

Cluedoc does **not** document the whole repository in one pass. It builds the documentation **progressively**, driven by code changes.

A software system is an organism: a code change propagates **both up and down** the feature hierarchy, so a single change can require updating parent *and* child papers.

- **Upward (what contains this):** scan **where the changed code is used** — call sites, imports, references. This reveals the larger feature the code participates in, and how the change affects that parent.
- **Downward (what this depends on):** scan **what the changed code uses** — the functions and modules it calls. These are its child features/collaborators, and the change may alter how they are described or which ones matter.

When code is added or changed, Cluedoc:

1. **Locates the code** and scans **both directions** — its callers (upward) and its callees (downward).
2. **Infers its purpose** — what capability this code serves, in language-neutral terms.
3. **Places it in the tree** — identifies the parent feature that contains it *and* the child features it builds on, up to a level that already has a paper (or the root), and down to the collaborators worth documenting.
4. **Creates or updates every affected paper** — parent, self, and children alike — placing each at the correct depth in `.cluedoc/`. A small change may touch one leaf; a structural change may ripple across several levels in both directions.

```
   root paper ─────────────► update if the top-level picture shifted
        ▲  upward: "where is this used?" (callers)
        │
   parent feature ─────────► refine to reflect the changed sub-feature
        ▲
        │
   changed code ───────────► create/update its own paper
        │
        ▼
   child features ─────────► update the collaborators it now uses
        │  downward: "what does this use?" (callees)
        ▼
   deeper children ────────► add/refine if new dependencies appeared
```

Over many changes the tree fills in and sharpens from every direction. Early on it may be shallow; it deepens as features reveal both the structures that contain them and the collaborators they rely on.

## The `init` Command — Bootstrap and Wire-Up

`init` is the one-time way to *start* Cluedoc in a repository. Trigger it when the user runs `/cluedoc init`, says "cluedoc init", or asks to initialize/bootstrap/set up Cluedoc here. It does two things: lay down a shallow starter tree of papers, and wire up a persistent trigger so future sessions keep the docs in sync.

This is **not** a second documentation mode. `init` produces the same capability tree as the progressive build — it just does a fast, shallow first pass and stops. Everything after `init` is ordinary progressive updating.

### Job 1 — Generate the quick essential papers (shallow, breadth-first)

Create a starter skeleton, then let the progressive build deepen it later.

1. **Guard.** If `.cluedoc/` already has papers, do **not** overwrite. Tell the user it's already initialized and offer a normal sync instead. Only proceed when `.cluedoc/` is absent or empty.
2. **Find the top-level features.** Survey the repository and identify its handful of major capabilities in language-neutral terms (the same "capability, not code layout" judgment used everywhere in Cluedoc). Aim for a small set — typically 3–7 — not an exhaustive list.
3. **Write only two levels:**
   - The **root paper** (`.cluedoc/README.md`) — the whole-repository overview.
   - **One paper per top-level feature** (`.cluedoc/<slug>/README.md`).
   Each is a full paper: frontmatter (`title`, `sources`) plus the six sections and a hero visual, per *The Paper Structure*.
4. **Do not recurse.** Stop at the top level. Sub-features are left for the progressive build — this keeps `init` fast and honors the "progressive, not one pass" principle. The root's Related Work links the top-level papers you just created (they exist now, so the links are live — never link papers you haven't written).

### Job 2 — Wire up the sync trigger

Write a short, marker-delimited block into the repository's agent-instructions file so every future session is reminded to keep `.cluedoc/` in sync — closing the gap where a proactive update is missed because the agent never reached for the skill.

- **Target file.** Prefer `AGENTS.md` at the repository root. If it is absent, fall back to whatever agent-instructions file the repo already uses (for example `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, or `.github/copilot-instructions.md`). If none exists, create `AGENTS.md`.
- **Idempotent.** Wrap the injected text in `<!-- cluedoc:start -->` … `<!-- cluedoc:end -->`. On re-run, replace the existing block in place — never duplicate it. When adding to a file that already has content, append the block after a blank line and leave the rest untouched.
- **Block content** (keep it short — point at the skill, don't restate it):

```markdown
<!-- cluedoc:start -->
## Documentation (Cluedoc)

This repository keeps human-readable, visual "papers" under `.cluedoc/`, one per feature. After finishing a set of code changes, use the **cluedoc** skill to update every affected paper — parent, self, and children — so the docs stay in sync with the code. When answering questions about how the system works, consult these papers and append a short Reading Guide.
<!-- cluedoc:end -->
```

After both jobs, briefly report what was created: the root paper, the top-level feature papers, and which file received the trigger block.

## Keeping Papers in Sync

Because the docs track real code, the tree must stay consistent as features appear, move, and disappear:

- **New feature** → create its folder + `README.md`; add it to its parent's Related Work.
- **Feature grows sub-capabilities** → split it: create subfolders for the new sub-features, move the fine-grained detail down, leave the parent paper as an overview that links to its children.
- **Feature renamed or refocused** → rename the folder (new slug) and update every inbound hyperlink so no reference dangles.
- **Feature removed** → delete its folder and fix or remove links that pointed to it.

After any of these, verify that all Related Work hyperlinks still resolve.

## Abstract Prose, Anchored to Code

Papers are **about** the code but must never **contain** the code. The reading experience stays abstract and human-readable; the link to the implementation lives in structured metadata, out of the prose.

**In the prose — describe, don't quote.** Write about behavior, responsibilities, data, and concepts in plain domain language. Do **not** put into the body of a paper:
- Code snippets or excerpts
- Function, class, method, variable, or type names written as code symbols
- File paths, directory names, or line numbers
- Language- or framework-specific implementation trivia

Name concepts the way a user or designer would ("the option's *value source*", "the *parse loop*"), not the way the compiler would (`getOptionValueSource()`). If you feel the urge to paste code to explain something, draw a visual instead.

**In the frontmatter — anchor to code.** So an agent (or curious reader) can still jump from a paper to the implementation, each `README.md` carries a `sources` list in YAML frontmatter pointing at the files or directories that realize the feature. This is the *only* place raw paths appear, and it is metadata, not narrative:

```markdown
---
title: Option Parsing
sources:
  - lib/option.js
  - lib/command.js   # option registration & the parse loop
---
```

Keep `sources` at the granularity of files or directories (not symbols or line numbers) so it survives ordinary refactors. When code moves, update `sources`; the prose usually needn't change at all — which is exactly the point of keeping them separate.

**`sources` may overlap across papers.** One file often contributes to several features (an entry point that implements part of many capabilities; a shared module that a "hub" feature and its consumers both draw on). Listing the same file under multiple papers is expected and correct — `sources` maps *feature → the code that realizes it*, not code → one owner. Do not force a file to belong to exactly one paper.

## The Paper Structure

Every doc Cluedoc produces is a *paper* with YAML frontmatter (`title`, `sources`) followed by exactly these sections, in order:

1. **Hero visual** — a diagram that captures the essence of the subject at a glance (see *Visuals*): a diagram of its key flow or structure. Opens the paper before any prose.
2. **Abstract** — a short paragraph: what this part of the system is and why it exists.
3. **Introduction** — the problem it solves and the context a reader needs to start.
4. **Related Work** — hyperlinks to *other Cluedoc papers* that give the reader context. This is how the documentation forms a navigable graph.
5. **Description** — the substance: how the subject works, its behavior, structure, and important details. Heavy use of visuals.
6. **Conclusion** — what to take away; where the reader might go next.

## Visuals Are Mandatory

Papers must be **visual**. Never explain a system or concept in prose alone when a visual would make it clearer. Use a visual aid whenever describing structure, flow, relationships, states, or sequences.

Choose the form that fits the subject best:
- **Mermaid diagrams** — for structure, flows, relationships, state, sequences (graphs, flowcharts, sequence diagrams, state diagrams, ER diagrams, etc.).
- **CLI-style text graphics** — for things that read better as monospace/terminal art: directory trees, ASCII boxes-and-arrows, tables, timelines, layouts.

Pick whichever communicates the idea most clearly. Every paper opens with a **hero visual** — a diagram (Mermaid or CLI graphic) of its key flow or structure — and uses additional visuals throughout the Description.

## Related Work = the Link Graph

"Related Work" is the connective tissue of the documentation. When a paper depends on, builds upon, or is clarified by another paper, cite it there as a hyperlink to that paper's `README.md`. This lets a reader traverse the docs like a citation graph — landing on any paper and walking outward to the context they need.

Related Work carries **all** cross-paper links, including hierarchy links:
- The **parent feature** paper (the folder above).
- **Child sub-feature** papers (the folders below).
- Any **non-adjacent** papers that provide useful context, anywhere in the tree.

Guidelines:
- Prefer linking to Cluedoc papers over re-explaining shared concepts.
- Every listed reference must be a working relative hyperlink (e.g. `../README.md`, `./login/README.md`).
- **Link only papers that already exist. Never create a dead link to a planned-but-unwritten paper.** Because the tree is built progressively, many features will be known before they are documented. Refer to such a feature by name in plain text (no link), or — if it is important context — write its paper first, then link it. A missing paper you keep wanting to cite is a signal to write it next.

## Reading Guide — Recommend Papers When Answering Questions

The papers are not only for writing; they are a map for reading. Whenever the user asks a question about **how the system works** — a feature, a flow, an architectural decision, "where does X happen", "how does Y work" — answer the question first, then **append a short "Reading Guide"** that points them at the Cluedoc papers most worth reading to go deeper on that question.

**When to append a guide.** Only when both hold:
- The question is about understanding the system (its behavior, structure, or design) — not a pure coding task, a shell command, or a question unrelated to this repository.
- A `.cluedoc/` folder with papers actually exists. If it does not, say nothing about a reading guide (optionally suggest running Cluedoc to generate the docs), and never invent papers or links.

**How to build the guide.**
1. **Map the question to features.** Identify which capabilities the question touches, then find the papers that cover them — start from the root paper and walk the feature tree / Related Work graph, the same structure Cluedoc writes.
2. **Pick the entry point, then the path.** Recommend the single best paper to start from, followed by the few papers that build the necessary context around it (parents for the big picture, children for detail, non-adjacent papers for cross-cutting concerns). Order them as a **suggested reading sequence**, not an unranked list.
3. **Keep it short.** Typically 2–5 papers. More than that is a table of contents, not a guide — prefer the most load-bearing ones.
4. **Say why each matters.** One clause per entry: what the reader gets from it and why it's relevant to *their* question.

**Rules.**
- **Link only papers that exist** — the same dead-link rule as Related Work. If the ideal paper hasn't been written yet, name the feature in plain text and (optionally) note it as a gap worth documenting. Never fabricate a path.
- Use working relative hyperlinks to each paper's `README.md`, resolved from the repository root (e.g. `.cluedoc/authentication/README.md`).
- The guide **supplements** the answer; it never replaces answering the question. Do not defer the reader to the papers instead of responding.

**Format.** Close the answer with a compact section, for example:

```markdown
### Reading Guide
1. [Authentication](.cluedoc/authentication/README.md) — start here for the overall login flow your question is about.
2. [Session Management](.cluedoc/authentication/session-management/README.md) — how the session your request creates is tracked afterward.
3. [Token Refresh](.cluedoc/authentication/session-management/token-refresh/README.md) — the specific mechanism behind the expiry behavior you asked about.
```
