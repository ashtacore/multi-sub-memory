import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_DB_PATH, DEFAULT_EMBEDDING_ENABLED, effectiveDatabaseFilePath, loadConfig, parseConfigLayer, parseYaml,
  readConfigText, resolveConfigDestination, writeConfig,
} from '../config.mjs';
import { createEmbeddingEngine } from '../embeddings.mjs';
import {
  CLI_PRESETS, DREAMER_EXECUTABLE_GUIDANCE, HOOK_HOSTS, HOSTS, detectHost, findExecutable, hookConfigPaths,
  hostConfigPath, hostSkillPath, hostSnippet, prepareHookInstall, prepareHookUninstall, prepareHostRegistration,
  prepareSkillChange,
} from './hosts.mjs';
import { cliContext, configErrorMessage, parseOptions, transformersAvailable } from './options.mjs';

const dreamerOptions = [
  'dreamer-mode', 'http-base-url', 'http-model', 'http-api-key-env', 'cli-orchestrator', 'cli-command',
  'cli-model', 'cadence', 'cadence-interval-hours', 'cadence-min-memories',
];
const hasDreamerOptions = (values) => dreamerOptions.some((key) => values[key] !== undefined);
const settingsChanged = 'Settings file changed during setup. Run setup again.';
const help = [
  'Usage: multi-sub-memory setup [options]',
  '  --yes, -y                        Use defaults and flags without prompts',
  '  --db <path> --config <path>       Override storage paths',
  '  --no-embeddings                  Use FTS-only search',
  '  --host <omp|claude|codex|agy|all|none>  Repeat or use a comma-separated list',
  '  --hooks <omp|claude|all>         Install startup hooks. Repeat or use a comma-separated list',
  '  --uninstall-hooks <omp|claude|all>  Remove startup hooks. Repeat or use a comma-separated list',
  '  --skills                         Install the memory guide for selected MCP hosts',
  '  --install-skills <omp|claude|codex|agy|all>   Install skills only when used on its own',
  '  --uninstall-skills <omp|claude|codex|agy|all> Remove managed skills',
  '  --omp-extensions-dir <path> --claude-settings <path>',
  '  --dreamer-mode <disabled|http|cli>',
  '  --http-base-url <url> --http-model <model> --http-api-key-env <name>',
  '  --cli-orchestrator <omp|claude|codex> --cli-command <path> --cli-model <model>',
  '  --cadence <manual|auto> --cadence-interval-hours <hours> --cadence-min-memories <count>',
  '  --home <path>                    Override home directory',
  '  --omp-config <path> --claude-config <path> --codex-config <path> --agy-config <path>',
  '  --help, -h',
].join('\n');

function choices(value, allowed, flag) {
  if (!allowed.includes(value)) throw new Error(flag + ' must be one of ' + allowed.join(', '));
  return value;
}

function selectedHosts(value) {
  const hosts = [...new Set(value.split(',').map((host) => host.trim()))];
  for (const host of hosts) choices(host, [...Object.keys(HOSTS), 'all', 'none'], '--host');
  if (hosts.length > 1 && (hosts.includes('all') || hosts.includes('none'))) {
    throw new Error('--host all and --host none must be used on their own');
  }
  if (hosts[0] === 'all') return Object.keys(HOSTS);
  return hosts[0] === 'none' ? [] : hosts;
}

function selectedActionHosts(values, flag, supportedHosts = HOOK_HOSTS) {
  const hosts = values?.flatMap((value) => value.split(',').map((host) => host.trim())) ?? [];
  for (const host of hosts) choices(host, [...supportedHosts, 'all'], flag);
  return hosts.includes('all') ? supportedHosts : [...new Set(hosts)];
}

