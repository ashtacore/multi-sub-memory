import { createHmac, randomBytes } from 'node:crypto';
import { assertDreamerTrust, loadConfig, readConfigLayer, resolveUserConfigPath } from '../config.mjs';
import { runDream } from '../dreamer/engine.mjs';
import { createDreamRedactor, sanitizeDreamError } from '../dreamer/runners.mjs';
import {
  GLOBAL_PROJECT_KEY, MAX_LIST_LIMIT, MEMORY_CATEGORIES, MEMORY_SCOPES, MEMORY_STATUSES, NOTE_STATUSES,
  StaleRecordError, updateMemory, updateNote,
} from '../memory-service.mjs';
import { hybridSearch } from '../search.mjs';

const all = 'all';
const globalKey = GLOBAL_PROJECT_KEY;
const bodyLimit = 256 * 1024;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  if (Number(req.headers['content-length']) > bodyLimit) {
    req.resume();
    throw new RequestError(413, 'JSON body exceeds 256 KiB');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bodyLimit) {
      req.resume();
      throw new RequestError(413, 'JSON body exceeds 256 KiB');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'Expected a JSON object');
  }
  return body;
}

function validate(fields, rules) {
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(rules, key)) throw new RequestError(400, 'Unexpected field');
    if (!rules[key](fields[key])) throw new RequestError(400, 'Invalid field: ' + key);
  }
  return fields;
}

const nonblank = (value) => typeof value === 'string' && Boolean(value.trim());
const oneOf = (values) => (value) => values.includes(value);
const importance = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
const memoryRules = {
  content: nonblank, category: oneOf(MEMORY_CATEGORIES), importance, status: oneOf(MEMORY_STATUSES), expected_updated_at: nonblank,
};
const noteRules = {
  content: nonblank, status: oneOf(NOTE_STATUSES), expected_updated_at: nonblank,
  surface_condition: (value) => value === null || typeof value === 'string',
};

function choice(params, name, values, fallback) {
  const value = params.get(name);
  if (!value) return fallback;
  if (!values.includes(value)) throw new RequestError(400, 'Invalid ' + name);
  return value;
}

function listLimit(params) {
  const value = params.get('limit');
  if (value === null) return 100;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new RequestError(400, 'Invalid limit');
  return Math.min(Number(value), MAX_LIST_LIMIT);
}

function projectFilter(params) {
  const value = params.get('project_key');
  return value && value !== all ? value : undefined;
}

function counts(statuses) {
  return Object.fromEntries([...statuses, 'total'].map((key) => [key, 0]));
}

function emptyCounts() {
  return { memories: counts(MEMORY_STATUSES), notes: counts(NOTE_STATUSES), transcripts: { files: 0, messages: 0 } };
}

function overview({ db, defaultProjectKey, config, embeddingEngine }) {
  const projects = new Map();
  const global = emptyCounts();
  const totals = emptyCounts();
  function projectCounts(key) {
    if (key === globalKey) return global;
    if (!projects.has(key)) projects.set(key, { project_key: key, ...emptyCounts() });
    return projects.get(key);
  }
  if (defaultProjectKey) projectCounts(defaultProjectKey);
  for (const table of ['memories', 'notes']) {
    for (const { project_key, status, count } of db.prepare(
      'SELECT project_key, status, COUNT(*) AS count FROM ' + table + ' GROUP BY project_key, status',
    ).all()) {
      const project = projectCounts(project_key)[table];
      project[status] = count;
      project.total += count;
      totals[table][status] += count;
      totals[table].total += count;
    }
  }
  const transcriptCounts = db.prepare(`
    SELECT project_key, COUNT(*) AS files,
      SUM((SELECT COUNT(*) FROM transcript_messages WHERE file_id = f.id)) AS messages
    FROM transcript_files f GROUP BY project_key
  `).all();
  for (const { project_key, files, messages } of transcriptCounts) {
    projectCounts(project_key).transcripts = { files, messages };
    totals.transcripts.files += files;
    totals.transcripts.messages += messages;
  }
  for (const { project_key } of db.prepare('SELECT DISTINCT project_key FROM dream_runs').all()) {
    projectCounts(project_key);
  }
  let engineStatus;
  try {
    engineStatus = embeddingEngine?.getStatus?.();
  } catch {
    // Health remains available when the optional engine cannot report status.
  }
  const enabled = engineStatus?.enabled ?? config.embedding?.enabled ?? false;
  return {
    projects: [...projects.values()].sort((a, b) => a.project_key.localeCompare(b.project_key)),
    global: { memories: global.memories, notes: global.notes },
    totals,
    default_project_key: defaultProjectKey,
    embedding: {
      enabled,
      model: engineStatus?.model ?? config.embedding?.model ?? null,
      status: !enabled ? 'disabled' : engineStatus?.available ? 'onnx' : engineStatus?.reason ? 'fts-only' : 'uninitialized',
    },
    db: {
      ok: true,
      schema_version: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    },
  };
}

