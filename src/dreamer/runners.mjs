import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CLI_PRESETS, findExecutable } from '../cli/hosts.mjs';
import { assertDreamerTrust, TAG_PATTERN } from '../config.mjs';
import { MEMORY_CATEGORIES } from '../memory-service.mjs';

const nonBlank = z.string().trim().min(1);
const memoryFields = {
  category: z.enum(MEMORY_CATEGORIES).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  reason: z.string().optional(),
};
const DreamOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('merge'),
    source_ids: z.array(nonBlank).min(2).refine((ids) => new Set(ids).size === ids.length, 'Duplicate merge source IDs'),
    content: nonBlank,
    ...memoryFields,
  }),
  z.strictObject({ type: z.literal('archive'), id: nonBlank, reason: nonBlank }),
  z.strictObject({ type: z.literal('update'), id: nonBlank, content: nonBlank.optional(), ...memoryFields })
    .refine(({ content, category, importance }) => [content, category, importance].some((value) => value !== undefined),
      'Update requires content, category, or importance'),
  z.strictObject({ type: z.literal('add'), content: nonBlank, ...memoryFields }),
  z.strictObject({
    type: z.literal('compact_note_comments'),
    note_id: nonBlank,
    source_comment_ids: z.array(nonBlank).min(3).refine((ids) => new Set(ids).size === ids.length, 'Duplicate source comment IDs'),
    summary: nonBlank,
  }),
]);
const tagName = z.string().regex(TAG_PATTERN);
const tagOperation = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('merge'), from_tag: tagName, to_tag: tagName, description: nonBlank.optional() }),
  z.strictObject({ type: z.literal('describe'), tag: tagName, description: nonBlank }),
]);
export const DreamPlanSchema = z.strictObject({
  summary: z.string(), operations: z.array(DreamOperationSchema), tag_operations: z.array(tagOperation).optional(),
});

export function validateDreamPlan(value) {
  const result = DreamPlanSchema.safeParse(value);
  if (result.success) return result.data;
  // Report field paths and codes without echoing model output.
  const issues = result.error.issues.map(({ path, code, message }) =>
    `${path.join('.') || 'plan'} (${code === 'custom' ? message : code})`);
  throw new Error('Dream plan failed validation: ' + issues.join(', '));
}

