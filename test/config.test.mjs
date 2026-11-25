import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigSchema, expandHome, loadConfig, parseYaml, writeConfig } from '../src/config.mjs';
import { initGit, writeProjectConfig } from './git-fixtures.mjs';

const defaultDreamer = {
  enabled: false, mode: 'disabled', cadence: { mode: 'manual', minIntervalHours: 24, minNewMemories: 10 },
};
const defaultIndexers = {
  enabled: true, backgroundRefresh: false, refreshIntervalMs: 60_000,
  omp: {}, claude: {}, codex: {}, agy: {},
};

function configFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(projectRoot);
  return { homeDir, projectRoot, cwd: projectRoot, env: {} };
}

test('loads defaults and expands only the current home marker', (t) => {
  const options = configFixture(t);
  const { homeDir } = options;
  assert.deepEqual(loadConfig(options), {
    dbPath: path.join(homeDir, '.local', 'share', 'multi-sub-memory', 'memory.db'),
    embedding: { model: 'BAAI/bge-base-en-v1.5', enabled: true },
    bootstrap: { tokenBudget: 2500 },
    dreamer: defaultDreamer,
    tags: { strict: false, definitions: {} },
    indexers: defaultIndexers,
  });
  assert.equal(expandHome('~', homeDir), homeDir);
  assert.equal(expandHome('~/folder/memory.db', homeDir), path.join(homeDir, 'folder', 'memory.db'));
  assert.equal(expandHome('~\\folder\\memory.db', homeDir), path.join(homeDir, 'folder', 'memory.db'));
  assert.equal(expandHome('~other/memory.db', homeDir), '~other/memory.db');
  assert.equal(expandHome('relative/memory.db', homeDir), 'relative/memory.db');
});

test('expands ~/ paths using the native meaning of backslashes', () => {
  const expected = process.platform === 'win32'
    ? '\\home\\user\\a\\b\\memory.db'
    : '/home/user/a\\b/memory.db';
  assert.equal(expandHome('~/a\\b/memory.db', '/home/user'), expected);
});

test('reads YAML comments, quoted values and a UTF-8 BOM, and rejects duplicate keys', () => {
  const url = 'https://example.test/a#b';
  assert.deepEqual(parseYaml('\uFEFF# settings\nurl: "' + url + '" # endpoint\nitems: [one, two]\n'), {
    url, items: ['one', 'two'],
  });
  assert.deepEqual(parseYaml('# empty settings\n'), {});
  assert.throws(() => parseYaml('dbPath: first\ndbPath: second\n'), /Invalid YAML syntax/);
  assert.throws(() => parseYaml('embedding: [\n'), /Invalid YAML syntax/);
});

test('merges global and repository YAML settings before applying environment overrides', (t) => {
  const options = configFixture(t);
  const { cwd, homeDir } = options;
  initGit(cwd);
  const userConfigPath = path.join(homeDir, '.config', 'multi-sub-memory', 'config.yaml');
  writeConfig(userConfigPath, {
    dbPath: '~/user.db',
    embedding: { model: 'user-model', enabled: false },
    bootstrap: { tokenBudget: 1000 },
    indexers: { backgroundRefresh: false, omp: { sessionsDir: '~/user-omp' } },
  });
  writeProjectConfig(userConfigPath, cwd, {
    dbPath: '~/project.db',
    embedding: { model: 'project-model' },
    bootstrap: { tokenBudget: 1200 },
    indexers: { backgroundRefresh: true, refreshIntervalMs: 30_000, claude: { sessionsDir: '~/project-claude' } },
  });

  assert.deepEqual(loadConfig(options), {
    dbPath: path.join(homeDir, 'project.db'),
    embedding: { model: 'project-model', enabled: false },
    bootstrap: { tokenBudget: 1200 },
    dreamer: defaultDreamer,
    tags: { strict: false, definitions: {} },
    indexers: {
      ...defaultIndexers, backgroundRefresh: true, refreshIntervalMs: 30_000,
      omp: { sessionsDir: path.join(homeDir, 'user-omp') }, claude: { sessionsDir: path.join(homeDir, 'project-claude') },
    },
  });
  assert.equal(loadConfig({ ...options, cwd: homeDir }).dbPath, path.join(homeDir, 'user.db'));
  assert.equal(loadConfig({ ...options, cwd: homeDir }).bootstrap.tokenBudget, 1000);

  writeConfig(path.join(homeDir, 'custom.yaml'), { bootstrap: { tokenBudget: 1800 } });
  const env = {
    MULTI_SUB_MEMORY_DB: '~\\env.db',
    MULTI_SUB_MEMORY_CONFIG: '~/custom.yaml',
    MULTI_SUB_MEMORY_NO_EMBEDDINGS: 'yes',
    MULTI_SUB_MEMORY_EMBEDDING_MODEL: 'env-model',
  };
  assert.deepEqual(loadConfig({ ...options, env }), {
    dbPath: path.join(homeDir, 'env.db'),
    embedding: { model: 'env-model', enabled: false },
    bootstrap: { tokenBudget: 1800 },
    dreamer: defaultDreamer,
    tags: { strict: false, definitions: {} },
    indexers: defaultIndexers,
  });
  env.MULTI_SUB_MEMORY_NO_EMBEDDINGS = 'no';
  assert.equal(loadConfig({ ...options, env }).embedding.enabled, true);
  assert.equal(loadConfig({ ...options, env, userConfigPath }).bootstrap.tokenBudget, 1200);
});

