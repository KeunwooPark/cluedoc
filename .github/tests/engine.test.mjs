// Tests for the engine.
//
// The action's shell steps are covered by the .sh suites next door, which run
// the text extracted from action.yml. This covers the other half: the program
// those steps invoke. Everything here is hermetic — the provider is a stub
// function, so no test needs a key, a network, or a model.
//
//   node --test .github/tests/engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInside, assertWritable, globToRegExp, PathError } from '../../engine/paths.mjs';
import { createTools } from '../../engine/tools.mjs';
import { complete, endpointFor, ProviderError } from '../../engine/provider.mjs';
import { runAgent, LoopError } from '../../engine/loop.mjs';
import { loadConfig, ConfigError } from '../../engine/config.mjs';
import { systemPrompt, skillBody } from '../../engine/prompt.mjs';

// ---------------------------------------------------------------- fixtures

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluedoc-engine-'));
  return fs.realpathSync(dir);
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

// A small repository that looks like something worth documenting: a source
// tree, a paper, a gitignored build directory.
function repo() {
  const root = tmpdir();
  write(root, 'src/auth/login.js', 'export function login(user) {\n  return session(user);\n}\n');
  write(root, 'src/auth/session.js', 'export function session(user) {\n  return { user };\n}\n');
  write(root, 'src/app.js', "import { login } from './auth/login.js';\nlogin('a');\n");
  write(root, '.cluedoc/README.md', '# Root paper\n\nOne paragraph.\n');
  write(root, '.gitignore', 'dist/\n');
  write(root, 'dist/bundle.js', 'ignored\n');
  write(root, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

function toolsFor(root, writeScope = '.cluedoc') {
  const written = [];
  const t = createTools({ root, writeScope, onWrite: (rel) => written.push(rel) });
  return { ...t, written };
}

// A provider stub: hand it the assistant messages to return, in order.
function stubProvider(turns) {
  const seen = [];
  let i = 0;
  const fn = async ({ messages }) => {
    seen.push(structuredClone(messages));
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    return {
      message: turn.message,
      finishReason: turn.finishReason ?? (turn.message.tool_calls ? 'tool_calls' : 'stop'),
      usage: turn.usage,
    };
  };
  fn.seen = seen;
  fn.count = () => i;
  return fn;
}

function toolCall(name, args, id = 'c1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const baseConfig = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'k',
  model: 'm',
  maxTurns: 10,
};

// ------------------------------------------------------------------- paths

test('resolveInside accepts a path inside the root', () => {
  const root = tmpdir();
  write(root, 'a/b.txt', 'x');
  assert.equal(resolveInside(root, 'a/b.txt').rel, 'a/b.txt');
});

test('resolveInside accepts a path whose file does not exist yet', () => {
  const root = tmpdir();
  assert.equal(resolveInside(root, '.cluedoc/new/deep/README.md').rel, '.cluedoc/new/deep/README.md');
});

test('resolveInside rejects a parent-directory escape', () => {
  const root = tmpdir();
  assert.throws(() => resolveInside(root, '../secrets.txt'), PathError);
});

test('resolveInside rejects an absolute path outside the root', () => {
  const root = tmpdir();
  assert.throws(() => resolveInside(root, '/etc/passwd'), PathError);
});

test('resolveInside rejects a symlink that leaves the root', () => {
  const root = tmpdir();
  const outside = tmpdir();
  write(outside, 'secret.txt', 'no');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => resolveInside(root, 'link/secret.txt'), PathError);
});

test('resolveInside rejects an empty path', () => {
  const root = tmpdir();
  assert.throws(() => resolveInside(root, '   '), PathError);
});

test('assertWritable enforces the scope, and an empty scope allows anything', () => {
  assert.doesNotThrow(() => assertWritable('.cluedoc/auth/README.md', '.cluedoc'));
  assert.doesNotThrow(() => assertWritable('.cluedoc', '.cluedoc'));
  assert.throws(() => assertWritable('src/app.js', '.cluedoc'), PathError);
  // A prefix match on the string alone would let this through.
  assert.throws(() => assertWritable('.cluedoc-other/x.md', '.cluedoc'), PathError);
  assert.doesNotThrow(() => assertWritable('AGENTS.md', ''));
});

test('globToRegExp distinguishes * from **', () => {
  assert.ok(globToRegExp('*.md').test('a.md'));
  assert.ok(!globToRegExp('*.md').test('d/a.md'));
  assert.ok(globToRegExp('**/*.md').test('d/e/a.md'));
  assert.ok(globToRegExp('**/*.md').test('a.md'));
  assert.ok(globToRegExp('src/*.js').test('src/app.js'));
  assert.ok(globToRegExp('a?c.txt').test('abc.txt'));
  // Regex metacharacters in a glob are literal.
  assert.ok(globToRegExp('a+b.md').test('a+b.md'));
  assert.ok(!globToRegExp('a+b.md').test('aab.md'));
});

// ------------------------------------------------------------------- tools

test('read_file returns file content', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  const out = await impl.read_file({ path: 'src/auth/login.js' });
  assert.match(out, /export function login/);
});