function rowFilter(fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  return {
    where: entries.length ? ' WHERE ' + entries.map(([column]) => column + ' = ?').join(' AND ') : '',
    values: entries.map(([, value]) => value),
  };
}

async function memories({ db, embeddingEngine, cwd }, params) {
  const scope = choice(params, 'scope', [...MEMORY_SCOPES, all], all);
  const status = choice(params, 'status', [...MEMORY_STATUSES, all], 'active');
  const category = choice(params, 'category', [...MEMORY_CATEGORIES, all], all);
  const projectKey = projectFilter(params);
  const fields = {
    project_key: projectKey,
    scope: scope === all ? undefined : scope,
    category: category === all ? undefined : category,
    status: status === all ? undefined : status,
  };
  const { where, values } = rowFilter(fields);
  const limit = listLimit(params);
  const query = params.get('q')?.trim();
  if (!query) {
    return {
      mode: 'list',
      memories: db.prepare('SELECT * FROM memories' + where
        + ' ORDER BY importance DESC, updated_at DESC, id ASC LIMIT ?').all(...values, limit),
    };
  }
  const { mode, results } = await hybridSearch(db, {
    query, sources: ['memory'], scope: 'all_projects', projectKey, cwd, defaultCwd: cwd, embeddingEngine, limit,
    memoryFilters: { projectKey, scope: fields.scope, category: fields.category, status: fields.status },
  });
  const find = db.prepare('SELECT * FROM memories WHERE id = ?');
  return { mode, memories: results.map(({ id }) => find.get(id)).filter(Boolean) };
}

function noteCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') === value) {
      const decoded = bytes.toString('utf8');
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed) && parsed.length === 2 && Number.isSafeInteger(parsed[0])
        && nonblank(parsed[1]) && !parsed[1].includes('\0') && JSON.stringify(parsed) === decoded
        && Buffer.from(decoded).equals(bytes)) return parsed;
    }
  } catch {
    // Invalid encoding or JSON.
  }
  throw new RequestError(400, 'Invalid cursor');
}

function notes({ db }, params) {
  const status = choice(params, 'status', [...NOTE_STATUSES, all], all);
  const { where, values } = rowFilter({
    project_key: projectFilter(params), status: status === all ? undefined : status,
  });
  const cursors = params.getAll('cursor');
  if (cursors.length > 1) throw new RequestError(400, 'Invalid cursor');
  const cursor = noteCursor(cursors[0] ?? null);
  const limit = listLimit(params);
  const boundary = cursor ? (where ? ' AND ' : ' WHERE ') + '(updated_at < ? OR (updated_at = ? AND id < ?))' : '';
  if (cursor) {
    const [updatedAt, id] = cursor;
    values.push(updatedAt, updatedAt, id);
  }
  const rows = db.prepare('SELECT * FROM notes' + where + boundary + ' ORDER BY updated_at DESC, id DESC LIMIT ?')
    .all(...values, limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    notes: rows,
    next_cursor: hasMore ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString('base64url') : null,
  };
}

async function changeRecord({ db, config, embeddingEngine }, req, table, id) {
  const noun = table === 'memories' ? 'Memory' : 'Note';
  if (req.method === 'DELETE') {
    if (!db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id).changes) {
      throw new RequestError(404, noun + ' not found');
    }
    return { deleted: true, id };
  }
  const { expected_updated_at: expectedUpdatedAt, ...body } = validate(
    await readBody(req), table === 'memories' ? memoryRules : noteRules,
  );
  if (table === 'memories' && body.status === 'superseded') {
    throw new RequestError(400, 'Memories cannot be marked superseded manually.');
  }
  try {
    if (table === 'memories') {
      const memory = await updateMemory(db, { ...body, id }, {
        embeddingEngine, embeddingModel: config.embedding?.model, rawRow: true, expectedUpdatedAt,
      });
      return { memory };
    }
    return { note: updateNote(db, { ...body, id }, { expectedUpdatedAt }) };
  } catch (error) {
    if (error instanceof StaleRecordError) throw new RequestError(409, error.message);
    if (error.message.startsWith(noun + ' not found:')) throw new RequestError(404, noun + ' not found');
    if (error.message.startsWith('Memory update conflicts with existing content')) {
      throw new RequestError(409, 'A memory with this content already exists in the project and scope');
    }
    throw error;
  }
}

function dreamRedactor(env, apiKeyEnv) {
  const redactText = createDreamRedactor(env, apiKeyEnv);
  function redact(value) {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redact(field)]));
    }
    return value;
  }
  return redact;
}

