import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigSchema, expandHome, loadConfig, parseJsonc, stripJsonc, writeConfig } from '../src/config.mjs';

function configFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(projectRoot);
  return { homeDir, projectRoot, env: {} };
}

test('loads defaults and expands only the current home marker', (t) => {
  const options = configFixture(t);
  const { homeDir } = options;
  assert.deepEqual(loadConfig(options), {
    dbPath: path.join(homeDir, '.local', 'share', 'multi-sub-memory', 'memory.db'),
    embedding: { model: 'BAAI/bge-base-en-v1.5', enabled: true },
    bootstrap: { tokenBudget: 2500 },
    dreamer: { enabled: false },
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

test('strips comments and trailing commas while preserving quoted content', () => {
  const url = 'https://example.com/a//b/*c*/';
  const quoted = 'He said "keep /* this */", path\\';
  const jsonc = [
    '{ // line comment',
    '  "url": ' + JSON.stringify(url) + ',',
    '  "items": [' + JSON.stringify(quoted) + ', /* block comment */ ],',
    '} // final comment',
  ].join('\r\n');
  const expected = { url, items: [quoted] };
  assert.deepEqual(JSON.parse(stripJsonc(jsonc)), expected);
  assert.deepEqual(parseJsonc(jsonc), expected);
  assert.throws(() => parseJsonc('{} /* missing close'), /unterminated block comment/i);
  assert.throws(() => parseJsonc('[1/* separator */2]'), SyntaxError);
  assert.throws(() => parseJsonc('[,]'), SyntaxError);
});

test('accepts a single leading UTF-8 BOM in JSONC config', (t) => {
  const options = configFixture(t);
  const userConfigPath = path.join(options.homeDir, 'config.jsonc');
  const model = 'model\uFEFFname';
  const jsonc = `\uFEFF{ // config saved with a UTF-8 BOM\n  "embedding": { "model": "${model}", },\n}`;
  const expected = { embedding: { model } };

  assert.deepEqual(JSON.parse(stripJsonc(jsonc)), expected);
  assert.deepEqual(parseJsonc(jsonc), expected);
  assert.equal(stripJsonc('\uFEFF\uFEFF{}'), '\uFEFF{}');
  assert.equal(stripJsonc(' \uFEFF{}'), ' \uFEFF{}');

  fs.writeFileSync(userConfigPath, jsonc, 'utf8');
  assert.equal(loadConfig({ ...options, userConfigPath }).embedding.model, model);
});

test('merges environment, project, user, and default config in precedence order', (t) => {
  const options = configFixture(t);
  const { homeDir, projectRoot } = options;
  writeConfig(path.join(homeDir, '.config', 'multi-sub-memory', 'config.jsonc'), {
    dbPath: '~/user.db',
    embedding: { model: 'user-model', enabled: false },
    bootstrap: { tokenBudget: 1000 },
  });
  writeConfig(path.join(projectRoot, '.multi-sub-memory.jsonc'), {
    dbPath: '~/project.db',
    embedding: { model: 'project-model' },
  });

  assert.deepEqual(loadConfig(options), {
    dbPath: path.join(homeDir, 'project.db'),
    embedding: { model: 'project-model', enabled: false },
    bootstrap: { tokenBudget: 1000 },
    dreamer: { enabled: false },
  });
  assert.equal(loadConfig({ ...options, projectConfigPath: path.join(projectRoot, 'absent.jsonc') }).dbPath,
    path.join(homeDir, 'user.db'));

  writeConfig(path.join(homeDir, 'custom.jsonc'), { bootstrap: { tokenBudget: 1200 } });
  const env = {
    MULTI_SUB_MEMORY_DB: '~\\env.db',
    MULTI_SUB_MEMORY_CONFIG: '~/custom.jsonc',
    MULTI_SUB_MEMORY_NO_EMBEDDINGS: 'yes',
    MULTI_SUB_MEMORY_EMBEDDING_MODEL: 'env-model',
  };
  assert.deepEqual(loadConfig({ ...options, env }), {
    dbPath: path.join(homeDir, 'env.db'),
    embedding: { model: 'env-model', enabled: false },
    bootstrap: { tokenBudget: 1200 },
    dreamer: { enabled: false },
  });
  env.MULTI_SUB_MEMORY_NO_EMBEDDINGS = 'no';
  assert.equal(loadConfig({ ...options, env }).embedding.enabled, true);
  assert.equal(loadConfig({
    ...options,
    env,
    userConfigPath: path.join(homeDir, '.config', 'multi-sub-memory', 'config.jsonc'),
  }).bootstrap.tokenBudget, 1000);
});

test('rejects invalid values and unknown keys in individual config layers', (t) => {
  const options = configFixture(t);
  const projectConfigPath = path.join(options.projectRoot, 'invalid.jsonc');
  const invalidConfigs = [
    { embedding: { enabled: 'true' } },
    { bootstrap: { tokenBudget: -1 } },
    { bootstrap: { tokenBudget: 1.5 } },
    { embedding: { unknown: true } },
    { unexpected: true },
    { dbPath: '' },
  ];
  for (const invalid of invalidConfigs) {
    fs.writeFileSync(projectConfigPath, JSON.stringify(invalid));
    assert.throws(() => loadConfig({ ...options, projectConfigPath }), /Invalid config at/);
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

test('validates config and creates parent directories before writing JSON', (t) => {
  const options = configFixture(t);
  const data = loadConfig(options);
  const configPath = '~/missing/nested/config.jsonc';
  const outputPath = expandHome(configPath, options.homeDir);

  assert.throws(() => writeConfig(configPath, { dreamer: { enabled: 'false' } }, options));
  assert.equal(fs.existsSync(path.dirname(outputPath)), false);

  writeConfig(configPath, data, options);
  const written = fs.readFileSync(outputPath, 'utf8');
  assert.equal(written, JSON.stringify(data, null, 2) + '\n');
  assert.deepEqual(ConfigSchema.parse(JSON.parse(written)), data);
});

test('replaces existing config without leaving a temporary sibling', (t) => {
  const { homeDir } = configFixture(t);
  const configPath = path.join(homeDir, 'config.jsonc');
  fs.writeFileSync(configPath, '{"dbPath":"previous.db"}\n');
  const replacement = { dreamer: { enabled: true } };

  writeConfig(configPath, replacement);

  assert.deepEqual(parseJsonc(fs.readFileSync(configPath, 'utf8')), replacement);
  assert.deepEqual(fs.readdirSync(homeDir), ['config.jsonc']);
});

test('writes through chained config symlinks to missing and existing targets', (t) => {
  const { homeDir, projectRoot: dotfilesDir } = configFixture(t);
  const linkPath = path.join(homeDir, 'config.jsonc');
  const intermediatePath = path.join(dotfilesDir, 'linked.jsonc');
  const targetDir = path.join(dotfilesDir, 'settings');
  const targetPath = path.join(targetDir, 'config.jsonc');
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
  assert.deepEqual(parseJsonc(fs.readFileSync(targetPath, 'utf8')), initial);

  if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o640);
  const replacement = { dreamer: { enabled: true } };
  writeConfig(linkPath, replacement);
  assert.deepEqual(parseJsonc(fs.readFileSync(targetPath, 'utf8')), replacement);
  if (process.platform !== 'win32') assert.equal(fs.statSync(targetPath).mode & 0o777, 0o640);

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(intermediatePath).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(homeDir), ['config.jsonc']);
  assert.deepEqual(fs.readdirSync(dotfilesDir).sort(), ['linked.jsonc', 'settings']);
  assert.deepEqual(fs.readdirSync(targetDir), ['config.jsonc']);
});

test('preserves the mode of an existing private POSIX config', { skip: process.platform === 'win32' }, (t) => {
  const { homeDir } = configFixture(t);
  const configPath = path.join(homeDir, 'config.jsonc');
  fs.writeFileSync(configPath, '{"dbPath":"previous.db"}\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  writeConfig(configPath, { dreamer: { enabled: true } });

  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('removes the temporary config file when replacement fails', (t) => {
  const { homeDir } = configFixture(t);
  const configPath = path.join(homeDir, 'config.jsonc');
  fs.mkdirSync(configPath);
  fs.writeFileSync(path.join(configPath, 'keep'), 'original');

  assert.throws(() => writeConfig(configPath, { dreamer: { enabled: true } }));

  assert.deepEqual(fs.readdirSync(homeDir), ['config.jsonc']);
  assert.equal(fs.readFileSync(path.join(configPath, 'keep'), 'utf8'), 'original');
});
