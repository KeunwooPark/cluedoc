// Configuration arrives as environment variables because the alternative is a
// command line, and a command line puts the API key in the process table of a
// machine the caller does not own.

import fs from 'node:fs';

export class ConfigError extends Error {}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TURNS = 30;

function required(env, name, hint) {
  const value = (env[name] ?? '').trim();
  if (!value) throw new ConfigError(`${name} is not set${hint ? ` — ${hint}` : ''}`);
  return value;
}

function readFileArg(env, name, hint) {
  const p = required(env, name, hint);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new ConfigError(`${name} points at '${p}', which could not be read: ${e.message}`);
  }
}

function positiveInt(env, name, fallback) {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got '${raw}'`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  const baseUrl = (env.CLUEDOC_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError(`CLUEDOC_BASE_URL must start with http:// or https://, got '${baseUrl}'`);
  }

  const temperatureRaw = (env.CLUEDOC_TEMPERATURE ?? '').trim();
  if (temperatureRaw && !Number.isFinite(Number(temperatureRaw))) {
    throw new ConfigError(`CLUEDOC_TEMPERATURE must be a number, got '${temperatureRaw}'`);
  }

  return {
    baseUrl,
    apiKey: required(env, 'CLUEDOC_API_KEY', "set the action's `api_key` input"),
    model: required(env, 'CLUEDOC_MODEL', "set the action's `model` input"),
    workspace: (env.CLUEDOC_WORKSPACE ?? '').trim() || process.cwd(),
    // An unset scope and an empty one mean different things: unset is the
    // ordinary papers-only run, empty is `bootstrap: full` deliberately opening
    // the tree. `CLUEDOC_WRITE_SCOPE=` in the step's env is how you say empty.
    writeScope: 'CLUEDOC_WRITE_SCOPE' in env ? env.CLUEDOC_WRITE_SCOPE.trim() : '.cluedoc',
    maxTurns: positiveInt(env, 'CLUEDOC_MAX_TURNS', DEFAULT_MAX_TURNS),
    maxTokens: positiveInt(env, 'CLUEDOC_MAX_TOKENS', 0),
    temperature: temperatureRaw === '' ? undefined : Number(temperatureRaw),
    prompt: readFileArg(env, 'CLUEDOC_PROMPT_FILE', 'the action writes this'),
    skill: readFileArg(env, 'CLUEDOC_SKILL_FILE', 'the action writes this'),
  };
}
