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
  'GIT_CONFIG',
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

function runGit(cwd, deadline, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (gitRepositoryEnv.has(name) || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(name)) delete env[key];
  }
  const timeout = deadline === undefined ? 2000 : Math.floor(deadline - performance.now());
  if (timeout <= 0) throw new Error('Git probe timed out');
  const result = spawnSync('git', args, {
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
  const absolute = runGit(cwd, deadline, 'rev-parse', '--path-format=absolute', option);
  if (absolute.error) return undefined;

  if (absolute.status === 0) {
    const directory = absolute.stdout.replace(gitLineTerminator, '');
    // Older Git can echo an unrecognized option and still exit successfully.
    if (path.isAbsolute(directory)) return directory;
  }

  const relative = runGit(cwd, deadline, 'rev-parse', option);
  if (relative.status !== 0) return undefined;
  const directory = relative.stdout.replace(gitLineTerminator, '');
  return directory ? path.resolve(cwd, directory) : undefined;
}

const remoteKeyPattern = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?(?:\/[A-Za-z0-9_.~-]+){2,}$/;
const caseInsensitiveHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com']);
const defaultPorts = new Map([['http:', '80'], ['https:', '443'], ['ssh:', '22'], ['git+ssh:', '22']]);

export function isProjectKey(value) {
  if (typeof value !== 'string') return false;
  return /^local:[a-f0-9]{16}$/.test(value) || (remoteKeyPattern.test(value)
    && value.split('/').every((segment) => segment !== '.' && segment !== '..'));
}

function normalizeRemoteKey(remote) {
  if (!remote || windowsAbsolutePath.test(remote)) return undefined;
  const scp = /^(?:[^/@:]+@)?([^/:]+):((?!\/\/).+)$/.exec(remote);
  const parsed = URL.parse(scp ? 'ssh://' + scp[1] + '/' + scp[2].replace(/^\//, '') : remote);
  if (!parsed || (!defaultPorts.has(parsed.protocol) && parsed.protocol !== 'git:')) return undefined;
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port && parsed.port !== defaultPorts.get(parsed.protocol) ? ':' + parsed.port : '';
  const repository = caseInsensitiveHosts.has(hostname) ? parsed.pathname.toLowerCase() : parsed.pathname;
  const key = hostname + port + repository.replace(/\/+$/, '').replace(/\.git$/, '');
  return isProjectKey(key) ? key : undefined;
}

function readRemotes(cwd, deadline) {
  const result = runGit(cwd, deadline, 'config', '--local', '--includes', '--null', '--get-regexp', '^remote\\.(upstream|origin)\\.url$');
  if (result.status !== 0) return {};
  const urls = new Map();
  for (const entry of result.stdout.split('\0')) {
    const separator = entry.indexOf('\n');
    if (separator === -1) continue;
    const name = entry.slice('remote.'.length, separator - '.url'.length);
    if (!urls.has(name)) urls.set(name, normalizeRemoteKey(entry.slice(separator + 1)));
  }
  return { upstream: urls.get('upstream'), origin: urls.get('origin') };
}

const projectCache = new Map();

function discoverProject(cwd, deadline) {
  const probe = runGit(cwd, deadline, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel');
  if (probe.error || (probe.status !== 0 && !probe.stdout)) return undefined;
  const lines = probe.stdout.replace(gitLineTerminator, '').split(process.platform === 'win32' ? /\r?\n/ : '\n');
  let [commonDir, topLevel] = lines;
  // Bare repositories, older Git, and paths containing line breaks need independent probes.
  if (probe.status !== 0 || lines.length !== 2 || !lines.every((line) => path.isAbsolute(line))) {
    commonDir = gitDirectory(cwd, deadline, '--git-common-dir');
    if (!commonDir) return undefined;
    topLevel = gitDirectory(cwd, deadline, '--show-toplevel');
  }
  const projectRoot = normalizePath(topLevel || (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir));
  const hash = createHash('sha256').update(normalizePath(commonDir)).digest('hex').slice(0, 16);
  return {
    projectRoot,
    local: 'local:' + hash,
    ...readRemotes(cwd, deadline),
  };
}

export function resolveProjectKey(cwd = process.cwd(), { timeoutMs, optional = false, forkMode, projects, cache = false } = {}) {
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const directory = path.resolve(cwd);
  const cached = cache ? projectCache.get(directory) : undefined;
  const hit = cached && cached.expiresAt > performance.now();
  const git = hit ? cached.git : discoverProject(directory, deadline);
  if (cache && !hit && git) {
    projectCache.delete(directory);
    if (projectCache.size >= 64) projectCache.delete(projectCache.keys().next().value);
    projectCache.set(directory, { git, expiresAt: performance.now() + 5000 });
  }
  if (!git) {
    if (optional) return undefined;
    throw new Error('Project-scoped memories require a Git repository. Select a Git workspace or use global scope.');
  }

  const { upstream, origin, local, projectRoot } = git;
  const defaultKey = upstream ?? origin ?? local;
  const preferOrigin = (forkMode ?? projects?.[origin]?.forkMode) === 'origin';
  const projectKey = preferOrigin ? origin ?? defaultKey : defaultKey;
  return { projectKey, projectRoot, displayName: path.posix.basename(projectRoot) || projectRoot, isGit: true };
}

function splitProjectSegments(projectRoot) {
  const separator = windowsAbsolutePath.test(projectRoot) ? /[\\/]/ : '/';
  const segments = projectRoot.split(separator).filter(Boolean);
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
    const remote = remoteKeyPattern.test(projectKey);
    const parsed = remote ? splitProjectSegments(projectKey)
      : typeof projectRoot === 'string' && projectRoot.trim() ? splitProjectSegments(projectRoot) : null;
    if (!parsed) {
      labels.set(projectKey, projectKey);
      continue;
    }
    const groupKey = parsed.base.toLowerCase();
    const group = byBase.get(groupKey) ?? [];
    group.push({ projectKey, remote, ...parsed });
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
          labels.set(item.projectKey, qualifier && item.remote ? `${qualifier}/${item.base}`
            : `${item.base} (${qualifier || item.projectKey})`);
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