async function dreamerConfig(current, values, ask) {
  const mode = choices(values['dreamer-mode'] ?? await ask('Dreamer mode (disabled/http/cli)', current.mode ?? 'disabled'),
    ['disabled', 'http', 'cli'], '--dreamer-mode');
  for (const key of ['http', 'cli']) {
    if (key !== mode && dreamerOptions.some((flag) => flag.startsWith(key + '-') && values[flag] !== undefined)) {
      throw new Error('Options starting with --' + key + '- require --dreamer-mode ' + key);
    }
  }

  const result = { ...current, mode, enabled: mode !== 'disabled' };
  if (mode === 'http') {
    const baseUrl = values['http-base-url'] ?? await ask('HTTP base URL (for example https://api.openai.com/v1)', current.http?.baseUrl);
    const model = values['http-model'] ?? await ask('HTTP model', current.http?.model);
    if (!baseUrl || !model) throw new Error('HTTP mode requires --http-base-url and --http-model');
    const url = URL.parse(baseUrl);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an HTTP(S) base URL without credentials, query parameters, or a fragment');
    }
    const previousKey = baseUrl === current.http?.baseUrl ? current.http?.apiKeyEnv : undefined;
    const apiKeyEnv = values['http-api-key-env'] ?? await ask('API key environment variable (enter - to clear)', previousKey);
    if (apiKeyEnv && apiKeyEnv !== '-' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new Error('Enter the API key environment variable name, such as OPENAI_API_KEY');
    }
    result.http = { baseUrl, model, apiKeyEnv: apiKeyEnv && apiKeyEnv !== '-' ? apiKeyEnv : undefined };
  }
  if (mode === 'cli') {
    const orchestrator = choices(values['cli-orchestrator'] ?? await ask('CLI orchestrator (omp/claude/codex)', current.cli?.orchestrator ?? 'omp'),
      Object.keys(CLI_PRESETS), '--cli-orchestrator');
    const previous = current.cli?.orchestrator === orchestrator ? current.cli : {};
    const preset = CLI_PRESETS[orchestrator];
    const command = values['cli-command'] ?? await ask('CLI command', previous.command ?? preset.command);
    const model = values['cli-model'] ?? await ask('CLI model (optional, enter - to clear)', previous.model);
    result.cli = { orchestrator, command, args: previous.args ?? preset.args, model: model && model !== '-' ? model : undefined };
  }
  if (mode !== 'disabled' || dreamerOptions.some((key) => key.startsWith('cadence') && values[key] !== undefined)) {
    const cadence = current.cadence;
    const cadenceMode = values.cadence ?? await ask('Dreamer cadence (manual/auto)', cadence?.mode ?? 'manual');
    const interval = values['cadence-interval-hours'] ?? await ask('Minimum interval in hours', cadence?.minIntervalHours ?? 24);
    const minimum = values['cadence-min-memories'] ?? await ask('Minimum new memories', cadence?.minNewMemories ?? 10);
    result.cadence = {
      mode: cadenceMode,
      minIntervalHours: String(interval).trim() ? Number(interval) : NaN,
      minNewMemories: String(minimum).trim() ? Number(minimum) : NaN,
    };
  }
  return result;
}

function pathKey(file) {
  const normalized = path.normalize(file);
  if (process.platform === 'darwin') return normalized.toUpperCase().toLowerCase().normalize('NFD');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function removalDatabasePaths(context) {
  const { env, userConfigPath } = context;
  const candidates = [DEFAULT_DB_PATH, env.MULTI_SUB_MEMORY_DB];
  try {
    // Database paths can still be valid when another setting fails validation.
    const settings = parseYaml(readConfigText(userConfigPath) ?? '');
    candidates.push(settings?.dbPath);
    for (const project of Object.values(settings?.projects ?? {})) candidates.push(project?.dbPath);
  } catch {
    // Missing or unreadable settings do not hide the other path candidates.
  }
  try {
    candidates.push(loadConfig(context).dbPath);
  } catch {
    // Removal can proceed with the individual paths when config loading fails.
  }
  return candidates.filter((value) => typeof value === 'string' && value.trim())
    .map((value) => effectiveDatabaseFilePath(value, context)).filter((file) => file !== undefined);
}

function checkPaths(dbPaths, context, hosts, hookHosts = [], settingsPath, skillHosts = []) {
  if (settingsPath && pathKey(resolveConfigDestination(context.userConfigPath)) !== pathKey(settingsPath)) {
    throw new Error(settingsChanged);
  }
  const hostPaths = hosts.map((host) => hostConfigPath(host, context));
  const resolvedSettings = settingsPath ?? resolveConfigDestination(context.userConfigPath);
  const paths = [
    resolvedSettings,
    ...(settingsPath ? [resolvedSettings + '.lock'] : []),
    ...hostPaths,
    ...hostPaths.map((file) => file + '.bak'),
    ...hookHosts.flatMap((host) => hookConfigPaths(host, context)),
    ...skillHosts.map((host) => hostSkillPath(host, context)),
  ];
  const keys = paths.map((file) => pathKey(resolveConfigDestination(file)));
  const dbDestinations = dbPaths.map((file) => resolveConfigDestination(file));
  // The saved and effective paths may share a database or corresponding sidecars.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const dbSidecars = dbPaths.flatMap((dbPath, index) => [dbPath + suffix, dbDestinations[index] + suffix]);
    keys.push(...new Set(dbSidecars.map((file) => pathKey(resolveConfigDestination(file)))));
  }
  if (settingsPath) {
    const lockPath = resolvedSettings + '.lock';
    const lockDest = resolveConfigDestination(lockPath);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      keys.push(...new Set([lockPath + suffix, lockDest + suffix].map((file) => pathKey(resolveConfigDestination(file)))));
    }
  }
  if (new Set(keys).size !== keys.length || ((hookHosts.length || skillHosts.length) && keys.some((file) =>
    keys.some((other) => other !== file && other.startsWith(file + path.sep))))) {
    throw new Error('Choose distinct paths for the database, settings, host configs, hooks, backups, and skills');
  }
}

