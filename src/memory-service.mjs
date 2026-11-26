import { randomBytes } from 'node:crypto';
import { hashNormalizedContent } from './db.mjs';
import { maybeTriggerAutoDream } from './dreamer/trigger.mjs';
import { encodeFloat32Vector } from './embeddings.mjs';
import { resolveConfigProject } from './config.mjs';

export const GLOBAL_PROJECT_KEY = 'global';
export const MEMORY_CATEGORIES = Object.freeze([
  'ARCHITECTURE', 'CONFIG_VALUES', 'CONSTRAINTS', 'PROJECT_RULES',
  'DECISIONS', 'WORKFLOW', 'GENERAL',
]);
export const MEMORY_SCOPES = Object.freeze(['project', 'global']);
export const MEMORY_STATUSES = Object.freeze(['active', 'archived', 'superseded']);
export const NOTE_STATUSES = Object.freeze(['active', 'pending', 'dismissed']);
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export class StaleRecordError extends Error {
  constructor() {
    super('Record was modified by another writer; refresh and try again.');
  }
}

export class MissingProjectDestinationError extends Error {
  constructor() {
    super('Select a project destination or launch the dashboard in a Git workspace.');
  }
}

function checkRevision(row, expectedUpdatedAt) {
  if (expectedUpdatedAt !== undefined && String(row.updated_at) !== expectedUpdatedAt) {
    throw new StaleRecordError();
  }
}

function rejectAccessFields(input) {
  for (const field of ['last_accessed_at', 'access_count']) {
    if (Object.hasOwn(input, field)) throw new Error(`Unknown field: ${field}`);
  }
}

export function resolveCachedProjectKey(cwd, config, options) {
  return resolveConfigProject(cwd, config, { ...options, cache: true });
}

export function generateId() {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  randomBytes(10).copy(bytes, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required and must not be blank');
  }
  return content;
}

function projectIdentityFor(scope, input, context) {
  if (scope === 'global') return { projectKey: GLOBAL_PROJECT_KEY, projectRoot: null };
  return resolveCachedProjectKey(input.cwd ?? context.defaultCwd, context.config);
}

function projectKeyFor(scope, input, context) {
  return projectIdentityFor(scope, input, context).projectKey;
}

function recordProject(db, projectKey, projectRoot, now) {
  if (!projectKey || projectKey === GLOBAL_PROJECT_KEY || !projectRoot) return;
  db.prepare(`
    INSERT INTO projects (project_key, project_root, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (project_key) DO UPDATE SET
      project_root = excluded.project_root,
      updated_at = excluded.updated_at
  `).run(projectKey, projectRoot, now);
}

function formatMemory(row) {
  const { metadata_json, last_dreamed_at, ...memory } = row;
  return { ...memory, metadata: JSON.parse(metadata_json) };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function mergeMetadata(previous, incoming) {
  if (incoming === undefined) return previous;
  const existing = JSON.parse(previous);
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    return JSON.stringify({ ...existing, ...incoming });
  }
  return JSON.stringify(incoming);
}

function requireRow(row, kind, id) {
  if (!row) throw new Error(`${kind} not found: ${id}`);
  return row;
}

function memoryRow(db, id) {
  return requireRow(db.prepare('SELECT * FROM memories WHERE id = ?').get(id), 'Memory', id);
}

export function inWriteTransaction(db, write) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Memory write and rollback failed');
    }
    throw error;
  }
}

function updateAccess(db, { memories = [], notes = [] }) {
  const updated = { memories: new Map(), notes: new Map() };
  const now = Date.now();
  for (const [table, ids] of [['memories', memories], ['notes', notes]]) {
    if (!ids.length) continue;
    const rows = db.prepare(`
      UPDATE ${table} SET access_count = access_count + 1,
        last_accessed_at = MAX(COALESCE(last_accessed_at, 0), ?)
      WHERE id IN (SELECT value FROM json_each(?))
      RETURNING id, last_accessed_at, access_count
    `).all(now, JSON.stringify(ids));
    const statsById = updated[table];
    for (const { id, ...stats } of rows) statsById.set(id, stats);
    if (ids.some((id) => !statsById.has(id))) {
      throw new Error('A selected memory or note was removed. Retry the request.');
    }
  }
  return updated;
}

