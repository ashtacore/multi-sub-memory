import { createHmac, randomBytes } from 'node:crypto';
import { loadWorkspaceConfig } from '../config.mjs';
import { runDream } from '../dreamer/engine.mjs';
import { createDreamRedactor, sanitizeDreamError } from '../dreamer/runners.mjs';
import {
  GLOBAL_PROJECT_KEY, MAX_LIST_LIMIT, MEMORY_CATEGORIES, MEMORY_SCOPES, MEMORY_STATUSES, NOTE_STATUSES,
  MissingProjectDestinationError,
  NOTE_COMMENT_PREVIEW_LENGTH, NoteValidationError, SameNoteStatusError, StaleRecordError, addNoteComment,
  decodeNoteCursor, deleteNote, deleteNoteComment, encodeNoteCursor, listNoteComments,
  updateMemory, updateNote, updateNoteComment,
} from '../memory-service.mjs';
import { formatProjectLabels } from '../project-id.mjs';
import { hybridSearch } from '../search.mjs';

const all = 'all';
const globalKey = GLOBAL_PROJECT_KEY;
const bodyLimit = 256 * 1024;
const SORT_ORDERS = ['desc', 'asc'];
const MEMORY_SORTS = ['importance', 'created_at', 'updated_at'];
const NOTE_SORTS = ['updated_at', 'created_at'];
const DREAM_STATUSES = ['completed', 'dry-run', 'failed', 'running'];
const DREAM_SORTS = ['started_at', 'finished_at', 'duration'];

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
  content: nonblank, category: oneOf(MEMORY_CATEGORIES), importance, status: oneOf(MEMORY_STATUSES),
  scope: oneOf(MEMORY_SCOPES), project_key: (value) => nonblank(value) && value.trim() === value,
  expected_updated_at: nonblank,
};
const noteRules = {
  content: nonblank, status: oneOf(NOTE_STATUSES), expected_updated_at: nonblank,
  surface_condition: (value) => value === null || typeof value === 'string',
  comment: (value) => typeof value === 'string',
};
const commentRules = { body: nonblank, expected_updated_at: nonblank };

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

function knownProjectRoots(db, defaultProjectKey, defaultProjectRoot) {
  const roots = new Map();
  if (defaultProjectKey && defaultProjectRoot) roots.set(defaultProjectKey, defaultProjectRoot);
  for (const { project_key, project_root } of db.prepare(
    'SELECT project_key, project_root FROM transcript_files WHERE project_root IS NOT NULL ORDER BY last_indexed_at DESC, id DESC',
  ).all()) {
    if (!roots.has(project_key)) roots.set(project_key, project_root);
  }
  const hasProjectsTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'projects'").get();
  if (hasProjectsTable) {
    for (const { project_key, project_root } of db.prepare('SELECT project_key, project_root FROM projects').all()) {
      roots.set(project_key, project_root);
    }
  }
  return roots;
}

function knownProjectCatalog(db, defaultProjectKey, defaultProjectRoot, extraKeys = []) {
  const roots = knownProjectRoots(db, defaultProjectKey, defaultProjectRoot);
  const keys = new Set(roots.keys());
  if (defaultProjectKey && defaultProjectKey !== globalKey) keys.add(defaultProjectKey);
  for (const table of ['memories', 'notes', 'dream_runs', 'transcript_files']) {
    for (const { project_key } of db.prepare('SELECT DISTINCT project_key FROM ' + table).all()) {
      if (project_key && project_key !== globalKey) keys.add(project_key);
    }
  }
  for (const key of extraKeys) {
    if (key && key !== globalKey) keys.add(key);
  }
  const labels = formatProjectLabels([...keys].map((projectKey) => ({
    projectKey,
    projectRoot: roots.get(projectKey),
  })));
  return { roots, labels };
}

function attachMemoryProject(row, { roots, labels }) {
  if (row.project_key === globalKey) {
    return { ...row, project_name: 'Global', project_root: null };
  }
  return {
    ...row,
    project_name: labels.get(row.project_key) ?? row.project_key,
    project_root: roots.get(row.project_key) ?? null,
  };
}