test('read_file windows with offset and limit, and says so', async () => {
  const root = tmpdir();
  write(root, 'long.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  const { impl } = toolsFor(root);
  const out = await impl.read_file({ path: 'long.txt', offset: 10, limit: 3 });
  assert.match(out, /\[long\.txt: lines 10-12 of 50\]/);
  assert.match(out, /line 10\nline 11\nline 12/);
  assert.ok(!out.includes('line 13'));
});

test('read_file refuses a directory and points at the right tool', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(() => impl.read_file({ path: 'src' }), /is a directory; use list_files/);
});

test('read_file reports a binary file instead of returning bytes', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  assert.match(await impl.read_file({ path: 'logo.png' }), /binary file/);
});

test('read_file cannot escape the repository', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(() => impl.read_file({ path: '../../etc/passwd' }), PathError);
});

test('list_files omits gitignored files', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  const out = await impl.list_files({});
  assert.match(out, /src\/app\.js/);
  assert.ok(!out.includes('dist/bundle.js'));
});

test('list_files includes a file written but never committed', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await impl.write_file({ path: '.cluedoc/auth/README.md', content: '# Auth\n' });
  assert.match(await impl.list_files({ path: '.cluedoc' }), /\.cluedoc\/auth\/README\.md/);
});

test('list_files treats a bare glob as matching a basename anywhere', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  const out = await impl.list_files({ pattern: '*.js' });
  assert.match(out, /src\/auth\/login\.js/);
  assert.match(out, /src\/app\.js/);
  assert.ok(!out.includes('README.md'));
});

test('list_files anchors a glob that contains a slash', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  const out = await impl.list_files({ pattern: 'src/*.js' });
  assert.match(out, /src\/app\.js/);
  assert.ok(!out.includes('src/auth/login.js'));
});

test('search_text reports file and line for each match', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  const out = await impl.search_text({ pattern: 'session' });
  assert.match(out, /src\/auth\/login\.js:2/);
  assert.match(out, /src\/auth\/session\.js:1/);
});

test('search_text can be narrowed by glob', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  const out = await impl.search_text({ pattern: 'login', glob: 'app.js' });
  // Matched against the file column only: app.js's matching line happens to
  // contain the path of the file that must not be searched.
  const files = out.split('\n').map((l) => l.split(':')[0]);
  assert.deepEqual([...new Set(files)], ['src/app.js']);
});

test('search_text says so when nothing matches', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  assert.match(await impl.search_text({ pattern: 'zzz-nothing' }), /no matches/);
});

test('search_text rejects an invalid regular expression', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(() => impl.search_text({ pattern: '([' }), /not a valid regular expression/);
});

test('write_file creates missing directories and reports the write', async () => {
  const root = repo();
  const { impl, written } = toolsFor(root);
  const out = await impl.write_file({ path: '.cluedoc/billing/README.md', content: '# Billing\n' });
  assert.match(out, /wrote \.cluedoc\/billing\/README\.md/);
  assert.equal(fs.readFileSync(path.join(root, '.cluedoc/billing/README.md'), 'utf8'), '# Billing\n');
  assert.deepEqual(written, ['.cluedoc/billing/README.md']);
});

