import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [{
  version: 1,
  up(db) {
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
        category TEXT NOT NULL CHECK (category IN (
          'ARCHITECTURE', 'CONFIG_VALUES', 'CONSTRAINTS', 'PROJECT_RULES',
          'DECISIONS', 'WORKFLOW', 'GENERAL'
        )),
        content TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'superseded')),
        superseded_by TEXT,
        source_orchestrator TEXT,
        source_session_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_key, scope, normalized_hash)
      );
      CREATE INDEX idx_memories_project_status_rank
        ON memories (project_key, status, importance DESC, updated_at DESC);

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, category, project_key, content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (rowid, content, category, project_key)
        VALUES (new.rowid, new.content, new.category, new.project_key);
      END;
      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, content, category, project_key)
        VALUES ('delete', old.rowid, old.content, old.category, old.project_key);
      END;
      CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, content, category, project_key)
        VALUES ('delete', old.rowid, old.content, old.category, old.project_key);
        INSERT INTO memories_fts (rowid, content, category, project_key)
        VALUES (new.rowid, new.content, new.category, new.project_key);
      END;

      CREATE TABLE memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'dismissed')),
        content TEXT NOT NULL,
        surface_condition TEXT,
        source_orchestrator TEXT,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_notes_project_status ON notes (project_key, status);

      CREATE VIRTUAL TABLE notes_fts USING fts5(
        content, surface_condition, project_key, content='notes', content_rowid='rowid'
      );
      CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts (rowid, content, surface_condition, project_key)
        VALUES (new.rowid, new.content, new.surface_condition, new.project_key);
      END;
      CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts (notes_fts, rowid, content, surface_condition, project_key)
        VALUES ('delete', old.rowid, old.content, old.surface_condition, old.project_key);
      END;
      CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts (notes_fts, rowid, content, surface_condition, project_key)
        VALUES ('delete', old.rowid, old.content, old.surface_condition, old.project_key);
        INSERT INTO notes_fts (rowid, content, surface_condition, project_key)
        VALUES (new.rowid, new.content, new.surface_condition, new.project_key);
      END;

      CREATE TABLE transcript_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE NOT NULL,
        orchestrator TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_indexed_at INTEGER NOT NULL
      );
      CREATE INDEX idx_transcript_files_session_id ON transcript_files (session_id);
      CREATE INDEX idx_transcript_files_project_orchestrator
        ON transcript_files (project_key, orchestrator);

      CREATE TABLE transcript_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES transcript_files(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT,
        text TEXT NOT NULL,
        tool_names TEXT,
        line_no INTEGER NOT NULL,
        UNIQUE (file_id, seq)
      );
      CREATE VIRTUAL TABLE transcript_messages_fts USING fts5(
        text, tool_names, role, content='transcript_messages', content_rowid='id'
      );
      CREATE TRIGGER transcript_messages_fts_insert AFTER INSERT ON transcript_messages BEGIN
        INSERT INTO transcript_messages_fts (rowid, text, tool_names, role)
        VALUES (new.id, new.text, new.tool_names, new.role);
      END;
      CREATE TRIGGER transcript_messages_fts_delete AFTER DELETE ON transcript_messages BEGIN
        INSERT INTO transcript_messages_fts (transcript_messages_fts, rowid, text, tool_names, role)
        VALUES ('delete', old.id, old.text, old.tool_names, old.role);
      END;
      CREATE TRIGGER transcript_messages_fts_update AFTER UPDATE ON transcript_messages BEGIN
        INSERT INTO transcript_messages_fts (transcript_messages_fts, rowid, text, tool_names, role)
        VALUES ('delete', old.id, old.text, old.tool_names, old.role);
        INSERT INTO transcript_messages_fts (rowid, text, tool_names, role)
        VALUES (new.id, new.text, new.tool_names, new.role);
      END;

      CREATE TABLE transcript_embeddings (
        message_id INTEGER PRIMARY KEY REFERENCES transcript_messages(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL
      );

      CREATE TABLE dream_runs (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        runner TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        memories_reviewed INTEGER DEFAULT 0,
        memories_merged INTEGER DEFAULT 0,
        memories_archived INTEGER DEFAULT 0,
        summary TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX idx_dream_runs_project_started ON dream_runs (project_key, started_at DESC);

      CREATE TABLE leases (
        lease_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  },
}];

const busyWait = new Int32Array(new SharedArrayBuffer(4));

function retryOnBusy(fn, deadlineMs = 5000) {
  const deadline = performance.now() + deadlineMs;
  while (true) {
    try {
      return fn();
    } catch (error) {
      const busy = error.errcode === 5 || (error.code === 'ERR_SQLITE_ERROR'
        && /database is locked|SQLITE_BUSY/i.test(error.message));
      if (!busy) throw error;

      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      Atomics.wait(busyWait, 0, 0, Math.min(10, remaining));
      if (performance.now() >= deadline) throw error;
    }
  }
}

export function openDatabase(dbPath, options = {}) {
  const readOnly = Boolean(options.readOnly);
  if (!readOnly && typeof dbPath === 'string' && dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (!readOnly) {
      retryOnBusy(() => db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'));
      runMigrations(db);
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Database initialization and close failed');
    }
    throw error;
  }
}

export function runMigrations(db) {
  retryOnBusy(() => db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `));
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const { version, up } of MIGRATIONS) {
    if (applied.get(version)) continue;
    retryOnBusy(() => db.exec('BEGIN IMMEDIATE'));
    try {
      if (!applied.get(version)) {
        up(db);
        record.run(version, Date.now());
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Migration ${version} and rollback failed`);
      }
      throw error;
    }
  }
}

export function acquireLease(db, leaseKey, owner, ttlMs, now = Date.now()) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('Lease TTL must be positive and finite');

  const result = db.prepare(`
    INSERT INTO leases (lease_key, owner, acquired_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (lease_key) DO UPDATE SET
      owner = excluded.owner,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE leases.expires_at <= excluded.acquired_at OR leases.owner = excluded.owner
  `).run(leaseKey, owner, now, now + ttlMs);
  return result.changes > 0;
}

export function releaseLease(db, leaseKey, owner) {
  return db.prepare('DELETE FROM leases WHERE lease_key = ? AND owner = ?').run(leaseKey, owner).changes > 0;
}

export function normalizeContent(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashNormalizedContent(text) {
  return createHash('sha256').update(normalizeContent(text)).digest('hex');
}
