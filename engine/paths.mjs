// Every path the model names is untrusted input. It arrives as a string in a
// tool-call argument, and the process reading it holds a token that can push to
// the repository — so the question each of these answers is not "does this file
// exist" but "is this path still inside the tree we agreed to touch".

import path from 'node:path';
import fs from 'node:fs';

export class PathError extends Error {}

// The nearest ancestor that exists, so a path can be checked before its file
// does. Writing a new paper creates directories that were never there.
function existingAncestor(abs) {
  let dir = abs;
  for (;;) {
    if (fs.existsSync(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return dir;
    dir = up;
  }
}

// Inside `root`, following symlinks. `..` is the obvious escape; a symlink is
// the one that survives a naive check, because the string looks local right up
// until the filesystem resolves it somewhere else.
export function resolveInside(root, p, { label = 'path' } = {}) {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new PathError(`${label} must be a non-empty string`);
  }
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, p);

  const anchor = existingAncestor(abs);
  let realAnchor;
  try {
    realAnchor = fs.realpathSync(anchor);
  } catch {
    realAnchor = anchor;
  }
  const resolved = path.join(realAnchor, path.relative(anchor, abs));

  const rel = path.relative(realRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathError(`${label} '${p}' is outside the repository`);
  }
  return { abs: resolved, rel: rel === '' ? '.' : rel };
}

// The write scope is narrower than the repository: on a normal sync the agent
// may read anything and write only `.cluedoc/`. An empty scope means the whole
// tree, which is what `bootstrap: full` asks for.
export function assertWritable(rel, scope) {
  if (!scope) return;
  const norm = rel.split(path.sep).join('/');
  if (norm !== scope && !norm.startsWith(`${scope}/`)) {
    throw new PathError(
      `writing '${norm}' is not allowed; this run may only write inside '${scope}/'`
    );
  }
}

// `*` and `?` stop at a separator, `**` crosses them — the usual reading, and
// the one the model will assume without being told.
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        i += slash ? 2 : 1;
        out += slash ? '(?:.*/)?' : '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