test('write_file refuses to write outside the scope', async () => {
  const root = repo();
  const { impl, written } = toolsFor(root);
  await assert.rejects(() => impl.write_file({ path: 'src/app.js', content: 'x' }), /only write inside/);
  assert.deepEqual(written, []);
  assert.match(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), /import/);
});

test('write_file writes anywhere when the scope is empty', async () => {
  const root = repo();
  const { impl } = toolsFor(root, '');
  await impl.write_file({ path: 'AGENTS.md', content: '# Agents\n' });
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Agents\n');
});

test('edit_file replaces a unique string', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await impl.edit_file({
    path: '.cluedoc/README.md',
    old_text: 'One paragraph.',
    new_text: 'Two paragraphs.',
  });
  assert.match(fs.readFileSync(path.join(root, '.cluedoc/README.md'), 'utf8'), /Two paragraphs\./);
});

test('edit_file refuses an ambiguous match rather than taking the first', async () => {
  const root = repo();
  write(root, '.cluedoc/README.md', 'x\nsame\nsame\n');
  const { impl } = toolsFor(root);
  await assert.rejects(
    () => impl.edit_file({ path: '.cluedoc/README.md', old_text: 'same', new_text: 'y' }),
    /appears 2 times/
  );
  assert.equal(fs.readFileSync(path.join(root, '.cluedoc/README.md'), 'utf8'), 'x\nsame\nsame\n');
});

test('edit_file replaces every occurrence when asked', async () => {
  const root = repo();
  write(root, '.cluedoc/README.md', 'x\nsame\nsame\n');
  const { impl } = toolsFor(root);
  const out = await impl.edit_file({
    path: '.cluedoc/README.md',
    old_text: 'same',
    new_text: 'y',
    replace_all: true,
  });
  assert.match(out, /2 replacement/);
  assert.equal(fs.readFileSync(path.join(root, '.cluedoc/README.md'), 'utf8'), 'x\ny\ny\n');
});

test('edit_file reports a stale old_text', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(
    () => impl.edit_file({ path: '.cluedoc/README.md', old_text: 'not there', new_text: 'y' }),
    /does not appear/
  );
});

test('edit_file honours the write scope', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(
    () => impl.edit_file({ path: 'src/app.js', old_text: 'import', new_text: 'x' }),
    /only write inside/
  );
});

test('git_diff lists changed names against a range', async () => {
  const root = repo();
  write(root, 'src/app.js', "import { login } from './auth/login.js';\nlogin('b');\n");
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'second');
  const { impl } = toolsFor(root);
  const out = await impl.git_diff({ range: 'HEAD~1..HEAD', name_only: true });
  assert.match(out, /src\/app\.js/);
});

test('git_diff reports an empty diff plainly', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  assert.equal(await impl.git_diff({}), '[no differences]');
});

test('git_diff refuses a range that could be read as a flag', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  // `git diff --output=FILE` writes to the filesystem. The model supplies this
  // string, so anything flag-shaped is refused rather than escaped.
  await assert.rejects(
    () => impl.git_diff({ range: '--output=/tmp/pwned' }),
    /may not begin with '-'/
  );
});

test('git_diff limits to a path inside the repository', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(() => impl.git_diff({ path: '../elsewhere' }), PathError);
});

// ---------------------------------------------------------------- provider