function applyHookActions(actions, print) {
  for (const { host, install, apply } of actions) {
    const { configPath, changed, backupPath } = apply();
    const result = install
      ? (changed ? 'Installed startup hook' : 'Startup hook already installed')
      : (changed ? 'Removed startup hook' : 'No managed startup hook found');
    print(result + ' for ' + host + ' at ' + configPath);
    if (backupPath) print('Backup: ' + backupPath);
  }
}

function applySkillActions(actions, print) {
  for (const { host, install, apply } of actions) {
    const { configPath, changed, preserved } = apply();
    const result = preserved ? 'Preserved existing skill'
      : install ? (changed ? 'Installed memory guide' : 'Memory guide already installed')
        : (changed ? 'Removed memory guide' : 'No managed memory guide found');
    print(result + ' for ' + host + ' at ' + configPath);
  }
}

async function saveSettings(userConfigPath, destination, original, draft) {
  const { DatabaseSync } = await import('node:sqlite');
  const lockPath = destination + '.lock';
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Keep the file in place so all setup processes lock the same file.
  const lockDb = new DatabaseSync(lockPath);
  try {
    try {
      lockDb.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;');
    } catch (error) {
      if ((error.errcode & 0xff) === 5) { // SQLITE_BUSY, including extended codes
        throw new Error('Another setup process is currently writing settings. Run setup again.', { cause: error });
      }
      throw error;
    }
    try {
      if (pathKey(resolveConfigDestination(userConfigPath)) !== pathKey(destination)
        || readConfigText(destination) !== original) {
        throw new Error(settingsChanged);
      }
      writeConfig(destination, draft, { mode: 0o600 });
    } finally {
      lockDb.exec('ROLLBACK');
    }
  } finally {
    lockDb.close();
  }
}