function overview({ db, defaultProjectKey, defaultProjectRoot, config, embeddingEngine }) {
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
  const roots = knownProjectRoots(db, defaultProjectKey, defaultProjectRoot);
  for (const key of roots.keys()) {
    if (key !== globalKey) projectCounts(key);
  }
  const labels = formatProjectLabels([...projects.keys()].map((projectKey) => ({
    projectKey,
    projectRoot: roots.get(projectKey),
  })));
  const projectList = [...projects.values()].map((project) => ({
    ...project,
    display_name: labels.get(project.project_key) ?? project.project_key,
  })).sort((a, b) => a.display_name.localeCompare(b.display_name) || a.project_key.localeCompare(b.project_key));
  let engineStatus;
  try {
    engineStatus = embeddingEngine?.getStatus?.();
  } catch {
    // Health remains available when the optional engine cannot report status.
  }
  const enabled = engineStatus?.enabled ?? config.embedding?.enabled ?? false;
  return {
    projects: projectList,
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

async function memories({ db, defaultProjectKey, defaultProjectRoot, embeddingEngine, cwd }, params) {
  const scope = choice(params, 'scope', [...MEMORY_SCOPES, all], all);
  const status = choice(params, 'status', [...MEMORY_STATUSES, all], 'active');
  const category = choice(params, 'category', [...MEMORY_CATEGORIES, all], all);
  const sort = choice(params, 'sort', MEMORY_SORTS, 'importance');
  const order = choice(params, 'order', SORT_ORDERS, 'desc');
  const direction = order.toUpperCase();
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
  const catalog = knownProjectCatalog(db, defaultProjectKey, defaultProjectRoot);
  if (!query) {
    const orderBy = sort === 'importance'
      ? `importance ${direction}, updated_at DESC, id ASC`
      : `${sort} ${direction}, id ${direction}`;
    const rows = db.prepare('SELECT * FROM memories' + where + ' ORDER BY ' + orderBy + ' LIMIT ?').all(...values, limit);
    return {
      mode: 'list',
      memories: rows.map((row) => attachMemoryProject(row, catalog)),
    };
  }
  const { mode, results } = await hybridSearch(db, {
    query, sources: ['memory'], scope: 'all_projects', projectKey, cwd, defaultCwd: cwd, embeddingEngine, limit,
    memoryFilters: { projectKey, scope: fields.scope, category: fields.category, status: fields.status },
  });
  const find = db.prepare('SELECT * FROM memories WHERE id = ?');
  return {
    mode,
    memories: results.map(({ id }) => find.get(id)).filter(Boolean).map((row) => attachMemoryProject(row, catalog)),
  };
}

function cursorParam(params) {
  const cursors = params.getAll('cursor');
  if (cursors.length > 1) throw new RequestError(400, 'Invalid cursor');
  return cursors[0];
}

function noteRequestError(error) {
  if (error instanceof SameNoteStatusError && !error.fieldsMatch) return new RequestError(409, error.message);
  if (error instanceof NoteValidationError) return new RequestError(400, error.message);
  if (error instanceof StaleRecordError) return new RequestError(409, error.message);
  if (/^Note(?: comment)? not found:/.test(error.message)) return new RequestError(404, error.message);
  return error;
}

function notes({ db }, params) {
  const status = choice(params, 'status', [...NOTE_STATUSES, all], all);
  const sort = choice(params, 'sort', NOTE_SORTS, 'updated_at');
  const order = choice(params, 'order', SORT_ORDERS, 'desc');
  const direction = order.toUpperCase();
  const cmp = order === 'asc' ? '>' : '<';
  const { where, values } = rowFilter({
    project_key: projectFilter(params), status: status === all ? undefined : status,
  });
  let cursor;
  try {
    cursor = decodeNoteCursor(cursorParam(params));
  } catch (error) {
    throw noteRequestError(error);
  }
  const limit = listLimit(params);
  const boundary = cursor ? (where ? ' AND ' : ' WHERE ') + `(${sort} ${cmp} ? OR (${sort} = ? AND id ${cmp} ?))` : '';
  if (cursor) {
    const [timestamp, id] = cursor;
    values.push(timestamp, timestamp, id);
  }
  const rows = db.prepare(`
    SELECT notes.*,
      (SELECT COUNT(*) FROM note_comments WHERE note_id = notes.id) AS comment_count,
      (SELECT substr(body, 1, ?) FROM note_comments WHERE note_id = notes.id
        ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_comment_preview
    FROM notes${where}${boundary} ORDER BY ${sort} ${direction}, id ${direction} LIMIT ?
  `).all(NOTE_COMMENT_PREVIEW_LENGTH + 1, ...values, limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    notes: rows.map((row) => {
      const chars = Array.from(row.latest_comment_preview ?? '');
      if (chars.length > NOTE_COMMENT_PREVIEW_LENGTH) {
        row.latest_comment_preview = chars.slice(0, NOTE_COMMENT_PREVIEW_LENGTH).join('') + '…';
      }
      return row;
    }),
    next_cursor: hasMore ? encodeNoteCursor(last[sort], last.id) : null,
  };
}

function deleteRevision(params) {
  const revisions = params.getAll('expected_updated_at');
  if (revisions.length > 1 || (revisions.length === 1 && !nonblank(revisions[0]))) {
    throw new RequestError(400, 'Invalid field: expected_updated_at');
  }
  return revisions[0];
}

async function noteComments({ db }, req, params, noteId, commentId) {
  try {
    if (req.method === 'GET') {
      return listNoteComments(db, noteId, { limit: listLimit(params), cursor: cursorParam(params) });
    }
    if (req.method === 'DELETE') {
      return deleteNoteComment(db, { noteId, id: commentId, expectedUpdatedAt: deleteRevision(params) });
    }
    const { body, expected_updated_at: expectedUpdatedAt } = validate(await readBody(req), commentRules);
    if (req.method === 'POST') return addNoteComment(db, { id: noteId, body }, { expectedUpdatedAt });
    const comment = updateNoteComment(db, { note_id: noteId, id: commentId, body }, { expectedUpdatedAt });
    return { comment };
  } catch (error) {
    throw noteRequestError(error);
  }
}

async function changeRecord({ db, config, defaultProjectKey, defaultProjectRoot, embeddingEngine }, req, table, id, params) {
  if (req.method === 'DELETE') {
    if (table === 'notes') {
      try {
        return deleteNote(db, { id, expectedUpdatedAt: deleteRevision(params) });
      } catch (error) {
        throw noteRequestError(error);
      }
    }
    if (!db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) {
      throw new RequestError(404, 'Memory not found');
    }
    return { deleted: true, id };
  }
  const { expected_updated_at: expectedUpdatedAt, ...body } = validate(
    await readBody(req), table === 'memories' ? memoryRules : noteRules,
  );
  if (table === 'memories') {
    if (body.status === 'superseded') {
      throw new RequestError(400, 'Memories cannot be marked superseded manually.');
    }
    if (body.project_key !== undefined && body.project_key !== globalKey) {
      // The catalog includes keys from existing memories, including legacy rows.
      const catalog = knownProjectCatalog(db, defaultProjectKey, defaultProjectRoot);
      if (body.project_key === all || !catalog.labels.has(body.project_key)) {
        throw new RequestError(400, 'Unknown project destination.');
      }
    }
    if (body.scope === 'global' && body.project_key !== undefined && body.project_key !== globalKey) {
      throw new RequestError(400, 'Global memories cannot have a project key.');
    }
    if (body.scope === 'project' && body.project_key === globalKey) {
      throw new RequestError(400, 'Project memories require a non-global project key.');
    }
  }
  const defaultProject = defaultProjectKey ? { projectKey: defaultProjectKey, projectRoot: defaultProjectRoot } : null;
  try {
    if (table === 'memories') {
      const memory = await updateMemory(db, { ...body, id }, {
        defaultProject, embeddingEngine, embeddingModel: config.embedding?.model, rawRow: true, expectedUpdatedAt,
      });
      const catalog = knownProjectCatalog(db, defaultProjectKey, defaultProjectRoot, [memory.project_key]);
      return { memory: attachMemoryProject(memory, catalog) };
    }
    return { note: updateNote(db, { ...body, id }, { expectedUpdatedAt }) };
  } catch (error) {
    if (error instanceof MissingProjectDestinationError) throw new RequestError(400, error.message);
    if (table === 'notes') throw noteRequestError(error);
    if (error instanceof StaleRecordError) throw new RequestError(409, error.message);
    if (error.message.startsWith('Memory not found:')) throw new RequestError(404, 'Memory not found');
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
  const { config, project } = loadWorkspaceConfig({ cwd, ...configOptions });
  config.dbPath = context.config.dbPath;
  const { enabled, mode, http, cli } = config.dreamer;
  const runnableProjectKey = project?.projectKey === context.defaultProjectKey ? project.projectKey : null;
  const authorized = Boolean(runnableProjectKey && enabled && mode !== 'disabled');
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
    runnableProjectKey, enabled, mode, authorized, runnerIdentity,
  ])).digest('hex');
  return { config, runnableProjectKey, authorized, fingerprint, endpoint, keyConfigured, redactDream };
}

