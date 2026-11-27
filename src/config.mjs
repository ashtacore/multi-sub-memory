import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { INDEXER_ORCHESTRATORS } from './indexers/types.mjs';
import { isProjectKey, resolveProjectKey } from './project-id.mjs';

export const DEFAULT_DB_PATH = '~/.local/share/multi-sub-memory/memory.db';
export const DEFAULT_CONFIG_PATH = '~/.config/multi-sub-memory/config.yaml';
export const DEFAULT_EMBEDDING_ENABLED = true;

const defaults = {
  dbPath: DEFAULT_DB_PATH,
  embedding: { model: 'BAAI/bge-base-en-v1.5', enabled: DEFAULT_EMBEDDING_ENABLED },
  bootstrap: { tokenBudget: 2500 },
  analytics: { retention_days: 93 },
  indexers: {
    enabled: true, backgroundRefresh: false, refreshIntervalMs: 60_000,
    omp: {}, claude: {}, codex: {}, agy: {},
  },
};

export const TAG_PATTERN = /^(?=.{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const tagFields = z.strictObject({
  strict: z.boolean(),
  definitions: z.record(z.string().regex(TAG_PATTERN), z.string()),
});
const tagsSchema = tagFields.extend({
  strict: tagFields.shape.strict.default(false),
  definitions: tagFields.shape.definitions.default({}),
});

const embeddingSchema = z.object({ model: z.string().min(1), enabled: z.boolean() }).strict();
const bootstrapSchema = z.object({ tokenBudget: z.number().int().positive() }).strict();
const nonEmptyString = z.string().min(1);
const httpSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = URL.parse(value);
    return url !== null && !url.username && !url.password;
  }, 'Use an API key environment variable instead of URL credentials'),
  model: nonEmptyString,
  apiKeyEnv: nonEmptyString.optional(),
});
const cliSchema = z.strictObject({
  orchestrator: z.enum(['omp', 'claude', 'codex']),
  command: nonEmptyString.optional(),
  args: z.array(z.string()).optional(),
  model: nonEmptyString.optional(),
});
const defaultCadence = { mode: 'manual', minIntervalHours: 24, minNewMemories: 10 };
const cadenceFields = z.strictObject({
  mode: z.enum(['manual', 'auto']),
  minIntervalHours: z.number().positive(),
  minNewMemories: z.number().int().nonnegative(),
});
const cadenceSchema = cadenceFields.extend({
  mode: cadenceFields.shape.mode.default(defaultCadence.mode),
  minIntervalHours: cadenceFields.shape.minIntervalHours.default(defaultCadence.minIntervalHours),
  minNewMemories: cadenceFields.shape.minNewMemories.default(defaultCadence.minNewMemories),
});
const dreamerFields = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(['disabled', 'http', 'cli']),
  http: httpSchema.optional(),
  cli: cliSchema.optional(),
});
const dreamerSchema = dreamerFields.extend({
  enabled: dreamerFields.shape.enabled.default(false),
  mode: dreamerFields.shape.mode.default('disabled'),
  cadence: cadenceSchema.prefault({}),
});
const adapterSchema = z.object({ sessionsDir: z.string().min(1).optional() }).strict();
const indexersSchema = z.object({
  enabled: z.boolean(),
  backgroundRefresh: z.boolean(),
  refreshIntervalMs: z.number().int().positive().max(2 ** 31 - 1),
  omp: adapterSchema,
  claude: adapterSchema,
  codex: adapterSchema,
  agy: adapterSchema,
}).strict();

const analyticsSchema = z.strictObject({ retention_days: z.number().int().min(7).max(3650) });

const configFields = z.object({
  dbPath: z.string().min(1),
  embedding: embeddingSchema,
  bootstrap: bootstrapSchema,
  dreamer: dreamerSchema,
  tags: tagsSchema.prefault({}),
  indexers: indexersSchema,
  analytics: analyticsSchema.default(defaults.analytics),
}).strict();

export const ConfigSchema = configFields.superRefine(({ dreamer }, context) => {
  const { enabled, mode } = dreamer;
  if (enabled && mode !== 'disabled' && !dreamer[mode]) {
    context.addIssue({
      code: 'custom', path: ['dreamer', mode], message: `Required for Dreamer ${mode} mode`,
    });
  }
});

