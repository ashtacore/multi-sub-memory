import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashNormalizedContent, openDatabase } from '../src/db.mjs';
import { openReadOnlySnapshot } from '../src/importers/common.mjs';
import { runImport } from '../src/importers/runner.mjs';
import { listMemories } from '../src/memory-service.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const digest = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const noSidecars = (filename) => {
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(filename + suffix), false, filename + suffix);
};

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-import-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function cliEnv(root, dbPath) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:MULTI_SUB_MEMORY_|HOME$|USERPROFILE$)/i.test(key)));
  return {
    ...env, HOME: root, USERPROFILE: root, MULTI_SUB_MEMORY_CONFIG: path.join(root, 'missing-config.jsonc'),
    ...(dbPath ? { MULTI_SUB_MEMORY_DB: dbPath } : {}),
  };
}

function makeDb(filename, schema) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(schema);
  } finally {
    db.close();
  }
}

function fixture(t) {
  const root = tempRoot(t);
  const dbPath = path.join(root, 'target', 'memory.db');
  const cwd = path.join(root, 'workspace');
  const magicDir = path.join(root, 'magic');
  const magicContextDb = path.join(magicDir, 'context.db');
  const mnemopiDir = path.join(root, 'mnemopi');
  const defaultBank = path.join(mnemopiDir, 'mnemopi.db');
  const alphaBank = path.join(mnemopiDir, 'banks', 'alpha', 'mnemopi.db');
  const notesDir = path.join(root, 'notes');
  const projectMapPath = path.join(root, 'project-map.json');
  for (const directory of [cwd, magicDir, path.join(notesDir, 'nested')]) fs.mkdirSync(directory, { recursive: true });
  const { projectKey } = resolveProjectKey(cwd);
  fs.writeFileSync(projectMapPath, JSON.stringify({ 'dir:explicit-legacy': cwd, 'by-filename.md': projectKey, alpha: projectKey }));
  for (const [host, header] of Object.entries({
    omp: { type: 'session', cwd }, claude: { cwd }, codex: { payload: { cwd } },
  })) fs.writeFileSync(path.join(magicDir, `${host}.jsonl`), '{broken}\n' + JSON.stringify(header) + '\n');

  makeDb(magicContextDb, `
    CREATE TABLE session_projects (project_path TEXT, session_id TEXT, jsonl_path TEXT);
    INSERT INTO session_projects VALUES
      ('git:omp-legacy', 'omp-fixture', 'omp.jsonl'), ('dir:claude-legacy', 'claude-fixture', 'claude.jsonl'),
      ('dir:codex-legacy', 'codex-fixture', 'codex.jsonl');
    CREATE TABLE memories (id TEXT, project_path TEXT, status TEXT, content TEXT, category TEXT, importance REAL,
      source_session_id TEXT, verification_status TEXT, verified_at TEXT, created_at, updated_at);
    INSERT INTO memories VALUES
      ('mc-1', 'git:omp-legacy', 'active', 'Synthetic project architecture', 'design', 4.8,
        'omp-fixture', 'verified', '2025-01-02T00:00:00Z', 1735689600, '2025-01-02T00:00:00Z'),
      ('mc-2', 'global', 'active', 'Shared fixture convention', 'rules', 0,
        NULL, NULL, NULL, 1735689600000, 1735689600000),
      ('mc-archived', 'dir:explicit-legacy', 'archived', 'Archived fixture', 'process', 3,
        NULL, NULL, NULL, 1735689600, 1735689600),
      ('mc-old', 'dir:explicit-legacy', 'superseded', 'Superseded fixture', 'general', 3,
        NULL, NULL, NULL, 1735689600, 1735689600);
    CREATE TABLE notes (content TEXT, status TEXT, project_path TEXT, surface_condition TEXT,
      source_session_id TEXT, created_at INTEGER, updated_at INTEGER);
    INSERT INTO notes VALUES
      ('Check the fixture', 'pending', 'dir:claude-legacy', 'During review', 'claude-fixture', 1735689600, 1735689601),
      ('Preserve the example', 'active', 'dir:codex-legacy', NULL, 'codex-fixture', 1735689600, 1735689601),
      ('Dismissed fixture', 'dismissed', 'global', NULL, NULL, 1735689600, 1735689601);
  `);
  makeDb(defaultBank, `
    CREATE TABLE memories (id INTEGER, text TEXT, category TEXT, metadata_json TEXT);
    INSERT INTO memories VALUES
      (1, '  SHARED fixture   convention ', 'rules', NULL),
      (2, 'Reworded project architecture', 'design', '{"magicContextId":"mc-1"}'),
      (3, 'New global fixture', 'settings', '{"magicContextId":"mc-standalone","label":"legacy"}');
  `);
  makeDb(alphaBank, `
    CREATE TABLE memories (id INTEGER, content TEXT, magicContextId TEXT, project_path TEXT);
    INSERT INTO memories VALUES (1, 'Reworded global convention', 'mc-2', NULL), (2, 'Bank memory fixture', NULL, '   ');
    CREATE TABLE facts (fact_id INTEGER, fact TEXT, importance REAL, metadata TEXT);
    INSERT INTO facts VALUES (1, 'Bank fact fixture', 2.2, '{"label":"fact"}');
  `);
  fs.writeFileSync(path.join(notesDir, 'nested', 'mapped.md'), [
    '---', 'project: dir:explicit-legacy', "surface_condition: 'During review'", '---',
    '- [ ] check the  fixture', '* [ ] New project note fixture', '- [x] Checked fixture', '* [X] Checked fixture', '- [ ]   ',
    '```md', '- [ ] Fenced fixture', '```', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(notesDir, 'by-filename.md'), '- [ ] Filename mapping fixture\n');
  fs.writeFileSync(path.join(notesDir, 'global.md'), '- [ ] Global note fixture\n');

  return { root, homeDir: root, cwd, dbPath, projectKey, projectMapPath, magicContextDb, mnemopiDir, notesDir,
    sqliteFiles: [magicContextDb, defaultBank, alphaBank], sourceDirs: [magicDir, mnemopiDir, notesDir] };
}

function sourceState({ sqliteFiles, sourceDirs }) {
  return {
    hashes: sqliteFiles.map(digest),
    entries: sourceDirs.map((dir) => fs.readdirSync(dir, { recursive: true }).sort()),
  };
}

test('all sources preserve provenance, deduplicate across schemas, and rerun idempotently', (t) => {
  const options = fixture(t);
  const { dbPath, projectKey, sqliteFiles } = options;
  const before = sourceState(options);
  const report = runImport({ ...options, from: 'all' });
  assert.deepEqual(Object.keys(report.sources), ['magic-context', 'mnemopi', 'notes']);
  assert.deepEqual(report.totals, {
    memoriesImported: 5, memoriesSkippedDuplicate: 3, memoriesSkippedUnresolved: 0,
    notesImported: 5, notesSkippedDuplicate: 1, notesSkippedUnresolved: 0,
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.allSourceFilesUnmodified, true);
  assert.deepEqual(report.sourceFiles, sqliteFiles.map((filename, index) => ({
    path: filename, sha256Before: before.hashes[index], sha256After: before.hashes[index], unmodified: true,
  })));

  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const memory = db.prepare('SELECT * FROM memories WHERE content = ?');
    const architecture = memory.get('Synthetic project architecture');
    assert.equal(architecture.project_key, projectKey);
    assert.equal(architecture.scope, 'project');
    assert.equal(architecture.category, 'ARCHITECTURE');
    assert.equal(architecture.importance, 5);
    assert.equal(architecture.source_session_id, 'omp-fixture');
    assert.equal(architecture.created_at, 1735689600000);
    assert.equal(architecture.updated_at, 1735776000000);
    assert.deepEqual(JSON.parse(architecture.metadata_json), {
      imported_from: 'magic-context', magic_context_id: 'mc-1', verification_status: 'verified', verified_at: '2025-01-02T00:00:00Z',
      magic_context_category: 'design', magic_context_importance: 4.8,
    });
    assert.equal(memory.get('Shared fixture convention').importance, 1);
    assert.equal(memory.get('New global fixture').scope, 'global');
    assert.equal(JSON.parse(memory.get('New global fixture').metadata_json).magic_context_id, 'mc-standalone');
    const bankMemory = memory.get('Bank memory fixture');
    assert.equal(bankMemory.project_key, projectKey);
    assert.equal(bankMemory.scope, 'project');
    const fact = memory.get('Bank fact fixture');
    assert.equal(fact.project_key, projectKey);
    assert.equal(fact.importance, 2);
    assert.deepEqual(JSON.parse(fact.metadata_json), { label: 'fact', imported_from: 'mnemopi', mnemopi_bank: 'alpha', mnemopi_id: 1 });
    assert.equal(memory.get('Archived fixture'), undefined);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memories_fts WHERE memories_fts MATCH 'architecture'").get().count, 1);

    const note = db.prepare('SELECT * FROM notes WHERE content = ?');
    const legacyNote = note.get('Check the fixture');
    assert.equal(legacyNote.project_key, projectKey);
    assert.equal(legacyNote.source_session_id, 'claude-fixture');
    assert.equal(legacyNote.status, 'pending');
    assert.equal(legacyNote.surface_condition, 'During review');
    assert.equal(legacyNote.updated_at, 1735689601000);
    assert.equal(note.get('Preserve the example').project_key, projectKey);
    assert.equal(note.get('Filename mapping fixture').project_key, projectKey);
    const markdownNote = note.get('New project note fixture');
    assert.equal(markdownNote.source_orchestrator, 'markdown-notes');
    assert.equal(markdownNote.status, 'active');
    assert.equal(markdownNote.project_key, projectKey);
    assert.equal(markdownNote.surface_condition, 'During review');
    assert.equal(note.get('Global note fixture').project_key, 'global');
    for (const content of ['Checked fixture', 'Fenced fixture', 'Dismissed fixture']) assert.equal(note.get(content), undefined);
  } finally {
    db.close();
  }

  const rerun = runImport({ ...options, from: 'all' });
  assert.deepEqual(rerun.totals, {
    memoriesImported: 0, memoriesSkippedDuplicate: 8, memoriesSkippedUnresolved: 0,
    notesImported: 0, notesSkippedDuplicate: 6, notesSkippedUnresolved: 0,
  });
  const archive = runImport({ ...options, from: 'magic-context', includeArchived: true });
  assert.equal(archive.totals.memoriesImported, 1);
  const snapshot = openReadOnlySnapshot(dbPath);
  try {
    const archived = snapshot.db.prepare("SELECT status, category, project_key FROM memories WHERE content = 'Archived fixture'").get();
    assert.deepEqual({ ...archived }, { status: 'archived', category: 'WORKFLOW', project_key: projectKey });
    assert.equal(snapshot.db.prepare("SELECT 1 FROM memories WHERE status = 'superseded'").get(), undefined);
  } finally {
    snapshot.close();
  }
  assert.deepEqual(sourceState(options), before);
  for (const filename of sqliteFiles) noSidecars(filename);
});

test('Magic Context resolves blank projects from session headers and honors explicit global scope', (t) => {
  const root = tempRoot(t);
  const magicContextDb = path.join(root, 'context.db');
  const dbPath = path.join(root, 'target.db');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'session.jsonl'), JSON.stringify({ payload: { cwd } }) + '\n');
  makeDb(magicContextDb, `
    CREATE TABLE session_projects (project_path TEXT, session_id TEXT, jsonl_path TEXT);
    INSERT INTO session_projects VALUES ('dir:legacy-fixture', 'fixture-session', 'session.jsonl');
    CREATE TABLE memories (id TEXT, content TEXT, project_path TEXT, scope TEXT, source_session_id TEXT);
    INSERT INTO memories VALUES
      ('fixture-memory', 'Session memory fixture', NULL, 'project', 'fixture-session'),
      ('fixture-global', 'Global memory fixture', 'dir:legacy-fixture', ' GLOBAL ', 'fixture-session');
    CREATE TABLE notes (content TEXT, project_path TEXT, source_session_id TEXT, session_id TEXT);
    INSERT INTO notes VALUES
      ('Session note fixture', '', 'fixture-session', NULL),
      ('Session ID alias fixture', '  ', NULL, 'fixture-session');
  `);

  runImport({ from: 'magic-context', dbPath, magicContextDb, homeDir: root });
  const { projectKey } = resolveProjectKey(cwd);
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const memory = db.prepare('SELECT project_key, scope FROM memories WHERE content = ?');
    assert.deepEqual({ ...memory.get('Session memory fixture') }, { project_key: projectKey, scope: 'project' });
    assert.deepEqual({ ...memory.get('Global memory fixture') }, { project_key: 'global', scope: 'global' });
    const note = db.prepare('SELECT project_key, source_session_id FROM notes WHERE content = ?');
    for (const content of ['Session note fixture', 'Session ID alias fixture']) {
      assert.deepEqual({ ...note.get(content) }, { project_key: projectKey, source_session_id: 'fixture-session' });
    }
  } finally {
    db.close();
  }
});

