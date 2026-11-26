import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { MIGRATIONS, acquireLease, hashNormalizedContent, normalizeContent, openDatabase, releaseLease, runMigrations } from '../src/db.mjs';
import { cosineSimilarity, decodeFloat32Vector, encodeFloat32Vector } from '../src/embeddings.mjs';

import { formatBootstrap } from '../src/bootstrap.mjs';
import { addNoteComment, getMemory, getNote, lastNoteComments, listNoteComments, recordProject, updateNote, updateNoteComment } from '../src/memory-service.mjs';

function databaseFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-db-'));
  const dbPath = path.join(root, 'state', 'memory.db');
  const connections = [];
  t.after(() => {
    try {
      for (const db of connections.reverse()) db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    dbPath,
    open(options) {
      const db = openDatabase(dbPath, options);
      connections.push(db);
      return db;
    },
    openUnmigrated() {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      connections.push(db);
      return db;
    },
  };
}

function addMemory(db, overrides = {}) {
  const memory = {
    id: 'memory', projectKey: 'project', scope: 'project', category: 'GENERAL',
    content: 'originalmemory', importance: 3, status: 'active', ...overrides,
  };
  db.prepare(`
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash,
      importance, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(memory.id, memory.projectKey, memory.scope, memory.category, memory.content,
    hashNormalizedContent(memory.content), memory.importance, memory.status);
}

function count(db, table) {
  return db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
}

function matches(db, table, query) {
  return db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`)
    .all(query).map((row) => row.rowid);
}

test('creates the core schema in WAL mode and preserves the migration record on reopen', (t) => {
  const fixture = databaseFixture(t);
  assert.equal(fs.existsSync(path.dirname(fixture.dbPath)), false);
  const db = fixture.open();
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);

  const schema = db.prepare('SELECT name, type FROM sqlite_schema').all();
  const objects = new Map(schema.map(({ name, type }) => [name, type]));
  for (const table of ['schema_migrations', 'memories', 'memory_embeddings', 'notes', 'note_comments', 'tag_dictionary', 'memory_tags',
    'transcript_files', 'transcript_messages', 'transcript_embeddings', 'dream_runs', 'leases', 'projects', 'project_checkouts']) {
    assert.equal(objects.get(table), 'table', table);
  }
  for (const table of ['memories_fts', 'notes_fts', 'transcript_messages_fts']) {
    assert.equal(objects.get(table), 'table', table);
    for (const operation of ['insert', 'update', 'delete']) {
      const trigger = `${table}_${operation}`;
      assert.equal(objects.get(trigger), 'trigger', trigger);
    }
  }
  for (const index of ['idx_memories_project_status_rank', 'idx_notes_project_status', 'idx_note_comments_note_created', 'idx_memory_tags_tag',
    'idx_transcript_files_session_id', 'idx_transcript_files_project_orchestrator',
    'idx_transcript_messages_file_line_seq', 'idx_dream_runs_project_started']) {
    assert.equal(objects.get(index), 'index', index);
  }

  const selectMigrations = 'SELECT version, applied_at FROM schema_migrations ORDER BY version';
  const migrations = db.prepare(selectMigrations).all();
  assert.deepEqual(migrations.map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(Number.isInteger(migrations[0].applied_at) && migrations[0].applied_at > 0);
  addMemory(db);
  const reopened = fixture.open();
  assert.deepEqual(reopened.prepare(selectMigrations).all(), migrations);
  assert.equal(count(reopened, 'memories'), 1);
});

test('unrestricted transcript expansion queries read messages in index order', (t) => {
  const db = databaseFixture(t).open();
  const queries = [
    `SELECT line_no, role, text, tool_names FROM transcript_messages
      WHERE file_id = ? ORDER BY line_no ASC LIMIT 1`,
    `SELECT line_no, seq, role, text, tool_names FROM transcript_messages
      WHERE file_id = ? ORDER BY line_no ASC, seq ASC`,
  ];
  for (const query of queries) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1).map(({ detail }) => detail).join('\n');
    assert.match(plan, /\bUSING (?:COVERING )?INDEX idx_transcript_messages_file_line_seq\b/i, query);
    assert.doesNotMatch(plan, /TEMP B-TREE/i, query);
  }
});