export function recordAccess(db, { memories = [], notes = [] }) {
  if (!memories.length && !notes.length) return { memories: new Map(), notes: new Map() };
  return inWriteTransaction(db, () => updateAccess(db, { memories, notes }));
}

export function readWithAccess(db, table, select) {
  return inWriteTransaction(db, () => {
    const records = select();
    const updated = updateAccess(db, { [table]: records.map(({ id }) => id) })[table];
    return records.map((row) => ({ ...row, ...updated.get(row.id) }));
  });
}

function trackMutationAccess(db, table, row, trackAccess) {
  if (!trackAccess) return row;
  const stats = updateAccess(db, { [table]: [row.id] })[table].get(row.id);
  return { ...row, ...stats };
}

export async function storeEmbedding(db, memory, engine, fallbackModel) {
  if (!engine) return 0;
  try {
    const vector = await engine.embed(memory.content);
    if (!vector) return 0;
    const model = engine.getStatus?.()?.model ?? fallbackModel;
    // Another writer may have changed the text while inference was running.
    return db.prepare(`
      INSERT INTO memory_embeddings (memory_id, model_id, dims, vector, updated_at)
      SELECT id, ?, ?, ?, ? FROM memories WHERE id = ? AND content = ?
      ON CONFLICT (memory_id) DO UPDATE SET
        model_id = excluded.model_id, dims = excluded.dims,
        vector = excluded.vector, updated_at = excluded.updated_at
    `).run(model, vector.length, encodeFloat32Vector(vector), Date.now(), memory.id, memory.content).changes;
  } catch {
    // Embeddings are optional, including when the database closes during inference.
    return 0;
  }
}

export function invalidateEmbedding(db, id) {
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
}

export async function writeMemory(db, input, context = {}) {
  const content = requireContent(input.content);
  const { scope = 'project', category = 'GENERAL', importance = 3 } = input;
  if (!MEMORY_SCOPES.includes(scope)) throw new Error('Memory scope must be project or global');
  const { projectKey, projectRoot } = projectIdentityFor(scope, input, context);
  const hash = hashNormalizedContent(content);
  const result = inWriteTransaction(db, () => {
    const now = Date.now();
    recordProject(db, projectKey, projectRoot, now);
    const row = db.prepare(`
      INSERT INTO memories (
        id, project_key, scope, category, content, normalized_hash, importance,
        source_orchestrator, source_session_id, metadata_json, created_at, updated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_key, scope, normalized_hash) DO NOTHING
      RETURNING *
    `).get(
      generateId(), projectKey, scope, category, content, hash, importance,
      input.source_orchestrator ?? null, input.source_session_id ?? null,
      mergeMetadata(null, input.metadata), now, now, now,
    );
    if (row) return { memory: formatMemory(row), deduplicated: false, reactivated: false };

    const existing = db.prepare(`
      SELECT * FROM memories WHERE project_key = ? AND scope = ? AND normalized_hash = ?
    `).get(projectKey, scope, hash);
    const reactivated = existing.status !== 'active';
    const updated = db.prepare(`
      UPDATE memories SET content = ?, category = ?, importance = ?, status = 'active',
        superseded_by = NULL, source_orchestrator = ?, source_session_id = ?,
        metadata_json = ?, updated_at = MAX(?, updated_at + 1)
      WHERE id = ? RETURNING *
    `).get(
      reactivated ? content : existing.content, input.category ?? existing.category,
      input.importance ?? existing.importance, input.source_orchestrator ?? existing.source_orchestrator,
      input.source_session_id ?? existing.source_session_id, mergeMetadata(existing.metadata_json, input.metadata),
      now, existing.id,
    );
    if (updated.content !== existing.content) invalidateEmbedding(db, existing.id);
    const memory = formatMemory(trackMutationAccess(db, 'memories', updated, context.trackAccess));
    return { memory, deduplicated: true, reactivated };
  });
  if (!result.deduplicated || result.reactivated) {
    void storeEmbedding(db, result.memory, context.embeddingEngine);
  }
  const { config, configOptions, spawnDream } = context;
  if (scope === 'project' && config?.dbPath && (input.cwd !== undefined || config.dreamer?.cadence?.mode === 'auto')) {
    setImmediate(() => maybeTriggerAutoDream({
      db, config, projectKey, cwd: input.cwd ?? context.defaultCwd,
      reloadProjectConfig: input.cwd !== undefined, configOptions, spawnImpl: spawnDream,
    }));
  }
  return result;
}

