import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ompHook, { createBeforeAgentStartHandler } from '../hooks/omp/index.mjs';
import { formatBootstrap } from '../src/bootstrap.mjs';
import { effectiveDatabaseFilePath, loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { renderHookBootstrap } from '../src/hooks/render-bootstrap.mjs';
import { writeMemory, writeNote } from '../src/memory-service.mjs';

const claudeScript = fileURLToPath(new URL('../hooks/claude/session-start.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const cwd = path.join(root, 'workspace');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(homeDir);
  const dbPath = path.join(root, 'memory.db');
  const userConfigPath = path.join(root, 'fixture.jsonc');
  const env = { MULTI_SUB_MEMORY_DB: dbPath, MULTI_SUB_MEMORY_CONFIG: userConfigPath };
  return { cwd, homeDir, dbPath, userConfigPath, env, timeoutMs: 3000 };
}

async function populate(options, existingDb) {
  const db = existingDb ?? openDatabase(options.dbPath);
  try {
    await writeMemory(db, { content: 'Fixture architecture', category: 'ARCHITECTURE', cwd: options.cwd });
    writeNote(db, { content: 'Fixture handoff', cwd: options.cwd });
    return formatBootstrap(db, { cwd: options.cwd, config: loadConfig(options) }).text;
  } finally {
    if (!existingDb) db.close();
  }
}

function assertNoSidecars(dbPath) {
  assert.equal(fs.existsSync(dbPath + '-wal'), false);
  assert.equal(fs.existsSync(dbPath + '-shm'), false);
  assert.equal(fs.existsSync(dbPath + '-journal'), false);
}

test('database connections can override the default busy timeout', (t) => {
  const { dbPath } = fixture(t);
  const db = openDatabase(dbPath);
  try {
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  } finally {
    db.close();
  }
  const reader = openDatabase(dbPath, { readOnly: true, busyTimeoutMs: 75 });
  try {
    assert.equal(reader.prepare('PRAGMA busy_timeout').get().timeout, 75);
  } finally {
    reader.close();
  }
});

test('hook bootstrap matches the shared formatter and leaves the source untouched', async (t) => {
  const options = fixture(t);
  const expected = await populate(options);
  const original = fs.readFileSync(options.dbPath);
  assert.match(expected, /<project-memory /);
  assert.match(expected, /<active-notes>/);
  assert.equal(await renderHookBootstrap(options), expected);
  assert.deepEqual(fs.readFileSync(options.dbPath), original);
  assertNoSidecars(options.dbPath);
});

test('hook bootstrap includes committed WAL data before and after the last writer closes', async (t) => {
  const options = fixture(t);
  const db = openDatabase(options.dbPath);
  let expected;
  try {
    expected = await populate(options, db);
    assert.match(expected, /Fixture handoff/);
    const walPath = options.dbPath + '-wal';
    const wal = fs.readFileSync(walPath);
    assert.ok(wal.length > 0);
    assert.equal(await renderHookBootstrap(options), expected);
    assert.deepEqual(fs.readFileSync(walPath), wal);
  } finally {
    db.close();
  }
  assertNoSidecars(options.dbPath);
  assert.equal(await renderHookBootstrap(options), expected);
  assertNoSidecars(options.dbPath);
});

test('hook bootstrap leaves no sidecars before and after a rollback database switches to WAL', async (t) => {
  const options = fixture(t);
  const expected = await populate(options);
  const rollbackWriter = new DatabaseSync(options.dbPath);
  try {
    assert.equal(rollbackWriter.prepare('PRAGMA journal_mode = DELETE').get().journal_mode, 'delete');
  } finally {
    rollbackWriter.close();
  }
  assert.equal(await renderHookBootstrap(options), expected);
  assertNoSidecars(options.dbPath);

  const walWriter = new DatabaseSync(options.dbPath);
  try {
    assert.equal(walWriter.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal');
  } finally {
    walWriter.close();
  }
  assert.equal(await renderHookBootstrap(options), expected);
  assertNoSidecars(options.dbPath);
});

test('hook bootstrap respects an exclusive WAL writer without a shared-memory sidecar', async (t) => {
  const options = fixture(t);
  await populate(options);
  const writer = new DatabaseSync(options.dbPath);
  try {
    writer.exec(`PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL;
      UPDATE notes SET content = 'Committed by the exclusive writer';`);
    assert.ok(fs.statSync(options.dbPath + '-wal').size > 0);
    assert.equal(fs.existsSync(options.dbPath + '-shm'), false);
    assert.equal(await renderHookBootstrap({ ...options, timeoutMs: 750 }), '');
    assert.equal(fs.existsSync(options.dbPath + '-shm'), false);
  } finally {
    writer.close();
  }
});

test('hook bootstrap matches MCP storage opened through a percent-encoded SQLite file URL', async (t) => {
  const options = fixture(t);
  options.dbPath = path.join(path.dirname(options.dbPath), 'memory fixture.db');
  options.env.MULTI_SUB_MEMORY_DB = pathToFileURL(options.dbPath).href + '?mode=ro';
  await populate(options);
  assertNoSidecars(options.dbPath);
  const actual = await renderHookBootstrap(options);
  assertNoSidecars(options.dbPath);

  const config = loadConfig(options);
  const db = openDatabase(config.dbPath, { readOnly: true });
  try {
    const expected = formatBootstrap(db, { cwd: options.cwd, config }).text;
    assert.match(expected, /Fixture handoff/);
    assert.equal(actual, expected);
  } finally {
    db.close();
  }
});

test('hook bootstrap fails open when MCP cannot open a SQLite URI with an unavailable VFS', async (t) => {
  const options = fixture(t);
  await populate(options);
  options.env.MULTI_SUB_MEMORY_DB = pathToFileURL(options.dbPath).href + '?vfs=nonexistent-vfs';
  const config = loadConfig(options);
  assert.throws(() => openDatabase(config.dbPath, { readOnly: true }), /no such vfs/i);
  assert.equal(effectiveDatabaseFilePath(config.dbPath), options.dbPath);
  assert.equal(await renderHookBootstrap(options), '');
  assertNoSidecars(options.dbPath);
});

test('hook bootstrap rejects conflicting SQLite URI modes while setup still resolves the path', async (t) => {
  const options = fixture(t);
  await populate(options);
  options.env.MULTI_SUB_MEMORY_DB = pathToFileURL(options.dbPath).href + '?mode=ro&mode=rw';
  const config = loadConfig(options);
  assert.throws(() => openDatabase(config.dbPath, { readOnly: true }), /access mode not allowed/i);
  assert.equal(await renderHookBootstrap(options), '');
  assertNoSidecars(options.dbPath);
  assert.equal(effectiveDatabaseFilePath(config.dbPath, options), options.dbPath);
});

test('hook bootstrap preserves a nonempty WAL beside a zero-byte database', async (t) => {
  const options = fixture(t);
  const walPath = options.dbPath + '-wal';
  const wal = Buffer.from('Fixture WAL sentinel');
  fs.writeFileSync(options.dbPath, '');
  fs.writeFileSync(walPath, wal);

  assert.equal(await renderHookBootstrap(options), '');
  assert.deepEqual(fs.readFileSync(walPath), wal);
  assert.equal(fs.existsSync(options.dbPath + '-shm'), false);
});

test('hook bootstrap fails open for missing, empty, corrupt, and malformed inputs', async (t) => {
  const options = fixture(t);
  assert.equal(await renderHookBootstrap(options), '');
  assert.equal(fs.existsSync(options.dbPath), false);
  assertNoSidecars(options.dbPath);
  openDatabase(options.dbPath).close();
  assert.equal(await renderHookBootstrap(options), '');
  assertNoSidecars(options.dbPath);
  fs.writeFileSync(options.dbPath, Buffer.alloc(100, 'invalid SQLite'));
  assert.equal(await renderHookBootstrap(options), '');
  assertNoSidecars(options.dbPath);

  fs.unlinkSync(options.dbPath);
  await populate(options);
  fs.writeFileSync(options.userConfigPath, '{ malformed');
  assert.equal(await renderHookBootstrap(options), '');
  assertNoSidecars(options.dbPath);
});

test('hook bootstrap skips expired reads and an in-progress rollback journal', async (t) => {
  const options = fixture(t);
  await populate(options);
  for (const timeoutMs of [0, -1, Infinity, NaN, 0.001]) {
    assert.equal(await renderHookBootstrap({ ...options, timeoutMs }), '');
  }
  const db = openDatabase(options.dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; UPDATE notes SET content = 'Uncommitted';");
    assert.equal(await renderHookBootstrap(options), '');
  } finally {
    db.close();
  }
  assertNoSidecars(options.dbPath);
});

test('hook bootstrap respects a rollback exclusive lock before the first write', async (t) => {
  const options = fixture(t);
  await populate(options);
  const db = openDatabase(options.dbPath);
  try {
    db.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
    assertNoSidecars(options.dbPath);
    assert.equal(await renderHookBootstrap({ ...options, timeoutMs: 750 }), '');
    assertNoSidecars(options.dbPath);
    db.exec('ROLLBACK');
    assert.match(await renderHookBootstrap(options), /Fixture handoff/);
  } finally {
    db.close();
  }
  assertNoSidecars(options.dbPath);
});

test('OMP registers only before_agent_start and leaves conversation state alone', () => {
  const events = [];
  ompHook({ on: (name) => events.push(name) });
  assert.deepEqual(events, ['before_agent_start']);
  const source = fs.readFileSync(new URL('../hooks/omp/index.mjs', import.meta.url), 'utf8');
  assert.deepEqual(Array.from(source.matchAll(/\.on\(\s*['"]([^'"]+)['"]/g), (match) => match[1]), ['before_agent_start']);
  assert.doesNotMatch(source, /\b(?:context|before_provider_request|session_tree|messages)\b/);
});

test('OMP reuses the session result and appends it to the current prompt', async (t) => {
  const options = fixture(t);
  const expected = await populate(options);
  const handler = createBeforeAgentStartHandler(options);
  const ctx = { cwd: options.cwd, sessionManager: { getSessionId: () => 'first' } };
  const event = Object.freeze({ systemPrompt: 'Original host prompt' });
  const segments = Object.freeze(['first', 'second']);
  assert.deepEqual(await handler(Object.freeze({ systemPrompt: segments }), ctx), {
    systemPrompt: ['first', 'second', expected],
  });
  assert.deepEqual(await handler(event, ctx), { systemPrompt: 'Original host prompt\n\n' + expected });
  assert.deepEqual(await handler({ systemPrompt: '' }, ctx), { systemPrompt: expected });
  fs.unlinkSync(options.dbPath);
  assert.deepEqual(await handler({ systemPrompt: 'Next host prompt' }, ctx), {
    systemPrompt: 'Next host prompt\n\n' + expected,
  });
  assert.equal(await handler(event, { cwd: options.cwd, sessionId: 'second' }), undefined);
  assert.equal(fs.existsSync(options.dbPath), false);
  assertNoSidecars(options.dbPath);
  await populate(options);
  assert.equal(await handler(event, { cwd: options.cwd, sessionId: 'second' }), undefined);
  assert.deepEqual(await handler({ sessionId: 'third', cwd: options.cwd }), { systemPrompt: expected });
});

test('OMP keeps the first populated and empty results after more than 32 session switches', async (t) => {
  const options = fixture(t);
  const renderedSessions = [];
  let activeSessionId;
  const handler = createBeforeAgentStartHandler({
    ...options,
    renderBootstrap(bootstrapOptions) {
      if (activeSessionId.startsWith('filler-')) return '';
      renderedSessions.push(activeSessionId);
      return renderHookBootstrap(bootstrapOptions);
    },
  });
  const start = (sessionId) => {
    activeSessionId = sessionId;
    return handler({ cwd: options.cwd, sessionId });
  };
  assert.equal(await start('initially-empty'), undefined);
  const initial = await populate(options);
  assert.deepEqual(await start('initially-populated'), { systemPrompt: initial });

  const db = openDatabase(options.dbPath);
  try {
    db.prepare('UPDATE notes SET content = ?').run('Updated fixture handoff');
  } finally {
    db.close();
  }
  const updated = await renderHookBootstrap(options);
  assert.match(updated, /Updated fixture handoff/);
  assert.notEqual(updated, initial);
  for (let index = 1; index <= 33; index++) {
    assert.equal(await start(`filler-${index}`), undefined);
  }
  assert.deepEqual(await start('initially-populated'), { systemPrompt: initial });
  assert.equal(await start('initially-empty'), undefined);
  assert.deepEqual(renderedSessions, ['initially-empty', 'initially-populated']);
});

test('OMP fails open on corrupt DB or malformed project config', async (t) => {
  const options = fixture(t);
  const handler = createBeforeAgentStartHandler({ ...options, projectConfigPath: path.join(options.cwd, '.fixture.jsonc') });
  fs.writeFileSync(options.dbPath, 'invalid SQLite');
  assert.equal(await handler({ cwd: options.cwd, sessionId: 'corrupt' }), undefined);
  assertNoSidecars(options.dbPath);
  fs.unlinkSync(options.dbPath);
  await populate(options);
  fs.writeFileSync(path.join(options.cwd, '.fixture.jsonc'), '{ malformed');
  assert.equal(await handler({ cwd: options.cwd, sessionId: 'invalid-config' }), undefined);
});

function claudeOptions(options) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^MULTI_SUB_MEMORY_/i.test(key)) delete env[key];
  }
  return { cwd: options.cwd, env: { ...env, ...options.env }, windowsHide: true };
}

function runClaude(options, input) {
  const child = spawnSync(process.execPath, [claudeScript], {
    ...claudeOptions(options), input, encoding: 'utf8', timeout: 6000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return child.stdout;
}

test('Claude SessionStart prints the formatter result and exits successfully', async (t) => {
  const options = fixture(t);
  const expected = await populate(options);
  assert.equal(runClaude(options, JSON.stringify({ cwd: options.cwd, session_id: 'fixture' })), expected + '\n');
  assertNoSidecars(options.dbPath);
});

test('Claude SessionStart exits quietly for missing/corrupt storage and invalid inputs', async (t) => {
  const options = fixture(t);
  const payload = JSON.stringify({ cwd: options.cwd });
  assert.equal(runClaude(options, payload), '');
  assert.equal(fs.existsSync(options.dbPath), false);
  fs.writeFileSync(options.dbPath, 'invalid SQLite');
  assert.equal(runClaude(options, payload), '');
  assertNoSidecars(options.dbPath);
  fs.unlinkSync(options.dbPath);
  await populate(options);
  for (const input of ['', '{ malformed', 'null', '[]']) {
    assert.equal(runClaude(options, input), '');
  }
  fs.writeFileSync(options.userConfigPath, '{ malformed');
  assert.equal(runClaude(options, payload), '');
});

test('Claude SessionStart exits within its deadline when the Git probe hangs', async (t) => {
  const options = fixture(t);
  await populate(options);
  const probeDir = path.join(options.cwd, 'probe');
  const tempDir = path.join(options.cwd, 'tmp');
  fs.mkdirSync(probeDir);
  fs.mkdirSync(tempDir);
  const marker = path.join(probeDir, 'entered');
  const childOptions = claudeOptions(options);
  const env = childOptions.env;
  for (const key of Object.keys(env)) {
    if (/^(?:path|node_options|tmpdir|tmp|temp)$/i.test(key)) delete env[key];
  }
  env.PATH = probeDir;
  env.TMPDIR = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  env.FIXTURE_GIT_MARKER = marker;
  if (process.platform === 'win32') {
    // Node interprets Git's first argument as the fixture script.
    const gitStub = path.join(probeDir, 'git.exe');
    try {
      fs.linkSync(process.execPath, gitStub);
    } catch (error) {
      if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
      fs.copyFileSync(process.execPath, gitStub);
    }
    fs.writeFileSync(path.join(options.cwd, 'rev-parse'), [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.FIXTURE_GIT_MARKER, fs.readdirSync(process.env.TMPDIR).join('\\n'));",
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);',
      'process.exit(1);',
    ].join('\n'));
  } else {
    fs.writeFileSync(path.join(probeDir, 'git'),
      [
        '#!/bin/sh',
        'for snapshot in "$TMPDIR"/multi-sub-memory-hook-*; do',
        '  if [ -d "$snapshot" ]; then printf "%s\\n" "$snapshot"; fi',
        'done > "$FIXTURE_GIT_MARKER"',
        'exec /bin/sleep 3.5',
        '',
      ].join('\n'), { mode: 0o700 });
  }

  const started = performance.now();
  const child = spawnSync(process.execPath, [claudeScript], {
    ...childOptions, input: JSON.stringify({ cwd: options.cwd }), encoding: 'utf8', timeout: 5000,
  });
  const elapsed = performance.now() - started;
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  assert.ok(fs.existsSync(marker), 'the Git stub was reached');
  assert.equal(fs.readFileSync(marker, 'utf8'), '', 'no snapshot directory existed during the Git probe');
  assert.deepEqual(fs.readdirSync(tempDir), []);
  assert.ok(elapsed < 1500, `Claude CLI took ${Math.round(elapsed)} ms`);
});

test('Claude SessionStart exits even when its input pipe stays open', async (t) => {
  const options = fixture(t);
  const child = spawn(process.execPath, [claudeScript], claudeOptions(options));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const timer = setTimeout(() => child.kill(), 6000);
  child.stdin.on('error', () => {});
  child.stdin.write('{"cwd":');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
    assert.deepEqual(await once(child, 'close'), [0, null]);
    assert.equal(output, '');
  } finally {
    clearTimeout(timer);
  }
});