test('endpointFor appends the chat-completions path to a base URL', () => {
  assert.equal(endpointFor('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(endpointFor('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
});

test('endpointFor leaves a URL that already names the endpoint', () => {
  const full = 'https://gw.test/v1/chat/completions';
  assert.equal(endpointFor(full), full);
});

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

test('complete returns the first choice and its usage', async () => {
  const res = await complete({
    ...baseConfig,
    messages: [],
    fetchImpl: async () => jsonResponse(200, OK_BODY),
  });
  assert.equal(res.message.content, 'done');
  assert.equal(res.usage.total_tokens, 12);
});

test('complete sends tools and auth, and omits unrequested parameters', async () => {
  let seen;
  await complete({
    ...baseConfig,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return jsonResponse(200, OK_BODY);
    },
  });
  assert.equal(seen.url, 'https://example.test/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.equal(seen.body.tool_choice, 'auto');
  // Newer models reject an explicit max_tokens, and several reject any
  // temperature but their own default.
  assert.ok(!('max_tokens' in seen.body));
  assert.ok(!('temperature' in seen.body));
});

test('complete retries a 429 and honours Retry-After', async () => {
  let calls = 0;
  const slept = [];
  const res = await complete({
    ...baseConfig,
    messages: [],
    sleep: async (ms) => slept.push(ms),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '2' });
      return jsonResponse(200, OK_BODY);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [2000]);
  assert.equal(res.message.content, 'done');
});

test('complete surfaces a provider error message on a non-retryable status', async () => {
  await assert.rejects(
    () =>
      complete({
        ...baseConfig,
        messages: [],
        fetchImpl: async () => jsonResponse(400, { error: { message: 'unknown model foo' } }),
      }),
    (e) => e instanceof ProviderError && /400: unknown model foo/.test(e.message)
  );
});

test('complete explains an HTML response rather than failing to parse it', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      complete({
        ...baseConfig,
        messages: [],
        sleep: async () => {},
        fetchImpl: async () => {
          calls++;
          return jsonResponse(200, '<html><body>Sign in</body></html>');
        },
      }),
    /response was not JSON/
  );
  assert.equal(calls, 5);
});

test('complete retries a network failure and eventually gives up', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      complete({
        ...baseConfig,
        messages: [],
        sleep: async () => {},
        fetchImpl: async () => {
          calls++;
          throw new Error('ECONNRESET');
        },
      }),
    /giving up after 5 attempts.*ECONNRESET/s
  );
  assert.equal(calls, 5);
});

test('complete refuses an empty base URL', async () => {
  await assert.rejects(() => complete({ ...baseConfig, baseUrl: '', messages: [] }), /base_url is empty/);
});

// -------------------------------------------------------------------- loop

test('runAgent executes a tool call and returns the closing message', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    { message: { role: 'assistant', tool_calls: [toolCall('read_file', { path: '.cluedoc/README.md' })] } },
    { message: { role: 'assistant', content: 'Nothing to change.' } },
  ]);

  const out = await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  assert.equal(out.text, 'Nothing to change.');
  assert.equal(out.turns, 2);
  assert.deepEqual(out.calls.map((c) => c.name), ['read_file']);

  // The tool result must come back keyed to the call that produced it.
  const second = completeImpl.seen[1];
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /Root paper/);
});

test('runAgent normalises a null assistant content', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('list_files', {})] } },
    { message: { role: 'assistant', content: 'ok' } },
  ]);
  await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  const assistant = completeImpl.seen[1].find((m) => m.role === 'assistant');
  assert.equal(assistant.content, '');
});

test('runAgent invents an id when the provider omits one', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const call = { type: 'function', function: { name: 'list_files', arguments: '{}' } };
  const completeImpl = stubProvider([
    { message: { role: 'assistant', tool_calls: [call] } },
    { message: { role: 'assistant', content: 'ok' } },
  ]);
  await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  const toolMsg = completeImpl.seen[1].find((m) => m.role === 'tool');
  assert.ok(toolMsg.tool_call_id);
});

test('runAgent hands a tool error back to the model instead of failing the run', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    { message: { role: 'assistant', tool_calls: [toolCall('write_file', { path: 'src/app.js', content: 'x' })] } },
    { message: { role: 'assistant', content: 'I stayed inside .cluedoc.' } },
  ]);
  const out = await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  assert.equal(out.calls[0].failed, true);
  assert.match(completeImpl.seen[1].find((m) => m.role === 'tool').content, /only write inside/);
  assert.equal(out.text, 'I stayed inside .cluedoc.');
});

