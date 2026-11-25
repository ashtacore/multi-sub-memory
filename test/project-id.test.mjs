import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizePath, resolveProjectKey } from '../src/project-id.mjs';

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
    projectKey: 'git:' + hash,
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
  assert.equal(result.projectKey, 'git:' + hash);
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
  assert.equal(result.projectKey, 'git:' + hash);
});

test('a bare Git repository uses the common directory as its root', (t) => {
  const directory = tempDirectory(t);
  git(directory, 'init', '--bare', '--template=');
  const project = resolveProjectKey(directory);
  assert.equal(project.isGit, true);
  assert.match(project.projectKey, /^git:[a-f0-9]{16}$/);
  assert.equal(project.projectRoot, normalizePath(directory));
});

test('a non-Git directory has a deterministic directory key', (t) => {
  const directory = tempDirectory(t);
  const result = resolveProjectKey(directory);
  assert.match(result.projectKey, /^dir:[a-f0-9]{16}$/);
  assert.equal(result.isGit, false);
  assert.equal(result.projectRoot, normalizePath(directory));
  assert.equal(result.displayName, path.basename(directory));
  assert.deepEqual(resolveProjectKey(directory), result);
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

  const first = resolveProjectKey(withBackslash);
  const second = resolveProjectKey(nested);
  assert.equal(first.projectRoot, path.join(fs.realpathSync.native(directory), 'a\\b'));
  assert.notEqual(first.projectRoot, second.projectRoot);
  assert.notEqual(first.projectKey, second.projectKey);
});
