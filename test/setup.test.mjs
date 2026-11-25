import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runSetup } from '../src/cli/setup.mjs';
import { DEFAULT_CONFIG_PATH, DEFAULT_DB_PATH, expandHome, loadConfig, readConfigLayer, writeConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { writeMemory } from '../src/memory-service.mjs';
import { initGit, writeProjectConfig } from './git-fixtures.mjs';

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
  initGit(cwd);
  const userConfigPath = expandHome(DEFAULT_CONFIG_PATH, homeDir);
  const project = {
    dbPath: 'project.db', embedding: { enabled: false, model: 'project-model' },
    dreamer: { enabled: true, mode: 'http', http: { baseUrl: 'https://example.test/v1', model: 'fixture' } },
  };
  writeProjectConfig(userConfigPath, cwd, project);
  const { projects } = readConfigLayer(userConfigPath);
  env.MULTI_SUB_MEMORY_DB = 'environment.db';
  env.MULTI_SUB_MEMORY_NO_EMBEDDINGS = 'yes';
  env.MULTI_SUB_MEMORY_EMBEDDING_MODEL = 'environment-model';

  assert.equal(await runSetup(['--yes', '--host', 'none'], options), 0, errors());
  const dbPath = expandHome(DEFAULT_DB_PATH, homeDir);
  assert.deepEqual(readConfigLayer(expandHome(DEFAULT_CONFIG_PATH, homeDir)), {
    dbPath,
    embedding: { enabled: true },
    dreamer: { enabled: false, mode: 'disabled' },
    projects,
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
      const configPath = path.join(options.cwd, 'settings.yaml');
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
  const configPath = path.join(options.cwd, 'settings.yaml');
  const intermediate = path.join(options.cwd, 'intermediate.yaml');
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
      const configPath = path.join(options.cwd, 'settings.yaml');
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
  const configPath = path.join(options.cwd, 'settings.yaml');
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
  const configPath = path.join(options.cwd, 'settings.yaml');
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
    const configPath = path.join(cwd, 'settings.yaml');
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
  initGit(cwd);
  writeProjectConfig(expandHome(DEFAULT_CONFIG_PATH, homeDir), cwd, { embedding: { enabled: true } });
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
  const command = path.join(cwd, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
  fs.writeFileSync(command, 'fixture', { mode: 0o700 });
  const scenarios = [
    ['disabled', []],
    ['http', ['--http-base-url', 'https://example.test/v1', '--http-model', 'fixture', '--http-api-key-env', 'FIXTURE_KEY']],
    ['cli', ['--cli-orchestrator', 'omp', '--cli-command', command, '--cli-model', 'fixture', '--cadence', 'auto',
      '--cadence-interval-hours', '1.5', '--cadence-min-memories', '0']],
  ];
  for (const [mode, flags] of scenarios) {
    const userConfigPath = path.join(cwd, mode + '.yaml');
    assert.equal(await runSetup(['-y', '--host', 'none', '--no-embeddings', '--config', userConfigPath,
      '--dreamer-mode', mode, ...flags], options), 0, errors());
    const { dreamer } = loadConfig({ ...options, userConfigPath });
    assert.equal(dreamer.mode, mode);
    assert.equal(dreamer.enabled, mode !== 'disabled');
    if (mode === 'http') {
      assert.deepEqual(dreamer.http, { baseUrl: 'https://example.test/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY' });
    } else if (mode === 'cli') {
      assert.deepEqual(dreamer.cli, { orchestrator: 'omp', command, args: ['-p', '--no-session', '--no-tools'], model: 'fixture' });
      assert.deepEqual(dreamer.cadence, { mode: 'auto', minIntervalHours: 1.5, minNewMemories: 0 });
      assert.match(output(), /Dreamer CLI executable found/);
    }
  }
});

test('setup binds the Dreamer HTTP key only to the chosen endpoint', async (t) => {
  const { options, errors } = fixture(t);
  const configPath = path.join(options.cwd, 'settings.yaml');
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

test('setup warns when the configured Dreamer command is only a relative path or shell shim', async (t) => {
  const { options, errors, output } = fixture(t);
  const { cwd } = options;
  const filename = process.platform === 'win32' ? 'fixture.exe' : 'fixture';
  fs.writeFileSync(path.join(cwd, filename), 'fixture', { mode: 0o700 });
  const commands = ['./' + filename];
  if (process.platform === 'win32') {
    const shim = path.join(cwd, 'fixture.cmd');
    fs.writeFileSync(shim, '@exit /b 1');
    commands.push(shim);
  }
  for (const [index, command] of commands.entries()) {
    assert.equal(await runSetup(['-y', '--host', 'none', '--no-embeddings', '--config', path.join(cwd, index + '.yaml'),
      '--dreamer-mode', 'cli', '--cli-orchestrator', 'omp', '--cli-command', command], options), 0, errors());
  }
  assert.equal((output().match(/Dreamer requires a native executable .* on PATH or an absolute executable path/g) ?? []).length,
    commands.length);
  assert.doesNotMatch(output(), /Dreamer CLI executable found/);
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

const hookSetup = ['--yes', '--host', 'none', '--no-embeddings'];

test('setup installs, loads, and removes the managed OMP loader', async (t) => {
  const { options, errors, output } = fixture(t);
  const extensionDir = path.join(options.cwd, 'extensions');
  const managedDir = path.join(extensionDir, 'multi-sub-memory');
  const loaderPath = path.join(managedDir, 'index.js');
  const manifestPath = path.join(managedDir, 'package.json');
  const unrelated = path.join(extensionDir, 'unrelated.mjs');
  fs.mkdirSync(extensionDir);
  fs.writeFileSync(unrelated, '// fixture');
  const override = ['--omp-extensions-dir', 'extensions'];
  const install = [...hookSetup, ...override, '--hooks', 'omp'];
  assert.equal(await runSetup(install, options), 0, errors());
  const source = fs.readFileSync(loaderPath, 'utf8');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  assert.deepEqual(JSON.parse(manifest), { type: 'module', private: true, multiSubMemoryManaged: true });
  assert.match(source, /^\/\/ Managed by multi-sub-memory setup/);
  assert.equal(await runSetup(install, options), 0, errors());
  assert.match(output(), /Startup hook already installed for omp/);
  assert.equal(fs.readFileSync(loaderPath, 'utf8'), source);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifest);

  const dbPath = expandHome(DEFAULT_DB_PATH, options.homeDir);
  const db = openDatabase(dbPath);
  try {
    initGit(options.cwd);
    await writeMemory(db, { content: 'Installed loader fixture', cwd: options.cwd });
  } finally {
    db.close();
  }
  const env = { ...process.env, MULTI_SUB_MEMORY_DB: dbPath,
    MULTI_SUB_MEMORY_CONFIG: expandHome(DEFAULT_CONFIG_PATH, options.homeDir), MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1' };
  const target = pathToFileURL(loaderPath).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { default: register } = await import(${JSON.stringify(target)});
    let run;
    register({ on(name, handler) {
      if (name !== 'before_agent_start') throw new Error(name);
      run = handler;
    } });
    const result = await run({ systemPrompt: 'Original' }, { cwd: process.cwd(), sessionId: 'fixture' });
    process.stdout.write(result?.systemPrompt ?? '');
  `], { cwd: options.cwd, env, encoding: 'utf8', timeout: 6000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^Original\n\n<project-memory [^>]+>[\s\S]*Installed loader fixture/);

  fs.writeFileSync(loaderPath, source.replace(/import\("[^"]+"\)/,
    'import(' + JSON.stringify(pathToFileURL(path.join(options.cwd, 'missing.mjs')).href) + ')'));
  const { default: registerBroken } = await import(pathToFileURL(loaderPath).href);
  let brokenHandler;
  registerBroken({ on: (name, handler) => {
    assert.equal(name, 'before_agent_start');
    brokenHandler = handler;
  } });
  assert.equal(await brokenHandler({}, {}), undefined);

  // Hook-only uninstall can proceed with invalid application config.
  const configPath = expandHome(DEFAULT_CONFIG_PATH, options.homeDir);
  fs.writeFileSync(configPath, '{ invalid');
  const before = fs.readFileSync(dbPath);
  assert.equal(await runSetup(['--uninstall-hooks', 'omp', ...override], options), 0, errors());
  assert.equal(fs.existsSync(loaderPath), false);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(fs.existsSync(managedDir), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), '// fixture');
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ invalid');
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('setup protects unmanaged OMP files and retains other files in the managed directory', async (t) => {
  const { options, errors } = fixture(t);
  const directory = path.join(options.homeDir, '.omp', 'agent', 'extensions', 'multi-sub-memory');
  const loader = path.join(directory, 'index.js');
  const manifest = path.join(directory, 'package.json');
  const userManifest = '{"type":"module","name":"fixture"}\n';
  const other = path.join(directory, 'fixture.mjs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(loader, '// unmanaged');
  fs.writeFileSync(other, '// fixture');
  assert.equal(await runSetup([...hookSetup, '--hooks', 'omp'], options), 1);
  assert.match(errors(), /Unmanaged OMP extension/);
  assert.equal(fs.existsSync(expandHome(DEFAULT_DB_PATH, options.homeDir)), false);
  assert.equal(await runSetup(['--uninstall-hooks', 'omp'], options), 0);
  assert.equal(fs.readFileSync(loader, 'utf8'), '// unmanaged');
  assert.equal(fs.existsSync(manifest), false);
  fs.writeFileSync(loader, '// Managed by multi-sub-memory setup\n');
  fs.writeFileSync(manifest, userManifest);
  assert.equal(await runSetup([...hookSetup, '--hooks', 'omp'], options), 1);
  assert.match(errors(), /Unmanaged OMP extension at .*package\.json/);
  assert.equal(fs.readFileSync(loader, 'utf8'), '// Managed by multi-sub-memory setup\n');
  assert.equal(await runSetup(['--uninstall-hooks', 'omp'], options), 0);
  assert.equal(fs.existsSync(loader), false);
  assert.equal(fs.readFileSync(manifest, 'utf8'), userManifest);
  assert.equal(fs.readFileSync(other, 'utf8'), '// fixture');
});

test('setup appends and removes a Claude startup hook with byte-preserving edits and backups', async (t) => {
  const { options, errors, output } = fixture(t);
  const file = path.join(options.cwd, 'settings.json');
  const lookalike = 'node "/tools/multi-sub-memory-custom/hooks/claude/session-start.mjs"';
  const existing = '{ "matcher" : "resume", "hooks" : [{"type":"command","command":'
    + JSON.stringify(lookalike) + '}], "number":9007199254740993 }';
  const source = '\uFEFF{\r\n  "hooks": { "SessionStart" : [\r\n    ' + existing
    + '\r\n  ], "Stop": [] },\r\n  "number":9007199254740993\r\n}\r\n';
  fs.writeFileSync(file, source);
  const override = ['--claude-settings', 'settings.json'];
  const install = [...hookSetup, ...override, '--hooks', 'claude'];
  assert.equal(await runSetup(install, options), 0, errors());
  const read = () => fs.readFileSync(file, 'utf8');
  const installed = read();
  const [, managed] = JSON.parse(installed.slice(1)).hooks.SessionStart;
  assert.equal(managed.matcher, '');
  assert.equal(managed.hooks[0].type, 'command');
  const command = managed.hooks[0].command;
  assert.match(command, /^node --input-type=module -e "\/\* multi-sub-memory:claude-session-start \*\/ import\(/);
  const argument = /"([^"]+)"$/.exec(command)[1];
  const encoded = command.includes("Buffer.from(process.argv[1],'base64url')");
  const targetUrl = encoded ? Buffer.from(argument, 'base64url').toString() : argument;
  assert.match(targetUrl, /^file:\/\/.*\/hooks\/claude\/session-start\.mjs$/);
  assert.equal(installed, source.replace(existing, existing + ', ' + JSON.stringify(managed)));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), source);
  assert.equal(await runSetup(install, options), 0, errors());
  assert.match(output(), /Startup hook already installed for claude/);
  assert.equal(read(), installed);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), source);

  const dbPath = expandHome(DEFAULT_DB_PATH, options.homeDir);
  const db = openDatabase(dbPath);
  try {
    initGit(options.cwd);
    await writeMemory(db, { content: 'Installed Claude hook fixture', cwd: options.cwd });
  } finally {
    db.close();
  }
  const spawnOptions = {
    shell: true, cwd: options.cwd, encoding: 'utf8', timeout: 6000, windowsHide: true,
    input: JSON.stringify({ cwd: options.cwd, session_id: 'fixture' }),
    env: { ...process.env, MULTI_SUB_MEMORY_DB: dbPath,
      MULTI_SUB_MEMORY_CONFIG: expandHome(DEFAULT_CONFIG_PATH, options.homeDir), MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1' },
  };
  // Exercise the installed shell command with room for cold subprocess startup.
  const cliCall = 'runClaudeSessionStartCli?.()';
  assert.ok(command.includes(cliCall));
  const testCommand = command.replace(cliCall, 'runClaudeSessionStartCli?.({timeoutMs:3000})');
  const child = spawnSync(testCommand, spawnOptions);
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^<project-memory [^>]+>[\s\S]*Installed Claude hook fixture/);

  const missingUrl = new URL(path.basename(path.dirname(options.cwd)) + '.mjs', targetUrl).href;
  assert.equal(fs.existsSync(new URL(missingUrl)), false);
  const missingArgument = encoded ? Buffer.from(missingUrl).toString('base64url') : missingUrl;
  const missing = spawnSync(command.replace(/"[^"]+"$/, () => `"${missingArgument}"`), spawnOptions);
  assert.ifError(missing.error);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, '');

  assert.equal(await runSetup(['--uninstall-hooks', 'claude', ...override], options), 0, errors());
  assert.equal(read(), source.replace(existing, existing + ' '));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), installed);
});

test('setup updates a marked Claude command in place and preserves hooks in the same matcher group', async (t) => {
  const { options, errors } = fixture(t);
  const file = path.join(options.cwd, 'claude.json');
  const previous = 'node --input-type=module -e "/* multi-sub-memory:claude-session-start */"';
  const other = '{"type":"command","command":"side task","timeout":9007199254740993}';
  const managed = '{"type":"command","command":' + JSON.stringify(previous) + '}';
  const source = '{"hooks":{"SessionStart":[{"matcher":"resume","hooks":[' + other + ',' + managed
    + ',' + other + ']}],"Stop":[]},"number":9007199254740993}\n';
  fs.writeFileSync(file, source);
  const override = ['--claude-settings', file];
  assert.equal(await runSetup([...hookSetup, ...override, '--hooks', 'claude'], options), 0, errors());
  const updated = fs.readFileSync(file, 'utf8');
  const command = JSON.parse(updated).hooks.SessionStart[0].hooks[1].command;
  assert.notEqual(command, previous);
  assert.equal(updated, source.replace(JSON.stringify(previous), JSON.stringify(command)));
  assert.equal(await runSetup(['--uninstall-hooks', 'claude', ...override], options), 0, errors());
  assert.equal(fs.readFileSync(file, 'utf8'), source.replace(managed + ',', ''));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), updated);
});

test('setup supports all hosts and rejects overlapping flags and backup collisions before writes', async (t) => {
  const { options, errors } = fixture(t);
  const loader = path.join(options.homeDir, '.omp', 'agent', 'extensions', 'multi-sub-memory', 'index.js');
  const manifest = path.join(path.dirname(loader), 'package.json');
  const settings = path.join(options.homeDir, '.claude', 'settings.json');
  const database = expandHome(DEFAULT_DB_PATH, options.homeDir);
  assert.equal(await runSetup([...hookSetup, '--hooks', 'all', '--uninstall-hooks', 'omp'], options), 1);
  assert.match(errors(), /cannot appear in both/);
  assert.equal(await runSetup([...hookSetup, '--hooks', 'omp,claude', '--db', settings + '.bak'], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.equal(await runSetup([...hookSetup, '--hooks', 'omp', '--db', manifest], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.equal(fs.existsSync(database), false);
  assert.equal(fs.existsSync(loader), false);
  assert.equal(fs.existsSync(manifest), false);

  assert.equal(await runSetup([...hookSetup, '--hooks', 'omp', '--hooks', 'all'], options), 0, errors());
  assert.equal(fs.existsSync(loader), true);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.SessionStart.length, 1);
  assert.equal(await runSetup(['--uninstall-hooks', 'all'], options), 0, errors());
  assert.equal(fs.existsSync(loader), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.SessionStart, []);
  assert.equal(await runSetup(['--uninstall-hooks', 'omp', '--uninstall-hooks', 'claude'], options), 0, errors());
});

test('setup rejects a Claude settings backup that aliases the database through its parent', async (t) => {
  const { options, errors } = fixture(t);
  const directory = path.join(options.cwd, 'actual');
  const alias = path.join(options.cwd, 'alias');
  fs.mkdirSync(directory);
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const settings = path.join(directory, 'settings.json');
  const database = settings + '.bak';
  const db = openDatabase(database);
  db.close();
  const originalDb = fs.readFileSync(database);
  const originalSettings = Buffer.from('{ "fixture": true }\n');
  fs.writeFileSync(settings, originalSettings);

  assert.equal(await runSetup([...hookSetup, '--hooks', 'claude', '--db', database,
    '--claude-settings', path.join(alias, 'settings.json')], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.deepEqual(fs.readFileSync(database), originalDb);
  assert.deepEqual(fs.readFileSync(settings), originalSettings);
  assert.equal(fs.existsSync(expandHome(DEFAULT_CONFIG_PATH, options.homeDir)), false);
});

test('setup rejects a Claude backup at the effective database path before opening storage', async (t) => {
  const { options, errors } = fixture(t);
  const settings = path.join(options.cwd, 'claude-settings.json');
  const database = settings + '.bak';
  options.env.MULTI_SUB_MEMORY_DB = database;
  const db = openDatabase(database);
  db.close();
  const originalDb = fs.readFileSync(database);
  const originalSettings = Buffer.from('{ "fixture": true }\n');
  fs.writeFileSync(settings, originalSettings);

  assert.equal(await runSetup([...hookSetup, '--hooks', 'claude', '--claude-settings', settings], options), 1);
  assert.match(errors(), /Choose distinct paths/);
  assert.deepEqual(fs.readFileSync(database), originalDb);
  assert.deepEqual(fs.readFileSync(settings), originalSettings);
  assert.equal(fs.existsSync(expandHome(DEFAULT_DB_PATH, options.homeDir)), false);
  assert.equal(fs.existsSync(expandHome(DEFAULT_CONFIG_PATH, options.homeDir)), false);
});

test('setup rejects a Claude backup at the effective SQLite file URI before opening storage', async (t) => {
  const cases = [
    ['file URL', 'claude settings.json', (backup) => pathToFileURL(backup).href],
    ['relative URI with a literal tilde', path.join('~', 'claude-settings.json'),
      () => 'file:~/claude-settings.json.bak'],
  ];
  if (process.platform === 'win32') {
    cases.push(['single-slash drive URI', 'claude-settings.json', (backup) => 'file:' + pathToFileURL(backup).pathname]);
  }

  for (const [name, settingsPath, makeURI] of cases) {
    await t.test(name, async (subtest) => {
      const { options, errors } = fixture(subtest);
      const settings = path.join(options.cwd, settingsPath);
      const backup = settings + '.bak';
      const selectedDbPath = path.join(options.cwd, 'selected.db');
      const originalSettings = Buffer.from('{ "fixture": true }\n');
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, originalSettings);
      options.env.MULTI_SUB_MEMORY_DB = makeURI(backup);

      assert.equal(await runSetup([...hookSetup, '--db', selectedDbPath, '--hooks', 'claude',
        '--claude-settings', settings], options), 1, errors());
      assert.match(errors(), /Choose distinct paths/);
      assert.deepEqual(fs.readFileSync(settings), originalSettings);
      assert.equal(fs.existsSync(backup), false);
      assert.equal(fs.existsSync(selectedDbPath), false);
    });
  }
});

test('hook-only Claude uninstall refuses to overwrite a SQLite database as a backup', async (t) => {
  const { options, errors } = fixture(t);
  const settings = path.join(options.cwd, 'claude-settings.json');
  const database = settings + '.bak';
  const db = openDatabase(database);
  db.close();
  const originalDb = fs.readFileSync(database);
  const originalSettings = Buffer.from(JSON.stringify({
    hooks: { SessionStart: [{ matcher: '', hooks: [{
      type: 'command', command: 'node -e "/* multi-sub-memory:claude-session-start */"',
    }] }] },
  }) + '\n');
  fs.writeFileSync(settings, originalSettings);

  assert.equal(await runSetup(['--uninstall-hooks', 'claude', '--claude-settings', settings], options), 1);
  assert.match(errors(), /Refusing to overwrite SQLite database at .* with a backup/);
  assert.deepEqual(fs.readFileSync(database), originalDb);
  assert.deepEqual(fs.readFileSync(settings), originalSettings);
});

test('hook-only Claude uninstall protects absent database files and sidecars from backup writes', async (t) => {
  const cases = [
    ['environment override with malformed config', 'settings.json', ({ options, backup, user }) => {
      options.env.MULTI_SUB_MEMORY_DB = backup;
      fs.writeFileSync(user, '{ invalid');
    }],
    ['file URI with conflicting modes', 'settings.json', ({ options, backup }) => {
      options.env.MULTI_SUB_MEMORY_DB = pathToFileURL(backup).href + '?mode=memory&mode=rwc';
    }],
    ['user config with an invalid unrelated field', 'settings.json', ({ backup, user }) => {
      fs.writeFileSync(user, JSON.stringify({ dbPath: backup, embedding: false }));
    }],
    ['repository YAML override and rollback sidecar', 'settings.json-journal', ({ options, settings, user }) => {
      initGit(options.cwd);
      writeProjectConfig(user, options.cwd, { dbPath: pathToFileURL(settings.slice(0, -'-journal'.length)).href });
    }],
  ];
  for (const [name, settingsName, configure] of cases) {
    await t.test(name, async (subtest) => {
      const { options, errors } = fixture(subtest);
      const settings = path.join(options.cwd, settingsName);
      const backup = settings + '.bak';
      const user = path.join(options.cwd, 'config.yaml');
      options.env.MULTI_SUB_MEMORY_CONFIG = user;
      const original = Buffer.from(JSON.stringify({
        hooks: { SessionStart: [{ matcher: '', hooks: [{
          type: 'command', command: 'node -e "/* multi-sub-memory:claude-session-start */"',
        }] }] },
      }) + '\n');
      fs.writeFileSync(settings, original);
      configure({ options, settings, backup, user });

      assert.equal(fs.existsSync(backup), false);
      assert.equal(await runSetup(['--uninstall-hooks', 'claude', '--claude-settings', settings], options), 1);
      assert.match(errors(), /Choose distinct paths/);
      assert.deepEqual(fs.readFileSync(settings), original);
      assert.equal(fs.existsSync(backup), false);
    });
  }
});

test('skill-only setup installs, upgrades, and removes guides while preserving edits and unmanaged skills', async (t) => {
  const { options, errors, output } = fixture(t);
  const paths = Object.fromEntries(Object.entries({
    codex: ['.agents', 'skills'],
    claude: ['.claude', 'skills'],
    omp: ['.omp', 'agent', 'skills'],
    agy: ['.gemini', 'config', 'skills'],
  }).map(([host, parts]) => [host, path.join(options.homeDir, ...parts, 'multi-sub-memory', 'SKILL.md')]));
  const userSkill = 'User-authored guide\n';
  fs.mkdirSync(path.dirname(paths.claude), { recursive: true });
  fs.writeFileSync(paths.claude, userSkill);
  assert.equal(await runSetup(['--install-skills', 'all'], options), 0, errors());
  const installed = fs.readFileSync(paths.codex, 'utf8');
  assert.match(installed, /^---\r?\nname: multi-sub-memory/);
  assert.match(installed, /<!-- Managed by multi-sub-memory setup \(sha256:[a-f0-9]{64}\) -->/);
  assert.equal(fs.readFileSync(paths.agy, 'utf8'), installed);
  assert.equal(fs.readFileSync(paths.omp, 'utf8'), installed);
  assert.equal(fs.readFileSync(paths.claude, 'utf8'), userSkill);

  const edited = installed.replace('# Memory guide', '# My memory guide');
  fs.writeFileSync(paths.codex, edited);
  const { createHash } = await import('node:crypto');
  const older = '---\nname: multi-sub-memory\ndescription: Older guide\n---\n';
  const digest = createHash('sha256').update(older).digest('hex');
  fs.writeFileSync(paths.omp, older + '\n<!-- Managed by multi-sub-memory setup (sha256:' + digest + ') -->\n');
  assert.equal(await runSetup(['--install-skills', 'all'], options), 0, errors());
  assert.equal(fs.readFileSync(paths.codex, 'utf8'), edited);
  assert.equal(fs.readFileSync(paths.omp, 'utf8'), installed);
  assert.match(output(), /Preserved existing skill for codex/);

  const sibling = path.join(path.dirname(paths.agy), 'personal.md');
  fs.writeFileSync(sibling, 'Keep this file');
  assert.equal(await runSetup(['--uninstall-skills', 'all'], options), 0, errors());
  assert.equal(fs.readFileSync(paths.codex, 'utf8'), edited);
  assert.equal(fs.readFileSync(paths.claude, 'utf8'), userSkill);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'Keep this file');
  assert.equal(fs.existsSync(paths.agy), false);
  assert.equal(fs.existsSync(paths.omp), false);
  assert.equal(fs.existsSync(expandHome(DEFAULT_DB_PATH, options.homeDir)), false);
  assert.equal(fs.existsSync(expandHome(DEFAULT_CONFIG_PATH, options.homeDir)), false);
});

test('setup --skills installs the guide for the selected MCP hosts', async (t) => {
  const { options, errors } = fixture(t);
  assert.equal(await runSetup(['--yes', '--host', 'codex', '--skills', '--no-embeddings'], options), 0, errors());
  assert.equal(fs.existsSync(path.join(options.homeDir, '.agents', 'skills', 'multi-sub-memory', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(options.homeDir, '.claude', 'skills')), false);
});