test('unresolved Magic Context records stay out of recall until the session is mapped', (t) => {
  const root = tempRoot(t);
  const magicContextDb = path.join(root, 'context.db');
  const dbPath = path.join(root, 'target.db');
  const cwd = path.join(root, 'workspace');
  const unrelatedCwd = path.join(root, 'unrelated');
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  gitEnv.GIT_CONFIG_GLOBAL = path.join(root, 'absent-gitconfig');
  for (const directory of [cwd, unrelatedCwd]) {
    fs.mkdirSync(directory);
    const git = spawnSync('git', ['init', '--template='], {
      cwd: directory, env: gitEnv, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(git.error);
    assert.equal(git.status, 0, git.stderr);
  }
  const { projectKey } = resolveProjectKey(cwd);
  assert.notEqual(resolveProjectKey(unrelatedCwd).projectKey, projectKey);
  makeDb(magicContextDb, `
    CREATE TABLE session_projects (session_id TEXT, jsonl_path TEXT);
    INSERT INTO session_projects VALUES ('missing-session', 'missing.jsonl');
    CREATE TABLE memories (id TEXT, content TEXT, project_path TEXT, scope TEXT, session_id TEXT);
    INSERT INTO memories VALUES ('memory-id', 'Private project fixture', '', ' Project ', ' missing-session ');
    CREATE TABLE notes (id TEXT, content TEXT, project_path TEXT, scope TEXT, session_id TEXT);
    INSERT INTO notes VALUES ('note-id', 'Private note fixture', NULL, 'project', 'missing-session');
  `);
  const options = { from: 'magic-context', dbPath, magicContextDb, homeDir: root };
  const skipped = runImport(options);
  for (const result of [skipped.totals, skipped.sources['magic-context']]) {
    assert.equal(result.memoriesSkippedUnresolved, 1);
    assert.equal(result.notesSkippedUnresolved, 1);
    assert.equal(result.memoriesImported, 0);
    assert.equal(result.notesImported, 0);
  }
  assert.deepEqual(skipped.errors.map(({ kind, id, sessionId }) => [kind, id, sessionId]), [
    ['memory', 'memory-id', 'missing-session'], ['note', 'note-id', 'missing-session'],
  ]);
  for (const error of skipped.errors) assert.match(error.message, /--project-map/);
  const preview = spawnSync(process.execPath, [cliPath, 'import', '--from', 'magic-context',
    '--magic-context-db', magicContextDb, '--dry-run'], {
    cwd: root, env: cliEnv(root, dbPath), encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.ifError(preview.error);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stderr, /memory.*missing-session.*--project-map/);
  assert.match(preview.stderr, /note.*missing-session.*--project-map/);

  const readTargetProject = () => {
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      assert.deepEqual(listMemories(db, { cwd: unrelatedCwd }), []);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE scope = 'global'").get().count, 0);
      return listMemories(db, { cwd });
    } finally {
      db.close();
    }
  };
  assert.deepEqual(readTargetProject(), []);

  const projectMapPath = path.join(root, 'project-map.json');
  fs.writeFileSync(projectMapPath, JSON.stringify({ 'missing-session': cwd }));
  const retried = runImport({ ...options, projectMapPath });
  assert.deepEqual(retried.errors, []);
  assert.equal(retried.totals.memoriesImported, 1);
  assert.equal(retried.totals.notesImported, 1);
  assert.deepEqual(readTargetProject().map(({ content, project_key, scope, source_session_id }) =>
    [content, project_key, scope, source_session_id]), [['Private project fixture', projectKey, 'project', 'missing-session']]);
});

test('normalized matches save all Magic Context IDs for a separate mnemopi run', (t) => {
  const root = tempRoot(t);
  const magicContextDb = path.join(root, 'context.db');
  const mnemopiDir = path.join(root, 'mnemopi');
  const dbPath = path.join(root, 'target.db');
  makeDb(magicContextDb, `
    CREATE TABLE memories (id TEXT, content TEXT, category TEXT, importance INTEGER, scope TEXT);
    INSERT INTO memories VALUES
      ('idA', 'Existing memory fixture', 'design', 5, 'global'),
      ('idB', 'existing memory  FIXTURE', 'rules', 1, 'global');
  `);
  makeDb(path.join(mnemopiDir, 'mnemopi.db'), `
    CREATE TABLE memories (content TEXT, magicContextId TEXT);
    INSERT INTO memories VALUES
      ('First reworded memory fixture', 'idA'),
      ('Second reworded memory fixture', 'idB');
  `);
  const content = 'Existing  MEMORY fixture';
  const originalMetadata = { label: 'original', settings: { retain: true }, magic_context_ids: [42] };
  const target = openDatabase(dbPath);
  let original;
  try {
    target.prepare(`
      INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, importance,
        status, source_orchestrator, metadata_json, created_at, updated_at)
      VALUES ('existing-fixture', 'global', 'global', 'WORKFLOW', ?, ?, 2, 'archived', 'fixture', ?, 1, 2)
    `).run(content, hashNormalizedContent(content), JSON.stringify(originalMetadata));
    original = target.prepare('SELECT * FROM memories').get();
  } finally {
    target.close();
  }

  const beforeDryRun = digest(dbPath);
  const dryRun = runImport({ from: 'magic-context', dbPath, magicContextDb, dryRun: true, homeDir: root });
  assert.equal(dryRun.totals.memoriesSkippedDuplicate, 2);
  assert.equal(digest(dbPath), beforeDryRun);

  for (const options of [{ from: 'magic-context', magicContextDb }, { from: 'mnemopi', mnemopiDir }]) {
    const report = runImport({ ...options, dbPath, homeDir: root });
    assert.equal(report.totals.memoriesImported, 0);
    assert.equal(report.totals.memoriesSkippedDuplicate, 2);
  }
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM memories').all();
    assert.equal(rows.length, 1);
    const { metadata_json: metadata, ...row } = rows[0];
    const { metadata_json: originalJson, ...originalRow } = original;
    assert.deepEqual(row, originalRow);
    assert.deepEqual(JSON.parse(metadata), {
      ...JSON.parse(originalJson), magic_context_id: 'idA', magic_context_ids: ['idA', 42, 'idB'],
      imported_from: 'magic-context', magic_context_category: 'design', magic_context_importance: 5,
      mnemopi_bank: 'default',
    });
  } finally {
    db.close();
  }
});

test('a project Magic Context ID match leaves a global mnemopi row unchanged', (t) => {
  const options = fixture(t);
  const unrelatedCwd = path.join(options.root, 'unrelated');
  fs.mkdirSync(unrelatedCwd);
  runImport({ ...options, from: 'mnemopi' });
  const report = runImport({ ...options, from: 'magic-context' });
  assert.equal(report.totals.memoriesImported, 0);
  assert.equal(report.totals.memoriesSkippedDuplicate, 2);

  const db = openDatabase(options.dbPath, { readOnly: true });
  try {
    const memory = listMemories(db, { cwd: unrelatedCwd }).find(({ content }) => content === 'Reworded project architecture');
    assert.ok(memory);
    assert.equal(memory.scope, 'global');
    assert.equal(memory.source_session_id, null);
    assert.deepEqual(memory.metadata, {
      magicContextId: 'mc-1', imported_from: 'mnemopi', mnemopi_bank: 'default', mnemopi_id: 2, magic_context_id: 'mc-1',
    });
  } finally {
    db.close();
  }
});

for (const [globalId, aliases] of [['A', ['B']], ['G', ['G', 'B']]]) {
  test(`cross-scope Magic Context match on ${globalId} leaves new aliases available in dry-run and live imports`, (t) => {
    const root = tempRoot(t);
    const dbPath = path.join(root, 'target.db');
    const seedSource = path.join(root, 'seed.db');
    const magicContextDb = path.join(root, 'context.db');
    const mixedOwners = globalId === 'G';
    makeDb(seedSource, `
      CREATE TABLE memories (id TEXT, content TEXT, scope TEXT, project_key TEXT);
      INSERT INTO memories VALUES ('${globalId}', 'Global fixture', 'global', NULL);
      ${mixedOwners ? "INSERT INTO memories VALUES ('A', 'Existing project fixture', 'project', 'dir:shared-fixture');" : ''}
    `);
    makeDb(magicContextDb, `
      CREATE TABLE memories (id TEXT, content TEXT, project_key TEXT, metadata_json TEXT, source_session_id TEXT);
      INSERT INTO memories VALUES
        ('A', 'Cross-scope duplicate fixture', 'dir:shared-fixture', '${JSON.stringify({ magic_context_ids: aliases })}', 'project-session'),
        ('B', 'Distinct project fixture', 'dir:shared-fixture', NULL, NULL);
    `);
    const options = { from: 'magic-context', dbPath, magicContextDb, homeDir: root };
    assert.equal(runImport({ ...options, magicContextDb: seedSource }).totals.memoriesImported, mixedOwners ? 2 : 1);

    const readRows = () => {
      const db = openDatabase(dbPath, { readOnly: true });
      try {
        return db.prepare('SELECT * FROM memories ORDER BY content').all();
      } finally {
        db.close();
      }
    };
    const originalRows = readRows();
    const dryRun = runImport({ ...options, dryRun: true });
    assert.equal(dryRun.totals.memoriesImported, 1);
    assert.equal(dryRun.totals.memoriesSkippedDuplicate, 1);
    assert.deepEqual(readRows(), originalRows);

    const live = runImport(options);
    assert.deepEqual(live.totals, dryRun.totals);
    const [project, ...unchangedRows] = readRows();
    assert.deepEqual(unchangedRows, originalRows);
    assert.equal(project.scope, 'project');
    assert.equal(project.project_key, 'dir:shared-fixture');
    assert.equal(project.content, 'Distinct project fixture');
    assert.equal(JSON.parse(project.metadata_json).magic_context_id, 'B');
  });
}

test('same-project Magic Context matches on distinct rows leave new aliases available in dry-run and live imports', (t) => {
  const root = tempRoot(t);
  const dbPath = path.join(root, 'target.db');
  const magicContextDb = path.join(root, 'context.db');
  makeDb(magicContextDb, `
    CREATE TABLE memories (id TEXT, content TEXT, project_key TEXT, metadata_json TEXT);
    INSERT INTO memories VALUES
      ('A', 'Fixture A', 'dir:shared-fixture', NULL),
      ('D', 'Fixture D', 'dir:shared-fixture', NULL),
      ('C', 'Fixture C', 'dir:shared-fixture', '{"magic_context_ids":["A","D","B"]}'),
      ('B', 'Fixture B', 'dir:shared-fixture', NULL);
  `);
  const options = { from: 'magic-context', dbPath, magicContextDb, homeDir: root };
  const dryRun = runImport({ ...options, dryRun: true });
  assert.deepEqual(dryRun.errors, []);
  assert.equal(dryRun.totals.memoriesImported, 3);
  assert.equal(dryRun.totals.memoriesSkippedDuplicate, 1);
  assert.equal(fs.existsSync(dbPath), false);

  const live = runImport(options);
  assert.deepEqual(live.errors, []);
  assert.deepEqual(live.totals, dryRun.totals);
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT content, metadata_json FROM memories ORDER BY content').all();
    assert.deepEqual(rows.map(({ content }) => content), ['Fixture A', 'Fixture B', 'Fixture D']);
    for (const { content, metadata_json } of rows) {
      const metadata = JSON.parse(metadata_json);
      assert.equal(metadata.magic_context_id, content.at(-1));
      assert.equal(metadata.magic_context_ids, undefined);
    }
  } finally {
    db.close();
  }
});

