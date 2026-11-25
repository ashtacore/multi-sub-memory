import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashNormalizedContent, normalizeContent } from '../db.mjs';
import { generateId, MEMORY_CATEGORIES } from '../memory-service.mjs';
import { normalizePath, resolveProjectKey } from '../project-id.mjs';

export function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function stat(filePath) {
  return fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
}

function sameFile(before, after) {
  return before?.dev === after?.dev && before?.ino === after?.ino && before?.size === after?.size
    && before?.mtimeNs === after?.mtimeNs && before?.ctimeNs === after?.ctimeNs;
}

export function openReadOnlySnapshot(sourcePath) {
  if (!stat(sourcePath)?.isFile()) throw new Error(`Expected a SQLite file at ${sourcePath}`);
  const source = fs.realpathSync(sourcePath);
  const wal = source + '-wal';
  const journal = source + '-journal';
  const dbBefore = stat(source);
  const walBefore = stat(wal);
  if ((walBefore && !walBefore.isFile()) || stat(journal)) {
    throw new Error(`Cannot snapshot ${sourcePath} with an invalid WAL or a rollback journal`);
  }
  const sha256Before = hashFileSha256(source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-import-'));
  const snapshotPath = path.join(directory, 'snapshot.db');
  let db;
  try {
    fs.copyFileSync(source, snapshotPath);
    if (walBefore) fs.copyFileSync(wal, snapshotPath + '-wal');
    if (!sameFile(dbBefore, stat(source)) || !sameFile(walBefore, stat(wal)) || stat(journal)
        || sha256Before !== hashFileSha256(snapshotPath)) {
      throw new Error(`SQLite source changed while taking a snapshot: ${sourcePath}`);
    }
    db = new DatabaseSync(snapshotPath, { readOnly: true });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    db,
    sha256Before,
    close() {
      try {
        db.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verifyUnmodified() {
      const sha256After = hashFileSha256(sourcePath);
      const unmodified = sha256Before === sha256After;
      if (!unmodified) throw new Error(`SQLite source changed during import: ${sourcePath}`);
      return { path: sourcePath, sha256Before, sha256After, unmodified };
    },
  };
}

const categoryAliases = new Map([
  ['RULE', 'PROJECT_RULES'], ['RULES', 'PROJECT_RULES'], ['PROJECT_RULE', 'PROJECT_RULES'],
  ['CONVENTION', 'PROJECT_RULES'], ['CONVENTIONS', 'PROJECT_RULES'],
  ['CONFIG', 'CONFIG_VALUES'], ['SETTINGS', 'CONFIG_VALUES'], ['ENV', 'CONFIG_VALUES'],
  ['DECISION', 'DECISIONS'], ['CONSTRAINT', 'CONSTRAINTS'], ['LIMITATION', 'CONSTRAINTS'],
  ['ARCH', 'ARCHITECTURE'], ['DESIGN', 'ARCHITECTURE'], ['PROCESS', 'WORKFLOW'], ['TOOLING', 'WORKFLOW'],
]);

export function mapCategory(raw) {
  const category = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return MEMORY_CATEGORIES.includes(category) ? category : categoryAliases.get(category) ?? 'GENERAL';
}

function numericValue(raw) {
  if (typeof raw === 'number' || typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.trim()) return Number(raw);
  return NaN;
}

export function clampImportance(raw, fallback = 3) {
  const value = numericValue(raw);
  return Number.isFinite(value) ? Math.min(5, Math.max(1, Math.round(value))) : fallback;
}

export function normalizeTimestamp(raw, fallback = Date.now()) {
  const numeric = numericValue(raw);
  const value = Number.isFinite(numeric) ? (Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric)
    : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|[Tt ])/u.test(raw.trim()) ? Date.parse(raw) : NaN;
  return Number.isSafeInteger(Math.trunc(value)) ? Math.trunc(value) : fallback;
}

export function loadProjectMap(projectMapPath) {
  let projectMap;
  try {
    projectMap = JSON.parse(fs.readFileSync(projectMapPath, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read project map ${projectMapPath}: ${cause.message}`, { cause });
  }
  if (!projectMap || typeof projectMap !== 'object' || Array.isArray(projectMap)) {
    throw new Error(`Project map ${projectMapPath} must contain a JSON object`);
  }
  return projectMap;
}

const globalProject = Object.freeze({ projectKey: 'global', scope: 'global' });
const isProjectKey = (value) => /^(?:git|dir):/.test(value);
const isGlobal = (value) => /^(?:global|default)$/i.test(value);
const isAbsolute = (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value);

export function resolveLegacyProjectKey(rawProject, {
  projectMap, sessionProjectLookup, sessionId, defaultScope = 'project', explicitScope,
} = {}) {
  const raw = String(rawProject ?? '').trim();
  if (explicitScope === 'global' || isGlobal(raw)) return globalProject;
  const session = String(sessionId ?? '').trim();
  const mapped = projectMap && (raw
    ? (Object.hasOwn(projectMap, raw) || isProjectKey(raw) ? raw : normalizePath(raw))
    : session);
  if (mapped && Object.hasOwn(projectMap, mapped)) {
    const value = projectMap[mapped];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid project map destination for ${mapped}`);
    const destination = value.trim();
    if (isGlobal(destination)) return globalProject;
    return { projectKey: isProjectKey(destination) ? destination : resolveProjectKey(destination).projectKey, scope: 'project' };
  }
  const sessionProject = sessionProjectLookup?.get(raw);
  if (sessionProject) return sessionProject === 'global' ? globalProject : { projectKey: sessionProject, scope: 'project' };
  if (raw && (isAbsolute(raw) || fs.existsSync(raw))) return { projectKey: resolveProjectKey(raw).projectKey, scope: 'project' };
  const sessionWorkspace = sessionProjectLookup?.get(session);
  if (sessionWorkspace) return sessionWorkspace === 'global' ? globalProject : { projectKey: sessionWorkspace, scope: 'project' };
  if (isProjectKey(raw)) return { projectKey: raw, scope: 'project' };
  if ((explicitScope ?? defaultScope) === 'global') return globalProject;
  return raw ? { projectKey: raw, scope: 'project' } : { projectKey: null, scope: 'project', unresolved: true };
}

export function parseLegacyMetadata(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function memoryKey(projectKey, scope, hash) {
  return `${projectKey}\0${scope}\0${hash}`;
}

function noteKey(projectKey, content, condition) {
  return `${projectKey}\0${normalizeContent(content)}\0${normalizeContent(condition ?? '')}`;
}

function magicContextIds(metadata) {
  const aliases = Array.isArray(metadata.magic_context_ids) ? metadata.magic_context_ids : [];
  return [metadata.magic_context_id, metadata.magicContextId, ...aliases]
    .filter((id) => typeof id === 'string' || typeof id === 'number');
}

function indexMagicContextIds(state, ids, owner) {
  for (const id of ids) {
    const key = String(id);
    if (!state.magicContextRowsById.has(key)) state.magicContextRowsById.set(key, owner);
  }
}

export function createImportState(targetDb) {
  const state = {
    memoryKeyOwners: new Map(), magicContextRowsById: new Map(), existingNoteKeys: new Set(), nextDryRunId: 0,
  };
  if (!targetDb) return state;
  if (hasTable(targetDb, 'memories')) {
    for (const row of targetDb.prepare('SELECT id, project_key, scope, normalized_hash, metadata_json FROM memories').iterate()) {
      const key = memoryKey(row.project_key, row.scope, row.normalized_hash);
      const owner = { id: row.id, projectKey: row.project_key, scope: row.scope };
      state.memoryKeyOwners.set(key, owner);
      const metadata = parseLegacyMetadata(row.metadata_json);
      indexMagicContextIds(state, magicContextIds(metadata), owner);
    }
  }
  if (hasTable(targetDb, 'notes')) {
    for (const row of targetDb.prepare('SELECT project_key, content, surface_condition FROM notes').iterate()) {
      state.existingNoteKeys.add(noteKey(row.project_key, row.content, row.surface_condition));
    }
  }
  return state;
}

function mergeMemoryProvenance(targetDb, existing, record, incoming, incomingIds) {
  const metadata = parseLegacyMetadata(existing.metadata_json);
  const before = JSON.stringify(metadata);
  const additions = Object.entries(incoming).filter(([key, value]) =>
    key !== 'magic_context_id' && key !== 'magic_context_ids' && value != null
    && (!Object.hasOwn(metadata, key) || metadata[key] == null));
  const merged = { ...metadata, ...Object.fromEntries(additions) };
  const incomingPrimary = incoming.magic_context_id ?? incoming.magicContextId;
  if (merged.magic_context_id == null && incomingPrimary != null) {
    merged.magic_context_id = metadata.magicContextId ?? incomingPrimary;
  }

  const knownIds = new Map();
  for (const id of magicContextIds(metadata)) {
    if (!knownIds.has(String(id))) knownIds.set(String(id), id);
  }
  const count = knownIds.size;
  for (const id of incomingIds) {
    if (!knownIds.has(String(id))) knownIds.set(String(id), id);
  }
  if (knownIds.size > count && (knownIds.size > 1 || merged.magic_context_id == null)) {
    merged.magic_context_ids = [...knownIds.values()];
  }

  const sourceSessionId = existing.source_session_id ?? record.sourceSessionId ?? null;
  const after = JSON.stringify(merged);
  if (after !== before || sourceSessionId !== existing.source_session_id) {
    const metadataJson = after === before ? existing.metadata_json : after;
    targetDb.prepare('UPDATE memories SET metadata_json = ?, source_session_id = ? WHERE id = ?')
      .run(metadataJson, sourceSessionId, existing.id);
  }
}

export function importMemoryRecord(targetDb, record, state, { dryRun } = {}) {
  const { projectKey, scope } = record;
  const hash = hashNormalizedContent(record.content);
  const key = memoryKey(projectKey, scope, hash);
  const incoming = record.metadata ?? {};
  const incomingIds = magicContextIds(incoming);
  const matchedOwners = incomingIds.map((id) => state.magicContextRowsById.get(String(id))).filter(Boolean);
  const [matched] = matchedOwners;
  if (matchedOwners.some((owner) =>
    owner.scope !== scope || owner.projectKey !== projectKey || owner.id !== matched.id)) return false;

  const existingOwner = matched ?? state.memoryKeyOwners.get(key);
  if (existingOwner) {
    if (!dryRun && targetDb) {
      const existing = targetDb.prepare('SELECT id, source_session_id, metadata_json FROM memories WHERE id = ?')
        .get(existingOwner.id);
      mergeMemoryProvenance(targetDb, existing, record, incoming, incomingIds);
    }
    indexMagicContextIds(state, incomingIds, existingOwner);
    return false;
  }
  const id = dryRun ? `dry-run:${++state.nextDryRunId}` : generateId();
  const owner = { id, projectKey, scope };
  if (!dryRun) {
    targetDb.prepare(`
      INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, importance,
        status, source_orchestrator, source_session_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectKey, scope, record.category, record.content, hash, record.importance,
      record.status, record.sourceOrchestrator ?? null, record.sourceSessionId ?? null,
      record.metadata ? JSON.stringify(record.metadata) : null, record.createdAt, record.updatedAt);
  }
  state.memoryKeyOwners.set(key, owner);
  indexMagicContextIds(state, incomingIds, owner);
  return true;
}

export function importNoteRecord(targetDb, record, state, { dryRun } = {}) {
  const key = noteKey(record.projectKey, record.content, record.surfaceCondition);
  if (state.existingNoteKeys.has(key)) return false;
  if (!dryRun) {
    targetDb.prepare(`
      INSERT INTO notes (id, project_key, status, content, surface_condition, source_orchestrator,
        source_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), record.projectKey, record.status, record.content, record.surfaceCondition ?? null,
      record.sourceOrchestrator ?? null, record.sourceSessionId ?? null, record.createdAt, record.updatedAt);
  }
  state.existingNoteKeys.add(key);
  return true;
}

export function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function emptyImportResult(found = false) {
  return {
    ran: true, found, memoriesImported: 0, memoriesSkippedDuplicate: 0, memoriesSkippedUnresolved: 0,
    notesImported: 0, notesSkippedDuplicate: 0, notesSkippedUnresolved: 0, sourceFiles: [], errors: [],
  };
}

export function legacyTimestamps(row) {
  const createdAt = normalizeTimestamp(row.created_at ?? row.createdAt ?? row.timestamp);
  return { createdAt, updatedAt: normalizeTimestamp(row.updated_at ?? row.updatedAt, createdAt) };
}
