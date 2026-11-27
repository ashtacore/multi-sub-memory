import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { createEmbeddingEngine, DEFAULT_EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL } from '../embeddings.mjs';
import { CLI_PRESETS, DREAMER_EXECUTABLE_GUIDANCE, HOSTS, detectHost, findExecutable } from './hosts.mjs';
import { cliContext, configErrorMessage, parseOptions, transformersAvailable } from './options.mjs';

const help = [
  'Usage: multi-sub-memory doctor [options]',
  '  --json                           Print a structured report',
  '  --db <path> --config <path>       Override storage paths',
  '  --cwd <path> --home <path>        Override workspace and home directory',
  '  --test-dreamer                   Request HTTP models or look up the CLI executable',
  '  --omp-config <path> --claude-config <path> --codex-config <path> --agy-config <path>',
  '  --help, -h',
].join('\n');

const countedTables = ['memories', 'notes', 'transcript_files', 'transcript_messages', 'dream_runs'];
const dbPathRemediation = 'Check --db, MULTI_SUB_MEMORY_DB, and the configured path. Run setup to initialize a new database.';
const snapshotAttempts = 4;

async function sqliteCheck(add) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(content)');
    } finally {
      probe.close();
    }
    add('SQLite / FTS5', 'pass', 'Built-in node:sqlite and FTS5 are available.');
    return true;
  } catch {
    add('SQLite / FTS5', 'fail', 'Could not initialize FTS5 with node:sqlite.', {
      remediation: 'Use an official Node.js build at version 24.0.0 or newer with SQLite enabled.',
    });
    return false;
  }
}

