// The agent loop: ask, run whatever tools came back, ask again.
//
// A tool that fails returns its error to the model rather than ending the run.
// A bad path or a stale `old_text` is a thing the model can see and correct, and
// a documentation sync that dies on the first mistyped filename is worse than
// one that takes an extra turn.

import { complete } from './provider.mjs';

export class LoopError extends Error {}

function toolCallsOf(message) {
  const calls = message?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function summarizeArgs(args) {
  const parts = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === '' || v === false) continue;
    const shown = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${shown.length > 60 ? `${shown.slice(0, 57)}…` : shown}`);
  }
  return parts.join(' ');
}

export async function runAgent({
  config,
  tools,
  system,
  prompt,
  log = () => {},
  complete: completeImpl = complete,
}) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];
  const usage = { prompt: 0, completion: 0, total: 0 };
  const calls = [];

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    const { message, finishReason, usage: turnUsage } = await completeImpl({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      tools: tools.schemas,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      onRetry: ({ attempt, delayMs, reason }) =>
        log(`  retrying (${attempt}/4) in ${Math.round(delayMs / 1000)}s — ${reason}`),
    });

    if (turnUsage) {
      usage.prompt += turnUsage.prompt_tokens ?? 0;
      usage.completion += turnUsage.completion_tokens ?? 0;
      usage.total += turnUsage.total_tokens ?? 0;
    }

    const toolCalls = toolCallsOf(message);

    // Providers disagree about `content` alongside tool calls — null, absent,
    // or a string. Normalised here so the next request is one shape.
    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (!toolCalls.length) {
      if (finishReason === 'length') {
        log('::warning::The model stopped because it hit its output limit. Raise max_tokens.');
      }
      return { text: message.content ?? '', turns: turn, usage, calls };
    }

    for (const call of toolCalls) {
      const name = call.function?.name ?? '(unnamed)';
      // Some gateways omit the id. Without one, results cannot be matched to
      // calls and the next request is rejected as malformed.
      const id = call.id || `call_${turn}_${calls.length}`;
      let args = {};
      let result;
      let failed = false;

      try {
        const raw = call.function?.arguments;
        args = raw ? JSON.parse(raw) : {};
      } catch (e) {
        failed = true;
        result = `Error: arguments were not valid JSON (${e.message}). Send them again as a JSON object.`;
      }

      if (!failed) {
        const fn = tools.impl[name];
        if (!fn) {
          failed = true;
          result = `Error: no tool named '${name}'. Available: ${Object.keys(tools.impl).join(', ')}.`;
        } else {
          try {
            result = await fn(args);
          } catch (e) {
            failed = true;
            result = `Error: ${e.message}`;
          }
        }
      }

      calls.push({ name, args, failed });
      log(`  ${failed ? '✗' : '·'} ${name} ${summarizeArgs(args)}`);
      messages.push({ role: 'tool', tool_call_id: id, name, content: String(result) });
    }
  }

  throw new LoopError(
    `the agent did not finish within ${config.maxTurns} turns. Raise max_turns, or narrow the scope it was given.`
  );
}