export async function updateMemory(db, input, context = {}) {
  rejectAccessFields(input);
  const content = input.content === undefined ? undefined : requireContent(input.content);
  if (input.scope !== undefined && !MEMORY_SCOPES.includes(input.scope)) {
    throw new Error('Memory scope must be project or global');
  }
  if (input.project_key !== undefined && (typeof input.project_key !== 'string' || !input.project_key.trim() || input.project_key.trim() !== input.project_key)) {
    throw new Error('Memory project_key must be a non-blank string');
  }
  if (input.scope === 'global' && input.project_key !== undefined && input.project_key !== GLOBAL_PROJECT_KEY) {
    throw new Error('Global memories must use the global project key');
  }
  if (input.scope === 'project' && input.project_key === GLOBAL_PROJECT_KEY) {
    throw new Error('Project memories cannot use the global project key');
  }
  let result;
  try {
    result = inWriteTransaction(db, () => {
      const existing = memoryRow(db, input.id);
      checkRevision(existing, context.expectedUpdatedAt);
      const scope = input.scope ?? (input.project_key !== undefined
        ? (input.project_key === GLOBAL_PROJECT_KEY ? 'global' : 'project')
        : existing.scope);
      let projectKey;
      if (scope === 'global') {
        projectKey = GLOBAL_PROJECT_KEY;
      } else if (input.project_key !== undefined) {
        projectKey = input.project_key;
      } else if (existing.scope === 'project') {
        projectKey = existing.project_key;
      } else {
        if (context.defaultProject === null) throw new MissingProjectDestinationError();
        const project = context.defaultProject ?? projectIdentityFor('project', input, context);
        projectKey = project.projectKey;
        recordProject(db, projectKey, project.projectRoot, Date.now());
      }
      const status = input.status ?? existing.status;
      if (status === 'superseded' && existing.superseded_by === null) {
        throw new Error('Use archive with superseded_by to mark a memory as superseded');
      }
      const changedContent = content !== undefined && content !== existing.content;
      const row = db.prepare(`
        UPDATE memories SET project_key = ?, scope = ?, content = ?, normalized_hash = ?,
          category = ?, importance = ?, status = ?, superseded_by = ?, metadata_json = ?, updated_at = MAX(?, updated_at + 1)
        WHERE id = ? RETURNING *
      `).get(
        projectKey, scope, content ?? existing.content,
        changedContent ? hashNormalizedContent(content) : existing.normalized_hash,
        input.category ?? existing.category, input.importance ?? existing.importance, status,
        input.status === undefined || status === 'superseded' ? existing.superseded_by : null,
        input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata),
        Date.now(), input.id,
      );
      if (changedContent) invalidateEmbedding(db, input.id);
      const accessed = trackMutationAccess(db, 'memories', row, context.trackAccess);
      return { memory: context.rawRow ? accessed : formatMemory(accessed), changedContent };
    });
  } catch (error) {
    if (error.errcode === 2067 || error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message))) {
      throw new Error('Memory update conflicts with existing content in the target project and scope', { cause: error });
    }
    throw error;
  }
  if (result.changedContent) void storeEmbedding(db, result.memory, context.embeddingEngine, context.embeddingModel);
  return result.memory;
}

export function archiveMemory(db, input, { trackAccess } = {}) {
  const supersededBy = input.superseded_by ?? null;
  return inWriteTransaction(db, () => {
    if (supersededBy !== null) {
      if (supersededBy === input.id) throw new Error('A memory cannot supersede itself');
      const successor = db.prepare('SELECT 1 FROM memories WHERE id = ?').get(supersededBy);
      if (!successor) throw new Error(`Memory not found for superseded_by: ${supersededBy}`);
    }
    const row = db.prepare(`
      UPDATE memories SET status = ?, superseded_by = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? RETURNING *
    `).get(supersededBy === null ? 'archived' : 'superseded', supersededBy, Date.now(), input.id);
    return formatMemory(trackMutationAccess(db, 'memories', requireRow(row, 'Memory', input.id), trackAccess));
  });
}

export function getMemory(db, id) {
  return formatMemory(memoryRow(db, id));
}

