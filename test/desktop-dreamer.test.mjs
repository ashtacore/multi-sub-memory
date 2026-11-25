import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8').replace(/^\uFEFF/, '');

test('desktop builds target Windows and Linux and use a sandboxed renderer', () => {
  const { build, devDependencies } = JSON.parse(read('desktop/package.json'));
  assert.deepEqual(build.win.target, ['nsis', 'portable']);
  assert.deepEqual(build.linux.target, ['AppImage']);
  assert.ok(devDependencies.electron);
  assert.ok(devDependencies['electron-builder']);

  const main = read('desktop/main.mjs');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  for (const file of ['main.mjs', 'preload.mjs', 'stage.mjs']) {
    const check = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('desktop/' + file, root))]);
    assert.equal(check.status, 0, check.stderr?.toString());
  }
});

test('npm pack contains the browser dashboard and excludes Electron and desktop sources', () => {
  const { dependencies, optionalDependencies } = JSON.parse(read('package.json'));
  for (const name of ['electron', 'electron-builder']) {
    assert.equal(dependencies[name], undefined);
    assert.equal(optionalDependencies?.[name], undefined);
  }
  const pack = spawnSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: fileURLToPath(root), encoding: 'utf8', shell: true,
  });
  assert.equal(pack.status, 0, pack.error?.message ?? pack.stderr);
  const files = Object.values(JSON.parse(pack.stdout))[0].files.map(({ path }) => path);
  assert.ok(files.includes('src/ui/server.mjs'));
  assert.ok(files.includes('src/ui/public/index.html'));
  assert.ok(files.includes('bin/cli.mjs'));
  assert.ok(files.every((file) => !/(^desktop\/|electron|\.(exe|AppImage)$)/i.test(file)));
});
