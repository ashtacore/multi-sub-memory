import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.mjs';
import { resolveProjectKey } from '../project-id.mjs';
import {
  clampImportance, createImportState, emptyImportResult, hasTable, importMemoryRecord, importNoteRecord, legacyTimestamps,
  mapCategory, openReadOnlySnapshot, parseLegacyMetadata, resolveLegacyProjectKey,
} from './common.mjs';

export const DEFAULT_MAGIC_CONTEXT_DB = '~/.local/share/cortexkit/magic-context/context.db';

export function magicContextPath({ magicContextDb, homeDir }) {
  return expandHome(magicContextDb ?? DEFAULT_MAGIC_CONTEXT_DB, homeDir);
}

function sessionCwd(sessionPath, dbPath, homeDir, protectedPaths) {
  if (typeof sessionPath !== 'string' || path.extname(sessionPath).toLowerCase() !== '.jsonl') return;
  const filename = path.resolve(path.dirname(dbPath), expandHome(sessionPath, homeDir));
  try {
    if (!fs.statSync(filename).isFile()) return;
    const fd = fs.openSync(filename, 'r');
    try {
      protectedPaths.add(filename);
      const prefix = Buffer.alloc(64 * 1024);
      const size = fs.readSync(fd, prefix, 0, prefix.length, 0);
      for (const line of prefix.toString('utf8', 0, size).replace(/^\uFEFF/, '').split(/\r?\n/, 32)) {
        try {
          const record = JSON.parse(line);
          const cwd = record?.cwd ?? record?.payload?.cwd;
          if (typeof cwd === 'string' && cwd.trim()) return cwd;
        } catch {
          // A malformed line can precede the session header.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
  }
}

function sessionProjects(db, dbPath, homeDir, protectedPaths) {
  const lookup = new Map();
  const workspaces = new Map();
  if (!hasTable(db, 'session_projects')) return lookup;
  for (const row of db.prepare('SELECT * FROM session_projects').iterate()) {
    const sessionPath = row.session_path ?? row.file_path ?? row.jsonl_path ?? row.session_id;
    const cwd = row.cwd ?? row.repo_path ?? row.root_path;
    const workspace = typeof cwd === 'string' && cwd.trim() ? cwd : sessionCwd(sessionPath, dbPath, homeDir, protectedPaths);
    if (!workspace) continue;
    if (!workspaces.has(workspace)) workspaces.set(workspace, resolveProjectKey(workspace).projectKey);
    const projectKey = workspaces.get(workspace);
    for (const key of [row.project_path, row.project_key, row.session_id]) {
      const alias = String(key ?? '').trim();
      if (alias && !lookup.has(alias)) lookup.set(alias, projectKey);
    }
  }
  return lookup;
}

export function withMagicContextSource(options, useSource) {
  const dbPath = magicContextPath(options);
  if (!fs.statSync(dbPath, { throwIfNoEntry: false })) return useSource(null);
  const snapshot = openReadOnlySnapshot(dbPath);
  const protectedPaths = new Set();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    snapshot.close();
  }
  try {
    const sessionProjectLookup = sessionProjects(snapshot.db, dbPath, options.homeDir, protectedPaths);
    return useSource({ snapshot, sessionProjectLookup, protectedPaths, close });
  } finally {
    close();
  }
}

function recordUnresolved(result, kind, row, sessionId) {
  const id = row.id ?? null;
  result.errors.push({
    source: 'magic-context', kind, id, sessionId: sessionId ?? null,
    message: `Unresolved project-scoped Magic Context ${kind} (id=${id ?? 'unknown'}, session=${sessionId ?? 'none'}). Map the session or project with --project-map and rerun.`,
  });
}

export function importMagicContext(options, source) {
  if (source === undefined) return withMagicContextSource(options, (prepared) => importMagicContext(options, prepared));
  if (!source) return { ...emptyImportResult(), protectedPaths: [] };

  const { targetDb, dryRun, includeArchived, projectMap } = options;
  const { snapshot, sessionProjectLookup, protectedPaths } = source;
  const state = options.state ?? createImportState(targetDb);
  const result = { ...emptyImportResult(true), protectedPaths: [...protectedPaths] };
  const { db } = snapshot;
  try {
    const sessionFor = (row) => [row.source_session_id, row.session_id]
      .map((value) => String(value ?? '').trim()).find(Boolean);
    const projectFor = (row, sessionId) => {
      const project = [row.project_path, row.project_key, row.project].find((value) => String(value ?? '').trim());
      const scope = String(row.scope ?? '').trim().toLowerCase();
      const explicitScope = scope === 'project' || scope === 'global' ? scope : undefined;
      return resolveLegacyProjectKey(project, { projectMap, sessionProjectLookup, sessionId, explicitScope });
    };
    if (hasTable(db, 'memories')) {
      for (const row of db.prepare('SELECT * FROM memories').iterate()) {
        const status = String(row.status ?? 'active').trim().toLowerCase();
        if (status !== 'active' && !(includeArchived && status === 'archived')) continue;
        if (typeof row.content !== 'string' || !row.content.trim()) continue;
        const sessionId = sessionFor(row);
        const project = projectFor(row, sessionId);
        if (project.unresolved) {
          recordUnresolved(result, 'memory', row, sessionId);
          result.memoriesSkippedUnresolved++;
          continue;
        }
        const metadata = { ...parseLegacyMetadata(row.metadata_json ?? row.metadata), imported_from: 'magic-context' };
        for (const key of ['verification_status', 'verified_at']) {
          if (Object.hasOwn(row, key)) metadata[key] = row[key];
        }
        if (row.id != null) metadata.magic_context_id = row.id;
        for (const key of ['category', 'importance']) {
          if (row[key] != null && String(row[key]).trim()) metadata[`magic_context_${key}`] = row[key];
        }
        const inserted = importMemoryRecord(targetDb, {
          ...project, ...legacyTimestamps(row), status, metadata, content: row.content,
          category: mapCategory(row.category), importance: clampImportance(row.importance),
          sourceOrchestrator: row.source_orchestrator ?? 'magic-context', sourceSessionId: sessionId,
        }, state, { dryRun });
        result[inserted ? 'memoriesImported' : 'memoriesSkippedDuplicate']++;
      }
    }
    if (hasTable(db, 'notes')) {
      for (const row of db.prepare('SELECT * FROM notes').iterate()) {
        const status = String(row.status ?? 'active').trim().toLowerCase();
        if (status !== 'active' && status !== 'pending') continue;
        if (typeof row.content !== 'string' || !row.content.trim()) continue;
        const sessionId = sessionFor(row);
        const project = projectFor(row, sessionId);
        if (project.unresolved) {
          recordUnresolved(result, 'note', row, sessionId);
          result.notesSkippedUnresolved++;
          continue;
        }
        const inserted = importNoteRecord(targetDb, {
          ...project, ...legacyTimestamps(row), status, content: row.content,
          surfaceCondition: row.surface_condition, sourceOrchestrator: row.source_orchestrator ?? 'magic-context',
          sourceSessionId: sessionId,
        }, state, { dryRun });
        result[inserted ? 'notesImported' : 'notesSkippedDuplicate']++;
      }
    }
  } finally {
    try {
      source.close();
    } finally {
      result.sourceFiles.push(snapshot.verifyUnmodified());
    }
  }
  return result;
}