test('rejects invalid values and unknown keys in individual config layers', (t) => {
  const options = configFixture(t);
  const userConfigPath = path.join(options.homeDir, 'invalid.yaml');
  const invalidConfigs = [
    { embedding: { enabled: 'true' } },
    { bootstrap: { tokenBudget: -1 } },
    { bootstrap: { tokenBudget: 1.5 } },
    { embedding: { unknown: true } },
    { unexpected: true },
    { tags: { strict: 'yes' } },
    { tags: { definitions: { 'Bad Tag': 'invalid' } } },
    { tags: { definitions: { good: false } } },
    { projects: { 'dir:legacy': {} } },
    { projects: { 'github.com/example/repo': { forkMode: 'fork' } } },
    { projects: { 'github.com/example/repo': { bootstrap: { unknown: true } } } },
    { dbPath: '' },
    { dreamer: { http: { baseUrl: 'ftp://example.test' } } },
    { dreamer: { http: { apiKey: 'fixture-key' } } },
    { dreamer: { cli: { orchestrator: 'agy' } } },
    { dreamer: { cadence: { minIntervalHours: 0 } } },
    { dreamer: { cadence: { minNewMemories: -1 } } },
    { indexers: { enabled: 'true' } },
    { indexers: { backgroundRefresh: 1 } },
    { indexers: { refreshIntervalMs: 0 } },
    { indexers: { refreshIntervalMs: 2 ** 31 } },
    { indexers: { unsupported: {} } },
    { indexers: { omp: { sessionsDir: '' } } },
    { indexers: { claude: { sessionsDir: false } } },
    { indexers: { codex: { otherDir: '/fixtures' } } },
    { indexers: { agy: null } },
  ];
  for (const invalid of invalidConfigs) {
    fs.writeFileSync(userConfigPath, JSON.stringify(invalid));
    assert.throws(() => loadConfig({ ...options, userConfigPath }), /Invalid config at/);
  }
  assert.throws(() => loadConfig({
    ...options,
    env: { MULTI_SUB_MEMORY_NO_EMBEDDINGS: 'maybe' },
  }), /MULTI_SUB_MEMORY_NO_EMBEDDINGS/);
  assert.throws(() => loadConfig({
    ...options,
    env: { MULTI_SUB_MEMORY_EMBEDDING_MODEL: '' },
  }));
});

test('validates config and creates parent directories before writing YAML', (t) => {
  const options = configFixture(t);
  const data = loadConfig(options);
  const configPath = '~/missing/nested/config.yaml';
  const outputPath = expandHome(configPath, options.homeDir);

  assert.throws(() => writeConfig(configPath, { dreamer: { enabled: 'false' } }, options));
  assert.equal(fs.existsSync(path.dirname(outputPath)), false);

  writeConfig(configPath, data, options);
  const written = fs.readFileSync(outputPath, 'utf8');
  assert.match(written, /^dbPath: /);
  assert.deepEqual(ConfigSchema.parse(parseYaml(written)), data);
});

test('replaces existing config without leaving a temporary sibling', (t) => {
  const { homeDir } = configFixture(t);
  const configPath = path.join(homeDir, 'config.yaml');
  fs.writeFileSync(configPath, '{"dbPath":"previous.db"}\n');
  const replacement = { dreamer: { enabled: true } };

  writeConfig(configPath, replacement);

  assert.deepEqual(parseYaml(fs.readFileSync(configPath, 'utf8')), replacement);
  assert.deepEqual(fs.readdirSync(homeDir), ['config.yaml']);
});

