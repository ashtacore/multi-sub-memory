import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runSetup } from '../src/cli/setup.mjs';
import { DEFAULT_CONFIG_PATH, DEFAULT_DB_PATH, expandHome, loadConfig, readConfigLayer, writeConfig } from '../src/config.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  fs.mkdirSync(homeDir);
  let output = '';
  let errors = '';
  const options = { homeDir, cwd, env: {},
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { errors += chunk; } },
  };
  return { options, output: () => output, errors: () => errors };
}

const entry = { command: 'npx', args: ['-y', 'multi-sub-memory'] };

test('setup merges JSON and TOML without overwriting unrelated settings and keeps original backups', async (t) => {
  const { options, errors, output } = fixture(t);
  const { cwd, homeDir } = options;
  const jsonPath = path.join(cwd, 'claude.json');
  const tomlPath = path.join(cwd, 'codex.toml');
  const json = {
    preferences: { mode: 'fixture' },
    mcpServers: {
      other: { command: 'other', env: { FIXTURE_TOKEN: 'placeholder' } },
      'multi-sub-memory': { command: 'old', env: { KEEP: 'placeholder' } },
    },
  };
  const jsonText = JSON.stringify(json);
  const toml = [
    '# Global comment',
    'description = """',
    '[mcp_servers.multi-sub-memory]',
    '"""',
    '',
    '[mcp_servers.other] # Other server',
    'command = "other"',
    '[mcp_servers.other.env]',
    'FIXTURE_TOKEN = "placeholder"',
    '',
    '[mcp_servers."multi-sub-memory"] # Entry',
    'command = "old" # Command',
    'args = [ # Arguments',
    '  # Keep this explanation',
    '  "old",',
    ']',
    'enabled = true',
    '',
    '[mcp_servers."multi-sub-memory".env]',
    'KEEP = "placeholder"',
    '',
    '[profiles.fixture]',
    'model = "fixture"',
    '',
  ].join('\r\n');
  fs.writeFileSync(jsonPath, jsonText);
  fs.writeFileSync(tomlPath, toml);
  const args = ['--yes', '--host', 'claude,codex', '--claude-config', 'claude.json', '--codex-config', 'codex.toml',
    '--db', 'setup.db', '--no-embeddings'];

  assert.equal(await runSetup(args, options), 0, errors());
  const writtenJson = fs.readFileSync(jsonPath, 'utf8');
  const writtenToml = fs.readFileSync(tomlPath, 'utf8');
  assert.deepEqual(JSON.parse(writtenJson), {
    ...json, mcpServers: { ...json.mcpServers, 'multi-sub-memory': { ...entry, env: { KEEP: 'placeholder' } } },
  });
  assert.equal(writtenToml, toml.replace('command = "old" # Command', 'command = "npx" # Command')
    .replace('args = [ # Arguments\r\n  # Keep this explanation\r\n  "old",\r\n]',
      'args = ["-y", "multi-sub-memory"] # Arguments\r\n  # Keep this explanation'));
  assert.match(output(), /Manual MCP configuration for omp/);
  assert.match(output(), /SQLite and FTS5 ready in WAL mode/);
  assert.match(output(), /Disabled; running in FTS-only mode/);
  assert.ok(fs.existsSync(path.join(cwd, 'setup.db')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(expandHome(DEFAULT_CONFIG_PATH, homeDir)).mode & 0o777, 0o600);
  }

  assert.equal(await runSetup(args, options), 0, errors());
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), writtenJson);
  assert.equal(fs.readFileSync(tomlPath, 'utf8'), writtenToml);
  assert.equal(fs.readFileSync(jsonPath + '.bak', 'utf8'), jsonText);
  assert.equal(fs.readFileSync(tomlPath + '.bak', 'utf8'), toml);
});

