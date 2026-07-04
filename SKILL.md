---
name: cluedoc
description: Automatically document a codebase as a set of interlinked, visual "papers". Use proactively after making code changes to keep the docs in .cluedoc/ in sync — updating the papers for features that were added, changed, or removed — without being asked. Also use when the user explicitly wants to generate or fully re-sync documentation for a repository (monorepo or single-package).
license: MIT
metadata:
  author: keunwoo
  version: "0.1.0"
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

1. **Hero visual** — a **banner + diagram pair** that captures the essence of the subject at a glance (see *Visuals*): a CLI-style banner naming the feature, immediately followed by a diagram of its key flow or structure. Opens the paper before any prose.
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

Pick whichever communicates the idea most clearly. Every paper opens with a **hero pair** — a CLI-style banner that names and frames the feature, immediately followed by a diagram (Mermaid or CLI graphic) of its key flow or structure — and uses additional visuals throughout the Description.

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
