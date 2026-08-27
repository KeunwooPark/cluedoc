#!/usr/bin/env node
//
// Entry point. Reads its configuration from the environment, runs the skill
// against a repository, and leaves the result in the working tree — committing
// is the action's job, not this program's, which is what lets the same engine
// serve `push: true`, `push: false`, and the conflict rebase without knowing
// which one it is in.

import fs from 'node:fs';
import { loadConfig, ConfigError } from './config.mjs';
import { createTools } from './tools.mjs';
import { systemPrompt } from './prompt.mjs';
import { runAgent } from './loop.mjs';

function log(line) {
  process.stdout.write(`${line}\n`);
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n`);
  } catch {
    // A summary that cannot be written is not worth failing a run over.
  }
}

async function main() {
  const config = loadConfig();
  const written = new Set();
  const tools = createTools({
    root: config.workspace,
    writeScope: config.writeScope,
    onWrite: (rel) => written.add(rel),
  });

  log(`Cluedoc engine: ${config.model} via ${config.baseUrl}`);
  log('::group::Agent transcript');

  const started = Date.now();
  let result;
  try {
    result = await runAgent({
      config,
      tools,
      system: systemPrompt(config),
      prompt: config.prompt,
      log,
    });
  } finally {
    log('::endgroup::');
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const failures = result.calls.filter((c) => c.failed).length;

  log('');
  log(result.text.trim() || '(the agent finished without a summary)');
  log('');
  log(
    `Cluedoc engine: ${result.turns} turn(s), ${result.calls.length} tool call(s)` +
      `${failures ? ` (${failures} failed)` : ''}, ${written.size} file(s) written, ${seconds}s.`
  );

  if (result.usage.total || result.usage.prompt) {
    log(
      `Tokens: ${result.usage.prompt} in, ${result.usage.completion} out` +
        `${result.usage.total ? `, ${result.usage.total} total` : ''}.`
    );
  }

  summary([
    '<details><summary>Cluedoc engine</summary>',
    '',
    `\`${config.model}\` · ${result.turns} turn(s) · ${result.calls.length} tool call(s) · ${seconds}s`,
    ...(result.usage.total ? ['', `${result.usage.total} tokens.`] : []),
    '',
    '</details>',
  ]);
}

main().catch((err) => {
  // A configuration mistake is the caller's to fix and needs no stack; anything
  // else is ours, and the stack is the only thing that will locate it.
  if (err instanceof ConfigError) {
    log(`::error::Cluedoc engine is misconfigured — ${err.message}`);
  } else {
    log(`::error::Cluedoc engine failed — ${err.message}`);
    if (process.env.RUNNER_DEBUG === '1' && err.stack) log(err.stack);
  }
  process.exit(1);
});