test('setup preserves JSON bytes outside new MCP fields across registration and re-runs', async (t) => {
  const { options, errors } = fixture(t);
  const sources = {
    omp: '\uFEFF{\r\n  "unrelated" : 9007199254740993\r\n}\r\n',
    claude: '{"mcp\\u0053ervers" : { "other": ["escaped \\\"}", {"unrelated":9007199254740993}] }}\n',
    agy: '{"mcpServers":{"multi-sub-memory":{"command" : "old", "unrelated":9007199254740993}}}\n',
  };
  const serializedEntry = JSON.stringify(entry);
  const expected = {
    omp: sources.omp.replace('9007199254740993', '9007199254740993, "mcpServers": {"multi-sub-memory":' + serializedEntry + '}'),
    claude: sources.claude.replace('}]', '}], "multi-sub-memory": ' + serializedEntry),
    agy: sources.agy.replace('"old"', '"npx"').replace('9007199254740993', '9007199254740993, "args": ' + JSON.stringify(entry.args)),
  };

  const args = ['--yes', '--host', 'omp,claude,agy', '--no-embeddings'];
  for (const [host, source] of Object.entries(sources)) {
    const file = path.join(options.cwd, host + '.json');
    fs.writeFileSync(file, source);
    args.push('--' + host + '-config', file);
  }
  for (let run = 0; run < 2; run++) {
    assert.equal(await runSetup(args, options), 0, errors());
    for (const [host, source] of Object.entries(sources)) {
      const file = path.join(options.cwd, host + '.json');
      const raw = fs.readFileSync(file, 'utf8');
      assert.equal(raw, expected[host]);
      assert.match(raw, /9007199254740993/);
      assert.equal(fs.readFileSync(file + '.bak', 'utf8'), source);
    }
  }
});

test('setup saves user defaults without promoting project or environment overrides', async (t) => {
  const { options, errors } = fixture(t);
  const { cwd, homeDir, env } = options;
  const projectPath = path.join(cwd, '.multi-sub-memory.jsonc');
  writeConfig(projectPath, {
    dbPath: 'project.db', embedding: { enabled: false, model: 'project-model' },
    dreamer: { enabled: true, mode: 'http', http: { baseUrl: 'https://example.test/v1', model: 'fixture' } },
  });
  env.MULTI_SUB_MEMORY_DB = 'environment.db';
  env.MULTI_SUB_MEMORY_NO_EMBEDDINGS = 'yes';
  env.MULTI_SUB_MEMORY_EMBEDDING_MODEL = 'environment-model';

  assert.equal(await runSetup(['--yes', '--host', 'none'], options), 0, errors());
  const dbPath = expandHome(DEFAULT_DB_PATH, homeDir);
  assert.deepEqual(readConfigLayer(expandHome(DEFAULT_CONFIG_PATH, homeDir)), {
    dbPath,
    embedding: { enabled: true },
    dreamer: { enabled: false, mode: 'disabled' },
  });
  assert.ok(fs.existsSync(dbPath));
  assert.equal(fs.existsSync(path.join(cwd, 'project.db')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'environment.db')), false);
});

test('setup preserves the stored database path when accepting the existing default', async (t) => {
  const { options, errors } = fixture(t);
  const { cwd, env, homeDir } = options;
  const configPath = expandHome(DEFAULT_CONFIG_PATH, homeDir);
  writeConfig(configPath, { dbPath: 'memory.db' });
  env.MULTI_SUB_MEMORY_NO_EMBEDDINGS = 'yes';

  assert.equal(await runSetup(['--yes', '--host', 'none'], options), 0, errors());
  assert.equal(readConfigLayer(configPath).dbPath, 'memory.db');
  assert.ok(fs.existsSync(path.join(cwd, 'memory.db')));

  writeConfig(configPath, { dbPath: '~/memory.db' });
  const stdin = new PassThrough();
  const setup = runSetup(['--host', 'none', '--no-embeddings'], { ...options, stdin });
  stdin.end('\n\n');
  assert.equal(await setup, 0, errors());
  assert.equal(readConfigLayer(configPath).dbPath, '~/memory.db');
  assert.ok(fs.existsSync(path.join(homeDir, 'memory.db')));
});