test('writes through chained config symlinks to missing and existing targets', (t) => {
  const { homeDir, projectRoot: dotfilesDir } = configFixture(t);
  const linkPath = path.join(homeDir, 'config.yaml');
  const intermediatePath = path.join(dotfilesDir, 'linked.yaml');
  const targetDir = path.join(dotfilesDir, 'settings');
  const targetPath = path.join(targetDir, 'config.yaml');
  try {
    fs.symlinkSync(path.relative(homeDir, intermediatePath), linkPath, 'file');
    fs.symlinkSync(targetPath, intermediatePath, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Creating file symlinks requires privileges on this Windows host');
    return;
  }

  assert.equal(fs.existsSync(targetDir), false);
  const initial = { dbPath: 'initial.db' };
  writeConfig(linkPath, initial);
  assert.deepEqual(parseYaml(fs.readFileSync(targetPath, 'utf8')), initial);

  if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o640);
  const replacement = { dreamer: { enabled: true } };
  writeConfig(linkPath, replacement);
  assert.deepEqual(parseYaml(fs.readFileSync(targetPath, 'utf8')), replacement);
  if (process.platform !== 'win32') assert.equal(fs.statSync(targetPath).mode & 0o777, 0o640);

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(intermediatePath).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(homeDir), ['config.yaml']);
  assert.deepEqual(fs.readdirSync(dotfilesDir).sort(), ['linked.yaml', 'settings']);
  assert.deepEqual(fs.readdirSync(targetDir), ['config.yaml']);
});

test('follows a directory symlink before applying .. in a dangling config target', { skip: process.platform === 'win32' }, (t) => {
  const { homeDir, projectRoot: dotfilesDir } = configFixture(t);
  const profilesDir = path.join(dotfilesDir, 'profiles');
  const workDir = path.join(profilesDir, 'work');
  const aliasPath = path.join(homeDir, 'alias');
  const linkPath = path.join(homeDir, 'config.yaml');
  const targetPath = path.join(profilesDir, 'settings.yaml');
  const unrelatedPath = path.join(homeDir, 'settings.yaml');
  const sentinel = '{"dbPath":"unrelated.db"}';

  fs.mkdirSync(workDir, { recursive: true });
  fs.symlinkSync(workDir, aliasPath, 'dir');
  fs.symlinkSync(['alias', '..', 'settings.yaml'].join(path.sep), linkPath, 'file');
  fs.writeFileSync(unrelatedPath, sentinel);

  const replacement = { dreamer: { enabled: true } };
  writeConfig(linkPath, replacement);

  assert.deepEqual(parseYaml(fs.readFileSync(targetPath, 'utf8')), replacement);
  assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), sentinel);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.deepEqual(parseYaml(fs.readFileSync(linkPath, 'utf8')), replacement);
});

test('rejects .. after a dangling directory symlink in a config target', { skip: process.platform === 'win32' }, (t) => {
  const { homeDir } = configFixture(t);
  const aliasPath = path.join(homeDir, 'alias');
  const linkPath = path.join(homeDir, 'config.yaml');
  const unrelatedPath = path.join(homeDir, 'settings.yaml');
  const sentinel = '{"dbPath":"unrelated.db"}';

  fs.symlinkSync(path.join(homeDir, 'missing'), aliasPath, 'dir');
  fs.symlinkSync(['alias', '..', 'settings.yaml'].join(path.sep), linkPath, 'file');
  fs.writeFileSync(unrelatedPath, sentinel);

  assert.throws(() => writeConfig(linkPath, { dreamer: { enabled: true } }), /Cannot traverse \.\./);
  assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), sentinel);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(homeDir).sort(), ['alias', 'config.yaml', 'settings.yaml']);
});