export async function runSetup(argv = [], options = {}) {
  const { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = options;
  const print = (message) => stdout.write(message + '\n');
  let readline;
  try {
    const values = parseOptions(argv, {
      yes: { type: 'boolean', short: 'y' },
      host: { type: 'string', multiple: true },
      hooks: { type: 'string', multiple: true },
      'uninstall-hooks': { type: 'string', multiple: true },
      skills: { type: 'boolean' },
      'install-skills': { type: 'string', multiple: true },
      'uninstall-skills': { type: 'string', multiple: true },
      'omp-extensions-dir': { type: 'string' },
      'claude-settings': { type: 'string' },
      'no-embeddings': { type: 'boolean' },
      ...Object.fromEntries(dreamerOptions.map((key) => [key, { type: 'string' }])),
    });
    if (values.help) {
      print(help);
      return 0;
    }
    const installHosts = selectedActionHosts(values.hooks, '--hooks');
    const uninstallHosts = selectedActionHosts(values['uninstall-hooks'], '--uninstall-hooks');
    if (installHosts.some((host) => uninstallHosts.includes(host))) {
      throw new Error('A host cannot appear in both --hooks and --uninstall-hooks');
    }
    const context = cliContext(values, options);
    const hookHosts = [...installHosts, ...uninstallHosts];
    const skillInstalls = selectedActionHosts(values['install-skills'], '--install-skills', Object.keys(HOSTS));
    const skillUninstalls = selectedActionHosts(values['uninstall-skills'], '--uninstall-skills', Object.keys(HOSTS));
    const selectedSkillHosts = (hosts = []) => {
      const install = [...new Set([...skillInstalls, ...(values.skills ? hosts : [])])];
      if (install.some((host) => skillUninstalls.includes(host))) {
        throw new Error('A host cannot be selected for both skill install and uninstall');
      }
      return install;
    };
    const prepareSkills = (install) => [
      ...install.map((host) => ({ host, install: true, apply: prepareSkillChange(host, context, true) })),
      ...skillUninstalls.map((host) => ({ host, install: false, apply: prepareSkillChange(host, context, false) })),
    ];
    const prepareHooks = () => [
      ...installHosts.map((host) => ({ host, install: true, apply: prepareHookInstall(host, context) })),
      ...uninstallHosts.map((host) => ({ host, install: false, apply: prepareHookUninstall(host, context) })),
    ];
    if ((uninstallHosts.length || skillInstalls.length || skillUninstalls.length)
      && !installHosts.length && !values.skills && values.db === undefined && !values.host
      && values['no-embeddings'] === undefined && !hasDreamerOptions(values)) {
      const install = selectedSkillHosts();
      checkPaths(removalDatabasePaths(context), context, [], hookHosts, undefined, [...install, ...skillUninstalls]);
      const skillActions = prepareSkills(install);
      applyHookActions(prepareHooks(), print);
      applySkillActions(skillActions, print);
      return 0;
    }
    const { cwd, env, resolvePath, userConfigPath } = context;
    const settingsPath = resolveConfigDestination(userConfigPath);
    const originalSettings = readConfigText(settingsPath);
    const user = parseConfigLayer(originalSettings, userConfigPath);

    let input;
    if (!values.yes) {
      readline = createInterface({ input: stdin, output: stdout });
      input = readline[Symbol.asyncIterator]();
    }
    const ask = async (label, fallback) => {
      if (values.yes) return fallback;
      stdout.write(label + (fallback === undefined ? '' : ' [' + fallback + ']') + ': ');
      const answer = await input.next();
      if (answer.done) throw new Error('Input ended. Run setup again or use --yes.');
      return answer.value.trim() || fallback;
    };

    print('Storage and embeddings');
    const dbInput = values.db ?? await ask('Database path', user.dbPath ?? DEFAULT_DB_PATH);
    if (!dbInput?.trim() || dbInput === ':memory:' || /^file:/i.test(dbInput)) {
      throw new Error('Choose a filesystem path for the persistent SQLite database');
    }
    const dbPath = resolvePath(dbInput);
    const savedDbPath = values.db === undefined && dbInput === user.dbPath ? user.dbPath : dbPath;
    const defaultEmbeddings = user.embedding?.enabled ?? DEFAULT_EMBEDDING_ENABLED;
    const embeddingsEnabled = values['no-embeddings'] ? false : choices(await ask('Enable embeddings (yes/no)', defaultEmbeddings ? 'yes' : 'no'),
      ['yes', 'no'], 'Embeddings choice') === 'yes';

    print('\nOrchestrator MCP registration');
    const detected = Object.keys(HOSTS).filter((host) => {
      try {
        const status = detectHost(host, context);
        return status.exists || status.existingTranscriptDirs.length || findExecutable(host, env, cwd);
      } catch {
        print('Warning: Could not inspect ' + host + '. Use --host to select it explicitly.');
        return false;
      }
    });
    print('Detected: ' + (detected.join(', ') || 'none'));
    const hosts = selectedHosts(values.host?.join(',') ?? await ask('Hosts to configure (comma-separated, all, or none)', detected.join(',') || 'none'));

    print('\nDreamer configuration');
    const userDreamer = user.dreamer ?? { enabled: false, mode: 'disabled' };
    const editDreamer = !values.yes || hasDreamerOptions(values);
    const dreamer = editDreamer ? await dreamerConfig(userDreamer, values, ask) : userDreamer;
    const draft = {
      ...user, dbPath: savedDbPath, dreamer,
      embedding: { ...user.embedding, enabled: embeddingsEnabled },
    };
    // Validate the effective configuration before writing any files.
    const effective = loadConfig({ ...context, userConfigData: draft });
    const dbPaths = [dbPath];
    const effectiveDbPath = effectiveDatabaseFilePath(effective.dbPath, context);
    if (effectiveDbPath !== undefined && effectiveDbPath !== dbPath) dbPaths.push(effectiveDbPath);
    for (const project of Object.values(draft.projects ?? {})) {
      if (project.dbPath === undefined) continue;
      const file = effectiveDatabaseFilePath(project.dbPath, context);
      if (file !== undefined) dbPaths.push(file);
    }
    const installSkills = selectedSkillHosts(hosts);
    checkPaths(dbPaths, context, hosts, hookHosts, settingsPath, [...installSkills, ...skillUninstalls]);
    const skillActions = prepareSkills(installSkills);
    const registration = hosts.map((host) => {
      try {
        return prepareHostRegistration(host, context);
      } catch (error) {
        print('Manual MCP configuration for ' + host + ':\n' + hostSnippet(host));
        throw error;
      }
    });
    const hookActions = prepareHooks();

    const { openDatabase } = await import('../db.mjs');
    const db = openDatabase(dbPath);
    try {
      const { journal_mode: journalMode } = db.prepare('PRAGMA journal_mode').get();
      if (journalMode !== 'wal') throw new Error('Could not enable WAL for ' + dbPath);
      db.prepare('SELECT count(*) FROM memories_fts WHERE memories_fts MATCH ?').get('setup');
    } finally {
      db.close();
    }
    print('SQLite and FTS5 ready in WAL mode at ' + dbPath);
    if (!effective.embedding.enabled) {
      print('Embeddings: Disabled; running in FTS-only mode');
    } else if (!embeddingsEnabled) {
      print('Embeddings: Setup probe skipped by request. Effective settings enable embeddings.');
    } else if (options.createEmbeddingEngine || transformersAvailable()) {
      const createEngine = options.createEmbeddingEngine ?? createEmbeddingEngine;
      print('Checking ONNX inference with ' + effective.embedding.model + ' (may download the model).');
      const engine = createEngine({ embedding: effective.embedding, env, warn: () => {} });
      const vector = await engine.embed('multi-sub-memory setup check');
      print(vector ? 'Embeddings: ONNX ready (' + vector.length + ' dimensions).'
        : 'Warning: ONNX embedding check failed. FTS-only search is available.');
    } else {
      print('Embeddings: Optional @huggingface/transformers not installed; running in FTS-only mode');
    }
    if (effective.dbPath === ':memory:' || resolvePath(effective.dbPath) !== dbPath) {
      print('An environment or project setting takes precedence over the saved database path.');
    }

    for (const register of registration) {
      const { configPath, changed, backupPath } = register();
      print((changed ? 'Registered MCP at ' : 'MCP already registered at ') + configPath);
      if (backupPath) print('Backup: ' + backupPath);
    }
    applyHookActions(hookActions, print);
    applySkillActions(skillActions, print);
    for (const host of Object.keys(HOSTS).filter((host) => !hosts.includes(host))) {
      print('\nManual MCP configuration for ' + host + ':\n' + hostSnippet(host));
    }

    if (effective.dreamer.enabled && effective.dreamer.mode === 'cli') {
      const { cli } = effective.dreamer;
      const command = cli.command ?? CLI_PRESETS[cli.orchestrator].command;
      const executable = findExecutable(command, env, undefined, { forSpawn: true });
      print(executable ? 'Dreamer CLI executable found at ' + executable
        : 'Warning: ' + (findExecutable(command, env, cwd) ? DREAMER_EXECUTABLE_GUIDANCE
          : 'Dreamer CLI executable unavailable. Install it or set --cli-command.'));
    }
    await saveSettings(userConfigPath, settingsPath, originalSettings, draft);
    print('\nSaved settings to ' + userConfigPath);
    return 0;
  } catch (error) {
    stderr.write('Setup failed: ' + configErrorMessage(error) + '\n');
    return 1;
  } finally {
    readline?.close();
  }
}
