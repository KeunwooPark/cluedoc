// The tools the skill actually needs, and nothing else.
//
// Cluedoc reads code, finds where things are used, and writes prose into
// `.cluedoc/`. It never builds, never installs, never edits source. That is the
// whole reason this file can exist: the surface is small enough to enumerate,
// so the job holding a write token never has to be handed a shell to get
// `git diff` out of it.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveInside, assertWritable, globToRegExp, PathError } from './paths.mjs';

const MAX_LINES = 2000;
const MAX_CHARS = 120_000;
const MAX_LIST = 1000;
const MAX_MATCHES = 100;
const MAX_LINE = 300;
const GIT_TIMEOUT_MS = 30_000;

// Directories no walk should descend into. Only consulted when the repository
// is not a git checkout — with git we ask git, which already knows.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', 'out',
  'target', 'vendor', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.terraform',
]);

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git', ['-C', root, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      }
    );
  });
}

// git argv is not a shell, so there is no injection here — but `git diff` has
// flags that write files (`--output`), and the model supplies these strings.
// Anything that could be read as a flag is refused rather than escaped.
function assertNotFlag(value, label) {
  if (typeof value === 'string' && value.startsWith('-')) {
    throw new PathError(`${label} may not begin with '-'`);
  }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walk(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_LIST * 20) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, root, out);
    } else if (e.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
}

// One list of candidate files, used by both listing and searching. `git
// ls-files -co --exclude-standard` is tracked files plus untracked ones that
// are not ignored — which is exactly "the files a human would say are in this
// repository", including papers written moments ago by this same run.
async function repoFiles(root) {
  try {
    const out = await git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
    const files = out.split('\0').filter(Boolean);
    if (files.length) return files;
  } catch {
    // Not a git checkout, or git is unavailable. Fall through and walk.
  }
  const out = [];
  walk(root, root, out);
  return out;
}

function filterFiles(files, { pattern, dir }) {
  let result = files;
  if (dir && dir !== '.') {
    const prefix = dir.replace(/\/+$/, '') + '/';
    result = result.filter((f) => f.startsWith(prefix));
  }
  if (pattern) {
    const re = globToRegExp(pattern);
    // A bare `*.md` should mean "anywhere", which is what a person means by it;
    // a pattern with a slash in it is anchored, which is also what they mean.
    const bare = !pattern.includes('/');
    result = result.filter((f) => re.test(f) || (bare && re.test(path.basename(f))));
  }
  return result;
}

