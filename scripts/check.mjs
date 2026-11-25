import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function checkDirectory(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkDirectory(path);
    } else if (entry.isFile() && /\.(m?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], {
        cwd: root,
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        console.error(`Syntax check failed for ${path}: ${result.error ?? result.signal ?? result.status}`);
        process.exitCode = 1;
      }
    }
  }
}

for (const directory of ['bin', 'src', 'test', 'scripts']) {
  checkDirectory(directory);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const targets = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
for (const target of targets) {
  if (!statSync(resolve(root, target), { throwIfNoEntry: false })?.isFile()) {
    console.error(`Package bin target is missing or is not a file: ${target}`);
    process.exitCode = 1;
  }
}
