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

function revParse(cwd, deadline, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (gitRepositoryEnv.has(process.platform === 'win32' ? key.toUpperCase() : key)) delete env[key];
  }
  const timeout = deadline === undefined ? 2000 : Math.floor(deadline - performance.now());
  if (timeout <= 0) throw new Error('Git probe timed out');
  const result = spawnSync('git', ['rev-parse', ...args], {
    cwd,
    env,
    timeout,
    ...(deadline === undefined ? {} : { killSignal: 'SIGKILL' }),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (deadline !== undefined && result.error?.code === 'ETIMEDOUT') throw result.error;
  return result;
}

function gitDirectory(cwd, deadline, option) {
  const absolute = revParse(cwd, deadline, '--path-format=absolute', option);
  if (absolute.error) return undefined;

  if (absolute.status === 0) {
    const directory = absolute.stdout.replace(gitLineTerminator, '');
    // Older Git can echo an unrecognized option and still exit successfully.
    if (path.isAbsolute(directory)) return directory;
  }

  const relative = revParse(cwd, deadline, option);
  if (relative.status !== 0) return undefined;
  const directory = relative.stdout.replace(gitLineTerminator, '');
  return directory ? path.resolve(cwd, directory) : undefined;
}

export function resolveProjectKey(cwd = process.cwd(), { timeoutMs } = {}) {
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const commonDir = gitDirectory(cwd, deadline, '--git-common-dir');
  const topLevel = commonDir ? gitDirectory(cwd, deadline, '--show-toplevel') : undefined;
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

function splitProjectSegments(projectRoot) {
  const normalized = projectRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return null;
  return {
    base: segments.at(-1),
    ancestors: segments.slice(0, -1).reverse(),
  };
}

export function formatProjectLabels(entries) {
  const labels = new Map();
  const byBase = new Map();

  for (const { projectKey, projectRoot } of entries) {
    const parsed = typeof projectRoot === 'string' && projectRoot.trim()
      ? splitProjectSegments(projectRoot.trim())
      : null;
    if (!parsed) {
      labels.set(projectKey, projectKey);
      continue;
    }
    const groupKey = parsed.base.toLowerCase();
    const group = byBase.get(groupKey) ?? [];
    group.push({ projectKey, ...parsed });
    byBase.set(groupKey, group);
  }

  for (const group of byBase.values()) {
    if (group.length === 1) {
      labels.set(group[0].projectKey, group[0].base);
      continue;
    }
    let remaining = group;
    let depth = 1;
    while (remaining.length > 0) {
      if (!remaining.some(({ ancestors }) => ancestors.length >= depth)) {
        for (const item of remaining) {
          labels.set(item.projectKey, `${item.base} (${item.projectKey})`);
        }
        break;
      }
      const buckets = new Map();
      for (const item of remaining) {
        const qualifier = item.ancestors.slice(0, depth).reverse().join('/');
        const key = qualifier.toLowerCase();
        const bucket = buckets.get(key) ?? [];
        bucket.push({ item, qualifier });
        buckets.set(key, bucket);
      }
      const next = [];
      for (const bucket of buckets.values()) {
        if (bucket.length === 1) {
          const { item, qualifier } = bucket[0];
          labels.set(item.projectKey, qualifier ? `${item.base} (${qualifier})` : `${item.base} (${item.projectKey})`);
        } else {
          for (const { item } of bucket) next.push(item);
        }
      }
      remaining = next;
      depth++;
    }
  }

  return labels;
}