export function extractJsonPlan(rawText) {
  if (typeof rawText !== 'string') throw new Error('Dream plan must be JSON text');
  const text = rawText.trim();
  const fenced = /^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[^\S\r\n]*```$/i.exec(text);
  let value;
  try {
    value = JSON.parse(fenced?.[1] ?? text);
  } catch {
    throw new Error('Dream plan contains malformed JSON');
  }
  return validateDreamPlan(value);
}

const HTTP_NOTE_PROMPT_BYTE_BUDGET = 8 * 1024;

export function createHttpLlmRunner({
  baseUrl, model, apiKeyEnv, timeoutMs = 60_000, maxRetries = 2, retryDelayMs = 250,
  fetchImpl = globalThis.fetch, env = process.env,
} = {}) {
  const endpoint = URL.parse(baseUrl);
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Dreamer HTTP requires an HTTP(S) base URL without credentials');
  }
  if (!model?.trim()) throw new Error('Dreamer HTTP requires a model');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('Dreamer HTTP requires a nonnegative retry count');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
  endpoint.search = '';
  endpoint.hash = '';

  const run = async ({ systemPrompt, userPrompt }) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (apiKeyEnv !== undefined) {
      const key = Object.hasOwn(env, apiKeyEnv) ? env[apiKeyEnv] : undefined;
      if (!key?.trim()) throw new Error('Dreamer HTTP API key environment variable is unset or empty');
      try {
        headers.set('Authorization', 'Bearer ' + key);
      } catch {
        throw new Error('Dreamer HTTP API key is invalid as a bearer token');
      }
    }
    const body = JSON.stringify({
      model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    });
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint.href, { method: 'POST', headers, body, redirect: 'error', signal });
      } catch (error) {
        if (signal.aborted || error.name === 'TimeoutError') throw new Error('Dreamer HTTP request timed out');
        if (attempt === maxRetries || error.name === 'AbortError' || error.cause?.message === 'unexpected redirect') {
          throw new Error('Dreamer HTTP request failed');
        }
        await delay(retryDelayMs);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const transient = response.status === 429 || (response.status >= 500 && response.status <= 599);
        if (!transient || attempt === maxRetries) throw new Error(`Dreamer HTTP returned status ${response.status}`);
        await delay(retryDelayMs);
        continue;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (signal.aborted || error.name === 'TimeoutError') throw new Error('Dreamer HTTP response timed out');
        if (error instanceof SyntaxError) throw new Error('Dreamer HTTP response contains malformed JSON');
        if (attempt === maxRetries || error.name === 'AbortError') throw new Error('Dreamer HTTP response could not be read');
        await delay(retryDelayMs);
        continue;
      }
      const plan = extractJsonPlan(payload?.choices?.[0]?.message?.content);
      return { plan, runner: 'http', model };
    }
  };
  return Object.assign(run, { promptBudget: { noteLimit: HTTP_NOTE_PROMPT_BYTE_BUDGET, measure: Buffer.byteLength } });
}

const MAX_STDOUT_BYTES = 1024 * 1024;
const WINDOWS_COMMAND_LINE_BUDGET = 24_000;
const POSIX_ARG_BYTE_BUDGET = 96 * 1024;

// Quotes and backslashes can expand to twice their original UTF-16 length.
function windowsArgLength(arg) {
  return 2 * arg.length + 3; // Surrounding quotes and a separator (or terminator).
}

function redactUrl(url) {
  const safe = url.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/?#]*@/i, '$1[REDACTED]@');
  const query = safe.indexOf('?');
  const fragment = safe.indexOf('#');
  if (query < 0 || (fragment >= 0 && fragment < query)) return safe;
  const end = fragment < 0 ? safe.length : fragment;
  const params = safe.slice(query + 1, end).replace(/(^|&)([^&=]*=)[^&]*/g, '$1$2[REDACTED]');
  return safe.slice(0, query + 1) + params + safe.slice(end);
}

export function createDreamRedactor(env = process.env, apiKeyEnv) {
  const secrets = Object.entries(env)
    .filter(([name, value]) => typeof value === 'string' && value
      && (name === apiKeyEnv || /(?:token|secret|password|api[_-]?key|credential|auth[_-]?key)/i.test(name)))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    text = text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"`]+|(?<![a-z\d+.-]:)\/\/[^\s<>"`]+|(?<=^|[\s"'`(\[<=,:;])\/[^\s<>"`?]*\?[^\s<>"`]+/gi, (url, offset) => {
      if (text[offset - 1] === "'" && url.endsWith("'")) return redactUrl(url.slice(0, -1)) + "'";
      return redactUrl(url);
    });
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text
      .replace(/\b(Authorization["']?[ \t]*:[ \t]*["']?)[\w.-]+[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+)/gi, '$1[redacted]')
      .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/gi, '$1 [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/(?<![A-Za-z0-9?&])(api[_-]?key["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&,;]+)/gi, '$1[redacted]');
  };
}

export function sanitizeDreamError(message, env = process.env, apiKeyEnv) {
  return createDreamRedactor(env, apiKeyEnv)(String(message))
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

function restrictCodexArgs(args, restrictions) {
  const isolatedFlags = new Set([
    ...restrictions.filter((arg) => arg.startsWith('--')), '--full-auto', '--approve-for-me',
    '--dangerously-bypass-approvals-and-sandbox', '--trust', '--worktree',
  ]);
  const isolatedOptions = new Set([
    '--sandbox', '-s', '--profile', '-p', '--remote', '--remote-auth-token-env', '--cd', '-C', '--add-dir',
  ]);
  const remaining = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') throw new Error('cli:codex spawn-error');
    const [flag] = arg.split('=', 1);
    if (isolatedOptions.has(flag)) {
      if (arg === flag) i++;
      continue;
    }
    if (/^-[spC]./.test(arg)) continue;
    if (isolatedFlags.has(flag)) continue;
    if (arg === '--enable=shell_tool' || (arg === '--enable' && args[i + 1] === 'shell_tool')) {
      if (arg === '--enable') i++;
      continue;
    }

    const separateConfig = arg === '-c' || arg === '--config';
    const config = separateConfig ? args[i + 1]
      : arg.startsWith('--config=') ? arg.slice('--config='.length)
      : arg.startsWith('-c') ? arg.slice(2).replace(/^=/, '') : undefined;
    const key = config?.split('=', 1)[0].trim();
    // Replace protected config keys as a group before adding the canonical overrides.
    if (key === 'mcp_servers' || key?.startsWith('mcp_servers.')
      || key === 'features' || key === 'features.shell_tool') {
      if (separateConfig) i++;
      continue;
    }
    remaining.push(arg);
    if (separateConfig && i + 1 < args.length) remaining.push(args[++i]);
  }
  return [...remaining, ...restrictions];
}

export function createCliLlmRunner({
  orchestrator, command, args, model, timeoutMs = 120_000, spawnImpl = spawn, env = process.env,
} = {}) {
  if (!Object.hasOwn(CLI_PRESETS, orchestrator)) throw new Error('Dreamer CLI requires an omp, claude, or codex preset');
  const preset = CLI_PRESETS[orchestrator];
  const runner = 'cli:' + orchestrator;
  const failure = (stage, detail) => new Error(runner + ' ' + stage + (detail ? ' ' + detail : ''));
  const requestedCommand = command ?? preset.command;
  let executable;
  try {
    executable = spawnImpl === spawn
      ? findExecutable(requestedCommand, env, undefined, { forSpawn: true })
      : requestedCommand;
  } catch {
    // Report lookup failures through the same diagnostic as process startup failures.
  }
  let restrictedArgs = preset.args;
  if (args !== undefined && !isDeepStrictEqual(args, preset.args)) {
    restrictedArgs = orchestrator === 'codex'
      ? restrictCodexArgs(args, preset.restrictedArgs) : [...args, ...preset.restrictedArgs];
  }
  const baseArgs = [...restrictedArgs, ...(model ? ['--model', model] : []), ...(orchestrator === 'claude' ? ['--'] : [])];
  const fixedLength = baseArgs.reduce((length, arg) => length + windowsArgLength(arg), windowsArgLength(executable ?? ''));
  const promptBudget = process.platform === 'win32'
    ? { limit: Math.floor((WINDOWS_COMMAND_LINE_BUDGET - fixedLength - windowsArgLength('')) / 2), measure: (value) => value.length }
    : { limit: POSIX_ARG_BYTE_BUDGET, measure: (value) => Buffer.byteLength(value, 'utf8') };

  const run = async ({ systemPrompt, userPrompt }) => {
    const prompt = systemPrompt + '\n\n' + userPrompt;
    if (!executable || promptBudget.measure(prompt) > promptBudget.limit) throw failure('spawn-error');
    let cwd;
    try {
      let child;
      try {
        cwd = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'msm-dream-'));
        child = spawnImpl(executable, [...baseArgs, prompt], {
          shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env, cwd,
        });
      } catch {
        throw failure('spawn-error');
      }
      return await new Promise((resolve, reject) => {
        const stdout = [];
        let stdoutBytes = 0;
        let failedStage;
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        function stop(stage) {
          if (failedStage) return;
          failedStage = stage;
          child.stdout.destroy();
          try {
            child.kill('SIGKILL');
          } catch {
            // The process may have exited before the kill.
          }
        }
        child.once('error', () => { failedStage ??= 'spawn-error'; });
        child.stdout.on('error', () => stop('invalid-output'));
        child.stdout.on('data', (chunk) => {
          if (failedStage) return;
          const bytes = Buffer.from(chunk);
          stdoutBytes += bytes.length;
          if (stdoutBytes > MAX_STDOUT_BYTES) stop('invalid-output');
          else stdout.push(bytes);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (failedStage) reject(failure(failedStage));
          else if (signal || code !== 0) {
            reject(failure('process-exit', signal ?? (Number.isInteger(code) ? 'code ' + code : undefined)));
          } else {
            try {
              const plan = extractJsonPlan(Buffer.concat(stdout).toString('utf8'));
              resolve({ plan, runner, model: model ?? null });
            } catch {
              reject(failure('invalid-output'));
            }
          }
        });
      });
    } finally {
      if (cwd !== undefined) {
        try {
          fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
        } catch {
          throw failure('cleanup-error');
        }
      }
    }
  };
  return Object.assign(run, { promptBudget });
}

export function createDreamRunner(config, overrides = {}) {
  const { enabled, mode, http, cli } = config?.dreamer ?? {};
  const { userDreamer, userConfigPath, homeDir, ...runnerOptions } = overrides;
  const trust = { userDreamer, userConfigPath, homeDir, env: runnerOptions.env, cwd: runnerOptions.cwd };
  if (!enabled || mode === 'disabled') throw new Error('Dreamer is disabled');
  if (mode === 'http' && http) {
    const options = { ...http, ...runnerOptions };
    assertDreamerTrust({ mode, http: options }, trust);
    return createHttpLlmRunner(options);
  }
  if (mode === 'cli' && cli) {
    const options = { ...cli, ...runnerOptions };
    assertDreamerTrust({ mode, cli: options }, trust);
    return createCliLlmRunner(options);
  }
  throw new Error('Dreamer backend is misconfigured');
}