test('setup rejects an aliased settings and database path before creating either file', async (t) => {
  const { options, errors } = fixture(t);
  const target = path.join(options.cwd, 'target');
  const alias = path.join(options.cwd, 'alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const dbPath = path.join(target, 'missing', 'memory.db');
  const configPath = path.join(alias, 'missing', 'memory.db');

  assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--db', dbPath,
    '--config', configPath], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.equal(fs.existsSync(path.dirname(dbPath)), false);
});

test('setup on macOS rejects database collisions with prospective host backups', async (t) => {
  for (const [difference, hostName, dbName] of [
    ['case', 'host.json', 'HOST.JSON.BAK'],
    ['Unicode composition', 'caf\u00e9.json', 'cafe\u0301.json.bak'],
    ['Greek sigma case folding', '\u03c2.json', '\u03c3.json.bak'],
  ]) {
    await t.test(difference, async (t) => {
      const { options, errors } = fixture(t);
      const hostPath = path.join(options.cwd, hostName);
      const dbPath = path.join(options.cwd, dbName);
      const original = Buffer.from('{"preferences":{}}\n');
      fs.writeFileSync(hostPath, original);
      assert.equal(fs.existsSync(dbPath), false);

      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        assert.equal(await runSetup(['--yes', '--host', 'claude', '--claude-config', hostPath,
          '--db', dbPath, '--no-embeddings'], options), 1);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }

      assert.match(errors(), /Choose distinct paths/);
      assert.equal(fs.existsSync(dbPath), false);
      assert.equal(fs.existsSync(hostPath + '.bak'), false);
      assert.deepEqual(fs.readFileSync(hostPath), original);
    });
  }
});

test('setup rejects settings at the rollback-journal path before creating the database', async (t) => {
  const { options, errors } = fixture(t);
  const dbPath = path.join(options.cwd, 'memory.db');
  const configPath = dbPath + '-journal';
  const original = Buffer.from('{"bootstrap":{"tokenBudget":1000}}\r\n');
  fs.writeFileSync(configPath, original);

  assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--db', dbPath,
    '--config', configPath], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(configPath), original);
});

test('setup reserves the settings lock and its SQLite sidecar paths', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await t.test('.lock' + suffix, async (t) => {
      const { options, errors } = fixture(t);
      const configPath = path.join(options.cwd, 'settings.jsonc');
      const dbPath = configPath + '.lock' + suffix;
      assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--db', dbPath,
        '--config', configPath], options), 1);
      assert.match(errors(), /Choose distinct paths/);
      assert.equal(fs.existsSync(dbPath), false);
    });
  }
});

test('setup rejects a dangling settings symlink chain that points to the database path', async (t) => {
  const { options, errors } = fixture(t);
  const dbPath = path.join(options.cwd, 'missing', 'memory.db');
  const configPath = path.join(options.cwd, 'settings.jsonc');
  const intermediate = path.join(options.cwd, 'intermediate.jsonc');
  try {
    fs.symlinkSync(intermediate, configPath, 'file');
    fs.symlinkSync(dbPath, intermediate, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Creating file symlinks requires privileges on this Windows host');
    return;
  }

  assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--db', dbPath,
    '--config', configPath], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.equal(fs.existsSync(path.dirname(dbPath)), false);
  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(intermediate).isSymbolicLink(), true);
});