const configLayerSchema = configFields.extend({
  embedding: embeddingSchema.partial(),
  bootstrap: bootstrapSchema.partial(),
  dreamer: dreamerFields.extend({
    http: httpSchema.partial().optional(),
    cli: cliSchema.partial().optional(),
    cadence: cadenceFields.partial(),
  }).partial(),
  indexers: indexersSchema.partial(),
  analytics: analyticsSchema.partial(),
  strictTags: z.boolean(),
  tags: tagFields.partial(),
}).partial();

const projectLayerSchema = configLayerSchema.omit({ analytics: true }).extend({
  checkouts: z.array(nonEmptyString).optional(),
  forkMode: z.enum(['origin', 'upstream']).optional(),
});
const fileSchema = configLayerSchema.extend({
  projects: z.record(z.string().refine(isProjectKey, 'Expected a repository project key'), projectLayerSchema).optional(),
});
const configSources = new WeakMap();

export function expandHome(inputPath, homeDir = os.homedir()) {
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return path.join(homeDir, inputPath.slice(2));
  if (inputPath.startsWith('~\\')) {
    return path.join(homeDir, inputPath.slice(2).replaceAll('\\', '/'));
  }
  return inputPath;
}

const hookUriOptions = new Map([
  ['mode', ['ro', 'rw', 'rwc']],
  ['cache', ['shared', 'private']],
  ['psow', ['0', '1']],
]);

export function effectiveDatabaseFilePath(dbPath, { cwd = process.cwd(), homeDir, strictHookUri = false } = {}) {
  if (dbPath === ':memory:') return undefined;
  if (!/^file:/i.test(dbPath)) return path.resolve(cwd, expandHome(dbPath, homeDir));

  try {
    const [location] = dbPath.slice('file:'.length).split('#', 1);
    const queryStart = location.indexOf('?');
    const uriPath = queryStart === -1 ? location : location.slice(0, queryStart);
    const query = queryStart === -1 ? '' : location.slice(queryStart + 1);
    const decodedPath = decodeURIComponent(uriPath);
    if (decodedPath.includes('\0')) throw new Error('Invalid SQLite URI path');
    const params = new URLSearchParams(query);
    const modes = params.getAll('mode');
    if (decodedPath === ':memory:' || (modes.length > 0 && modes.every((mode) => mode === 'memory'))) return undefined;
    if (strictHookUri) {
      const seen = new Set();
      for (const [name, value] of params) {
        if (seen.has(name) || !hookUriOptions.get(name)?.includes(value)) return undefined;
        seen.add(name);
      }
    }
    if (uriPath.startsWith('//')) {
      const [authority] = uriPath.slice(2).split('/', 1);
      if (authority !== '' && authority !== 'localhost') throw new Error('Non-local SQLite URI authority');
      return fileURLToPath(dbPath);
    }
    if (!decodedPath) throw new Error('Invalid SQLite URI path');
    const sqlitePath = process.platform === 'win32' && /^\/[A-Za-z]:(?:[\\/]|$)/.test(decodedPath)
      ? decodedPath.slice(1) : decodedPath;
    return path.resolve(cwd, sqlitePath);
  } catch (cause) {
    throw new Error('Unsupported SQLite URI in effective dbPath', { cause });
  }
}

export function parseYaml(text) {
  const document = parseDocument(text, { stringKeys: true });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw new SyntaxError('Invalid YAML syntax', { cause: issue });
  return document.contents === null ? {} : document.toJS({ maxAliasCount: 100 });
}

