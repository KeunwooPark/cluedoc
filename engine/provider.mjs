// One POST to /chat/completions, retried.
//
// The OpenAI chat-completions shape is the one thing every gateway agrees on —
// Faucet, OpenRouter, LiteLLM, vLLM, Together, and Anthropic's own
// compatibility endpoint all accept this request — so speaking it directly, with
// no SDK, is what makes the engine provider-agnostic rather than portable in
// principle. It also means no `npm install` step at the top of every run.

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export class ProviderError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export function endpointFor(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new ProviderError('base_url is empty');
  // A caller who already wrote the full path meant it. Anything else gets the
  // path appended, which is what "base URL" means everywhere else.
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function delayFor(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return backoff / 2 + Math.random() * (backoff / 2);
}

// A gateway that is misconfigured, asleep, or behind a login page answers with
// HTML, and `JSON.parse` fails on it with a message about character 0 that tells
// nobody anything. Say what actually came back instead.
async function parseBody(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function describe(status, json, text) {
  const message =
    json?.error?.message ||
    json?.message ||
    json?.error ||
    text.slice(0, 400).replace(/\s+/g, ' ').trim();
  return `${status}: ${message || '(empty response body)'}`;
}

export async function complete({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  maxTokens,
  temperature,
  timeoutMs = 300_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = globalThis.fetch,
  onRetry = () => {},
}) {
  const url = endpointFor(baseUrl);
  const body = { model, messages };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // Sent only when asked for. Newer models reject an explicit `max_tokens`, and
  // several reject any `temperature` but their default — so an unrequested
  // parameter is a 400 waiting to happen on a provider we have never seen.
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature !== undefined && temperature !== null && temperature !== '') {
    body.temperature = Number(temperature);
  }

  let last;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const ms = delayFor(attempt - 1, last?.retryAfter);
      onRetry({ attempt, delayMs: ms, reason: last?.message });
      await sleep(ms);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // Network failures and timeouts are the retryable case that never
      // reaches a status code.
      last = { message: `request failed: ${e.message}`, retryAfter: null };
      continue;
    } finally {
      clearTimeout(timer);
    }

    const { json, text } = await parseBody(res);

    if (!res.ok) {
      const message = describe(res.status, json, text);
      if (RETRY_STATUS.has(res.status)) {
        last = { message, retryAfter: res.headers.get('retry-after') };
        continue;
      }
      throw new ProviderError(message, { status: res.status });
    }

    if (!json) {
      last = { message: `${res.status}: response was not JSON: ${text.slice(0, 200)}`, retryAfter: null };
      continue;
    }
    const choice = json.choices?.[0];
    if (!choice) {
      throw new ProviderError(
        `provider returned no choices: ${JSON.stringify(json).slice(0, 400)}`,
        { status: res.status }
      );
    }
    return { message: choice.message ?? {}, finishReason: choice.finish_reason, usage: json.usage };
  }

  throw new ProviderError(
    `giving up after ${MAX_ATTEMPTS} attempts — last error was ${last?.message}`,
    { retryable: true }
  );
}