test('rejects dangling config symlinks with directory-only targets', { skip: process.platform === 'win32' }, (t) => {
  const { homeDir } = configFixture(t);
  const slashLinkPath = path.join(homeDir, 'config-slash.yaml');
  const dotLinkPath = path.join(homeDir, 'config-dot.yaml');
  fs.symlinkSync('missing-slash/', slashLinkPath, 'file');
  fs.symlinkSync('missing-dot/.', dotLinkPath, 'file');

  const replacement = { dreamer: { enabled: true } };
  assert.throws(() => writeConfig(slashLinkPath, replacement), /Config symlink target must not be a directory path/);
  assert.throws(() => writeConfig(dotLinkPath, replacement), /Config symlink target must not be a directory path/);

  assert.equal(fs.existsSync(path.join(homeDir, 'missing-slash')), false);
  assert.equal(fs.existsSync(path.join(homeDir, 'missing-dot')), false);
  assert.equal(fs.lstatSync(slashLinkPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(dotLinkPath).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(homeDir).sort(), ['config-dot.yaml', 'config-slash.yaml']);
});

test('loads legacy Dreamer enabled flags with new defaults', (t) => {
  const options = configFixture(t);
  const userConfigPath = path.join(options.homeDir, 'settings.yaml');
  for (const enabled of [false, true]) {
    writeConfig(userConfigPath, { dreamer: { enabled } });
    assert.deepEqual(loadConfig({ ...options, userConfigPath }).dreamer, { ...defaultDreamer, enabled });
  }
});

test('merges nested Dreamer settings across layers before applying defaults and validating', (t) => {
  const options = configFixture(t);
  const userConfigPath = path.join(options.homeDir, 'settings.yaml');
  writeConfig(userConfigPath, { dreamer: {
    enabled: true, mode: 'http', http: { baseUrl: 'https://example.test/v1', apiKeyEnv: 'FIXTURE_KEY' },
    cli: { orchestrator: 'codex', args: ['exec'] }, cadence: { minIntervalHours: 3 },
  } });
  initGit(options.cwd);
  writeProjectConfig(userConfigPath, options.cwd, { dreamer: {
    http: { model: 'fixture-http' }, cli: { model: 'fixture-cli' }, cadence: { mode: 'auto' },
  } });
  assert.deepEqual(loadConfig({ ...options, userConfigPath }).dreamer, {
    enabled: true, mode: 'http',
    http: { baseUrl: 'https://example.test/v1', model: 'fixture-http', apiKeyEnv: 'FIXTURE_KEY' },
    cli: { orchestrator: 'codex', args: ['exec'], model: 'fixture-cli' },
    cadence: { mode: 'auto', minIntervalHours: 3, minNewMemories: 10 },
  });
});

test('requires the selected backend for an enabled Dreamer in the effective config', (t) => {
  const options = configFixture(t);
  const userConfigPath = path.join(options.homeDir, 'settings.yaml');
  for (const mode of ['http', 'cli']) {
    writeConfig(userConfigPath, { dreamer: { enabled: true, mode } });
    assert.throws(() => loadConfig({ ...options, userConfigPath }), /Required for Dreamer/);
    writeConfig(userConfigPath, { dreamer: { enabled: false, mode } });
    assert.equal(loadConfig({ ...options, userConfigPath }).dreamer.mode, mode);
  }
});

test('a project Dreamer URL change drops the inherited API key name', (t) => {
  const options = configFixture(t);
  const userConfigPath = path.join(options.homeDir, 'settings.yaml');
  initGit(options.cwd);
  const baseUrl = 'https://project.example.test/v1';
  writeConfig(userConfigPath, { dreamer: { enabled: true, mode: 'http', http: {
    baseUrl: 'https://user.example.test/v1', model: 'fixture', apiKeyEnv: 'USER_FIXTURE_KEY',
  } } });
  writeProjectConfig(userConfigPath, options.cwd, { dreamer: { http: { baseUrl } } });
  assert.deepEqual(loadConfig({ ...options, userConfigPath }).dreamer.http, { baseUrl, model: 'fixture' });

  writeProjectConfig(userConfigPath, options.cwd, { dreamer: { http: { baseUrl, apiKeyEnv: 'PROJECT_FIXTURE_KEY' } } });
  assert.deepEqual(loadConfig({ ...options, userConfigPath }).dreamer.http,
    { baseUrl, model: 'fixture', apiKeyEnv: 'PROJECT_FIXTURE_KEY' });
});

test('preserves the mode of an existing private POSIX config', { skip: process.platform === 'win32' }, (t) => {
  const { homeDir } = configFixture(t);
  const configPath = path.join(homeDir, 'config.yaml');
  fs.writeFileSync(configPath, '{"dbPath":"previous.db"}\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  writeConfig(configPath, { dreamer: { enabled: true } });

  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('removes the temporary config file when replacement fails', (t) => {
  const { homeDir } = configFixture(t);
  const configPath = path.join(homeDir, 'config.yaml');
  fs.mkdirSync(configPath);
  fs.writeFileSync(path.join(configPath, 'keep'), 'original');

  assert.throws(() => writeConfig(configPath, { dreamer: { enabled: true } }));

  assert.deepEqual(fs.readdirSync(homeDir), ['config.yaml']);
  assert.equal(fs.readFileSync(path.join(configPath, 'keep'), 'utf8'), 'original');
});