function truncate(text, limit, note) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated: ${note}]`;
}

export function createTools({ root, writeScope, onWrite = () => {} }) {
  const impl = {
    async read_file({ path: p, offset = 1, limit = MAX_LINES }) {
      const { abs, rel } = resolveInside(root, p);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) throw new PathError(`'${rel}' is a directory; use list_files`);

      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) return `[${rel} is a binary file; not shown]`;

      const lines = buf.toString('utf8').split('\n');
      // A file ending in a newline splits to a trailing empty element, which
      // would report every file as one line longer than it is.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

      const start = Math.max(1, Number(offset) || 1);
      const count = Math.min(Number(limit) || MAX_LINES, MAX_LINES);
      const slice = lines.slice(start - 1, start - 1 + count);

      let body = slice.join('\n');
      body = truncate(body, MAX_CHARS, `${rel} is large; read it in ranges with offset/limit`);
      const shown = start + slice.length - 1;
      const header =
        lines.length > shown || start > 1
          ? `[${rel}: lines ${start}-${shown} of ${lines.length}]\n`
          : '';
      return header + body;
    },

    async list_files({ path: dir = '.', pattern = '' } = {}) {
      const { rel } = resolveInside(root, dir || '.');
      const files = filterFiles(await repoFiles(root), {
        pattern,
        dir: rel === '.' ? '' : rel,
      });
      if (!files.length) return '[no files matched]';
      const head = files.slice(0, MAX_LIST).sort();
      const more = files.length - head.length;
      return head.join('\n') + (more > 0 ? `\n[${more} more not shown]` : '');
    },

    async search_text({ pattern, path: dir = '.', glob = '', max_results = MAX_MATCHES }) {
      if (typeof pattern !== 'string' || pattern === '') {
        throw new PathError('pattern must be a non-empty string');
      }
      let re;
      try {
        re = new RegExp(pattern, 'i');
      } catch (e) {
        throw new PathError(`pattern is not a valid regular expression: ${e.message}`);
      }
      const { rel } = resolveInside(root, dir || '.');
      const files = filterFiles(await repoFiles(root), {
        pattern: glob,
        dir: rel === '.' ? '' : rel,
      });

      const cap = Math.min(Number(max_results) || MAX_MATCHES, MAX_MATCHES);
      const hits = [];
      let scanned = 0;
      for (const f of files.sort()) {
        if (hits.length >= cap) break;
        let buf;
        try {
          buf = fs.readFileSync(path.join(root, f));
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        scanned++;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (re.test(lines[i])) {
            hits.push(`${f}:${i + 1}: ${lines[i].slice(0, MAX_LINE).trim()}`);
          }
        }
      }
      if (!hits.length) return `[no matches for /${pattern}/ in ${scanned} file(s)]`;
      const suffix = hits.length >= cap ? `\n[stopped at ${cap} matches]` : '';
      return hits.join('\n') + suffix;
    },

    async write_file({ path: p, content }) {
      if (typeof content !== 'string') throw new PathError('content must be a string');
      const { abs, rel } = resolveInside(root, p);
      assertWritable(rel, writeScope);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      onWrite(rel);
      const lines = content.split('\n').length;
      return `wrote ${rel} (${lines} line(s))`;
    },

    async edit_file({ path: p, old_text, new_text, replace_all = false }) {
      if (typeof old_text !== 'string' || old_text === '') {
        throw new PathError('old_text must be a non-empty string');
      }
      if (typeof new_text !== 'string') throw new PathError('new_text must be a string');
      const { abs, rel } = resolveInside(root, p);
      assertWritable(rel, writeScope);

      // ENOENT here means the model is amending a paper it only planned to
      // write. Say that, rather than passing on an errno the skill never uses.
      if (!fs.existsSync(abs)) {
        throw new PathError(`${rel} does not exist; use write_file to create it`);
      }
      const before = fs.readFileSync(abs, 'utf8');
      const occurrences = before.split(old_text).length - 1;
      if (occurrences === 0) throw new PathError(`old_text does not appear in ${rel}`);
      // Editing the first of several matches is how an edit lands in the wrong
      // place and looks like it worked. Make the model disambiguate instead.
      if (occurrences > 1 && !replace_all) {
        throw new PathError(
          `old_text appears ${occurrences} times in ${rel}; include more context or pass replace_all`
        );
      }
      const after = replace_all
        ? before.split(old_text).join(new_text)
        : before.replace(old_text, new_text);
      fs.writeFileSync(abs, after, 'utf8');
      onWrite(rel);
      return `edited ${rel} (${occurrences} replacement(s))`;
    },

    async git_diff({ range = '', path: p = '', name_only = false, stat = false }) {
      assertNotFlag(range, 'range');
      assertNotFlag(p, 'path');
      const args = ['diff'];
      if (name_only) args.push('--name-only');
      else if (stat) args.push('--stat');
      if (range) args.push(range);
      args.push('--');
      if (p) {
        const { rel } = resolveInside(root, p);
        args.push(rel);
      }
      const out = await git(root, args);
      if (!out.trim()) return '[no differences]';
      return truncate(out, MAX_CHARS, 'diff is large; narrow it with `path`, or pass name_only');
    },
  };

  return { schemas, impl };
}

// Descriptions are prompt, not documentation: each one has to say when to reach
// for the tool, because that judgment is the only thing standing between a
// focused sync and a model that reads the entire repository first.
export const schemas = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the repository. Use offset/limit to read a large file in ranges rather than all at once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path.' },
          offset: { type: 'integer', description: 'First line to read, 1-based. Default 1.' },
          limit: { type: 'integer', description: 'How many lines to read. Default 2000.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files in the repository, ignoring anything git ignores. Use this to see the shape of a directory before reading anything in it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list. Default the repository root.' },
          pattern: {
            type: 'string',
            description:
              "Glob filter, e.g. '*.ts' for any TypeScript file, or 'src/**/*.py' to anchor it.",
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description:
        'Case-insensitive regular-expression search across the repository. This is how you find where a symbol is used (its callers) and what it uses (its callees) — the upward and downward scans the skill asks for.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to match per line.' },
          path: { type: 'string', description: 'Directory to search under. Default everywhere.' },
          glob: { type: 'string', description: "Only search files matching this glob, e.g. '*.go'." },
          max_results: { type: 'integer', description: 'Cap on matches returned. Default 100.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content. Use this for a new paper, or when a paper changes enough that rewriting it is clearer than editing it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string in an existing file. Prefer this over write_file when amending part of a paper. old_text must match exactly once unless replace_all is set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path.' },
          old_text: { type: 'string', description: 'Exact text to replace, with enough context to be unique.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Show a git diff. Call this first on a scoped run to see exactly what changed, then document only what the change affects.',
      parameters: {
        type: 'object',
        properties: {
          range: { type: 'string', description: "Range such as 'origin/main...HEAD'. Default the working tree." },
          path: { type: 'string', description: 'Limit the diff to this path.' },
          name_only: { type: 'boolean', description: 'List changed file names instead of contents.' },
          stat: { type: 'boolean', description: 'Show a diffstat summary instead of contents.' },
        },
      },
    },
  },
];
