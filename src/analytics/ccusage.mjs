import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const CACHE_MS = 60_000;
const TIMEOUT_MS = 4_000;
const cache = new WeakMap();

export function nonnegative(value, integer = false) {
  return Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
}

export function normalizeUsage(usage, cost) {
  return {
    inputTokens: nonnegative(usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens, true),
    outputTokens: nonnegative(usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens, true),
    cacheReadTokens: nonnegative(usage?.cacheReadTokens ?? usage?.cache_read_input_tokens ?? usage?.cached_input_tokens ?? usage?.cachedInputTokens, true),
    cacheCreationTokens: nonnegative(usage?.cacheCreationTokens ?? usage?.cache_creation_input_tokens, true),
    costUsd: nonnegative(cost ?? usage?.costUsd ?? usage?.totalCost ?? usage?.total_cost_usd ?? usage?.costUSD ?? usage?.cost_usd ?? usage?.cost),
  };
}

const CODEX_ROLLOUT_ID = /(?:^|[\\/])rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i;

async function bundledRunner(args, options) {
  // Execute ccusage's installed native CLI directly so the timeout owns the process.
  const fromCcusage = createRequire(require.resolve('ccusage/package.json'));
  const binary = fromCcusage.resolve(`@ccusage/ccusage-${process.platform}-${process.arch}/bin/ccusage${process.platform === 'win32' ? '.exe' : ''}`);
  const { stdout } = await exec(binary, args, options);
  return stdout;
}

export function readCcusage({ runner = bundledRunner, since, until } = {}) {
  let entries = cache.get(runner);
  if (!entries) cache.set(runner, entries = new Map());
  const key = JSON.stringify([since, until]);
  const now = Date.now();
  const cached = entries.get(key);
  if (cached?.expiresAt > now) return cached.result;
  for (const [entry, value] of entries) {
    if (value.expiresAt <= now) entries.delete(entry);
  }
  if (entries.size >= 16) entries.delete(entries.keys().next().value);
  const result = (async () => {
    const args = ['session', '--json', '--offline', '--timezone', 'UTC', '--no-color'];
    if (since) args.push('--since', since);
    if (until) args.push('--until', until);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const output = await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        Promise.resolve().then(() => runner(args, {
          signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
          env: { ...process.env, DO_NOT_TRACK: '1', CCUSAGE_TELEMETRY_DISABLED: '1' },
        })).then(resolve, reject);
      });
      const raw = output?.stdout ?? output;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const rows = parsed?.sessions ?? parsed?.session ?? parsed;
      if (!Array.isArray(rows)) throw new Error('Unexpected session report');
      const sessions = new Map();
      for (const row of rows) {
        const id = row?.sessionId ?? row?.session_id ?? row?.id ?? row?.period;
        if (typeof id !== 'string' || !id.trim()) continue;
        const sessionId = row.agent === 'codex' ? CODEX_ROLLOUT_ID.exec(id)?.[1] ?? id : id;
        const usage = normalizeUsage(row);
        if (Object.values(usage).every((value) => value === null)) continue;
        // Ambiguous IDs across multiple local providers cannot be joined safely.
        sessions.set(sessionId, sessions.has(sessionId) ? null : usage);
      }
      for (const [id, usage] of sessions) if (!usage) sessions.delete(id);
      if (!sessions.size) return { available: false, reason: 'No local ccusage session data in the selected window' };
      return { available: true, sessions };
    } catch {
      return { available: false, reason: 'Local ccusage session data could not be read' };
    }
  })();
  entries.set(key, { expiresAt: now + CACHE_MS, result });
  return result;
}

