import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatProjectLabels, normalizePath, resolveProjectKey } from '../src/project-id.mjs';

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-project-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(cwd, 'absent-gitconfig');
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('a repository and linked worktree share a project key from any subdirectory', (t) => {
  const directory = tempDirectory(t);
  const main = path.join(directory, 'main repo');
  const linked = path.join(directory, 'linked tree');
  const nested = path.join(linked, 'sub', 'dir');
  fs.mkdirSync(main);
  git(main, 'init', '--template=');
  git(main, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com',
    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Fixture commit');
  git(main, 'worktree', 'add', '--detach', linked);
  fs.mkdirSync(nested, { recursive: true });

  const gitCommonDir = normalizePath(path.join(main, '.git'));
  const hash = createHash('sha256').update(gitCommonDir).digest('hex').slice(0, 16);
  const first = resolveProjectKey(main);
  const second = resolveProjectKey(linked);
  assert.deepEqual(first, {
    projectKey: 'local:' + hash,
    projectRoot: normalizePath(main),
    displayName: 'main repo',
    isGit: true,
  });
  assert.deepEqual(second, {
    ...first,
    projectRoot: normalizePath(linked),
    displayName: 'linked tree',
  });
  assert.deepEqual(resolveProjectKey(nested), second);
});

test('repository discovery ignores inherited Git directory and worktree overrides', (t) => {
  const directory = tempDirectory(t);
  const repoA = path.join(directory, 'repo-a');
  const repoB = path.join(directory, 'repo-b');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  git(repoA, 'init', '--template=');
  git(repoB, 'init', '--template=');

  const expected = resolveProjectKey(repoB);
  assert.equal(expected.projectRoot, normalizePath(repoB));
  assert.equal(expected.isGit, true);
  assert.notEqual(expected.projectKey, resolveProjectKey(repoA).projectKey);

  const overrides = {
    GIT_DIR: path.join(repoA, '.git'),
    GIT_WORK_TREE: repoA,
  };
  for (const [name, value] of Object.entries(overrides)) {
    const original = process.env[name];
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
    process.env[name] = value;
  }

  assert.deepEqual(resolveProjectKey(repoB), expected);
});

test('Git discovery preserves newlines in POSIX repository paths', { skip: process.platform === 'win32' }, (t) => {
  const directory = tempDirectory(t);
  const repo = path.join(directory, 'repo\n');
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  git(repo, 'init', '--template=');

  const commonDir = normalizePath(path.join(repo, '.git'));
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
  const result = resolveProjectKey(nested);
  assert.equal(result.projectKey, 'local:' + hash);
  assert.equal(result.projectRoot, normalizePath(repo));
});

test('Git discovery preserves a trailing carriage return in a POSIX repository path', { skip: process.platform === 'win32' }, (t) => {
  const directory = tempDirectory(t);
  const repo = path.join(directory, 'repo\r');
  fs.mkdirSync(repo);
  git(repo, 'init', '--template=');

  const commonDir = normalizePath(path.join(repo, '.git'));
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
  const result = resolveProjectKey(repo);
  assert.equal(result.projectRoot, normalizePath(repo));
  assert.equal(result.projectKey, 'local:' + hash);
});

test('a bare Git repository uses the common directory as its root', (t) => {
  const directory = tempDirectory(t);
  git(directory, 'init', '--bare', '--template=');
  const project = resolveProjectKey(directory);
  assert.equal(project.isGit, true);
  assert.match(project.projectKey, /^local:[a-f0-9]{16}$/);
  assert.equal(project.projectRoot, normalizePath(directory));
});

test('rejects project scope outside Git and supports explicit optional resolution', (t) => {
  const directory = tempDirectory(t);
  assert.throws(() => resolveProjectKey(directory), /Project-scoped memories require a Git repository/);
  assert.equal(resolveProjectKey(directory, { optional: true }), undefined);
});

test('normalizes remote transports across clones and prefers upstream with an explicit fork override', (t) => {
  const root = tempDirectory(t);
  const fork = path.join(root, 'fork');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(fork);
  fs.mkdirSync(clone);
  git(fork, 'init', '--template=');
  git(clone, 'init', '--template=');
  git(fork, 'remote', 'add', 'origin', 'git@github.com:Fork/Repo.git');
  assert.equal(resolveProjectKey(fork).projectKey, 'github.com/fork/repo');
  git(fork, 'remote', 'add', 'upstream', 'ssh://git@GitHub.COM/Owner/Repo.git');
  git(clone, 'remote', 'add', 'origin', 'https://github.com/Owner/Repo.git');
  const upstream = 'github.com/owner/repo';
  assert.equal(resolveProjectKey(fork).projectKey, upstream);
  assert.equal(resolveProjectKey(clone).projectKey, upstream);
  assert.equal(resolveProjectKey(fork, { forkMode: 'origin' }).projectKey, 'github.com/fork/repo');
  assert.equal(resolveProjectKey(fork, { projects: { 'github.com/fork/repo': { forkMode: 'origin' } } }).projectKey, 'github.com/fork/repo');
  git(clone, 'remote', 'set-url', 'origin', 'git@GITHUB.com:/OWNER/rePO.git');
  assert.equal(resolveProjectKey(clone).projectKey, upstream);
});

test('Git insteadOf aliases and expanded fetch URLs share a project key', (t) => {
  const repo = tempDirectory(t);
  git(repo, 'init', '--template=');
  git(repo, 'config', '--local', 'url.https://github.com/.insteadOf', 'fixture-gh:');
  git(repo, 'remote', 'add', 'origin', 'fixture-gh:Team/Repo.git');
  const aliasKey = resolveProjectKey(repo).projectKey;

  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/Team/Repo.git');
  assert.equal(aliasKey, resolveProjectKey(repo).projectKey);
  assert.equal(aliasKey, 'github.com/team/repo');
});

test('preserves non-default ports and repository path casing on other hosts', (t) => {
  const repo = tempDirectory(t);
  git(repo, 'init', '--template=');
  git(repo, 'remote', 'add', 'origin', 'https://GIT.example.test:8443/team/Repo.git');
  assert.equal(resolveProjectKey(repo).projectKey, 'git.example.test:8443/team/Repo');
  for (const [remote, key] of [
    ['https://git.example.test:9443/team/Repo.git', 'git.example.test:9443/team/Repo'],
    ['https://git.example.test:8443/team/repo.git', 'git.example.test:8443/team/repo'],
    ['https://git.example.test:443/team/Repo.git', 'git.example.test/team/Repo'],
    ['http://git.example.test:80/team/Repo.git', 'git.example.test/team/Repo'],
    ['ssh://git@GIT.example.test:22/team/Repo.git', 'git.example.test/team/Repo'],
    ['git+ssh://git@GIT.example.test:22/team/Repo.git', 'git.example.test/team/Repo'],
    ['git://git.example.test/team/Repo.git', 'git.example.test/team/Repo'],
    ['git://git.example.test:9418/team/Repo.git', 'git.example.test/team/Repo'],
    ['git://git.example.test:9419/team/Repo.git', 'git.example.test:9419/team/Repo'],
    ['git@GIT.example.test:/team/Repo.git', 'git.example.test/team/Repo'],
  ]) {
    git(repo, 'remote', 'set-url', 'origin', remote);
    assert.equal(resolveProjectKey(repo).projectKey, key);
  }
});

test('remote project labels use the shortest distinguishing suffix', () => {
  const labels = formatProjectLabels([
    { projectKey: 'example.test/alpha/unique', projectRoot: '/work/unrelated' },
    { projectKey: 'example.test/alpha/shared' },
    { projectKey: 'example.test/beta/shared' },
    { projectKey: 'github.com/beta/shared' },
  ]);
  assert.deepEqual(Object.fromEntries(labels), {
    'example.test/alpha/unique': 'unique',
    'example.test/alpha/shared': 'alpha/shared',
    'example.test/beta/shared': 'example.test/beta/shared',
    'github.com/beta/shared': 'github.com/beta/shared',
  });
});

test('normalizes Windows drive casing, separators, and trailing slashes', () => {
  const backslashPath = normalizePath('C:\\Foo\\Bar\\');
  assert.equal(backslashPath, normalizePath('c:/Foo/Bar'));
  assert.match(backslashPath, /^c:\/Foo\/Bar$/i);
  assert.ok(backslashPath.startsWith('c:/'));
  assert.equal(normalizePath('C:\\'), 'c:/');
});

test('normalizes POSIX paths with literal backslashes distinctly from separators', () => {
  const options = { platform: 'linux' };
  assert.equal(normalizePath('/tmp/a\\b', options), '/tmp/a\\b');
  assert.notEqual(normalizePath('/tmp/a\\b', options), normalizePath('/tmp/a/b', options));
});

test('POSIX directories with literal backslashes have distinct keys', { skip: process.platform === 'win32' }, (t) => {
  const directory = tempDirectory(t);
  const withBackslash = path.join(directory, 'a\\b');
  const nested = path.join(directory, 'a', 'b');
  fs.mkdirSync(withBackslash);
  fs.mkdirSync(nested, { recursive: true });

  git(withBackslash, 'init', '--template=');
  git(nested, 'init', '--template=');
  const first = resolveProjectKey(withBackslash);
  const second = resolveProjectKey(nested);
  assert.equal(first.projectRoot, path.join(fs.realpathSync.native(directory), 'a\\b'));
  assert.notEqual(first.projectRoot, second.projectRoot);
  assert.notEqual(first.projectKey, second.projectKey);
});

test('formatProjectLabels uses basename and appends unique ancestor segments on collision', () => {
  const unique = formatProjectLabels([
    { projectKey: 'local:0000000000000001', projectRoot: 'C:\\Programming\\GameDev\\CoveCrawler' },
    { projectKey: 'local:0000000000000002', projectRoot: '/home/dev/multi-sub-memory' },
    { projectKey: 'local:0000000000000003', projectRoot: null },
  ]);
  assert.equal(unique.get('local:0000000000000001'), 'CoveCrawler');
  assert.equal(unique.get('local:0000000000000002'), 'multi-sub-memory');
  assert.equal(unique.get('local:0000000000000003'), 'local:0000000000000003');

  const singleLevel = formatProjectLabels([
    { projectKey: 'local:000000000000000a', projectRoot: 'C:\\Programming\\GameDev\\CoveCrawler' },
    { projectKey: 'local:000000000000000b', projectRoot: 'C:\\Programming\\CoveCrawler' },
  ]);
  assert.equal(singleLevel.get('local:000000000000000a'), 'CoveCrawler (GameDev)');
  assert.equal(singleLevel.get('local:000000000000000b'), 'CoveCrawler (Programming)');

  const multiLevel = formatProjectLabels([
    { projectKey: 'local:000000000000000a', projectRoot: 'C:\\Work\\GameDev\\CoveCrawler' },
    { projectKey: 'local:000000000000000b', projectRoot: 'C:\\Personal\\GameDev\\CoveCrawler' },
    { projectKey: 'local:000000000000000c', projectRoot: 'C:\\Programming\\CoveCrawler' },
  ]);
  assert.equal(multiLevel.get('local:000000000000000a'), 'CoveCrawler (Work/GameDev)');
  assert.equal(multiLevel.get('local:000000000000000b'), 'CoveCrawler (Personal/GameDev)');
  assert.equal(multiLevel.get('local:000000000000000c'), 'CoveCrawler (Programming)');

  const driveLevel = formatProjectLabels([
    { projectKey: 'local:000000000000000c', projectRoot: 'c:/CoveCrawler' },
    { projectKey: 'local:000000000000000d', projectRoot: 'd:/CoveCrawler' },
  ]);
  assert.equal(driveLevel.get('local:000000000000000c'), 'CoveCrawler (c:)');
  assert.equal(driveLevel.get('local:000000000000000d'), 'CoveCrawler (d:)');
});

test('formatProjectLabels preserves literal backslashes and whitespace in POSIX names', () => {
  const labels = formatProjectLabels([
    { projectKey: 'local:000000000000000e', projectRoot: '/work/team\\repo' },
    { projectKey: 'local:000000000000000f', projectRoot: '/work/ repo ' },
  ]);
  assert.equal(labels.get('local:000000000000000e'), 'team\\repo');
  assert.equal(labels.get('local:000000000000000f'), ' repo ');
});
