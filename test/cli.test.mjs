import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const plannedCommands = ['setup', 'doctor', 'index', 'dream', 'ui', 'import'];

function invoke(...args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

for (const flag of ['--help', '-h', 'help']) {
  test(flag + ' prints usage and the planned commands', () => {
    const result = invoke(flag);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /usage:/i);
    assert.match(result.stdout, /\bserve\b/);
    for (const command of plannedCommands) assert.ok(result.stdout.includes(command), command);
  });
}

test('explicit and default serve failures keep stdout empty', () => {
  for (const args of [[], ['serve']]) {
    const result = invoke(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /serve.*not yet implemented.*Issue #3/i);
  }
});

for (const command of plannedCommands) {
  test(command + ' reports its stub on stderr', () => {
    const result = invoke(command);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), command + ' is not yet implemented.');
  });
}

test('unknown commands report an error and help hint on stderr', () => {
  const result = invoke('invalid-command');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown command: invalid-command.*--help/i);
});