function dreamer(context, params) {
  const { db, env } = context;
  const { config, runnableProjectKey, authorized, fingerprint, endpoint, keyConfigured, redactDream } = effectiveDreamer(context);
  const { enabled = false, mode = 'disabled', cadence = {}, http, cli } = config.dreamer ?? {};
  const runner = mode === 'http' || mode === 'cli' ? config.dreamer[mode] : undefined;
  const status = choice(params, 'status', [...DREAM_STATUSES, all], all);
  const sort = choice(params, 'sort', DREAM_SORTS, 'started_at');
  const order = choice(params, 'order', SORT_ORDERS, 'desc');
  const direction = order.toUpperCase();
  const { where, values } = rowFilter({
    project_key: projectFilter(params),
    status: status === all ? undefined : status,
  });
  const activeLeases = db.prepare(`
    SELECT lease_key, substr(lease_key, 7) AS project_key, owner, acquired_at, expires_at
      FROM leases WHERE lease_key LIKE 'dream:%' AND expires_at > ? ORDER BY acquired_at DESC
  `).all(Date.now());
  const orderBy = sort === 'started_at'
    ? `started_at ${direction}, id ASC`
    : sort === 'finished_at'
      ? `finished_at IS NULL ASC, finished_at ${direction}, started_at DESC, id ASC`
      : `finished_at IS NULL ASC, (finished_at - started_at) ${direction}, started_at DESC, id ASC`;
  const runs = db.prepare('SELECT * FROM dream_runs' + where + ' ORDER BY ' + orderBy + ' LIMIT 50')
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
  return { runnable_project_key: runnableProjectKey, ...details };
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
  const { config, runnableProjectKey, fingerprint, redactDream } = effectiveDreamer(context);
  if (body.expected_config_fingerprint !== undefined && body.expected_config_fingerprint !== fingerprint) {
    throw new RequestError(409, 'Dreamer configuration changed; refresh before running.');
  }
  if (!runnableProjectKey) throw new RequestError(409, 'Workspace identity changed; restart the dashboard.');
  return redactDream(await runDream({
    db, config, projectKey: defaultProjectKey, cwd, embeddingEngine, dryRun: Boolean(body.dry_run),
    ...configOptions, userDreamer: config.dreamer,
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
    const comments = /^\/api\/notes\/([^/]+)\/comments(?:\/([^/]+))?$/.exec(pathname);
    if (comments && (comments[2] ? ['PATCH', 'DELETE'].includes(req.method) : ['GET', 'POST'].includes(req.method))) {
      return noteComments(context, req, params, comments[1], comments[2]);
    }
    const record = /^\/api\/(memories|notes)\/([^/]+)$/.exec(pathname);
    if (record && ['PATCH', 'DELETE'].includes(req.method)) {
      return changeRecord(context, req, record[1], record[2], params);
    }
    if (pathname === '/api/dreamer/run' && req.method === 'POST') return startDream(context, req);
    throw new RequestError(404, 'Not found');
  };
}
