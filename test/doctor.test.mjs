import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/cli/doctor.mjs';
import { writeConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { createEmbeddingEngine, DEFAULT_EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL } from '../src/embeddings.mjs';
import { initGit, writeProjectConfig } from './git-fixtures.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(cwd);
  const dbPath = path.join(cwd, 'memory #1.db');
  const configPath = path.join(cwd, 'settings.yaml');
  const data = { dbPath: path.basename(dbPath), embedding: { enabled: false } };
  writeConfig(configPath, data);
  const env = {};
  const invoke = async (args = [], overrides = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await runDoctor(['--config', configPath, ...args], {
      cwd, homeDir, env, ...overrides,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    return { code, stdout, stderr };
  };
  return { cwd, homeDir, dbPath, configPath, data, env, invoke };
}

test('doctor reports integrity, WAL and table counts for a healthy database', async (t) => {
  const { cwd, homeDir, dbPath, invoke } = fixture(t);
  const db = openDatabase(dbPath);
  try {
    db.prepare('INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('fixture-note', 'fixture-project', 'Fixture content', 1, 1);
  } finally {
    db.close();
  }
  const before = fs.readFileSync(dbPath);
  const sessions = path.join(homeDir, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'codex.toml'), '[mcp_servers.multi-sub-memory]\ncommand = "npx"\nargs = ["-y", "multi-sub-memory"]\n');
  const filesBefore = fs.readdirSync(cwd);
  assert.ok(!filesBefore.some((file) => /-(wal|shm)$/.test(file)));
  const args = ['--cwd', cwd, '--home', homeDir, '--codex-config', 'codex.toml'];
  const table = await invoke(args);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /PASS\s+Database integrity/);
  assert.match(table.stdout, /notes=1/);
  assert.match(table.stdout, /WARN\s+omp/);
  const result = await invoke(['--json', ...args]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.find(({ counts }) => counts).counts, {
    memories: 0, notes: 1, transcript_files: 0, transcript_messages: 0, dream_runs: 0,
  });
  assert.equal(report.checks.find(({ journalMode }) => journalMode).journalMode, 'wal');
  assert.deepEqual(report.checks.find(({ check }) => check === 'codex').existingTranscriptDirs, [sessions]);
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(cwd), filesBefore);
});

