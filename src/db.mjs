import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [{
  version: 1,
  up(db) {
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY NOT NULL,
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
        memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE notes (
        id TEXT PRIMARY KEY NOT NULL,
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
        message_id INTEGER PRIMARY KEY NOT NULL REFERENCES transcript_messages(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE dream_runs (
        id TEXT PRIMARY KEY NOT NULL,
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
        lease_key TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  },
}, {
  version: 2,
  up(db) {
    db.exec(`
      ALTER TABLE transcript_files ADD COLUMN line_count INTEGER;
      ALTER TABLE transcript_files ADD COLUMN file_identity TEXT;
      ALTER TABLE transcript_files ADD COLUMN checkpoint_hash TEXT;
      ALTER TABLE transcript_files ADD COLUMN file_size INTEGER;
    `);
  },
}, {
  version: 3,
  up(db) {
    // An earlier v2 implementation already added this column.
    const existing = db.prepare("SELECT 1 FROM pragma_table_info('transcript_messages') WHERE name = 'embed_eligible'").get();
    if (existing) return;
    db.exec('ALTER TABLE transcript_messages ADD COLUMN embed_eligible INTEGER NOT NULL DEFAULT 0;');
  },
}, {
  version: 4,
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transcript_messages_file_line_seq
        ON transcript_messages (file_id, line_no, seq);
    `);
  },
}, {
  version: 5,
  up(db) {
    const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all()
      .some((info) => info.name === column);
    if (!hasColumn('transcript_files', 'project_root')) {
      db.exec('ALTER TABLE transcript_files ADD COLUMN project_root TEXT;');
    }
    if (!hasColumn('memories', 'last_dreamed_at')) {
      db.exec('ALTER TABLE memories ADD COLUMN last_dreamed_at INTEGER;');
    }
    if (!hasColumn('dream_runs', 'last_transcript_message_id')) {
      db.exec('ALTER TABLE dream_runs ADD COLUMN last_transcript_message_id INTEGER;');
    }
  },
}, {
  version: 6,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY NOT NULL,
        project_root TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
}, {
  version: 7,
  up(db) {
    for (const [table, indexedField] of [['memories', 'category'], ['notes', 'surface_condition']]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (!columns.includes('last_accessed_at')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN last_accessed_at INTEGER`);
      }
      if (!columns.includes('access_count')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0)`);
      }

      const fts = `${table}_fts`;
      db.exec(`
        DROP TRIGGER IF EXISTS ${fts}_update;
        CREATE TRIGGER ${fts}_update AFTER UPDATE ON ${table}
        WHEN old.rowid IS NOT new.rowid OR old.content IS NOT new.content
          OR old.${indexedField} IS NOT new.${indexedField} OR old.project_key IS NOT new.project_key
        BEGIN
          INSERT INTO ${fts} (${fts}, rowid, content, ${indexedField}, project_key)
            VALUES ('delete', old.rowid, old.content, old.${indexedField}, old.project_key);
          INSERT INTO ${fts} (rowid, content, ${indexedField}, project_key)
            VALUES (new.rowid, new.content, new.${indexedField}, new.project_key);
        END;
      `);
    }
  },
}, {
  version: 8,
  up(db) {
    db.exec(`
      CREATE TABLE note_comments (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        body TEXT NOT NULL CHECK (length(trim(body)) > 0),
        from_status TEXT CHECK (from_status IN ('active', 'pending', 'dismissed')),
        to_status TEXT CHECK (to_status IN ('active', 'pending', 'dismissed')),
        source_orchestrator TEXT,
        source_session_id TEXT,
        compacted_from_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((from_status IS NULL AND to_status IS NULL) OR
          (from_status IS NOT NULL AND to_status IS NOT NULL AND from_status <> to_status))
      );
      CREATE INDEX idx_note_comments_note_created ON note_comments (note_id, created_at, id);
      CREATE TRIGGER note_transition_no_update BEFORE UPDATE ON note_comments
      WHEN old.from_status IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'Status-transition comments are immutable');
      END;
      CREATE TRIGGER note_transition_no_delete BEFORE DELETE ON note_comments
      WHEN old.from_status IS NOT NULL AND EXISTS (SELECT 1 FROM notes WHERE id = old.note_id)
      BEGIN
        SELECT RAISE(ABORT, 'Status-transition comments are immutable');
      END;
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
  const { busyTimeoutMs = 5000 } = options;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new RangeError('busyTimeoutMs must be a positive integer');
  }
  if (!readOnly && typeof dbPath === 'string' && dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.min(busyTimeoutMs, 2 ** 31 - 1)}; PRAGMA foreign_keys = ON;`);
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
