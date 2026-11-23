import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.mjs';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const plannedCommands = ['setup', 'doctor', 'dream', 'ui', 'import'];

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
    for (const command of plannedCommands) assert.ok(result.stdout.includes(command), command);
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

test('index writes JSON summaries and respects adapter selection and --cwd', (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'multi-sub-memory-cli-index-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project');
  const omp = path.join(directory, 'omp');
  const claude = path.join(directory, 'claude');
  for (const folder of [cwd, omp, claude]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(omp, 'omp.jsonl'), JSON.stringify({
    type: 'message', message: { role: 'user', content: 'OMP fixture transcript' },
  }) + '\n');
  fs.writeFileSync(path.join(claude, 'claude.jsonl'), JSON.stringify({
    type: 'assistant', cwd, message: { content: 'Claude fixture transcript' },
  }) + '\n');
  fs.writeFileSync(path.join(cwd, '.multi-sub-memory.jsonc'), JSON.stringify({
    indexers: { omp: { sessionsDir: omp }, claude: { sessionsDir: claude } },
  }));

  for (const [selection, expected] of [[undefined, ['claude', 'omp']], ['omp', ['omp']], ['claude', ['claude']]]) {
    const dbPath = path.join(directory, (selection ?? 'all') + '.db');
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
    ['--bogus'], ['--json', '--json'], ['--cwd'], ['--orchestrator'], ['--orchestrator', 'codex'], ['extra'],
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