function effectiveDreamer(context) {
  const { cwd, configOptions, env } = context;
  const userConfigPath = resolveUserConfigPath(configOptions);
  const userConfigData = readConfigLayer(userConfigPath);
  const config = loadConfig({ cwd, ...configOptions, userConfigPath, userConfigData });
  config.dbPath = context.config.dbPath;
  const userDreamer = userConfigData.dreamer ?? null;
  const { enabled, mode, http, cli } = config.dreamer;
  let authorized = false;
  if (enabled && (mode === 'http' || mode === 'cli')) {
    try {
      assertDreamerTrust(config.dreamer, { userDreamer });
      authorized = true;
    } catch {
      // Execution independently enforces trust and records a sanitized failure.
    }
  }
  const endpoint = mode === 'http' ? URL.parse(http?.baseUrl) : null;
  const keyConfigured = Boolean(http?.apiKeyEnv && env[http.apiKeyEnv]?.trim());
  let runnerIdentity = null;
  if (mode === 'http') {
    // The HTTP runner sends requests using only the origin and normalized path.
    const target = endpoint && endpoint.origin + endpoint.pathname.replace(/\/+$/, '');
    runnerIdentity = [target, http?.model, http?.apiKeyEnv, keyConfigured];
  } else if (mode === 'cli') {
    runnerIdentity = [cli?.orchestrator, cli?.command, cli?.args, cli?.model];
  }
  const redactDream = dreamRedactor(env, http?.apiKeyEnv);
  // CLI arguments can contain credentials. Key the digest per launch so the
  // public fingerprint cannot be used to test guesses about their values.
  const fingerprint = createHmac('sha256', context.fingerprintKey).update(JSON.stringify([
    enabled, mode, authorized, runnerIdentity,
  ])).digest('hex');
  return { config, userDreamer, authorized, fingerprint, endpoint, keyConfigured, redactDream };
}

function dreamer(context, params) {
  const { db, defaultProjectKey, env } = context;
  const { config, authorized, fingerprint, endpoint, keyConfigured, redactDream } = effectiveDreamer(context);
  const { enabled = false, mode = 'disabled', cadence = {}, http, cli } = config.dreamer ?? {};
  const runner = mode === 'http' || mode === 'cli' ? config.dreamer[mode] : undefined;
  const { where, values } = rowFilter({ project_key: projectFilter(params) });
  const activeLeases = db.prepare(`
    SELECT lease_key, substr(lease_key, 7) AS project_key, owner, acquired_at, expires_at
      FROM leases WHERE lease_key LIKE 'dream:%' AND expires_at > ? ORDER BY acquired_at DESC
  `).all(Date.now());
  const runs = db.prepare('SELECT * FROM dream_runs' + where + ' ORDER BY started_at DESC, id ASC LIMIT 50')
    .all(...values).map((run) => ({
      ...run,
      error: run.error === null ? null : sanitizeDreamError(run.error, env, http?.apiKeyEnv),
    }));
  const details = redactDream({
    active_leases: activeLeases,
    config: {
      enabled: enabled && mode !== 'disabled',
      authorized,
      mode,
      cadence: cadence.mode ?? 'manual',
      interval_hours: cadence.minIntervalHours ?? 24,
      min_new_memories: cadence.minNewMemories ?? 10,
      runner: {
        type: runner ? mode : null,
        model: runner?.model ?? null,
        endpoint_host: endpoint?.host || null,
        executable: mode === 'cli' && cli ? cli.command ?? cli.orchestrator : null,
        api_key_configured: mode === 'http' && keyConfigured,
      },
    },
    runs,
  });
  details.config.config_fingerprint = fingerprint;
  return { runnable_project_key: defaultProjectKey, ...details };
}

async function startDream(context, req) {
  const { db, cwd, defaultProjectKey, embeddingEngine, configOptions } = context;
  const body = validate(await readBody(req), {
    project_key: (key) => nonblank(key) && key.trim() === key,
    dry_run: (value) => typeof value === 'boolean',
    expected_config_fingerprint: (value) => typeof value === 'string',
  });
  if (!body.project_key) throw new RequestError(400, 'A project key is required');
  if (body.project_key !== defaultProjectKey) {
    throw new RequestError(400, 'Dreamer can only run for the workspace this dashboard was launched in');
  }
  const { config, userDreamer, fingerprint, redactDream } = effectiveDreamer(context);
  if (body.expected_config_fingerprint !== undefined && body.expected_config_fingerprint !== fingerprint) {
    throw new RequestError(409, 'Dreamer configuration changed; refresh before running.');
  }
  return redactDream(await runDream({
    db, config, projectKey: defaultProjectKey, cwd, embeddingEngine, dryRun: Boolean(body.dry_run),
    ...configOptions, userDreamer,
  }));
}

export function createApi(context) {
  context = { ...context, fingerprintKey: randomBytes(32) };
  return async function api(req, pathname, params) {
    if (req.method === 'GET') {
      if (pathname === '/api/overview') return overview(context);
      if (pathname === '/api/memories') return memories(context, params);
      if (pathname === '/api/notes') return notes(context, params);
      if (pathname === '/api/dreamer') return dreamer(context, params);
    }
    const record = /^\/api\/(memories|notes)\/([^/]+)$/.exec(pathname);
    if (record && ['PATCH', 'DELETE'].includes(req.method)) {
      return changeRecord(context, req, record[1], record[2]);
    }
    if (pathname === '/api/dreamer/run' && req.method === 'POST') return startDream(context, req);
    throw new RequestError(404, 'Not found');
  };
}
