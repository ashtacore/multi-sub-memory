import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { INDEXER_ORCHESTRATORS } from './indexers/types.mjs';
import { resolveProjectKey } from './project-id.mjs';

export const DEFAULT_DB_PATH = '~/.local/share/multi-sub-memory/memory.db';
export const DEFAULT_CONFIG_PATH = '~/.config/multi-sub-memory/config.jsonc';
export const DEFAULT_EMBEDDING_ENABLED = true;

const defaults = {
  dbPath: DEFAULT_DB_PATH,
  embedding: { model: 'BAAI/bge-base-en-v1.5', enabled: DEFAULT_EMBEDDING_ENABLED },
  bootstrap: { tokenBudget: 2500 },
  indexers: {
    enabled: true, backgroundRefresh: false, refreshIntervalMs: 60_000,
    omp: {}, claude: {}, codex: {}, agy: {},
  },
};

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

const configFields = z.object({
  dbPath: z.string().min(1),
  embedding: embeddingSchema,
  bootstrap: bootstrapSchema,
  dreamer: dreamerSchema,
  indexers: indexersSchema,
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
}).partial();

export function expandHome(inputPath, homeDir = os.homedir()) {
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return path.join(homeDir, inputPath.slice(2));
  if (inputPath.startsWith('~\\')) {
    return path.join(homeDir, inputPath.slice(2).replaceAll('\\', '/'));
  }
  return inputPath;
}

export function stripJsonc(text) {
  const output = [];
  let inString = false;
  let escaped = false;
  let previousToken;
  let trailingComma = -1;

  for (let index = text[0] === '\uFEFF' ? 1 : 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];

    if (inString) {
      output.push(character);
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
      index--;
      continue;
    }

    if (character === '/' && next === '*') {
      // Leave whitespace so a comment cannot splice separate JSON tokens.
      output.push(' ');
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n' || text[index] === '\r') output.push(text[index]);
        index++;
      }
      if (index === text.length) throw new SyntaxError('Unterminated block comment');
      index++;
      continue;
    }

    if (character === '"') inString = true;
    if (!' \t\r\n'.includes(character)) {
      if ((character === '}' || character === ']') && trailingComma !== -1) {
        output[trailingComma] = '';
      }
      const canFollowValue = previousToken && !'{[:,'.includes(previousToken);
      trailingComma = character === ',' && canFollowValue ? output.length : -1;
      previousToken = character;
    }
    output.push(character);
  }
  return output.join('');
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
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
    return configLayerSchema.parse(parseJsonc(text));
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
  if (mode !== 'cli' && mode !== 'http') return;
  const trusted = userDreamer === undefined ? readConfigLayer(resolveUserConfigPath(configOptions)).dreamer : userDreamer;
  if (mode === 'http') {
    const trustedHttp = trusted?.http;
    if (!trustedHttp?.baseUrl || http?.baseUrl !== trustedHttp.baseUrl
      || (http.apiKeyEnv !== undefined && http.apiKeyEnv !== trustedHttp.apiKeyEnv)) {
      throw new Error('Dreamer HTTP endpoint and API key must be authorized in user settings');
    }
  } else {
    const trustedCli = trusted?.cli;
    if (trusted?.mode !== 'cli' || !cli || cli.orchestrator !== trustedCli?.orchestrator
      || cli.command !== trustedCli?.command || !isDeepStrictEqual(cli.args, trustedCli?.args)) {
      throw new Error('Dreamer CLI orchestrator, command, and arguments must be authorized in user settings');
    }
  }
}

export function loadConfig(options = {}) {
  const { cwd, projectRoot, env = process.env, homeDir = os.homedir() } = options;
  const userConfigPath = resolveUserConfigPath(options);
  const projectConfigPath = options.projectConfigPath
    ?? path.join(projectRoot ?? resolveProjectKey(cwd).projectRoot, '.multi-sub-memory.jsonc');
  const user = options.userConfigData === undefined
    ? readConfigLayer(userConfigPath)
    : configLayerSchema.parse(options.userConfigData);
  const project = readConfigLayer(projectConfigPath);
  const overrides = environmentLayer(env);
  const indexers = { ...defaults.indexers, ...user.indexers, ...project.indexers };
  const projectSelectsDatabase = project.dbPath !== undefined && overrides.dbPath === undefined;
  indexers.backgroundRefresh = user.indexers?.backgroundRefresh === true
    && project.indexers?.backgroundRefresh !== false && !projectSelectsDatabase;
  for (const orchestrator of INDEXER_ORCHESTRATORS) {
    const adapter = { ...defaults.indexers[orchestrator], ...user.indexers?.[orchestrator], ...project.indexers?.[orchestrator] };
    if (adapter.sessionsDir !== undefined) adapter.sessionsDir = expandHome(adapter.sessionsDir, homeDir);
    indexers[orchestrator] = adapter;
  }

  const config = ConfigSchema.parse({
    dbPath: overrides.dbPath ?? project.dbPath ?? user.dbPath ?? defaults.dbPath,
    embedding: { ...defaults.embedding, ...user.embedding, ...project.embedding, ...overrides.embedding },
    bootstrap: { ...defaults.bootstrap, ...user.bootstrap, ...project.bootstrap },
    dreamer: mergeDreamer(user.dreamer, project.dreamer),
    indexers,
  });
  config.dbPath = expandHome(config.dbPath, homeDir);
  return config;
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
  const config = configLayerSchema.parse(configData);
  const resolvedPath = expandHome(configPath, options.homeDir);
  const destination = resolveConfigDestination(resolvedPath);

  let existingMode;
  try {
    const stat = fs.statSync(destination);
    if (stat.isFile()) existingMode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  writeTextAtomically(destination, JSON.stringify(config, null, 2) + '\n', options.mode ?? existingMode);
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