test('Magic Context merges provenance onto same-scope mnemopi rows matched by ID or normalized content', (t) => {
  const root = tempRoot(t);
  const dbPath = path.join(root, 'target.db');
  const magicContextDb = path.join(root, 'context.db');
  const mnemopiDir = path.join(root, 'mnemopi');
  makeDb(path.join(mnemopiDir, 'mnemopi.db'), `
    CREATE TABLE memories (id INTEGER, content TEXT, category TEXT, importance INTEGER, source_session_id TEXT,
      metadata_json TEXT, project_key TEXT);
    INSERT INTO memories VALUES
      (1, 'Reworded fixture', 'rules', 2, NULL,
        '{"magicContextId":"legacy-id","verification_status":null,"verified_at":null}', 'dir:shared-fixture'),
      (2, '  SHARED content fixture', 'rules', 1, 'existing-session', '{"label":"retain","verification_status":"reviewed"}', NULL);
  `);
  makeDb(magicContextDb, `
    CREATE TABLE memories (id TEXT, content TEXT, category TEXT, importance REAL, scope TEXT,
      source_session_id TEXT, verification_status TEXT, verified_at TEXT, project_key TEXT);
    INSERT INTO memories VALUES
      ('legacy-id', 'Original fixture', 'design', 4.8, 'project', 'legacy-session', 'verified', '2025-01-02', 'dir:shared-fixture'),
      ('content-id', 'Shared content fixture', 'design', 4.8, 'global', 'other-session', 'verified', '2025-01-02', NULL);
  `);
  const options = { dbPath, magicContextDb, mnemopiDir, homeDir: root };
  assert.equal(runImport({ ...options, from: 'mnemopi' }).totals.memoriesImported, 2);
  const report = runImport({ ...options, from: 'magic-context' });
  assert.equal(report.totals.memoriesImported, 0);
  assert.equal(report.totals.memoriesSkippedDuplicate, 2);
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM memories').all();
    assert.equal(rows.length, 2);
    const byId = rows.find(({ content }) => content === 'Reworded fixture');
    const byContent = rows.find(({ content }) => content === '  SHARED content fixture');
    for (const row of [byId, byContent]) {
      assert.equal(row.category, 'PROJECT_RULES');
      assert.equal(row.source_orchestrator, 'mnemopi');
      const metadata = JSON.parse(row.metadata_json);
      assert.equal(metadata.imported_from, 'mnemopi');
      assert.equal(metadata.verified_at, '2025-01-02');
      assert.equal(metadata.magic_context_category, 'design');
      assert.equal(metadata.magic_context_importance, 4.8);
    }
    assert.equal(byId.importance, 2);
    assert.equal(byId.scope, 'project');
    assert.equal(byId.project_key, 'dir:shared-fixture');
    assert.equal(byId.source_session_id, 'legacy-session');
    assert.equal(JSON.parse(byId.metadata_json).verification_status, 'verified');
    assert.equal(byContent.importance, 1);
    assert.equal(byContent.source_session_id, 'existing-session');
    assert.equal(JSON.parse(byContent.metadata_json).verification_status, 'reviewed');
    assert.equal(JSON.parse(byContent.metadata_json).magic_context_id, 'content-id');
    assert.equal(JSON.parse(byContent.metadata_json).label, 'retain');
  } finally {
    db.close();
  }
});