test('setup preserves settings created, edited or removed during the embedding probe', async (t) => {
  const initial = '{"bootstrap":{"tokenBudget":1000}}\n';
  const newer = '// new settings\n{"bootstrap":{"tokenBudget":2000}}\n';
  for (const [change, original, replacement] of [
    ['created', undefined, newer],
    ['edited', initial, newer],
    ['removed', initial, undefined],
  ]) {
    await t.test(change, async (t) => {
      const { options, errors } = fixture(t);
      const configPath = path.join(options.cwd, 'settings.jsonc');
      if (original !== undefined) fs.writeFileSync(configPath, original);
      const embed = t.mock.fn(async () => {
        if (replacement === undefined) fs.unlinkSync(configPath);
        else fs.writeFileSync(configPath, replacement);
        return new Float32Array([1]);
      });

      assert.equal(await runSetup(['--yes', '--host', 'none', '--config', configPath], {
        ...options, createEmbeddingEngine: () => ({ embed }),
      }), 1);
      assert.equal(embed.mock.callCount(), 1);
      assert.match(errors(), /Settings file changed during setup\. Run setup again\./);
      if (replacement === undefined) assert.equal(fs.existsSync(configPath), false);
      else assert.equal(fs.readFileSync(configPath, 'utf8'), replacement);
    });
  }
});

async function withReadySetupChild(cwd, source, args, run) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, '--', ...args], {
    cwd, stdio: 'pipe', timeout: 15000, killSignal: 'SIGKILL', windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { stderr += error.message; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    const ready = await output[Symbol.asyncIterator]().next();
    assert.equal(ready.value, 'ready', stderr);
    await run(child, closed, () => stderr);
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

const holdSettingsLock = `
  import { once } from 'node:events';
  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync(process.argv[1]);
  db.exec('PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;');
  const ended = once(process.stdin, 'end');
  process.stdin.resume();
  console.log('ready');
  await ended;
  db.exec('ROLLBACK');
  db.close();
`;

test('setup preserves settings while another process holds the settings lock', { timeout: 20000 }, async (t) => {
  const { options, errors } = fixture(t);
  const configPath = path.join(options.cwd, 'settings.jsonc');
  const lockPath = configPath + '.lock';
  const original = '{"bootstrap":{"tokenBudget":1000}}\r\n';
  fs.writeFileSync(configPath, original);

  await withReadySetupChild(options.cwd, holdSettingsLock, [lockPath], async (child, closed, childErrors) => {
    assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--config', configPath], options), 1);
    assert.match(errors(), /Another setup process is currently writing settings\. Run setup again\./);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.ok(fs.existsSync(lockPath));
    child.stdin.end();
    assert.deepEqual(await closed, { code: 0, signal: null }, childErrors());
  });
});

test('setup can save after the lock holder is killed', { timeout: 20000 }, async (t) => {
  const { options, errors } = fixture(t);
  const configPath = path.join(options.cwd, 'settings.jsonc');
  const lockPath = configPath + '.lock';
  const dbPath = path.join(options.cwd, 'recovered.db');
  writeConfig(configPath, { bootstrap: { tokenBudget: 1000 } });

  await withReadySetupChild(options.cwd, holdSettingsLock, [lockPath], async (child, closed, childErrors) => {
    assert.ok(child.kill('SIGKILL'));
    assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' }, childErrors());
    assert.ok(fs.existsSync(lockPath));
    assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--db', dbPath,
      '--config', configPath], options), 0, errors());
    assert.equal(readConfigLayer(configPath).dbPath, dbPath);
    assert.ok(fs.existsSync(lockPath));
  });
});

test('concurrent setup processes preserve the first commit when the other snapshot is stale',
  { timeout: 20000 }, async (t) => {
    const { options, errors } = fixture(t);
    const { cwd, homeDir } = options;
    const configPath = path.join(cwd, 'settings.jsonc');
    const firstDb = path.join(cwd, 'first.db');
    const secondDb = path.join(cwd, 'second.db');
    writeConfig(configPath, { embedding: { enabled: true } });

    const source = `
      import { once } from 'node:events';
      import { runSetup } from ${JSON.stringify(new URL('../src/cli/setup.mjs', import.meta.url).href)};
      const [configPath, dbPath, homeDir] = process.argv.slice(1);
      process.exitCode = await runSetup(['--yes', '--host', 'none', '--config', configPath, '--db', dbPath], {
        cwd: process.cwd(), homeDir, env: {}, stdout: { write() {} },
        createEmbeddingEngine: () => ({
          async embed() {
            const ended = once(process.stdin, 'end');
            process.stdin.resume();
            console.log('ready');
            await ended;
            return new Float32Array([1]);
          },
        }),
      });
    `;
    await withReadySetupChild(cwd, source, [configPath, secondDb, homeDir], async (child, closed, childErrors) => {
      assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings', '--config', configPath,
        '--db', firstDb], options), 0, errors());
      const committed = fs.readFileSync(configPath, 'utf8');
      assert.equal(readConfigLayer(configPath).dbPath, firstDb);
      child.stdin.end();
      assert.deepEqual(await closed, { code: 1, signal: null }, childErrors());
      assert.match(childErrors(), /Settings file changed during setup\. Run setup again\./);
      assert.equal(fs.readFileSync(configPath, 'utf8'), committed);
    });
  });

