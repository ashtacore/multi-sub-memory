import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hashNormalizedContent, openDatabase } from '../src/db.mjs';
import { normalizePath, resolveProjectKey } from '../src/project-id.mjs';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const plannedCommands = [];

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

for (const flag of ['--help', '-h', 'help']) {
  test(flag + ' prints usage and the planned commands', () => {
    const result = invoke([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /usage:/i);
    assert.match(result.stdout, /\bserve\b/);
    assert.match(result.stdout, /\bindex\b/);
    assert.match(result.stdout, /<omp\|claude\|codex\|agy\|all>/);
    for (const command of ['setup', 'doctor', 'index', 'dream', 'import', 'ui', ...plannedCommands]) {
      assert.ok(result.stdout.includes(command), command);
    }
    assert.match(result.stdout, /import --from <magic-context\|mnemopi\|notes\|all>/);
  });
}

test('import help and argument validation run before configuration or storage access', () => {
  for (const flag of ['--help', '-h']) {
    const result = invoke(['import', flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: multi-sub-memory import --from/);
    for (const option of ['--dry-run', '--include-archived', '--project-map', '--magic-context-db', '--mnemopi-dir', '--notes-dir', '--report', '--json', '--cwd']) {
      assert.ok(result.stdout.includes(option), option);
    }
  }
  const base = ['--from', 'all'];
  for (const args of [[], ['--from'], ['--from', 'unknown'], ['--from', ''],
    ...[['--bogus'], ['--report'], ['--notes-dir='], ['--cwd', '--json'], ['--json', '--json'],
      ['--from', 'notes'], ['--'], ['extra'], ['--help']].map((extra) => [...base, ...extra]),
  ]) {
    const result = invoke(['import', ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
});

for (const command of ['setup', 'doctor']) {
  test(command + ' dispatches to its own help and returns its exit code', () => {
    const help = invoke([command, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, new RegExp('Usage: multi-sub-memory ' + command));
    const invalid = invoke([command, '--bogus']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /--bogus/);
    assert.doesNotMatch(invalid.stderr, /ExperimentalWarning/);
  });
}

test('default and explicit serve exit cleanly on closed stdin', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const args of [[], ['serve'], ['serve', '--cwd', directory], ['--cwd', directory]]) {
    const result = invoke(args, {
      cwd: directory,
      input: '',
      env: {
        ...process.env,
        MULTI_SUB_MEMORY_CONFIG: path.join(directory, 'absent-config.jsonc'),
        MULTI_SUB_MEMORY_DB: ':memory:',
        MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
  }
});

test('invalid serve arguments keep stdout empty', () => {
  for (const [args, message] of [
    [['--cwd'], /--cwd requires a path/],
    [['serve', '--cwd'], /--cwd requires a path/],
    [['serve', '--cwd', '--bogus'], /--cwd requires a path/],
    [['serve', '--bogus'], /Unknown serve argument: --bogus/],
    [['--bogus'], /Unknown serve argument: --bogus/],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
  }
});

test('ui --help prints the dashboard usage', () => {
  const result = invoke(['ui', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: multi-sub-memory ui \[--port <number>\] \[--open\] \[--cwd <path>\] \[--help\]/);
});

test('ui rejects invalid, duplicate, unknown and positional arguments', () => {
  for (const args of [
    ['--port'], ['--port=-1'], ['--port=65536'], ['--port=1.5'], ['--port='], ['--port=abc'],
    ['--port=0', '--port=1'], ['--open', '--open'], ['--open=false'], ['--cwd'], ['--cwd='],
    ['--cwd=a', '--cwd=b'], ['--help', '-h'], ['--unknown'], ['extra'],
  ]) {
    const result = invoke(['ui', ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
});

for (const command of plannedCommands) {
  test(command + ' reports its stub on stderr', () => {
    const result = invoke([command]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), command + ' is not yet implemented.');
  });
}

test('unknown commands report an error and help hint on stderr', () => {
  const result = invoke(['invalid-command']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown command: invalid-command.*--help/i);
});

function dreamCliFixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'multi-sub-memory-cli-dream-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'settings.jsonc');
  const dbPath = path.join(directory, 'memory.db');
  const env = {
    ...process.env, MULTI_SUB_MEMORY_CONFIG: configPath,
    MULTI_SUB_MEMORY_DB: dbPath, MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
  };
  delete env.MULTI_SUB_MEMORY_AUTO_DREAM_CONTEXT;
  return { directory, configPath, dbPath, env };
}

test('dream --dry-run --json reports disabled without opening storage', (t) => {
  const { directory, dbPath, env } = dreamCliFixture(t);
  const result = invoke(['dream', '--dry-run', '--json'], { cwd: directory, env });
  assert.equal(result.status, 0, result.stderr);
  const { skipped, reason } = JSON.parse(result.stdout);
  assert.deepEqual({ skipped, reason }, { skipped: true, reason: 'disabled' });
  assert.equal(fs.existsSync(dbPath), false);
});

test('dream --dry-run --json loads project config and records a proposal through HTTP', async (t) => {
  const { directory, configPath, dbPath, env } = dreamCliFixture(t);
  const project = path.join(directory, 'workspace');
  fs.mkdirSync(project);
  const requests = [];
  const plan = { summary: 'Fixture proposal', operations: [{ type: 'add', content: 'Document fixture conventions' }] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(configPath, JSON.stringify({ dreamer: { http: { baseUrl } } }));
  fs.writeFileSync(path.join(project, '.multi-sub-memory.jsonc'), JSON.stringify({
    dreamer: { enabled: true, mode: 'http', http: { model: 'fixture' } },
  }));
  const seed = openDatabase(dbPath);
  try {
    const { lastInsertRowid } = seed.prepare(`
      INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
      VALUES ('fixture.jsonl', 'omp', 'fixture', ?, 1, 1)
    `).run(resolveProjectKey(project).projectKey);
    seed.prepare(`
      INSERT INTO transcript_messages (file_id, seq, role, text, line_no)
      VALUES (?, 0, 'user', 'The fixture has documented conventions.', 1)
    `).run(lastInsertRowid);
  } finally {
    seed.close();
  }
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    cliPath, 'dream', '--project', project, '--dry-run', '--json',
  ], { cwd: directory, env, windowsHide: true, timeout: 10_000 });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.memoriesAdded, 1);
  assert.deepEqual(result.operations, plan.operations);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.model, 'fixture');
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM dream_runs WHERE id = ?').get(result.runId).status, 'dry-run');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  } finally {
    db.close();
  }
});

test('dream reports a trusted CLI failure without leaking native child stderr', (t) => {
  const { directory, configPath, dbPath, env } = dreamCliFixture(t);
  const script = path.join(directory, 'stderr fixture.mjs');
  const secret = 'fixture-private-disk-secret';
  fs.writeFileSync(script, `console.error(${JSON.stringify(secret)}); process.exitCode = 7;`);
  fs.writeFileSync(configPath, JSON.stringify({
    dreamer: {
      enabled: true, mode: 'cli', cli: { orchestrator: 'codex', command: process.execPath, args: [script] },
    },
  }));
  const result = invoke(['dream'], { cwd: directory, env });
  const diagnostic = 'cli:codex process-exit code 7';
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), diagnostic);
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const run = db.prepare('SELECT status, error FROM dream_runs').get();
    assert.deepEqual({ ...run }, { status: 'failed', error: diagnostic });
  } finally {
    db.close();
  }
});

test('plain dream --dry-run prints proposed operations with an empty summary and preserves memories', (t) => {
  const { directory, configPath, dbPath, env } = dreamCliFixture(t);
  const script = path.join(directory, 'plan fixture.mjs');
  const plan = { summary: '', operations: [
    { type: 'merge', source_ids: ['source-a', 'source-b'], content: 'Proposed consolidation',
      category: 'WORKFLOW', importance: 4, reason: 'Duplicate conventions' },
    { type: 'archive', id: 'retired-c', reason: 'Obsolete convention' },
    { type: 'update', id: 'current-d', content: 'Proposed revision', category: 'GENERAL', importance: 5 },
    { type: 'add', content: 'Proposed new memory', reason: 'Found in transcript' },
  ] };
  fs.writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(plan))});`);
  fs.writeFileSync(configPath, JSON.stringify({
    dreamer: { enabled: true, mode: 'cli', cli: { orchestrator: 'codex', command: process.execPath, args: [script] } },
  }));
  const { projectKey } = resolveProjectKey(directory);
  const memoryRows = 'SELECT * FROM memories ORDER BY id';
  const db = openDatabase(dbPath);
  let before;
  try {
    const insert = db.prepare(`
      INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, created_at, updated_at)
      VALUES (?, ?, 'project', 'GENERAL', ?, ?, 1, 1)
    `);
    for (const id of ['source-a', 'source-b', 'retired-c', 'current-d']) {
      insert.run(id, projectKey, id, hashNormalizedContent(id));
    }
    const file = db.prepare(`
      INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
      VALUES ('fixture.jsonl', 'omp', 'fixture', ?, 1, 1)
    `).run(projectKey).lastInsertRowid;
    db.prepare(`
      INSERT INTO transcript_messages (file_id, seq, role, text, line_no)
      VALUES (?, 0, 'user', 'Evidence for the proposed addition', 1)
    `).run(file);
    before = db.prepare(memoryRows).all();
  } finally {
    db.close();
  }
  const result = invoke(['dream', '--dry-run'], { cwd: directory, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- merge source-a, source-b\s+Content: "Proposed consolidation"\s+Category: WORKFLOW\s+Importance: 4\s+Reason: "Duplicate conventions"/);
  assert.match(result.stdout, /- archive retired-c\s+Reason: "Obsolete convention"/);
  assert.match(result.stdout, /- update current-d\s+Content: "Proposed revision"\s+Category: GENERAL\s+Importance: 5/);
  assert.match(result.stdout, /- add\s+Content: "Proposed new memory"\s+Reason: "Found in transcript"/);
  const verified = openDatabase(dbPath, { readOnly: true });
  try {
    assert.deepEqual(verified.prepare(memoryRows).all(), before);
  } finally {
    verified.close();
  }
});

test('the detached Dreamer command uses the indexed project key and keeps stdout empty', async (t) => {
  const { directory, configPath, dbPath, env } = dreamCliFixture(t);
  const projectKey = 'dir:indexed-fixture';
  const server = http.createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"Fixture","operations":[]}' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(configPath, JSON.stringify({ dreamer: { http: { baseUrl } } }));
  env.MULTI_SUB_MEMORY_AUTO_DREAM_CONTEXT = JSON.stringify({
    dbPath,
    projectKey,
    embedding: { enabled: false },
    dreamer: {
      enabled: true,
      mode: 'http',
      http: { baseUrl, model: 'fixture' },
      cadence: { mode: 'auto', minIntervalHours: 1, minNewMemories: 0 },
    },
  });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cliPath, 'dream'], {
    cwd: directory, env, windowsHide: true, timeout: 10_000,
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const runs = db.prepare('SELECT status, project_key FROM dream_runs').all();
    assert.deepEqual(runs.map(({ status, project_key }) => [status, project_key]), [['completed', projectKey]]);
  } finally {
    db.close();
  }
});

test('manual and detached Dreamer select the target project and isolate runners while using the original database', async (t) => {
  const { directory, configPath, dbPath, env } = dreamCliFixture(t);
  const target = path.join(directory, 'target');
  const sessionsDir = path.join(directory, 'sessions');
  fs.mkdirSync(target);
  fs.mkdirSync(sessionsDir);
  const script = path.join(directory, 'cwd fixture.mjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify({ summary: process.cwd(), operations: [] }));');
  fs.writeFileSync(configPath, JSON.stringify({
    dreamer: { mode: 'cli', cli: { orchestrator: 'codex', command: process.execPath, args: [script] } },
    indexers: { omp: { sessionsDir } },
  }));
  fs.writeFileSync(path.join(target, '.multi-sub-memory.jsonc'), JSON.stringify({
    dreamer: { enabled: true, cadence: { mode: 'auto', minNewMemories: 0 } },
  }));
  fs.writeFileSync(path.join(sessionsDir, 'fixture.jsonl'), [
    JSON.stringify({ type: 'session', id: 'fixture', cwd: target }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'Fixture transcript' } }),
    '',
  ].join('\n'));

  const options = { cwd: directory, env: { ...env, MULTI_SUB_MEMORY_DB: path.basename(dbPath) } };
  const manual = invoke(['dream', '--project', 'target', '--dry-run', '--json'], options);
  assert.equal(manual.status, 0, manual.stderr);
  const result = JSON.parse(manual.stdout);
  const projectKey = resolveProjectKey(target).projectKey;
  assert.equal(result.projectKey, projectKey);
  assert.notEqual(normalizePath(result.summary), normalizePath(target));
  assert.ok(path.basename(result.summary).startsWith('msm-dream-'));
  assert.equal(fs.existsSync(result.summary), false);

  const indexed = invoke(['index', '--orchestrator', 'omp', '--json'], options);
  assert.equal(indexed.status, 0, indexed.stderr);
  const summary = JSON.parse(indexed.stdout);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.messagesIndexed, 1);

  const db = openDatabase(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM dream_runs WHERE id = ?').get(result.runId).status, 'dry-run');
    const findDetached = db.prepare(`
      SELECT status, project_key, summary, error FROM dream_runs WHERE id <> ?
        AND NOT EXISTS (SELECT 1 FROM leases WHERE lease_key = ?)
    `);
    const deadline = Date.now() + 10_000;
    let detached;
    while (!(detached = findDetached.get(result.runId, 'dream:' + projectKey)) && Date.now() < deadline) await delay(50);
    assert.ok(detached, 'Expected a detached Dreamer run in the original database');
    assert.equal(detached.status, 'completed', detached.error);
    assert.equal(detached.project_key, projectKey);
    assert.notEqual(normalizePath(detached.summary), normalizePath(target));
    assert.notEqual(normalizePath(detached.summary), normalizePath(result.summary));
    assert.ok(path.basename(detached.summary).startsWith('msm-dream-'));
    assert.equal(fs.existsSync(detached.summary), false);
    assert.equal(fs.existsSync(path.join(target, path.basename(dbPath))), false);
  } finally {
    db.close();
  }
});

test('dream rejects unknown, duplicate, conflicting, missing, and positional arguments', () => {
  for (const args of [
    ['--bogus'], ['--json', '--json'], ['--dry-run', '--dry-run'], ['--cwd'], ['--project', ''],
    ['--project', 'a', '--project', 'b'], ['--project', 'a', '--cwd', 'b'], ['extra'],
  ]) {
    const result = invoke(['dream', ...args]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
});

test('index writes JSON summaries and respects adapter selection and --cwd', (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'multi-sub-memory-cli-index-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project');
  const omp = path.join(directory, 'omp');
  const claude = path.join(directory, 'claude');
  const codex = path.join(directory, 'codex');
  const agy = path.join(directory, 'agy');
  for (const folder of [cwd, omp, claude, codex, agy]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(omp, 'omp.jsonl'), JSON.stringify({
    type: 'message', message: { role: 'user', content: 'OMP fixture transcript' },
  }) + '\n');
  fs.writeFileSync(path.join(claude, 'claude.jsonl'), JSON.stringify({
    type: 'assistant', cwd, message: { content: 'Claude fixture transcript' },
  }) + '\n');
  fs.writeFileSync(path.join(codex, 'codex.jsonl'), JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: 'Codex fixture transcript' },
  }) + '\n');
  fs.writeFileSync(path.join(agy, 'agy.jsonl'), JSON.stringify({
    type: 'USER_INPUT', cwd, content: 'Antigravity fixture transcript',
  }) + '\n');
  fs.writeFileSync(path.join(cwd, '.multi-sub-memory.jsonc'), JSON.stringify({
    indexers: {
      omp: { sessionsDir: omp }, claude: { sessionsDir: claude },
      codex: { sessionsDir: codex }, agy: { sessionsDir: agy },
    },
  }));

  const all = ['agy', 'claude', 'codex', 'omp'];
  for (const selection of [undefined, 'all', ...all]) {
    const expected = all.includes(selection) ? [selection] : all;
    const dbPath = path.join(directory, (selection ?? 'default') + '.db');
    const args = ['index', '--json'];
    if (selection) args.push('--orchestrator', selection, '--cwd', cwd);
    const result = invoke(args, {
      cwd: selection ? directory : cwd,
      env: {
        ...process.env,
        MULTI_SUB_MEMORY_CONFIG: path.join(directory, 'absent-config.jsonc'),
        MULTI_SUB_MEMORY_DB: dbPath,
        MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.filesIndexed, expected.length);
    assert.equal(summary.messagesIndexed, expected.length);
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT orchestrator FROM transcript_files ORDER BY orchestrator').all();
      assert.deepEqual(rows.map(({ orchestrator }) => orchestrator), expected);
    } finally {
      db.close();
    }
  }
});

test('index rejects unknown, duplicate, missing, and invalid arguments', () => {
  for (const args of [
    ['--bogus'], ['--json', '--json'], ['--cwd'], ['--orchestrator'], ['--orchestrator', 'unknown'], ['extra'],
  ]) {
    const result = invoke(['index', ...args]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
});

test('index honors the global indexer switch', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-cli-disabled-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.jsonc');
  fs.writeFileSync(configPath, JSON.stringify({ indexers: { enabled: false } }));
  const result = invoke(['index', '--json'], {
    cwd: directory,
    env: { ...process.env, MULTI_SUB_MEMORY_CONFIG: configPath, MULTI_SUB_MEMORY_DB: ':memory:' },
  });
  assert.equal(result.status, 0, result.stderr);
  const { skipped, reason, filesScanned } = JSON.parse(result.stdout);
  assert.deepEqual({ skipped, reason, filesScanned }, { skipped: true, reason: 'disabled', filesScanned: 0 });
});

test('serve refreshes on startup and after an append while keeping stdout quiet', { timeout: 15_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'multi-sub-memory-cli-refresh-'));
  const sessions = path.join(directory, 'sessions');
  fs.mkdirSync(sessions);
  const file = path.join(sessions, 'refresh.jsonl');
  const entry = (content) => JSON.stringify({ type: 'message', message: { role: 'user', content } }) + '\n';
  fs.writeFileSync(file, entry('First refresh fixture'));
  const configPath = path.join(directory, 'config.jsonc');
  const dbPath = path.join(directory, 'refresh.db');
  fs.writeFileSync(configPath, JSON.stringify({
    indexers: {
      backgroundRefresh: true, refreshIntervalMs: 100,
      omp: { sessionsDir: sessions }, claude: { sessionsDir: path.join(directory, 'absent') },
      codex: { sessionsDir: path.join(directory, 'absent-codex') },
      agy: { sessionsDir: path.join(directory, 'absent-agy') },
    },
  }));
  openDatabase(dbPath).close();
  const child = spawn(process.execPath, [cliPath, 'serve', '--cwd', directory], {
    cwd: directory,
    env: {
      ...process.env,
      MULTI_SUB_MEMORY_CONFIG: configPath,
      MULTI_SUB_MEMORY_DB: dbPath,
      MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
    },
    stdio: 'pipe',
    windowsHide: true,
  });
  const closed = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try {
      await closed;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const count = db.prepare('SELECT COUNT(*) AS count FROM transcript_messages');
    async function waitForCount(expected) {
      const deadline = Date.now() + 5_000;
      while (count.get().count < expected && child.exitCode === null && Date.now() < deadline) await delay(50);
      assert.equal(count.get().count, expected, stderr);
    }
    await waitForCount(1);
    fs.appendFileSync(file, entry('Next refresh fixture'));
    await waitForCount(2);
  } finally {
    db.close();
  }
  child.stdin.end();
  const [code, signal] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(stdout, '');
});