test('two processes can open and migrate a fresh database concurrently', async (t) => {
  const fixture = databaseFixture(t);
  const readyFiles = ['a.ready', 'b.ready'].map((name) => path.join(fixture.root, name));
  assert.equal(fs.existsSync(fixture.dbPath), false);

  const worker = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { openDatabase } from ${JSON.stringify(new URL('../src/db.mjs', import.meta.url).href)};

    const [dbPath, ownReady, peerReady] = process.argv.slice(1);
    fs.writeFileSync(ownReady, '');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(peerReady)) {
      assert.ok(Date.now() < deadline, 'Other database opener did not reach the barrier');
      await delay(1);
    }
    // Give both processes the same start time after the later arrival.
    const startAt = Math.max(fs.statSync(ownReady).mtimeMs, fs.statSync(peerReady).mtimeMs) + 100;
    await delay(Math.max(0, startAt - Date.now()));

    const db = openDatabase(dbPath);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
        .map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      db.close();
    }
  `;

  const run = promisify(execFile);
  const results = await Promise.allSettled(readyFiles.map((ownReady, index) => run(process.execPath, [
    '--input-type=module', '--eval', worker, '--', fixture.dbPath, ownReady, readyFiles[1 - index],
  ], { timeout: 15000, windowsHide: true })));
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }

  const db = fixture.open({ readOnly: true });
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('rolls back both schema changes and the migration record when migration fails', (t) => {
  const db = databaseFixture(t).openUnmigrated();
  db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY)');
  assert.throws(() => runMigrations(db), /notes already exists/i);
  assert.equal(count(db, 'schema_migrations'), 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'memories'").get(), undefined);
  db.exec('DROP TABLE notes');
  runMigrations(db);
  assert.equal(count(db, 'schema_migrations'), 10);
});

test('adds transcript checkpoints, embedding eligibility, and Dreamer fields to a version 1 database without losing rows', (t) => {
  const db = databaseFixture(t).openUnmigrated();
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 1);
  `);
  MIGRATIONS[0].up(db);
  db.exec(`
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, byte_offset, last_indexed_at)
    VALUES ('fixture.jsonl', 'omp', 'session', 'project', 1, 42, 1);
    INSERT INTO transcript_messages (file_id, seq, role, text, line_no)
    SELECT id, 0, 'user', 'Existing fixture message', 1 FROM transcript_files;
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, created_at, updated_at)
    VALUES ('fixture', 'project', 'project', 'GENERAL', 'Fixture', 'fixture-hash', 1, 1);
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at)
    VALUES ('fixture', 'project', 'fixture', 'completed', 1, 2);
  `);
  runMigrations(db);
  const { byte_offset, line_count, file_identity, project_root } = db.prepare('SELECT * FROM transcript_files').get();
  assert.deepEqual([byte_offset, line_count, file_identity, project_root], [42, null, null, null]);
  const { text, embed_eligible } = db.prepare('SELECT text, embed_eligible FROM transcript_messages').get();
  assert.equal(text, 'Existing fixture message');
  assert.equal(embed_eligible, 0);
  const { content, last_dreamed_at } = db.prepare('SELECT * FROM memories').get();
  assert.deepEqual([content, last_dreamed_at], ['Fixture', null]);
  const { status, last_transcript_message_id } = db.prepare('SELECT * FROM dream_runs').get();
  assert.deepEqual([status, last_transcript_message_id], ['completed', null]);
});