test('CLI dry-run reports planned inserts and keeps absent and existing targets read-only', (t) => {
  const options = fixture(t);
  const { root, cwd, dbPath, projectMapPath, magicContextDb, mnemopiDir, notesDir } = options;
  const before = sourceState(options);
  const reportPath = path.join(root, 'reports', 'nested', 'import.json');
  const args = ['import', '--from', 'all', '--json', '--cwd', cwd, '--project-map', projectMapPath,
    '--magic-context-db', magicContextDb, '--mnemopi-dir', mnemopiDir, '--notes-dir', notesDir];
  fs.writeFileSync(path.join(cwd, '.multi-sub-memory.jsonc'), JSON.stringify({ dbPath }));
  function invoke(extra) {
    const result = spawnSync(process.execPath, [cliPath, ...args, ...extra], {
      cwd: root, env: cliEnv(root), encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const planned = invoke(['--dry-run', '--report', reportPath]);
  assert.equal(planned.dryRun, true);
  assert.deepEqual(planned.totals, {
    memoriesImported: 5, memoriesSkippedDuplicate: 3, memoriesSkippedUnresolved: 0,
    notesImported: 5, notesSkippedDuplicate: 1, notesSkippedUnresolved: 0,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), planned);
  assert.equal(fs.existsSync(path.dirname(dbPath)), false);
  const live = invoke([]);
  assert.deepEqual(live.totals, planned.totals);
  const target = digest(dbPath);
  noSidecars(dbPath);
  const repeat = invoke(['--dry-run']);
  assert.deepEqual(repeat.totals, {
    memoriesImported: 0, memoriesSkippedDuplicate: 8, memoriesSkippedUnresolved: 0,
    notesImported: 0, notesSkippedDuplicate: 6, notesSkippedUnresolved: 0,
  });
  assert.equal(digest(dbPath), target);
  noSidecars(dbPath);
  assert.deepEqual(sourceState(options), before);
});

test('snapshots read committed source and target WAL content without touching their sidecars', (t) => {
  const root = tempRoot(t);
  const magicContextDb = path.join(root, 'context.db');
  const dbPath = path.join(root, 'target.db');
  const source = new DatabaseSync(magicContextDb);
  const target = openDatabase(dbPath);
  try {
    source.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE memories (id TEXT, content TEXT, scope TEXT);
      INSERT INTO memories VALUES ('wal-fixture', 'First WAL fixture', 'global'), ('new-fixture', 'Second WAL fixture', 'global');`);
    target.exec(`INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, metadata_json, created_at, updated_at)
      VALUES ('existing', 'global', 'global', 'GENERAL', 'Previously imported WAL fixture', 'fixture-hash',
      '{"magicContextId":"wal-fixture"}', 1, 1);`);
    const files = [magicContextDb, dbPath].flatMap((filename) => [filename, filename + '-wal', filename + '-shm']);
    const before = files.map(digest);
    const entries = fs.readdirSync(root).sort();
    const report = runImport({ from: 'magic-context', dryRun: true, dbPath, magicContextDb, homeDir: root });
    assert.equal(report.totals.memoriesImported, 1);
    assert.equal(report.totals.memoriesSkippedDuplicate, 1);
    assert.deepEqual(files.map(digest), before);
    assert.deepEqual(fs.readdirSync(root).sort(), entries);
  } finally {
    try { target.close(); } finally { source.close(); }
  }
});

test('optional sources fail open and malformed maps fail before target creation', (t) => {
  const homeDir = tempRoot(t);
  const dbPath = path.join(homeDir, 'target', 'memory.db');
  const options = { from: 'all', dryRun: true, dbPath, homeDir, env: {}, defaultNotesDirs: ['~/AgentWork/notes'] };
  const result = runImport(options);
  for (const source of Object.values(result.sources)) {
    assert.equal(source.ran, true);
    assert.equal(source.found, false);
    assert.deepEqual(source.errors, []);
  }
  assert.deepEqual(result.sourceFiles, []);
  assert.equal(result.allSourceFilesUnmodified, true);
  const projectMapPath = path.join(homeDir, 'map.json');
  for (const [content, error] of [['{', /Could not read project map/], ['[]', /must contain a JSON object/]]) {
    fs.writeFileSync(projectMapPath, content);
    assert.throws(() => runImport({ ...options, dryRun: false, projectMapPath }), error);
  }
  assert.equal(fs.existsSync(dbPath), false);

  const notesDir = path.join(homeDir, 'custom-notes');
  fs.mkdirSync(notesDir);
  fs.writeFileSync(path.join(notesDir, 'fixture.md'), '* [ ] Environment fixture\n');
  const notes = runImport({ ...options, from: 'notes', env: { MULTI_SUB_MEMORY_NOTES_DIR: '~/custom-notes' } });
  assert.equal(notes.totals.notesImported, 1);
});

test('Markdown notes scan every default directory once and skip absent directories', (t) => {
  const homeDir = tempRoot(t);
  const dbPath = path.join(homeDir, 'target.db');
  const primary = path.join(homeDir, 'z-first');
  const fallback = path.join(homeDir, 'a-second');
  const nested = path.join(fallback, 'nested');
  const alias = path.join(homeDir, 'fallback-alias');
  const options = { from: 'notes', dbPath, homeDir, dryRun: true, env: {},
    defaultNotesDirs: ['~/z-first', fallback, nested, alias] };

  const absent = runImport(options);
  assert.equal(absent.sources.notes.found, false);
  assert.equal(absent.totals.notesImported, 0);

  fs.mkdirSync(primary, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync(fallback, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const fallbackFile = path.join(nested, 'fixture.md');
  fs.writeFileSync(fallbackFile, '- [ ] First fallback note\n- [ ] Second fallback note\n- [x] Done\n');
  const fallbackTime = new Date('2025-01-02T00:00:00Z');
  fs.utimesSync(fallbackFile, fallbackTime, fallbackTime);
  const emptyFirst = runImport(options);
  assert.equal(emptyFirst.totals.notesImported, 2);
  assert.equal(emptyFirst.totals.notesSkippedDuplicate, 0);

  const primaryFile = path.join(primary, 'fixture.md');
  fs.writeFileSync(primaryFile, '- [ ] Preferred note fixture\n- [ ] FIRST  fallback note\n');
  const primaryTime = new Date('2025-01-01T00:00:00Z');
  fs.utimesSync(primaryFile, primaryTime, primaryTime);
  assert.equal(fs.existsSync(dbPath), false);
  const both = runImport({ ...options, dryRun: false });
  assert.equal(both.totals.notesImported, 3);
  assert.equal(both.totals.notesSkippedDuplicate, 1);
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const notes = db.prepare('SELECT content, updated_at FROM notes ORDER BY content').all();
    assert.deepEqual(notes.map(({ content, updated_at }) => [content, updated_at]), [
      ['FIRST  fallback note', primaryTime.getTime()],
      ['Preferred note fixture', primaryTime.getTime()],
      ['Second fallback note', fallbackTime.getTime()],
    ]);
  } finally {
    db.close();
  }
  const rerun = runImport(options);
  assert.equal(rerun.totals.notesImported, 0);
  assert.equal(rerun.totals.notesSkippedDuplicate, 4);
});

test('notes-only imports protect all legacy SQLite databases and sidecars from writes', (t) => {
  const options = fixture(t);
  const { dbPath, sqliteFiles } = options;
  const before = sourceState(options);
  for (const filename of sqliteFiles) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const legacyPath = filename + suffix;
      assert.throws(() => runImport({ ...options, from: 'notes', dryRun: true, reportPath: legacyPath }), /Choose separate paths/);
      assert.throws(() => runImport({ ...options, from: 'notes', dbPath: legacyPath }), /Choose separate paths/);
    }
  }
  assert.deepEqual(sourceState(options), before);
  assert.equal(fs.existsSync(dbPath), false);

  const homeDir = path.join(options.root, 'isolated-home');
  const defaults = { from: 'notes', dbPath, homeDir, notesDir: options.notesDir };
  for (const filename of [
    path.join(homeDir, '.local', 'share', 'cortexkit', 'magic-context', 'context.db'),
    path.join(homeDir, '.omp', 'agent', 'memories', 'mnemopi', 'mnemopi.db'),
  ]) {
    assert.throws(() => runImport({ ...defaults, dryRun: true, reportPath: filename + '-shm' }), /Choose separate paths/);
    assert.throws(() => runImport({ ...defaults, dbPath: filename }), /Choose separate paths/);
  }
  assert.equal(fs.existsSync(homeDir), false);
});

test('CLI notes dry runs protect default legacy databases when source overrides are supplied', (t) => {
  const { root, dbPath, notesDir, magicContextDb, mnemopiDir, sqliteFiles } = fixture(t);
  const defaultMagic = path.join(root, '.local', 'share', 'cortexkit', 'magic-context', 'context.db');
  const defaultMnemopi = path.join(root, '.omp', 'agent', 'memories', 'mnemopi');
  const cases = [
    ['--magic-context-db', magicContextDb, defaultMagic],
    ['--mnemopi-dir', mnemopiDir, path.join(defaultMnemopi, 'mnemopi.db')],
    ['--mnemopi-dir', mnemopiDir, path.join(defaultMnemopi, 'banks', 'alpha', 'mnemopi.db')],
  ];
  const defaultFiles = cases.map(([, , filename]) => filename);
  for (const [index, filename] of defaultFiles.entries()) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.copyFileSync(sqliteFiles[index], filename);
  }
  const allFiles = [...sqliteFiles, ...defaultFiles];
  const before = allFiles.map(digest);
  for (const [flag, override, reportPath] of cases) {
    const result = spawnSync(process.execPath, [cliPath, 'import', '--from', 'notes', '--dry-run',
      '--notes-dir', notesDir, flag, override, '--report', reportPath], {
      cwd: root, env: cliEnv(root, dbPath), encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Choose separate paths/);
    assert.deepEqual(allFiles.map(digest), before);
  }
  assert.equal(fs.existsSync(dbPath), false);
});

test('a report aliased to an absent target through a directory link is rejected before creation', (t) => {
  const root = tempRoot(t);
  const targetDir = path.join(root, 'target');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(targetDir);
  fs.symlinkSync(targetDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const dbPath = path.join(targetDir, 'nested', 'memory.db');
  const reportPath = path.join(alias, 'nested', 'memory.db');
  assert.throws(() => runImport({ from: 'notes', notesDir: path.join(root, 'missing-notes'), dbPath, reportPath, homeDir: root }),
    /Choose separate paths/);
  assert.equal(fs.existsSync(path.dirname(dbPath)), false);
  assert.equal(fs.existsSync(reportPath), false);
});

test('CLI dry run rejects a report below an absent target database without creating it', (t) => {
  const root = tempRoot(t);
  const dbPath = path.join(root, 'target.db');
  const reportPath = path.join(dbPath, 'reports', 'import.json');
  const result = spawnSync(process.execPath, [cliPath, 'import', '--from', 'notes', '--dry-run',
    '--notes-dir', path.join(root, 'missing-notes'), '--report', reportPath], {
    cwd: root,
    env: cliEnv(root, dbPath),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Choose separate paths/);
  assert.equal(fs.existsSync(dbPath), false);
});

test('CLI live import rejects a target below an absent source database without creating it', (t) => {
  const root = tempRoot(t);
  const magicContextDb = path.join(root, 'absent-context.db');
  const dbPath = path.join(magicContextDb, 'target.db');
  const result = spawnSync(process.execPath, [cliPath, 'import', '--from', 'magic-context',
    '--magic-context-db', magicContextDb], {
    cwd: root,
    env: cliEnv(root, dbPath),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Choose separate paths/);
  assert.equal(fs.existsSync(magicContextDb), false);
});

test('CLI live import rejects a target below a source reached through a dangling directory link', (t) => {
  const root = tempRoot(t);
  const future = path.join(root, 'future');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(future, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const magicContextDb = path.join(alias, 'context.db');
  const dbPath = path.join(future, 'context.db', 'target.db');
  const result = spawnSync(process.execPath, [cliPath, 'import', '--from', 'magic-context',
    '--magic-context-db', magicContextDb], {
    cwd: root,
    env: cliEnv(root, dbPath),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Choose separate paths/);
  assert.equal(fs.existsSync(future), false);
});

test('CLI live import resolves a relative dangling link from its physical parent', (t) => {
  const root = tempRoot(t);
  const work = path.join(root, 'work');
  const store = path.join(root, 'store');
  const nested = path.join(store, 'nested');
  const future = path.join(store, 'future');
  const view = path.join(work, 'view');
  fs.mkdirSync(work);
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync(nested, view, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    fs.symlinkSync('../future', path.join(nested, 'alias'), 'dir');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Creating a relative directory symlink requires additional privileges (EPERM)');
    return;
  }

  const magicContextDb = path.join(view, 'alias', 'context.db');
  const dbPath = path.join(future, 'context.db', 'target.db');
  const result = spawnSync(process.execPath, [cliPath, 'import', '--from', 'magic-context',
    '--magic-context-db', magicContextDb], {
    cwd: root,
    env: cliEnv(root, dbPath),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Choose separate paths/);
  assert.equal(fs.existsSync(future), false);
});

test('a session header read during project mapping is protected from report and database writes', (t) => {
  const options = fixture(t);
  const { dbPath, magicContextDb } = options;
  const sessionPath = path.join(path.dirname(magicContextDb), 'omp.jsonl');
  const before = digest(sessionPath);

  for (const dryRun of [true, false]) {
    assert.throws(() => runImport({ ...options, from: 'magic-context', reportPath: sessionPath, dryRun }), /Choose separate paths/);
  }
  assert.throws(() => runImport({ ...options, from: 'magic-context', dbPath: sessionPath }), /Choose separate paths/);
  assert.equal(digest(sessionPath), before);
  assert.equal(fs.existsSync(path.dirname(dbPath)), false);
});

test('overlapping paths are rejected and a failed source rolls back earlier inserts', (t) => {
  const options = fixture(t);
  const { dbPath, magicContextDb, sqliteFiles } = options;
  const before = sourceState(options);
  assert.throws(() => runImport({ ...options, from: 'all', dbPath: magicContextDb }), /Choose separate paths/);
  assert.throws(() => runImport({ ...options, from: 'all', dryRun: true, reportPath: sqliteFiles[1] + '-wal' }), /Choose separate paths/);
  assert.deepEqual(sourceState(options), before);
  assert.equal(fs.existsSync(dbPath), false);

  fs.writeFileSync(sqliteFiles[1], 'Malformed SQLite fixture');
  assert.throws(() => runImport({ ...options, from: 'all' }), /database|SQLite/i);
  const snapshot = openReadOnlySnapshot(dbPath);
  try {
    assert.equal(snapshot.db.prepare('SELECT count(*) AS count FROM memories').get().count, 0);
    assert.equal(snapshot.db.prepare('SELECT count(*) AS count FROM notes').get().count, 0);
  } finally {
    snapshot.close();
  }
  assert.equal(digest(magicContextDb), before.hashes[0]);
});