export function selectMemories(db, { projectKey, scope, status, category, limit }) {
  const filters = [];
  const parameters = [];
  if (scope === 'all') {
    filters.push("((scope = 'project' AND project_key = ?) OR (scope = 'global' AND project_key = ?))");
    parameters.push(projectKey, GLOBAL_PROJECT_KEY);
  } else {
    filters.push('scope = ? AND project_key = ?');
    parameters.push(scope, scope === 'global' ? GLOBAL_PROJECT_KEY : projectKey);
  }
  if (status !== 'all') {
    filters.push('status = ?');
    parameters.push(status);
  }
  if (category !== undefined) {
    filters.push('category = ?');
    parameters.push(category);
  }
  if (limit !== undefined) parameters.push(limit);
  return db.prepare(`
    SELECT * FROM memories WHERE ${filters.join(' AND ')}
    ORDER BY importance DESC, updated_at DESC, id ASC
    ${limit === undefined ? '' : 'LIMIT ?'}
  `).all(...parameters);
}

export function listMemories(db, input = {}, context = {}) {
  const { scope = 'all', status = 'active', category, limit = DEFAULT_LIST_LIMIT } = input;
  return selectMemories(db, {
    projectKey: scope === 'all'
      ? resolveCachedProjectKey(input.cwd ?? context.defaultCwd, context.config, { optional: true })?.projectKey ?? GLOBAL_PROJECT_KEY
      : projectKeyFor(scope, input, context),
    scope, status, category,
    limit: Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit))),
  }).map(formatMemory);
}

export function writeNote(db, input, context = {}) {
  const content = requireContent(input.content);
  const { status = 'active' } = input;
  if (status !== 'active' && status !== 'pending') throw new Error('New note status must be active or pending');
  const { projectKey, projectRoot } = projectIdentityFor('project', input, context);
  const now = Date.now();
  return inWriteTransaction(db, () => {
    recordProject(db, projectKey, projectRoot, now);
    return db.prepare(`
      INSERT INTO notes (
        id, project_key, status, content, surface_condition, source_orchestrator,
        source_session_id, created_at, updated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      generateId(), projectKey, status, content, input.surface_condition ?? null,
      input.source_orchestrator ?? null, input.source_session_id ?? null, now, now, now,
    );
  });
}

export function selectNotes(db, { projectKey, status, includeGlobal }) {
  const projects = includeGlobal ? [projectKey, GLOBAL_PROJECT_KEY] : [projectKey];
  const parameters = [...projects];
  let statusFilter = '';
  if (status === undefined) {
    statusFilter = "AND status IN ('active', 'pending')";
  } else if (status !== 'all') {
    statusFilter = 'AND status = ?';
    parameters.push(status);
  }
  return db.prepare(`
    SELECT * FROM notes WHERE project_key IN (${projects.map(() => '?').join(', ')}) ${statusFilter}
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC, id ASC
  `).all(...parameters);
}

export function readNotes(db, input = {}, context = {}) {
  return selectNotes(db, {
    projectKey: input.include_global
      ? resolveCachedProjectKey(input.cwd ?? context.defaultCwd, context.config, { optional: true })?.projectKey ?? GLOBAL_PROJECT_KEY
      : projectKeyFor('project', input, context),
    status: input.status,
    includeGlobal: input.include_global,
  });
}

export function updateNote(db, input, { expectedUpdatedAt, trackAccess } = {}) {
  rejectAccessFields(input);
  const content = input.content === undefined ? null : requireContent(input.content);
  function update() {
    if (expectedUpdatedAt !== undefined) {
      const existing = db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(input.id);
      checkRevision(requireRow(existing, 'Note', input.id), expectedUpdatedAt);
    }
    const row = db.prepare(`
      UPDATE notes SET content = COALESCE(?, content), status = COALESCE(?, status),
        surface_condition = CASE WHEN ? THEN ? ELSE surface_condition END, updated_at = MAX(?, updated_at + 1)
      WHERE id = ? RETURNING *
    `).get(
      content, input.status ?? null, Number(input.surface_condition !== undefined),
      input.surface_condition ?? null, Date.now(), input.id,
    );
    return trackMutationAccess(db, 'notes', requireRow(row, 'Note', input.id), trackAccess);
  }
  return trackAccess || expectedUpdatedAt !== undefined ? inWriteTransaction(db, update) : update();
}

export function dismissNote(db, id, options) {
  return updateNote(db, { id, status: 'dismissed' }, options);
}