test('reopens a pre-repair version 2 database and adds embedding eligibility without losing rows', (t) => {
  const fixture = databaseFixture(t);
  const db = fixture.openUnmigrated();
  MIGRATIONS[0].up(db);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 1), (2, 2);
    ALTER TABLE transcript_files ADD COLUMN line_count INTEGER;
    ALTER TABLE transcript_files ADD COLUMN file_identity TEXT;
    ALTER TABLE transcript_files ADD COLUMN checkpoint_hash TEXT;
    ALTER TABLE transcript_files ADD COLUMN file_size INTEGER;
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms,
      byte_offset, last_indexed_at, line_count, file_identity, checkpoint_hash, file_size)
    VALUES ('fixture.jsonl', 'omp', 'session', 'project', 1, 42, 1, 2, 'device:inode', 'digest', 48);
    INSERT INTO transcript_messages (file_id, seq, role, text, line_no)
    SELECT id, 0, 'user', 'Existing fixture message', 2 FROM transcript_files;
  `);

  const reopened = fixture.open();
  const migrations = reopened.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(migrations.map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(migrations.slice(0, 2).map(({ applied_at }) => applied_at), [1, 2]);
  const { id, byte_offset, line_count, file_identity, checkpoint_hash, file_size } = reopened
    .prepare('SELECT * FROM transcript_files').get();
  assert.deepEqual([byte_offset, line_count, file_identity, checkpoint_hash, file_size], [42, 2, 'device:inode', 'digest', 48]);

  reopened.prepare(`
    INSERT INTO transcript_messages (file_id, seq, role, text, line_no, embed_eligible)
    VALUES (?, 1, 'assistant', 'New fixture message', 3, 1)
  `).run(id);
  const messages = reopened.prepare('SELECT text, embed_eligible FROM transcript_messages ORDER BY seq').all();
  assert.deepEqual(messages.map(({ text, embed_eligible }) => [text, embed_eligible]), [
    ['Existing fixture message', 0], ['New fixture message', 1],
  ]);
});

test('records migration 3 when an earlier version 2 already added embedding eligibility', (t) => {
  const fixture = databaseFixture(t);
  const db = fixture.openUnmigrated();
  MIGRATIONS[0].up(db);
  MIGRATIONS[1].up(db);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 1), (2, 2);
    ALTER TABLE transcript_messages ADD COLUMN embed_eligible INTEGER NOT NULL DEFAULT 0;
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
    VALUES ('fixture.jsonl', 'omp', 'session', 'project', 1, 1);
    INSERT INTO transcript_messages (file_id, seq, role, text, line_no, embed_eligible)
    SELECT id, 0, 'user', 'Eligible fixture message', 1, 1 FROM transcript_files;
  `);

  const reopened = fixture.open();
  assert.ok(reopened.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get());
  assert.equal(reopened.prepare('SELECT embed_eligible FROM transcript_messages').get().embed_eligible, 1);
});

