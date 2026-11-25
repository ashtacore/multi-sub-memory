import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const windowsAbsolutePath = /^(?:[a-z]:[\\/]|\\\\)/i;
// Match only Git's final line terminator so trailing line breaks in a path survive.
const gitLineTerminator = process.platform === 'win32' ? /\r?\n(?![\s\S])/ : /\n(?![\s\S])/;
const gitRepositoryEnv = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SUPER_PREFIX',
]);

export function normalizePath(inputPath, options = {}) {
  const { platform = process.platform } = options;
  let resolved = path.isAbsolute(inputPath) || windowsAbsolutePath.test(inputPath)
    ? inputPath
    : path.resolve(inputPath);

  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      // Nonexistent or inaccessible paths still have a lexical identity.
    }
  }

  const normalized = platform === 'win32' || windowsAbsolutePath.test(resolved)
    ? resolved.replaceAll('\\', '/').replace(/^[A-Z](?=:\/)/, (drive) => drive.toLowerCase())
    : resolved;
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed || /^[a-z]:$/.test(trimmed)) return `${trimmed}/`;
  return trimmed;
}

function revParse(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (gitRepositoryEnv.has(process.platform === 'win32' ? key.toUpperCase() : key)) delete env[key];
  }
  return spawnSync('git', ['rev-parse', ...args], {
    cwd,
    env,
    timeout: 2000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitDirectory(cwd, option) {
  const absolute = revParse(cwd, '--path-format=absolute', option);
  if (absolute.error) return undefined;

  if (absolute.status === 0) {
    const directory = absolute.stdout.replace(gitLineTerminator, '');
    // Older Git can echo an unrecognized option and still exit successfully.
    if (path.isAbsolute(directory)) return directory;
  }

  const relative = revParse(cwd, option);
  if (relative.status !== 0) return undefined;
  const directory = relative.stdout.replace(gitLineTerminator, '');
  return directory ? path.resolve(cwd, directory) : undefined;
}

export function resolveProjectKey(cwd = process.cwd()) {
  const commonDir = gitDirectory(cwd, '--git-common-dir');
  const topLevel = commonDir ? gitDirectory(cwd, '--show-toplevel') : undefined;
  const isGit = Boolean(commonDir);
  const projectRoot = normalizePath(isGit
    ? topLevel || (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir)
    : cwd);
  const identity = isGit ? normalizePath(commonDir) : projectRoot;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16);

  return {
    projectKey: `${isGit ? 'git' : 'dir'}:${hash}`,
    projectRoot,
    displayName: path.posix.basename(projectRoot) || projectRoot,
    isGit,
  };
}