test('runAgent reports malformed tool arguments to the model', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const bad = { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{not json' } };
  const completeImpl = stubProvider([
    { message: { role: 'assistant', tool_calls: [bad] } },
    { message: { role: 'assistant', content: 'recovered' } },
  ]);
  const out = await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  assert.match(completeImpl.seen[1].find((m) => m.role === 'tool').content, /not valid JSON/);
  assert.equal(out.text, 'recovered');
});

test('runAgent reports an unknown tool name and lists the real ones', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    { message: { role: 'assistant', tool_calls: [toolCall('bash', { cmd: 'rm -rf /' })] } },
    { message: { role: 'assistant', content: 'ok' } },
  ]);
  await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  const content = completeImpl.seen[1].find((m) => m.role === 'tool').content;
  assert.match(content, /no tool named 'bash'/);
  assert.match(content, /read_file/);
});

test('runAgent stops with a usable message when it runs out of turns', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    { message: { role: 'assistant', tool_calls: [toolCall('list_files', {})] } },
  ]);
  await assert.rejects(
    () => runAgent({ config: { ...baseConfig, maxTurns: 3 }, tools, system: 's', prompt: 'p', complete: completeImpl }),
    (e) => e instanceof LoopError && /within 3 turns/.test(e.message)
  );
  assert.equal(completeImpl.count(), 3);
});

test('runAgent accumulates usage across turns', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    {
      message: { role: 'assistant', tool_calls: [toolCall('list_files', {})] },
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    },
    {
      message: { role: 'assistant', content: 'ok' },
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
    },
  ]);
  const out = await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  assert.deepEqual(out.usage, { prompt: 300, completion: 30, total: 330 });
});

test('runAgent runs several tool calls from one turn, in order', async () => {
  const root = repo();
  const tools = toolsFor(root);
  const completeImpl = stubProvider([
    {
      message: {
        role: 'assistant',
        tool_calls: [
          toolCall('list_files', {}, 'a'),
          toolCall('read_file', { path: '.cluedoc/README.md' }, 'b'),
        ],
      },
    },
    { message: { role: 'assistant', content: 'ok' } },
  ]);
  const out = await runAgent({ config: baseConfig, tools, system: 's', prompt: 'p', complete: completeImpl });
  assert.deepEqual(out.calls.map((c) => c.name), ['list_files', 'read_file']);
  assert.deepEqual(
    completeImpl.seen[1].filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    ['a', 'b']
  );
});

// ------------------------------------------------------------------ config

const ENV = {
  CLUEDOC_API_KEY: 'k',
  CLUEDOC_MODEL: 'gpt-5',
};

function envWith(extra, promptText = 'do the thing', skillText = '# Skill') {
  const dir = tmpdir();
  const prompt = path.join(dir, 'prompt.txt');
  const skill = path.join(dir, 'SKILL.md');
  fs.writeFileSync(prompt, promptText);
  fs.writeFileSync(skill, skillText);
  return { ...ENV, CLUEDOC_PROMPT_FILE: prompt, CLUEDOC_SKILL_FILE: skill, ...extra };
}

test('loadConfig defaults the base URL, turns and write scope', () => {
  const c = loadConfig(envWith({}));
  assert.equal(c.baseUrl, 'https://api.openai.com/v1');
  assert.equal(c.maxTurns, 30);
  assert.equal(c.writeScope, '.cluedoc');
  assert.equal(c.temperature, undefined);
  assert.equal(c.maxTokens, 0);
  assert.equal(c.prompt, 'do the thing');
});

test('loadConfig distinguishes an unset write scope from an empty one', () => {
  assert.equal(loadConfig(envWith({})).writeScope, '.cluedoc');
  assert.equal(loadConfig(envWith({ CLUEDOC_WRITE_SCOPE: '' })).writeScope, '');
});

test('loadConfig names the input behind a missing key', () => {
  const env = envWith({});
  delete env.CLUEDOC_API_KEY;
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && /api_key/.test(e.message));
});