test('adds Dreamer fields to a version 4 database and preserves completed runs', (t) => {
  const fixture = databaseFixture(t);
  const db = fixture.openUnmigrated();
  MIGRATIONS[0].up(db);
  MIGRATIONS[1].up(db);
  MIGRATIONS[2].up(db);
  MIGRATIONS[3].up(db);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 1), (2, 2), (3, 3), (4, 4);
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at, summary)
    VALUES ('fixture', 'project', 'fixture', 'completed', 1, 2, 'Existing review');
  `);
  const originalRun = db.prepare('SELECT * FROM dream_runs').get();
  const reopened = fixture.open();
  assert.deepEqual(reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual({ ...reopened.prepare('SELECT * FROM dream_runs').get() }, {
    ...originalRun, last_transcript_message_id: null,
  });
});

test('records version 5 and preserves a completed run with existing Dreamer columns', (t) => {
  const fixture = databaseFixture(t);
  const db = fixture.openUnmigrated();
  MIGRATIONS[0].up(db);
  MIGRATIONS[1].up(db);
  MIGRATIONS[2].up(db);
  MIGRATIONS[3].up(db);
  db.exec(`
    ALTER TABLE transcript_files ADD COLUMN project_root TEXT;
    ALTER TABLE memories ADD COLUMN last_dreamed_at INTEGER;
    ALTER TABLE dream_runs ADD COLUMN last_transcript_message_id INTEGER;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 1), (2, 2), (3, 3), (4, 4);
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at, last_transcript_message_id)
    VALUES ('fixture', 'project', 'fixture', 'completed', 1, 2, 42);
  `);

  const reopened = fixture.open();
  assert.deepEqual(reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const { status, last_transcript_message_id } = reopened.prepare(
    'SELECT status, last_transcript_message_id FROM dream_runs WHERE id = ?',
  ).get('fixture');
  assert.equal(status, 'completed');
  assert.equal(last_transcript_message_id, 42);
});

test('migration 7 preserves existing rows and handles access columns already present', (t) => {
  const fixture = databaseFixture(t);
  const db = fixture.openUnmigrated();
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const { version, up } of MIGRATIONS.slice(0, 6)) {
    up(db);
    db.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(version);
  }
  addMemory(db);
  db.exec(`
    INSERT INTO notes (id, project_key, content, created_at, updated_at)
    VALUES ('note', 'project', 'originalnote', 1, 1);
    ALTER TABLE notes ADD COLUMN last_accessed_at INTEGER;
  `);

  const reopened = fixture.open();
  for (const [table, term] of [['memories', 'originalmemory'], ['notes', 'originalnote']]) {
    const read = () => ({ ...reopened.prepare(`SELECT last_accessed_at, access_count FROM ${table}`).get() });
    assert.deepEqual(read(), { last_accessed_at: null, access_count: 0 });
    assert.equal(matches(reopened, `${table}_fts`, term).length, 1);
    assert.throws(() => reopened.exec(`UPDATE ${table} SET access_count = -1`), /CHECK constraint failed/);
    assert.throws(() => reopened.exec(`UPDATE ${table} SET access_count = NULL`), /NOT NULL constraint failed/);
    reopened.exec(`UPDATE ${table} SET last_accessed_at = 123, access_count = 2`);
  }
  reopened.exec('DELETE FROM schema_migrations WHERE version = 7');
  const reapplied = fixture.open();
  for (const table of ['memories', 'notes']) {
    assert.deepEqual({ ...reapplied.prepare(`SELECT last_accessed_at, access_count FROM ${table}`).get() },
      { last_accessed_at: 123, access_count: 2 });
  }
  assert.ok(reapplied.prepare('SELECT 1 FROM schema_migrations WHERE version = 7').get());
});

test('migration 10 preserves registry roots and orders repeat writes with identical timestamps', (t) => {
  const fixture = databaseFixture(t);
  const db = fixture.openUnmigrated();
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const { version, up } of MIGRATIONS.filter(({ version }) => version < 10)) {
    up(db);
    db.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(version);
  }
  db.exec("INSERT INTO projects VALUES ('fixture', '/first', 1)");
  const reopened = fixture.open();
  const checkouts = reopened.prepare(
    "SELECT project_root FROM project_checkouts WHERE project_key = 'fixture' ORDER BY last_used_order DESC",
  );
  assert.deepEqual(checkouts.all().map(({ project_root }) => project_root), ['/first']);
  recordProject(reopened, 'fixture', '/second', 1);
  assert.deepEqual(checkouts.all().map(({ project_root }) => project_root), ['/second', '/first']);
  recordProject(reopened, 'fixture', '/third', 1);
  recordProject(reopened, 'fixture', '/first', 1);
  assert.deepEqual(checkouts.all().map(({ project_root }) => project_root), ['/first', '/third', '/second']);
});

test('read-only connections allow reads, reject writes, and skip migrations and directory creation', (t) => {
  const fixture = databaseFixture(t);
  const missingPath = path.join(fixture.root, 'missing', 'nested', 'memory.db');
  assert.throws(() => openDatabase(missingPath, { readOnly: true }));
  assert.equal(fs.existsSync(path.join(fixture.root, 'missing')), false);

  const db = fixture.openUnmigrated();
  db.exec('CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES (\'existing\');');
  const readOnly = fixture.open({ readOnly: true });
  assert.equal(readOnly.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(readOnly.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(readOnly.prepare('SELECT value FROM fixture').get().value, 'existing');
  assert.throws(() => readOnly.exec("INSERT INTO fixture VALUES ('new')"), /readonly/i);
  assert.equal(readOnly.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get(), undefined);
});

test('WAL lets a writer commit while another connection holds a read snapshot', (t) => {
  const fixture = databaseFixture(t);
  const writer = fixture.open();
  const reader = fixture.open();
  reader.exec('BEGIN');
  assert.equal(count(reader, 'memories'), 0);

  writer.exec('BEGIN IMMEDIATE');
  addMemory(writer);
  assert.equal(count(reader, 'memories'), 0);
  writer.exec('COMMIT');
  assert.equal(count(reader, 'memories'), 0);
  reader.exec('COMMIT');

  assert.equal(count(reader, 'memories'), 1);
  addMemory(reader, { id: 'second', content: 'secondmemory' });
  assert.equal(count(writer, 'memories'), 2);
});

test('memory search follows writes and deleting a memory cascades to its embedding', (t) => {
  const db = databaseFixture(t).open();
  addMemory(db);
  const rowid = db.prepare('SELECT rowid FROM memories').get().rowid;
  assert.deepEqual(matches(db, 'memories_fts', 'content:originalmemory category:general'), [rowid]);
  db.exec("UPDATE memories SET content = 'revisedmemory', category = 'DECISIONS' WHERE id = 'memory'");
  assert.deepEqual(matches(db, 'memories_fts', 'originalmemory OR category:general'), []);
  assert.deepEqual(matches(db, 'memories_fts', 'content:revisedmemory category:decisions'), [rowid]);

  db.prepare('INSERT INTO memory_embeddings VALUES (?, ?, ?, ?, ?)')
    .run('memory', 'fixture-model', 2, encodeFloat32Vector([0.5, -1]), 1);
  const { vector } = db.prepare('SELECT vector FROM memory_embeddings').get();
  assert.deepEqual(decodeFloat32Vector(vector), new Float32Array([0.5, -1]));

  db.exec("DELETE FROM memories WHERE id = 'memory'");
  assert.deepEqual(matches(db, 'memories_fts', 'revisedmemory'), []);
  assert.equal(count(db, 'memory_embeddings'), 0);
});

test('compares a live vector with a SQLite embedding BLOB', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  addMemory(db);
  db.prepare('INSERT INTO memory_embeddings VALUES (?, ?, ?, ?, ?)')
    .run('memory', 'fixture-model', 1, encodeFloat32Vector([-1]), 1);
  const { vector } = db.prepare('SELECT vector FROM memory_embeddings').get();
  assert.ok(vector instanceof Uint8Array);
  assert.equal(cosineSimilarity(new Float32Array([1]), vector), -1);
});

test('note search follows content and surface condition changes', (t) => {
  const db = databaseFixture(t).open();
  const insert = db.prepare(`
    INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, 1, 1)
  `).run('note', 'project', 'originalnote');
  const rowid = insert.lastInsertRowid;
  assert.deepEqual(matches(db, 'notes_fts', 'content:originalnote project_key:project'), [rowid]);
  db.exec("UPDATE notes SET content = 'revisednote', surface_condition = 'release' WHERE id = 'note'");
  assert.deepEqual(matches(db, 'notes_fts', 'originalnote'), []);
  assert.deepEqual(matches(db, 'notes_fts', 'content:revisednote surface_condition:release'), [rowid]);
  db.exec("DELETE FROM notes WHERE id = 'note'");
  assert.deepEqual(matches(db, 'notes_fts', 'revisednote OR release'), []);
});

test('transcript search follows writes and file deletion cascades through messages and embeddings', (t) => {
  const db = databaseFixture(t).open();
  const file = db.prepare(`
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
    VALUES ('fixture.jsonl', 'fixture', 'session', 'project', 1, 1)
  `).run().lastInsertRowid;
  const insert = db.prepare(`
    INSERT INTO transcript_messages (file_id, seq, role, text, tool_names, line_no)
    VALUES (?, ?, 'assistant', ?, ?, ?)
  `);
  const first = insert.run(file, 1, 'originalmessage', 'originaltool', 1).lastInsertRowid;
  assert.throws(() => db.exec(`
    INSERT INTO transcript_embeddings (message_id, model_id, dims, vector)
    VALUES (NULL, 'fixture-model', 1, X'0000803F')
  `), /NOT NULL constraint failed: transcript_embeddings\.message_id/);
  assert.deepEqual(matches(db, 'transcript_messages_fts', 'text:originalmessage role:assistant'), [first]);
  db.prepare('UPDATE transcript_messages SET text = ?, tool_names = ? WHERE id = ?')
    .run('revisedmessage', 'revisedtool', first);
  assert.deepEqual(matches(db, 'transcript_messages_fts', 'originalmessage OR originaltool'), []);
  assert.deepEqual(matches(db, 'transcript_messages_fts', 'text:revisedmessage tool_names:revisedtool'), [first]);
  db.prepare('DELETE FROM transcript_messages WHERE id = ?').run(first);
  assert.deepEqual(matches(db, 'transcript_messages_fts', 'revisedmessage OR revisedtool'), []);

  const second = insert.run(file, 2, 'cascadedmessage', null, 2).lastInsertRowid;
  db.prepare('INSERT INTO transcript_embeddings VALUES (?, ?, ?, ?)')
    .run(second, 'fixture-model', 1, encodeFloat32Vector([1]));
  assert.deepEqual(matches(db, 'transcript_messages_fts', 'cascadedmessage'), [second]);
  db.prepare('DELETE FROM transcript_files WHERE id = ?').run(file);
  assert.equal(count(db, 'transcript_messages'), 0);
  assert.equal(count(db, 'transcript_embeddings'), 0);
  assert.deepEqual(matches(db, 'transcript_messages_fts', 'cascadedmessage'), []);
});

test('enforces schema constraints and deduplicates content per project and scope', (t) => {
  const db = databaseFixture(t).open();
  assert.throws(() => addMemory(db, { id: null }), /NOT NULL constraint failed: memories\.id/);
  assert.throws(() => db.exec(`
    INSERT INTO memory_embeddings (memory_id, model_id, dims, vector, updated_at)
    VALUES (NULL, 'fixture-model', 1, X'0000803F', 1)
  `), /NOT NULL constraint failed: memory_embeddings\.memory_id/);
  assert.throws(() => db.exec(`
    INSERT INTO notes (project_key, content, created_at, updated_at)
    VALUES ('project', 'fixture', 1, 1)
  `), /NOT NULL constraint failed: notes\.id/);
  assert.throws(() => db.exec(`
    INSERT INTO dream_runs (project_key, runner, status, started_at)
    VALUES ('project', 'fixture-runner', 'running', 1)
  `), /NOT NULL constraint failed: dream_runs\.id/);
  assert.throws(() => db.exec(`
    INSERT INTO leases (owner, acquired_at, expires_at) VALUES ('fixture-owner', 1, 2)
  `), /NOT NULL constraint failed: leases\.lease_key/);

  for (const overrides of [{ scope: 'other' }, { category: 'other' }, { importance: 0 },
    { importance: 6 }, { status: 'other' }]) {
    assert.throws(() => addMemory(db, overrides), /CHECK constraint failed/);
  }
  assert.throws(() => db.exec(`
    INSERT INTO notes (id, project_key, status, content, created_at, updated_at)
    VALUES ('note', 'project', 'other', 'fixture', 1, 1)
  `), /CHECK constraint failed/);
  addMemory(db);
  assert.throws(() => addMemory(db, { id: 'duplicate', content: ' ORIGINALMEMORY ' }), /UNIQUE constraint failed/);
  addMemory(db, { id: 'another-project', projectKey: 'another' });
  addMemory(db, { id: 'global', scope: 'global' });
  assert.equal(count(db, 'memories'), 3);
});

test('leases support owner renewal, expiry takeover and owner-only release', (t) => {
  const fixture = databaseFixture(t);
  const first = fixture.open();
  const second = fixture.open();
  assert.throws(() => acquireLease(first, 'index', 'alpha', 0, 100), RangeError);
  assert.throws(() => acquireLease(first, 'index', 'alpha', -1, 100), RangeError);
  assert.throws(() => acquireLease(first, 'index', 'alpha', Infinity, 100), RangeError);
  assert.equal(acquireLease(first, 'index', 'alpha', 10, 100), true);
  assert.equal(acquireLease(second, 'index', 'beta', 10, 105), false);
  assert.equal(acquireLease(first, 'index', 'alpha', 10, 105), true);
  assert.equal(acquireLease(second, 'index', 'beta', 10, 114), false);
  assert.equal(acquireLease(second, 'index', 'beta', 10, 115), true);
  assert.equal(releaseLease(first, 'index', 'alpha'), false);
  assert.equal(releaseLease(second, 'index', 'beta'), true);
  assert.equal(releaseLease(second, 'index', 'beta'), false);
});

test('normalizes whitespace and case before hashing content', () => {
  assert.equal(normalizeContent(' \t Hello\r\n  WORLD \u00a0'), 'hello world');
  assert.equal(hashNormalizedContent('   A\n BC  '), hashNormalizedContent('a bc'));
  assert.equal(hashNormalizedContent(' ABC '), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('migration 8 preserves existing topics and defines the comment constraints and cascade', (t) => {
  const fixture = databaseFixture(t);
  const legacy = fixture.openUnmigrated();
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const { version, up } of MIGRATIONS.slice(0, 7)) {
    up(legacy);
    legacy.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(version);
  }
  legacy.exec("INSERT INTO notes (id, project_key, status, content, created_at, updated_at) VALUES ('legacy', 'project', 'pending', 'topicterm', 7, 9)");
  const previous = getNote(legacy, 'legacy');
  const readOnly = fixture.open({ readOnly: true });
  const { text } = formatBootstrap(readOnly, { project: { projectKey: 'project', displayName: 'Project' } });
  assert.match(text, /<active-notes>\n- \[pending\] topicterm\n<\/active-notes>/);
  const db = fixture.open();
  assert.deepEqual(getNote(db, 'legacy'), previous);
  assert.deepEqual(listNoteComments(db, 'legacy'), { comments: [], next_cursor: null });
  assert.throws(() => db.exec(`
    INSERT INTO note_comments (note_id, body, created_at, updated_at)
    VALUES ('legacy', 'Missing ID', 1, 1)
  `), /NOT NULL constraint failed: note_comments\.id/);
  assert.throws(() => db.exec(`
    INSERT INTO note_comments (id, note_id, body, created_at, updated_at)
    VALUES (NULL, 'legacy', 'Null ID', 1, 1)
  `), /NOT NULL constraint failed: note_comments\.id/);
  const insert = db.prepare(`
    INSERT INTO note_comments (id, note_id, body, from_status, to_status, created_at, updated_at)
    VALUES ('first', ?, ?, ?, ?, 1, 1)
  `);
  assert.throws(() => insert.run('missing', 'progressterm', null, null), /FOREIGN KEY/);
  for (const fields of [[' ', null, null], ['text', null, 'active'], ['text', 'active', null],
    ['text', 'active', 'active'], ['text', 'invalid', 'active']]) {
    assert.throws(() => insert.run('legacy', ...fields), /CHECK/);
  }
  insert.run('legacy', 'progressterm', null, null);
  updateNote(db, { id: 'legacy', status: 'active', comment: 'Migration complete' });
  assert.throws(() => db.exec("UPDATE note_comments SET body = 'changed' WHERE from_status IS NOT NULL"), /immutable/);
  assert.throws(() => db.exec('DELETE FROM note_comments WHERE from_status IS NOT NULL'), /immutable/);
  assert.equal(matches(db, 'notes_fts', 'topicterm').length, 1);
  assert.deepEqual(matches(db, 'notes_fts', 'progressterm'), []);
  db.exec("DELETE FROM notes WHERE id = 'legacy'");
  assert.equal(count(db, 'note_comments'), 0);
  assert.deepEqual(matches(db, 'notes_fts', 'topicterm'), []);
});

test('note comment mutations are atomic and use separate topic and comment revisions', (t) => {
  const db = databaseFixture(t).open();
  db.exec(`
    INSERT INTO notes (id, project_key, status, content, created_at, updated_at)
    VALUES ('topic', 'project', 'pending', 'Topic', 1, 1), ('other', 'project', 'active', 'Other', 1, 1);
    CREATE TRIGGER reject_status BEFORE UPDATE OF status ON notes
      WHEN new.status = 'active' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;
  `);
  const before = getNote(db, 'topic');
  const transition = { id: 'topic', status: 'active', comment: 'Ready for review' };
  assert.throws(() => updateNote(db, transition), /fixture rollback/);
  assert.deepEqual(getNote(db, 'topic'), before);
  assert.equal(count(db, 'note_comments'), 0);
  db.exec('DROP TRIGGER reject_status');
  const active = updateNote(db, transition);
  const [reason] = lastNoteComments(db, 'topic');
  assert.deepEqual([reason.from_status, reason.to_status, reason.body], ['pending', 'active', transition.comment]);
  assert.ok(active.updated_at > before.updated_at);
  assert.throws(() => updateNoteComment(db, { note_id: 'topic', id: reason.id, body: 'changed' }), /immutable/);

  const { note, comment } = addNoteComment(db, { id: 'topic', body: 'Progress' });
  assert.ok(note.updated_at > active.updated_at);
  assert.equal(comment.created_at, comment.updated_at);
  assert.deepEqual([comment.from_status, comment.to_status], [null, null]);
  assert.throws(() => updateNoteComment(db, { note_id: 'other', id: comment.id, body: 'changed' }), /not found/);
  const edited = updateNoteComment(db, { note_id: 'topic', id: comment.id, body: 'Updated progress' },
    { expectedUpdatedAt: String(comment.updated_at) });
  assert.equal(edited.created_at, comment.created_at);
  assert.ok(edited.updated_at > comment.updated_at);
  assert.deepEqual(getNote(db, 'topic'), note);
  assert.throws(() => updateNoteComment(db, { note_id: 'topic', id: comment.id, body: 'Stale edit' },
    { expectedUpdatedAt: String(comment.updated_at) }), /modified by another writer/);

  const insert = db.prepare(`
    INSERT INTO note_comments (id, note_id, body, created_at, updated_at) VALUES (?, 'topic', 'Tied', ?, ?)
  `);
  const latest = Math.max(reason.created_at, comment.created_at) + 1;
  for (const id of ['tie-a', 'tie-c', 'tie-b']) insert.run(id, latest, latest);
  assert.deepEqual(lastNoteComments(db, 'topic').map(({ id }) => id), ['tie-c', 'tie-b', 'tie-a']);
});

test('migration 9 preserves v8 data, is idempotent, and cascades tag assignments', (t) => {
  const fixture = databaseFixture(t);
  const legacy = fixture.openUnmigrated();
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const { version, up } of MIGRATIONS.slice(0, 8)) {
    up(legacy);
    legacy.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(version);
  }
  addMemory(legacy, { category: 'DECISIONS' });
  const original = legacy.prepare('SELECT * FROM memories').get();

  const db = fixture.open();
  assert.deepEqual(db.prepare('SELECT * FROM memories').get(), original);
  assert.equal(getMemory(db, 'memory').category, 'DECISIONS');
  assert.deepEqual(getMemory(db, 'memory').tags, []);
  db.exec("INSERT INTO tag_dictionary VALUES ('project', 'release', '', 1, 1)");
  assert.throws(() => db.exec("INSERT INTO tag_dictionary VALUES ('project', 'Invalid', '', 1, 1)"), /CHECK/);
  db.exec("INSERT INTO memory_tags VALUES ('memory', 'release')");
  assert.throws(() => db.exec("INSERT INTO memory_tags VALUES ('missing', 'release')"), /FOREIGN KEY/);
  MIGRATIONS.at(-1).up(db);
  runMigrations(db);
  assert.deepEqual(getMemory(db, 'memory').tags, ['release']);
  db.exec("DELETE FROM memories WHERE id = 'memory'");
  assert.equal(count(db, 'memory_tags'), 0);
  assert.equal(count(db, 'tag_dictionary'), 1);
});
