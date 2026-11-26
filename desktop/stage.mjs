import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = fileURLToPath(new URL('./.dashboard', import.meta.url));
await rm(stage, { recursive: true, force: true });
await mkdir(stage);
await cp(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true });
await cp(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), {
  recursive: true,
  filter: (file) => !['.bin', '.package-lock.json'].includes(path.basename(file)),
});
await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