test('loadConfig rejects a base URL with no scheme', () => {
  assert.throws(() => loadConfig(envWith({ CLUEDOC_BASE_URL: 'api.openai.com/v1' })), /must start with http/);
});

test('loadConfig rejects a non-integer turn count', () => {
  assert.throws(() => loadConfig(envWith({ CLUEDOC_MAX_TURNS: 'lots' })), /positive integer/);
  assert.throws(() => loadConfig(envWith({ CLUEDOC_MAX_TURNS: '0' })), /positive integer/);
});

test('loadConfig rejects a non-numeric temperature', () => {
  assert.throws(() => loadConfig(envWith({ CLUEDOC_TEMPERATURE: 'warm' })), /must be a number/);
  assert.equal(loadConfig(envWith({ CLUEDOC_TEMPERATURE: '0' })).temperature, 0);
});

test('loadConfig says which file it could not read', () => {
  const env = envWith({ CLUEDOC_PROMPT_FILE: '/nonexistent/prompt.txt' });
  assert.throws(() => loadConfig(env), /CLUEDOC_PROMPT_FILE points at/);
});

// ------------------------------------------------------------------ prompt

test('skillBody strips YAML frontmatter', () => {
  const body = skillBody('---\nname: cluedoc\n---\n# Cluedoc\n\nText.\n');
  assert.equal(body, '# Cluedoc\n\nText.\n');
});

test('skillBody leaves a document with no frontmatter alone', () => {
  assert.equal(skillBody('# Cluedoc\n'), '# Cluedoc\n');
});

test('systemPrompt states the write scope and carries the skill', () => {
  const p = systemPrompt({ skill: '---\nname: x\n---\n# Cluedoc rules\n', writeScope: '.cluedoc' });
  assert.match(p, /only write inside `\.cluedoc\/`/);
  assert.match(p, /# Cluedoc rules/);
  assert.ok(!p.includes('name: x'));
  // The engine has no shell, and a model that assumes one wastes turns.
  assert.match(p, /You have no shell/);
  assert.match(p, /never attempt to stage, commit or push/);
});

test('systemPrompt opens the tree when the scope is empty', () => {
  const p = systemPrompt({ skill: '# x', writeScope: '' });
  assert.match(p, /read and write anywhere/);
  assert.ok(!p.includes('only write inside'));
});

// ------------------------------------------------------------- end to end

// The pieces above are tested in isolation, which leaves the wiring between
// them — env to config to tools to loop to disk — covered by nothing. This runs
// the real entry point as a real process against a real HTTP server, so a
// mistake in that wiring fails here rather than on someone's pull request.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../../engine/run.mjs', import.meta.url));
const SKILL = fileURLToPath(new URL('../../SKILL.md', import.meta.url));

// Replies with the next scripted turn on each request, and records what it saw.
async function scriptedProvider(turns) {
  const requests = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: turn, finish_reason: turn.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

function runEngine(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENGINE], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stdout += c));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('the engine writes a paper end to end', async () => {
  const root = repo();
  const promptFile = path.join(tmpdir(), 'prompt.md');
  fs.writeFileSync(promptFile, 'Document the auth feature.');

  const { requests, server, url } = await scriptedProvider([
    { role: 'assistant', tool_calls: [toolCall('search_text', { pattern: 'session' })] },
    {
      role: 'assistant',
      tool_calls: [toolCall('write_file', {
        path: '.cluedoc/authentication/README.md',
        content: '# Authentication\n\nHow a user becomes a session.\n',
      }, 'c2')],
    },
    { role: 'assistant', content: 'Wrote one paper for Authentication.' },
  ]);

  try {
    const { code, stdout } = await runEngine({
      CLUEDOC_API_KEY: 'test-key',
      CLUEDOC_BASE_URL: url,
      CLUEDOC_MODEL: 'test-model',
      CLUEDOC_WORKSPACE: root,
      CLUEDOC_PROMPT_FILE: promptFile,
      CLUEDOC_SKILL_FILE: SKILL,
    });

    assert.equal(code, 0);
    assert.equal(
      fs.readFileSync(path.join(root, '.cluedoc/authentication/README.md'), 'utf8'),
      '# Authentication\n\nHow a user becomes a session.\n'
    );
    assert.match(stdout, /Wrote one paper for Authentication\./);
    assert.match(stdout, /3 turn\(s\), 2 tool call\(s\), 1 file\(s\) written/);
    assert.match(stdout, /Tokens: 15 in, 3 out/);

    // The skill and the prompt both have to arrive, or the model is documenting
    // a repository with no idea what a paper is.
    const first = requests[0];
    assert.equal(first.model, 'test-model');
    assert.match(first.messages[0].content, /Papers Are Features/);
    assert.equal(first.messages[1].content, 'Document the auth feature.');
    assert.deepEqual(
      first.tools.map((t) => t.function.name).sort(),
      ['edit_file', 'git_diff', 'list_files', 'read_file', 'search_text', 'write_file']
    );
  } finally {
    server.close();
  }
});