test('setup skips embedding inference when --no-embeddings overrides the probe', async (t) => {
  const { options, errors, output } = fixture(t);
  const { cwd, homeDir } = options;
  writeConfig(path.join(cwd, '.multi-sub-memory.jsonc'), { embedding: { enabled: true } });
  const embed = t.mock.fn(async () => new Float32Array([1]));
  const createEmbeddingEngine = t.mock.fn(() => ({ embed }));

  assert.equal(await runSetup(['--yes', '--host', 'none', '--no-embeddings'], {
    ...options, createEmbeddingEngine,
  }), 0, errors());
  assert.equal(createEmbeddingEngine.mock.callCount(), 0);
  assert.equal(embed.mock.callCount(), 0);
  assert.equal(readConfigLayer(expandHome(DEFAULT_CONFIG_PATH, homeDir)).embedding.enabled, false);
  assert.equal(loadConfig(options).embedding.enabled, true);
  assert.match(output(), /Setup probe skipped by request/);
});

test('non-interactive setup writes all three Dreamer modes', async (t) => {
  const { options, errors, output } = fixture(t);
  const { cwd } = options;
  const command = path.join(cwd, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
  fs.writeFileSync(command, 'fixture', { mode: 0o700 });
  const scenarios = [
    ['disabled', []],
    ['http', ['--http-base-url', 'https://example.test/v1', '--http-model', 'fixture', '--http-api-key-env', 'FIXTURE_KEY']],
    ['cli', ['--cli-orchestrator', 'omp', '--cli-command', command, '--cli-model', 'fixture', '--cadence', 'auto',
      '--cadence-interval-hours', '1.5', '--cadence-min-memories', '0']],
  ];
  for (const [mode, flags] of scenarios) {
    const userConfigPath = path.join(cwd, mode + '.jsonc');
    assert.equal(await runSetup(['-y', '--host', 'none', '--no-embeddings', '--config', userConfigPath,
      '--dreamer-mode', mode, ...flags], options), 0, errors());
    const { dreamer } = loadConfig({ ...options, userConfigPath });
    assert.equal(dreamer.mode, mode);
    assert.equal(dreamer.enabled, mode !== 'disabled');
    if (mode === 'http') {
      assert.deepEqual(dreamer.http, { baseUrl: 'https://example.test/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY' });
    } else if (mode === 'cli') {
      assert.deepEqual(dreamer.cli, { orchestrator: 'omp', command, args: ['-p', '--no-session'], model: 'fixture' });
      assert.deepEqual(dreamer.cadence, { mode: 'auto', minIntervalHours: 1.5, minNewMemories: 0 });
      assert.match(output(), /Dreamer CLI executable found/);
    }
  }
});

test('setup binds the Dreamer HTTP key only to the chosen endpoint', async (t) => {
  const { options, errors } = fixture(t);
  const configPath = path.join(options.cwd, 'settings.jsonc');
  writeConfig(configPath, {
    dreamer: { mode: 'http', enabled: true, http: {
      baseUrl: 'https://first.example.test/v1', model: 'fixture', apiKeyEnv: 'FIRST_KEY',
    } },
  });
  const baseUrl = 'https://second.example.test/v1';
  const args = ['--yes', '--host', 'none', '--no-embeddings', '--config', configPath, '--http-base-url', baseUrl];

  assert.equal(await runSetup(args, options), 0, errors());
  assert.deepEqual(readConfigLayer(configPath).dreamer.http, { baseUrl, model: 'fixture' });

  assert.equal(await runSetup([...args, '--http-api-key-env', 'SECOND_KEY'], options), 0, errors());
  assert.equal(await runSetup(args, options), 0, errors());
  assert.equal(readConfigLayer(configPath).dreamer.http.apiKeyEnv, 'SECOND_KEY');

  assert.equal(await runSetup([...args, '--http-api-key-env', '-'], options), 0, errors());
  assert.deepEqual(readConfigLayer(configPath).dreamer.http, { baseUrl, model: 'fixture' });
});

test('interactive setup consumes piped readline answers and registers the selected host', async (t) => {
  const { options, errors, output } = fixture(t);
  const stdin = new PassThrough();
  const setup = runSetup([], { ...options, stdin });
  stdin.end('interactive.db\nno\nagy\nhttp\nhttps://example.test/v1\nfixture-model\n\nmanual\n\n\n');
  assert.equal(await setup, 0, errors());
  assert.match(output(), /Database path/);
  assert.match(output(), /Dreamer cadence/);
  const config = loadConfig(options);
  assert.equal(config.dbPath, path.join(options.cwd, 'interactive.db'));
  assert.equal(config.embedding.enabled, false);
  assert.equal(config.dreamer.http.model, 'fixture-model');
  const hostPath = path.join(options.homeDir, '.gemini', 'antigravity', 'mcp_config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(hostPath, 'utf8')), { mcpServers: { 'multi-sub-memory': entry } });
  assert.equal(fs.existsSync(hostPath + '.bak'), false);
});

test('setup prints a manual snippet when a Codex inline table requires manual editing', async (t) => {
  const { options, errors, output } = fixture(t);
  const codexPath = path.join(options.cwd, 'codex.toml');
  const source = 'mcp_servers = { other = { command = "other" } }\n';
  fs.writeFileSync(codexPath, source);
  const code = await runSetup(['-y', '--host', 'codex', '--codex-config', codexPath, '--no-embeddings'], options);
  assert.equal(code, 1);
  assert.match(errors(), /Could not safely edit/);
  assert.match(output(), /Manual MCP configuration for codex/);
  assert.equal(fs.readFileSync(codexPath, 'utf8'), source);
  assert.equal(fs.existsSync(codexPath + '.bak'), false);
  assert.equal(fs.existsSync(expandHome(DEFAULT_CONFIG_PATH, options.homeDir)), false);
});

test('setup prints a manual snippet and preserves existing remote MCP registrations', async (t) => {
  const url = 'https://mcp.example.test/';
  for (const [host, filename, source, snippet] of [
    ['claude', 'claude.json', JSON.stringify({
      mcpServers: { 'multi-sub-memory': { type: 'http', url } },
    }), /"command": "npx"/],
    ['codex', 'codex.toml', '[mcp_servers.multi-sub-memory]\nurl = "' + url + '"\n', /command = "npx"/],
  ]) {
    await t.test(host, async (t) => {
      const { options, errors, output } = fixture(t);
      const hostPath = path.join(options.cwd, filename);
      fs.writeFileSync(hostPath, source);
      const code = await runSetup(['--yes', '--host', host, '--' + host + '-config', hostPath, '--no-embeddings'], options);
      assert.equal(code, 1);
      assert.match(errors(), /Could not safely edit/);
      assert.ok(output().includes('Manual MCP configuration for ' + host));
      assert.match(output(), snippet);
      assert.equal(fs.readFileSync(hostPath, 'utf8'), source);
      assert.equal(fs.existsSync(hostPath + '.bak'), false);
      assert.equal(fs.existsSync(expandHome(DEFAULT_CONFIG_PATH, options.homeDir)), false);
    });
  }
});