export function readConfigText(configPath) {
  try {
    return fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function parseConfigLayer(text, configPath) {
  if (text === undefined) return {};
  try {
    return fileSchema.parse(parseYaml(text));
  } catch (error) {
    throw new Error('Invalid config at ' + configPath + '\n' + error.message, { cause: error });
  }
}

export function readConfigLayer(configPath) {
  return parseConfigLayer(readConfigText(configPath), configPath);
}

function environmentLayer(env) {
  const embedding = {};
  if (env.MULTI_SUB_MEMORY_EMBEDDING_MODEL !== undefined) {
    embedding.model = env.MULTI_SUB_MEMORY_EMBEDDING_MODEL;
  }
  const noEmbeddings = env.MULTI_SUB_MEMORY_NO_EMBEDDINGS;
  if (noEmbeddings !== undefined) {
    const value = typeof noEmbeddings === 'string' ? noEmbeddings.trim().toLowerCase() : noEmbeddings;
    if (['1', 'true', 'yes'].includes(value)) embedding.enabled = false;
    else if (['0', 'false', 'no'].includes(value)) embedding.enabled = true;
    else throw new Error('MULTI_SUB_MEMORY_NO_EMBEDDINGS must be 1, true, yes, 0, false, or no');
  }

  return configLayerSchema.parse({ dbPath: env.MULTI_SUB_MEMORY_DB, embedding });
}

export function resolveUserConfigPath({ userConfigPath, env = process.env, homeDir = os.homedir() } = {}) {
  return userConfigPath ?? expandHome(env.MULTI_SUB_MEMORY_CONFIG || DEFAULT_CONFIG_PATH, homeDir);
}

export function assertDreamerTrust(dreamer, { userDreamer, ...configOptions } = {}) {
  const { mode, http, cli } = dreamer;
  const trusted = userDreamer === undefined ? loadConfig(configOptions).dreamer : userDreamer;
  if (mode === 'http' && (!trusted?.http?.baseUrl || http?.baseUrl !== trusted.http.baseUrl
    || http.apiKeyEnv !== trusted.http.apiKeyEnv)) {
    throw new Error('Dreamer HTTP endpoint and API key must be authorized in user settings');
  }
  if (mode === 'cli' && (trusted?.mode !== 'cli' || cli?.orchestrator !== trusted.cli?.orchestrator
    || cli?.command !== trusted.cli?.command || !isDeepStrictEqual(cli?.args, trusted.cli?.args))) {
    throw new Error('Dreamer CLI orchestrator, command, and arguments must be authorized in user settings');
  }
}

export function resolveConfigProject(cwd, config, options = {}) {
  return resolveProjectKey(cwd, { projects: configSources.get(config)?.projects, ...options });
}

export function bootstrapTokenBudget(config, projectKey) {
  const user = configSources.get(config);
  return user
    ? user.projects?.[projectKey]?.bootstrap?.tokenBudget ?? user.bootstrap?.tokenBudget ?? defaults.bootstrap.tokenBudget
    : config?.bootstrap?.tokenBudget ?? defaults.bootstrap.tokenBudget;
}

function mergeTags(user, projectKey) {
  const project = user.projects?.[projectKey];
  return {
    strict: project?.strictTags ?? project?.tags?.strict ?? user.strictTags ?? user.tags?.strict ?? false,
    definitions: (projectKey === 'global' ? user.tags?.definitions : project?.tags?.definitions) ?? {},
  };
}

export function tagSettings(config, projectKey) {
  const user = configSources.get(config) ?? (config?.projects ? config : undefined);
  return user ? mergeTags(user, projectKey) : mergeTags(config ?? {}, 'global');
}

export function loadConfig(options = {}) {
  return resolveEffectiveConfig(options, false).config;
}

export function loadWorkspaceConfig(options = {}) {
  return resolveEffectiveConfig(options, true);
}

function resolveEffectiveConfig(options, includeProject) {
  const { cwd, env = process.env, homeDir = os.homedir(), requireProject = false, timeoutMs } = options;
  const user = options.userConfigData === undefined
    ? readConfigLayer(resolveUserConfigPath(options))
    : fileSchema.parse(options.userConfigData);
  const project = cwd !== null && (includeProject || requireProject || Object.keys(user.projects ?? {}).length)
    ? resolveProjectKey(cwd, { projects: user.projects, optional: !requireProject, timeoutMs })
    : undefined;
  const layer = user.projects?.[project?.projectKey] ?? {};
  const overrides = environmentLayer(env);
  const indexers = { ...defaults.indexers, ...user.indexers, ...layer.indexers };
  for (const orchestrator of INDEXER_ORCHESTRATORS) {
    const adapter = { ...defaults.indexers[orchestrator], ...user.indexers?.[orchestrator], ...layer.indexers?.[orchestrator] };
    if (adapter.sessionsDir !== undefined) adapter.sessionsDir = expandHome(adapter.sessionsDir, homeDir);
    indexers[orchestrator] = adapter;
  }

  const config = ConfigSchema.parse({
    dbPath: overrides.dbPath ?? layer.dbPath ?? user.dbPath ?? defaults.dbPath,
    embedding: { ...defaults.embedding, ...user.embedding, ...layer.embedding, ...overrides.embedding },
    bootstrap: { ...defaults.bootstrap, ...user.bootstrap, ...layer.bootstrap },
    dreamer: mergeDreamer(user.dreamer, layer.dreamer),
    tags: mergeTags(user, project?.projectKey ?? 'global'),
    indexers,
    analytics: { ...defaults.analytics, ...user.analytics },
  });
  config.dbPath = expandHome(config.dbPath, homeDir);
  configSources.set(config, user);
  return { config, project };
}

export function resolveConfigDestination(configPath) {
  let absolutePath = configPath;
  if (process.platform === 'win32') absolutePath = path.resolve(configPath);
  else if (!path.isAbsolute(configPath)) absolutePath = process.cwd() + path.sep + configPath;
  let hops = 0;
  function followLink(link) {
    if (++hops > 40) {
      throw new Error('Too many symbolic links resolving config path ' + configPath);
    }
    return fs.readlinkSync(link);
  }

  // Canonicalize the deepest existing ancestor and retain the missing tail.
  function resolve(file) {
    const parent = path.dirname(file);
    try {
      return fs.realpathSync.native(file);
    } catch (error) {
      if (error.code !== 'ENOENT' || file === parent) throw error;
    }
    const directory = resolve(parent);
    const candidate = path.join(directory, path.basename(file));
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) return candidate;
    // Win32 collapses `..` before following any symlinks in the target path.
    if (process.platform === 'win32') return resolve(path.resolve(directory, followLink(candidate)));
    return resolvePosixLink(directory, path.basename(file), file === absolutePath);
  }

  // POSIX follows each symlink before interpreting any later `..` components.
  function resolvePosixLink(destination, basename, requireFileTarget) {
    const remaining = [basename];
    while (remaining.length > 0) {
      const component = remaining.shift();
      if (component === '.') {
        if (requireFileTarget && remaining.length === 0) {
          throw new Error('Config symlink target must not be a directory path: ' + configPath);
        }
        continue;
      }
      if (component === '..') {
        if (!fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
          throw new Error('Cannot traverse .. from non-existent or non-directory path ' + destination);
        }
        destination = path.dirname(destination);
        continue;
      }

      const candidate = path.join(destination, component);
      if (!fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
        destination = candidate;
        continue;
      }

      const target = followLink(candidate);
      if (requireFileTarget && remaining.length === 0 && target.endsWith('/')) {
        throw new Error('Config symlink target must not be a directory path: ' + target);
      }
      const { root } = path.parse(target);
      if (root) destination = root;
      remaining.unshift(...target.slice(root.length).split('/').filter(Boolean));
    }
    return destination;
  }

  return resolve(absolutePath);
}

function mergeDreamer(user = {}, project = {}) {
  const dreamer = { ...user, ...project };
  for (const key of ['http', 'cli', 'cadence']) {
    if (user[key] || project[key]) dreamer[key] = { ...user[key], ...project[key] };
  }
  if (project.http?.baseUrl !== undefined && project.http.baseUrl !== user.http?.baseUrl
    && project.http.apiKeyEnv === undefined) {
    delete dreamer.http.apiKeyEnv;
  }
  return dreamer;
}

export function writeConfig(configPath, configData, options = {}) {
  const config = fileSchema.parse(configData);
  const resolvedPath = expandHome(configPath, options.homeDir);
  const destination = resolveConfigDestination(resolvedPath);

  let existingMode;
  try {
    const stat = fs.statSync(destination);
    if (stat.isFile()) existingMode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  writeTextAtomically(destination, stringify(config), options.mode ?? existingMode);
}

export function writeTextAtomically(resolvedPath, text, mode = 0o600) {
  const directory = path.dirname(resolvedPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, '.multi-sub-memory-' + randomBytes(6).toString('hex') + '.tmp');
  const tempFile = fs.openSync(tempPath, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(tempFile, text, 'utf8');
      if (process.platform !== 'win32') fs.fchmodSync(tempFile, mode);
    } finally {
      fs.closeSync(tempFile);
    }
    fs.renameSync(tempPath, resolvedPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not write config or remove the temporary file');
    }
    throw error;
  }
}
