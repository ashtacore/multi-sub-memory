import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const plannedCommands = ['setup', 'doctor', 'index', 'dream', 'ui', 'import'];

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