test('doctor counts committed WAL rows with an active writer and with a WAL lacking SHM', async (t) => {
  const { cwd, dbPath, invoke } = fixture(t);
  const writer = openDatabase(dbPath);
  try {
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0;');
    const insert = writer.prepare('INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('fixture-note', 'fixture-project', 'Committed in WAL', 1, 1);
    assert.ok(fs.statSync(dbPath + '-wal').size > 0);
    assert.ok(fs.existsSync(dbPath + '-shm'));

    const orphanedPath = path.join(cwd, 'orphaned.db');
    fs.copyFileSync(dbPath, orphanedPath);
    fs.copyFileSync(dbPath + '-wal', orphanedPath + '-wal');
    const filesBefore = fs.readdirSync(cwd);
    for (const file of [dbPath, orphanedPath]) {
      const result = await invoke(['--json', '--db', file]);
      assert.equal(result.code, 0, result.stdout);
      const { checks } = JSON.parse(result.stdout);
      assert.equal(checks.find(({ counts }) => counts).counts.notes, 1);
      assert.equal(checks.find(({ journalMode }) => journalMode).journalMode, 'wal');
      assert.deepEqual(fs.readdirSync(cwd), filesBefore);
    }
    assert.equal(writer.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    insert.run('second-note', 'fixture-project', 'Writer still works', 2, 2);
    assert.equal(writer.prepare('SELECT count(*) AS count FROM notes').get().count, 2);
  } finally {
    writer.close();
  }
});

test('doctor retries when a writer commits and checkpoints during a snapshot of a closed database', async (t) => {
  const { cwd, dbPath, invoke } = fixture(t);
  openDatabase(dbPath).close();
  const sourcePath = fs.realpathSync(dbPath);
  const filesBefore = fs.readdirSync(cwd);
  assert.ok(!filesBefore.some((file) => /-(wal|shm)$/.test(file)));

  const originalSize = fs.statSync(sourcePath).size;
  const copyFile = fs.copyFileSync;
  const snapshotCopies = [];
  t.mock.method(fs, 'copyFileSync', (source, destination) => {
    copyFile(source, destination);
    if (source !== sourcePath) return;
    snapshotCopies.push(destination);
    if (snapshotCopies.length !== 1) return;

    const writer = openDatabase(sourcePath);
    try {
      writer.exec('PRAGMA wal_autocheckpoint = 0');
      // Grow the database so the metadata differs even on filesystems with coarse timestamps.
      writer.prepare('INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('fixture-note', 'fixture-project', 'x'.repeat(64 * 1024), 1, 1);
      const { busy } = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      assert.equal(busy, 0);
    } finally {
      writer.close();
    }
    assert.ok(fs.statSync(sourcePath).size > originalSize);
    assert.deepEqual(fs.readdirSync(cwd), filesBefore);
  });

  const result = await invoke(['--json']);
  assert.equal(result.code, 0, result.stdout);
  const { checks } = JSON.parse(result.stdout);
  const counts = checks.find(({ check }) => check === 'Database counts');
  assert.equal(counts.status, 'pass');
  assert.equal(counts.counts.notes, 1);
  assert.equal(snapshotCopies.length, 2);
  const snapshotDirectory = path.dirname(snapshotCopies[0]);
  assert.notEqual(snapshotDirectory, cwd);
  assert.equal(fs.existsSync(snapshotDirectory), false);
  assert.deepEqual(fs.readdirSync(cwd), filesBefore);
});

test('doctor recopies the checkpointed database when the last writer closes during snapshot acquisition', async (t) => {
  const { cwd, dbPath, invoke } = fixture(t);
  const writer = openDatabase(dbPath);
  let writerOpen = true;
  try {
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0;');
    writer.prepare('INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('fixture-note', 'fixture-project', 'Committed before writer shutdown', 1, 1);
    assert.ok(fs.statSync(dbPath + '-wal').size > 0);
    assert.ok(fs.existsSync(dbPath + '-shm'));

    const sourcePath = fs.realpathSync(dbPath);
    const copyFile = fs.copyFileSync;
    const snapshotCopies = [];
    t.mock.method(fs, 'copyFileSync', (source, destination) => {
      copyFile(source, destination);
      if (source === sourcePath) {
        snapshotCopies.push(destination);
        if (writerOpen) {
          writer.close();
          writerOpen = false;
          assert.equal(fs.existsSync(dbPath + '-wal'), false);
          assert.equal(fs.existsSync(dbPath + '-shm'), false);
        }
      }
    });

    const result = await invoke(['--json']);
    assert.equal(result.code, 0, result.stdout);
    const { checks } = JSON.parse(result.stdout);
    assert.equal(checks.find(({ counts }) => counts).counts.notes, 1);
    assert.equal(checks.find(({ journalMode }) => journalMode).journalMode, 'wal');
    assert.equal(snapshotCopies.length, 2);
    assert.equal(snapshotCopies[0], snapshotCopies[1]);
    assert.notEqual(path.dirname(snapshotCopies[0]), cwd);
    assert.equal(fs.existsSync(path.dirname(snapshotCopies[0])), false);
    assert.deepEqual(fs.readdirSync(cwd).sort(), [path.basename(dbPath), 'settings.yaml'].sort());
  } finally {
    if (writerOpen) writer.close();
  }
});

test('doctor retries a snapshot when an open writer truncates the WAL after the main file is copied', async (t) => {
  const { cwd, dbPath, invoke } = fixture(t);
  const writer = openDatabase(dbPath);
  try {
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0;');
    writer.prepare('INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('fixture-note', 'fixture-project', 'Committed before checkpoint', 1, 1);
    const sourcePath = fs.realpathSync(dbPath);
    const walPath = sourcePath + '-wal';
    assert.ok(fs.statSync(walPath).size > 0);
    const filesBefore = fs.readdirSync(cwd);

    const copyFile = fs.copyFileSync;
    const snapshotCopies = [];
    t.mock.method(fs, 'copyFileSync', (source, destination) => {
      copyFile(source, destination);
      if (source === sourcePath) {
        snapshotCopies.push(destination);
        if (snapshotCopies.length === 1) {
          writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          assert.equal(fs.statSync(walPath).size, 0);
        }
      }
    });

    const result = await invoke(['--json']);
    assert.equal(result.code, 0, result.stdout);
    const { checks } = JSON.parse(result.stdout);
    const counts = checks.find(({ check }) => check === 'Database counts');
    assert.equal(counts.status, 'pass');
    assert.equal(counts.counts.notes, 1);
    assert.equal(snapshotCopies.length, 2);
    assert.equal(fs.existsSync(path.dirname(snapshotCopies[0])), false);
    assert.deepEqual(fs.readdirSync(cwd), filesBefore);
  } finally {
    writer.close();
  }
});

test('doctor warns without reporting counts when writes change every snapshot attempt', async (t) => {
  const { cwd, dbPath, invoke } = fixture(t);
  const writer = openDatabase(dbPath);
  try {
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0;');
    const insert = writer.prepare('INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('initial-note', 'fixture-project', 'Committed before snapshot', 1, 1);
    const sourcePath = fs.realpathSync(dbPath);
    const filesBefore = fs.readdirSync(cwd);

    const copyFile = fs.copyFileSync;
    const snapshotCopies = [];
    t.mock.method(fs, 'copyFileSync', (source, destination) => {
      copyFile(source, destination);
      if (source === sourcePath) {
        snapshotCopies.push(destination);
        insert.run('retry-note-' + snapshotCopies.length, 'fixture-project', 'Committed during snapshot', 2, 2);
      }
    });

    const result = await invoke(['--json']);
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    const warning = report.checks.find(({ check }) => check === 'Database');
    assert.equal(warning.status, 'warn');
    assert.match(warning.message, /actively changing during snapshot acquisition/);
    assert.match(warning.remediation, /Rerun doctor when write activity settles/);
    assert.equal(report.checks.some(({ counts }) => counts !== undefined), false);
    assert.equal(snapshotCopies.length, 4);
    assert.equal(fs.existsSync(path.dirname(snapshotCopies[0])), false);
    assert.deepEqual(fs.readdirSync(cwd), filesBefore);
  } finally {
    writer.close();
  }
});

test('doctor reports disabled embeddings without creating an engine', async (t) => {
  const { dbPath, invoke } = fixture(t);
  openDatabase(dbPath).close();
  const createEngine = t.mock.fn();

  const result = await invoke(['--json'], { createEmbeddingEngine: createEngine });
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout).checks.find(({ check }) => check === 'Embeddings');
  assert.deepEqual(report, {
    check: 'Embeddings', status: 'pass', mode: 'fts-only',
    message: 'Disabled; running in FTS-only mode', model: DEFAULT_EMBEDDING_MODEL, expectedDims: DEFAULT_EMBEDDING_DIMS,
  });
  assert.equal(createEngine.mock.callCount(), 0);
});

test('doctor warns when the optional Transformers.js package is missing', async (t) => {
  const { dbPath, configPath, data, invoke } = fixture(t);
  openDatabase(dbPath).close();
  writeConfig(configPath, { ...data, embedding: { enabled: true } });
  // This test covers the missing-package branch even with optional dependencies installed.
  let entry;
  try {
    entry = fileURLToPath(import.meta.resolve('@huggingface/transformers'));
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  if (entry) {
    const statSync = fs.statSync;
    t.mock.method(fs, 'statSync', (file, options) => file === entry ? undefined : statSync(file, options));
  }
  const result = await invoke(['--json']);
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout).checks.find(({ check }) => check === 'Embeddings');
  assert.equal(report.status, 'warn');
  assert.equal(report.mode, 'fts-only');
  assert.equal(report.model, DEFAULT_EMBEDDING_MODEL);
  assert.equal(report.expectedDims, DEFAULT_EMBEDDING_DIMS);
  assert.equal(Object.hasOwn(report, 'observedDims'), false);
  assert.match(report.remediation, /Install the optional Transformers\.js dependency/);
});

test('doctor reports dimensions from successful local-cache-only inference', async (t) => {
  const { dbPath, configPath, data, env, invoke } = fixture(t);
  openDatabase(dbPath).close();
  writeConfig(configPath, { ...data, embedding: { enabled: true } });
  const extractor = t.mock.fn(async () => new Float32Array(DEFAULT_EMBEDDING_DIMS).fill(1));
  const pipeline = t.mock.fn(async () => extractor);
  const createEngine = t.mock.fn((options) => createEmbeddingEngine({
    ...options, loader: async () => ({ pipeline }),
  }));

  const result = await invoke(['--json'], { createEmbeddingEngine: createEngine });
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout).checks.find(({ check }) => check === 'Embeddings');
  assert.deepEqual(report, {
    check: 'Embeddings', status: 'pass', mode: 'onnx', message: 'ONNX ready (768 dimensions).',
    model: DEFAULT_EMBEDDING_MODEL, expectedDims: DEFAULT_EMBEDDING_DIMS, observedDims: DEFAULT_EMBEDDING_DIMS,
  });
  assert.equal(createEngine.mock.calls[0].arguments[0].env, env);
  assert.deepEqual(pipeline.mock.calls[0].arguments, [
    'feature-extraction', DEFAULT_EMBEDDING_MODEL, { local_files_only: true },
  ]);
  assert.equal(extractor.mock.calls[0].arguments[0], 'multi-sub-memory doctor check');
});

test('doctor warns and omits observed dimensions when local inference fails', async (t) => {
  const { dbPath, configPath, data, invoke } = fixture(t);
  openDatabase(dbPath).close();
  writeConfig(configPath, { ...data, embedding: { enabled: true } });
  const embed = t.mock.fn(async () => null);
  const createEngine = t.mock.fn(() => ({ embed }));

  const result = await invoke(['--json'], { createEmbeddingEngine: createEngine });
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout).checks.find(({ check }) => check === 'Embeddings');
  assert.equal(report.status, 'warn');
  assert.equal(report.mode, 'fts-only');
  assert.equal(report.model, DEFAULT_EMBEDDING_MODEL);
  assert.equal(report.expectedDims, DEFAULT_EMBEDDING_DIMS);
  assert.equal(Object.hasOwn(report, 'observedDims'), false);
  assert.match(report.remediation, /Run setup to download and verify the model/);
  assert.deepEqual(createEngine.mock.calls[0].arguments[0].pipelineOptions, { local_files_only: true });
  assert.deepEqual(embed.mock.calls[0].arguments, ['multi-sub-memory doctor check']);
});

test('doctor reports missing and corrupt DBs without creating or replacing them', async (t) => {
  const { dbPath, invoke } = fixture(t);
  const missing = await invoke(['--db', dbPath]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /FAIL\s+Database .*missing.*Run setup/);
  assert.equal(fs.existsSync(dbPath), false);

  fs.writeFileSync(dbPath, 'fixture corruption');
  const corrupt = await invoke(['--json']);
  assert.equal(corrupt.code, 1);
  const report = JSON.parse(corrupt.stdout);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(({ check }) => check === 'Database').remediation, /Restore a backup/);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'fixture corruption');
});

test('doctor provides remediation for an invalid or missing explicit config', async (t) => {
  const { dbPath, configPath, data, invoke } = fixture(t);
  writeConfig(configPath, { ...data, dreamer: { mode: 'http', enabled: true } });
  const invalid = await invoke();
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /FAIL\s+Config .*dreamer\.http.*Check YAML/);
  fs.rmSync(configPath);
  const missing = await invoke();
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /FAIL\s+Config .*requested config file missing.*run setup/i);
  assert.equal(fs.existsSync(dbPath), false);
});