test('the engine refuses a write outside the scope, end to end', async () => {
  const root = repo();
  const promptFile = path.join(tmpdir(), 'prompt.md');
  fs.writeFileSync(promptFile, 'Try to edit the source.');

  const { server, url } = await scriptedProvider([
    { role: 'assistant', tool_calls: [toolCall('write_file', { path: 'src/app.js', content: 'pwned' })] },
    { role: 'assistant', content: 'Refused, as expected.' },
  ]);

  try {
    const { code } = await runEngine({
      CLUEDOC_API_KEY: 'test-key',
      CLUEDOC_BASE_URL: url,
      CLUEDOC_MODEL: 'test-model',
      CLUEDOC_WORKSPACE: root,
      CLUEDOC_PROMPT_FILE: promptFile,
      CLUEDOC_SKILL_FILE: SKILL,
    });
    assert.equal(code, 0);
    assert.ok(!fs.readFileSync(path.join(root, 'src/app.js'), 'utf8').includes('pwned'));
  } finally {
    server.close();
  }
});

test('the engine fails with a usable message when a key is missing', async () => {
  const promptFile = path.join(tmpdir(), 'prompt.md');
  fs.writeFileSync(promptFile, 'x');
  const { code, stdout } = await runEngine({
    CLUEDOC_API_KEY: '',
    CLUEDOC_MODEL: 'test-model',
    CLUEDOC_PROMPT_FILE: promptFile,
    CLUEDOC_SKILL_FILE: SKILL,
  });
  assert.equal(code, 1);
  assert.match(stdout, /::error::Cluedoc engine is misconfigured/);
  assert.match(stdout, /api_key/);
});

test('the engine surfaces a provider rejection and exits non-zero', async () => {
  const root = repo();
  const promptFile = path.join(tmpdir(), 'prompt.md');
  fs.writeFileSync(promptFile, 'x');

  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model not found: test-model' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { code, stdout } = await runEngine({
      CLUEDOC_API_KEY: 'k',
      CLUEDOC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      CLUEDOC_MODEL: 'test-model',
      CLUEDOC_WORKSPACE: root,
      CLUEDOC_PROMPT_FILE: promptFile,
      CLUEDOC_SKILL_FILE: SKILL,
    });
    assert.equal(code, 1);
    assert.match(stdout, /::error::Cluedoc engine failed/);
    assert.match(stdout, /model not found: test-model/);
  } finally {
    server.close();
  }
});

test('read_file does not count the trailing newline as a line', async () => {
  const root = tmpdir();
  write(root, 'three.txt', 'a\nb\nc\n');
  const { impl } = toolsFor(root);
  assert.match(await impl.read_file({ path: 'three.txt', offset: 2 }), /lines 2-3 of 3/);
});

test('edit_file points at write_file when the paper does not exist yet', async () => {
  const root = repo();
  const { impl } = toolsFor(root);
  await assert.rejects(
    () => impl.edit_file({ path: '.cluedoc/new/README.md', old_text: 'a', new_text: 'b' }),
    /does not exist; use write_file/
  );
});