function copyWal(sourcePath, snapshotPath) {
  try {
    fs.copyFileSync(sourcePath, snapshotPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

function sameSnapshotMetadata(before, after) {
  return before?.size === after?.size && before?.mtimeMs === after?.mtimeMs && before?.ctimeMs === after?.ctimeMs;
}

function copyDatabaseSnapshot(sourcePath, walPath, snapshotPath) {
  const snapshotWalPath = snapshotPath + '-wal';
  for (let attempt = 0; attempt < snapshotAttempts; attempt++) {
    const dbBefore = fs.statSync(sourcePath);
    const walBefore = fs.statSync(walPath, { throwIfNoEntry: false });
    fs.copyFileSync(sourcePath, snapshotPath);
    const walCopied = !walBefore || copyWal(walPath, snapshotWalPath);
    const dbAfter = fs.statSync(sourcePath);
    const walAfter = fs.statSync(walPath, { throwIfNoEntry: false });
    if (walCopied && sameSnapshotMetadata(dbBefore, dbAfter) && sameSnapshotMetadata(walBefore, walAfter)) {
      return true;
    }
    fs.rmSync(snapshotWalPath, { force: true });
    fs.rmSync(snapshotPath, { force: true });
  }
  return false;
}

async function databaseChecks(dbPath, add) {
  try {
    if (!dbPath || !fs.statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
      add('Database', 'fail', dbPath ? 'Database file missing at ' + dbPath : 'A persistent database path is required.', {
        remediation: dbPathRemediation,
      });
      return;
    }
    const { openDatabase } = await import('../db.mjs');
    const sourcePath = fs.realpathSync(dbPath);
    const walPath = sourcePath + '-wal';
    // SQLite may create WAL sidecars, so only open the copy in a private directory.
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-doctor-wal-'));
    let db;
    try {
      const inspectPath = path.join(temporaryDirectory, 'memory.db');
      if (!copyDatabaseSnapshot(sourcePath, walPath, inspectPath)) {
        add('Database', 'warn', 'The database was actively changing during snapshot acquisition at ' + dbPath, {
          remediation: 'Rerun doctor when write activity settles.',
        });
        return;
      }
      db = openDatabase(inspectPath, { readOnly: true });
      db.exec('BEGIN');
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
        add('Database integrity', 'fail', 'SQLite reported integrity errors at ' + dbPath, {
          remediation: 'Restore a known-good backup or recover the database with SQLite tools.',
        });
        return;
      }
      add('Database integrity', 'pass', 'Opened read-only and passed integrity_check at ' + dbPath);
      const { journal_mode: journalMode } = db.prepare('PRAGMA journal_mode').get();
      add('Database journal', journalMode === 'wal' ? 'pass' : 'warn', 'Journal mode is ' + journalMode, {
        journalMode,
        ...(journalMode === 'wal' ? {} : { remediation: 'Run setup for this database to enable WAL.' }),
      });
      const counts = Object.fromEntries(countedTables.map((table) => [
        table, db.prepare('SELECT count(*) AS count FROM ' + table).get().count,
      ]));
      add('Database counts', 'pass', Object.entries(counts).map(([table, count]) => table + '=' + count).join(', '), { counts });
    } finally {
      try {
        db?.close();
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  } catch {
    add('Database', 'fail', 'Could not read or inspect the database at ' + dbPath, {
      remediation: 'Check that this is a readable multi-sub-memory database with its current schema. Restore a backup if the file is corrupt.',
    });
  }
}

async function embeddingCheck(embedding, env, createEngine, add) {
  const { enabled, model } = embedding;
  const expectedDims = embedding.dims ?? (model === DEFAULT_EMBEDDING_MODEL ? DEFAULT_EMBEDDING_DIMS : undefined);
  const details = { mode: 'fts-only', model, expectedDims };
  if (!enabled) {
    add('Embeddings', 'pass', 'Disabled; running in FTS-only mode', details);
    return;
  }
  if (!createEngine && !transformersAvailable()) {
    add('Embeddings', 'warn', 'Optional @huggingface/transformers not installed; running in FTS-only mode', {
      ...details, remediation: 'Install the optional Transformers.js dependency or choose FTS-only mode in setup.',
    });
    return;
  }
  let vector;
  try {
    const engine = (createEngine ?? createEmbeddingEngine)({
      embedding, env, pipelineOptions: { local_files_only: true }, warn: () => {},
    });
    vector = await engine.embed('multi-sub-memory doctor check');
  } catch {
    // An unavailable runtime or model leaves FTS-only search available.
  }
  if (vector?.length) {
    add('Embeddings', 'pass', 'ONNX ready (' + vector.length + ' dimensions).', {
      ...details, mode: 'onnx', observedDims: vector.length,
    });
  } else {
    add('Embeddings', 'warn', 'Local ONNX inference failed; running in FTS-only mode.', {
      ...details, remediation: 'Run setup to download and verify the model or choose FTS-only mode.',
    });
  }
}

function hostChecks(context, add) {
  for (const host of Object.keys(HOSTS)) {
    try {
      const detection = detectHost(host, context);
      const { exists, registered, configPath, existingTranscriptDirs, invalid } = detection;
      const registration = invalid ? 'Cannot read MCP registration' : registered ? 'MCP entry present'
        : exists ? 'MCP entry missing' : 'MCP config missing';
      const transcripts = existingTranscriptDirs.length ? existingTranscriptDirs.join(', ') : 'none found';
      add(host, registered && existingTranscriptDirs.length ? 'pass' : 'warn',
        registration + ' at ' + configPath + '. Transcript directories: ' + transcripts, {
          ...detection,
          ...(!registered ? { remediation: 'If you use this host, check its config and run setup --host ' + host + '.' }
            : !existingTranscriptDirs.length ? { remediation: 'Start a session in this host to create transcripts.' } : {}),
        });
    } catch {
      add(host, 'warn', 'Could not inspect this host’s config or transcript directories.', {
        remediation: 'Check the host paths and read permissions.',
      });
    }
  }
}

async function dreamerChecks(dreamer, testBackend, context, fetchImpl, add) {
  const { mode, enabled } = dreamer;
  if (!enabled || mode === 'disabled') {
    const legacy = enabled && mode === 'disabled';
    add('Dreamer', legacy ? 'warn' : 'pass', 'Disabled.', legacy
      ? { remediation: 'Run setup to choose a Dreamer backend or explicitly disable Dreamer.' } : {});
    return;
  }
  add('Dreamer', 'pass', mode.toUpperCase() + ' backend configured with ' + dreamer.cadence.mode + ' cadence.');
  if (!testBackend) return;

  if (mode === 'cli') {
    const command = dreamer.cli.command ?? CLI_PRESETS[dreamer.cli.orchestrator].command;
    let executable;
    let incompatible;
    try {
      executable = findExecutable(command, context.env, undefined, { forSpawn: true });
      if (!executable) incompatible = findExecutable(command, context.env, context.cwd);
    } catch {
      // Report inaccessible paths the same way as a missing executable.
    }
    if (executable) {
      add('Dreamer probe', 'pass', 'Executable found at ' + executable, { executable });
    } else {
      add('Dreamer probe', 'fail', incompatible
        ? 'The configured executable cannot be launched by Dreamer.' : 'Could not find the configured executable.', {
        remediation: incompatible ? DREAMER_EXECUTABLE_GUIDANCE
          : 'Install the selected orchestrator, update PATH, or configure dreamer.cli.command.',
      });
    }
    return;
  }

  const { baseUrl, apiKeyEnv } = dreamer.http;
  const key = apiKeyEnv && Object.hasOwn(context.env, apiKeyEnv) ? context.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !key) {
    add('Dreamer probe', 'fail', 'The configured API key environment variable is unset or empty.', {
      remediation: 'Set the environment variable named by dreamer.http.apiKeyEnv before running doctor.',
    });
    return;
  }
  const endpoint = new URL(baseUrl);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/models';
  endpoint.search = '';
  endpoint.hash = '';
  const remediation = 'Check the Dreamer base URL, endpoint availability, and API key settings.';
  try {
    const response = await fetchImpl(endpoint.href, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
      ...(key ? { headers: { Authorization: 'Bearer ' + key } } : {}),
    });
    await response.body?.cancel();
    add('Dreamer probe', response.ok ? 'pass' : 'fail', 'GET /models returned HTTP ' + response.status + '.',
      response.ok ? {} : { remediation });
  } catch {
    add('Dreamer probe', 'fail', 'Could not complete GET /models.', { remediation });
  }
}

export async function runDoctor(argv = [], options = {}) {
  const { stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch } = options;
  const checks = [];
  const add = (check, status, message, details) => checks.push({ check, status, message, ...details });
  let values;
  try {
    values = parseOptions(argv, {
      json: { type: 'boolean' }, cwd: { type: 'string' }, 'test-dreamer': { type: 'boolean' },
    });
    if (values.help) {
      stdout.write(help + '\n');
      return 0;
    }
  } catch (error) {
    stderr.write('Doctor failed: ' + error.message + '\nRun doctor --help for usage.\n');
    return 1;
  }

  const [major] = process.versions.node.split('.').map(Number);
  const supported = major >= 24;
  add('Node.js', supported ? 'pass' : 'fail', 'Node.js ' + process.versions.node, supported ? {} : {
    remediation: 'Upgrade to Node.js 24.0.0 or newer.',
  });
  const sqliteAvailable = await sqliteCheck(add);
  let context;
  let config;
  try {
    context = cliContext(values, options);
    const { userConfigPath, env } = context;
    const userExists = fs.existsSync(userConfigPath);
    config = loadConfig(context);
    if (!userExists && (values.config !== undefined || env.MULTI_SUB_MEMORY_CONFIG)) {
      add('Config', 'fail', 'Requested config file missing at ' + userConfigPath, {
        remediation: 'Check --config or MULTI_SUB_MEMORY_CONFIG, or run setup with this config path.',
      });
    } else if (!userExists) {
      add('Config', 'warn', 'No settings file found. Using defaults and environment settings.', {
        remediation: 'Run setup to save settings at ' + userConfigPath,
      });
    } else {
      add('Config', 'pass', 'Effective configuration is valid.', {
        paths: [userConfigPath],
      });
    }
  } catch (error) {
    add('Config', 'fail', configErrorMessage(error), {
      remediation: context ? 'Check YAML settings in ' + context.userConfigPath
        : 'Check the config, home, and workspace paths.',
    });
  }

  if (context) {
    const dbInput = values.db ?? config?.dbPath;
    if (sqliteAvailable && dbInput !== undefined) {
      await databaseChecks(!dbInput.trim() || dbInput === ':memory:' || /^file:/i.test(dbInput)
        ? undefined : context.resolvePath(dbInput), add);
    }
    if (config) await embeddingCheck(config.embedding, context.env, options.createEmbeddingEngine, add);
    hostChecks(context, add);
    if (config) await dreamerChecks(config.dreamer, values['test-dreamer'], context, fetchImpl, add);
  }

  const ok = checks.every(({ status }) => status !== 'fail');
  if (values.json) stdout.write(JSON.stringify({ ok, checks }, null, 2) + '\n');
  else {
    const width = Math.max(...checks.map(({ check }) => check.length));
    stdout.write('Status  ' + 'Check'.padEnd(width) + '  Details\n');
    for (const { check, status, message, remediation } of checks) {
      stdout.write(status.toUpperCase().padEnd(6) + '  ' + check.padEnd(width) + '  ' + message
        + (remediation ? ' ' + remediation : '') + '\n');
    }
  }
  return ok ? 0 : 1;
}