test('the HTTP Dreamer probe sends only GET /models and uses the named environment variable', async (t) => {
  const { dbPath, configPath, data, env, invoke } = fixture(t);
  openDatabase(dbPath).close();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.authorization]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"data":[]}');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  writeConfig(configPath, { ...data, dreamer: { enabled: true, mode: 'http', http: {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1/', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY',
  } } });

  const ordinary = await invoke();
  assert.equal(ordinary.code, 0, ordinary.stdout);
  const missingKey = await invoke(['--test-dreamer']);
  assert.equal(missingKey.code, 1);
  assert.match(missingKey.stdout, /environment variable is unset/);
  assert.deepEqual(requests, []);

  env.FIXTURE_KEY = 'placeholder-key';
  const tested = await invoke(['--test-dreamer', '--json']);
  assert.equal(tested.code, 0, tested.stdout);
  assert.deepEqual(requests, [['GET', '/v1/models', 'Bearer placeholder-key']]);
  assert.doesNotMatch(tested.stdout + tested.stderr, /placeholder-key/);
  assert.match(tested.stdout, /GET \/models returned HTTP 200/);
});

test('the Dreamer probe uses the effective YAML key and drops inherited credentials when the endpoint changes', async (t) => {
  const { cwd, dbPath, configPath, data, env, invoke } = fixture(t);
  openDatabase(dbPath).close();
  const requests = [];
  const listen = async (name) => {
    const server = createServer((request, response) => {
      requests.push([name, request.url, request.headers.authorization]);
      response.end('{}');
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port + '/v1';
  };
  const [userUrl, projectUrl] = await Promise.all([listen('user'), listen('project')]);
  initGit(cwd);
  env.USER_FIXTURE_KEY = 'placeholder-user-key';
  env.PROJECT_FIXTURE_KEY = 'placeholder-project-key';
  writeConfig(configPath, { ...data, dreamer: { enabled: true, mode: 'http', http: {
    baseUrl: userUrl, model: 'fixture', apiKeyEnv: 'USER_FIXTURE_KEY',
  } } });

  for (const http of [
    { baseUrl: projectUrl },
    { baseUrl: projectUrl, apiKeyEnv: 'USER_FIXTURE_KEY' },
    { apiKeyEnv: 'PROJECT_FIXTURE_KEY' },
  ]) {
    writeProjectConfig(configPath, cwd, { dreamer: { http } });
    const result = await invoke(['--test-dreamer', '--json']);
    assert.equal(result.code, 0, result.stdout);
    const { checks } = JSON.parse(result.stdout);
    assert.equal(checks.find(({ check }) => check === 'Dreamer probe').status, 'pass');
    assert.doesNotMatch(result.stdout + result.stderr, /placeholder-(user|project)-key/);
  }
  assert.deepEqual(requests, [
    ['project', '/v1/models', undefined],
    ['project', '/v1/models', 'Bearer placeholder-user-key'],
    ['user', '/v1/models', 'Bearer placeholder-project-key'],
  ]);
});

test('the CLI Dreamer probe finds a PATH executable without launching it', async (t) => {
  const { cwd, dbPath, configPath, data, env, invoke } = fixture(t);
  openDatabase(dbPath).close();
  const binDir = path.join(cwd, 'bin');
  fs.mkdirSync(binDir);
  const executable = path.join(binDir, process.platform === 'win32' ? 'omp.exe' : 'omp');
  fs.writeFileSync(executable, 'this fixture cannot run', { mode: 0o700 });
  env.PATH = binDir;
  writeConfig(configPath, { ...data, dreamer: { enabled: true, mode: 'cli', cli: { orchestrator: 'omp' } } });
  const ready = await invoke(['--json', '--test-dreamer']);
  assert.equal(ready.code, 0, ready.stdout);
  assert.equal(JSON.parse(ready.stdout).checks.find(({ check }) => check === 'Dreamer probe').executable, executable);

  fs.rmSync(executable);
  const missing = await invoke(['--test-dreamer']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /FAIL\s+Dreamer probe .*Install the selected orchestrator/);
});

test('the CLI Dreamer probe fails with native-executable guidance for relative paths and shell shims', async (t) => {
  const { cwd, dbPath, configPath, data, env, invoke } = fixture(t);
  openDatabase(dbPath).close();
  const filename = process.platform === 'win32' ? 'omp.exe' : 'omp';
  fs.writeFileSync(path.join(cwd, filename), 'fixture', { mode: 0o700 });
  const commands = ['./' + filename];
  if (process.platform === 'win32') {
    const shims = path.join(cwd, 'shims');
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'omp.cmd'), '@exit /b 1');
    env.PATH = shims;
    commands.push('omp');
  }
  for (const command of commands) {
    writeConfig(configPath, { ...data, dreamer: { enabled: true, mode: 'cli', cli: { orchestrator: 'omp', command } } });
    const result = await invoke(['--test-dreamer']);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /FAIL\s+Dreamer probe .*Dreamer requires a native executable .* on PATH or an absolute executable path/);
  }
});
