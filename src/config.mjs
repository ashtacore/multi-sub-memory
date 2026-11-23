import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { INDEXER_ORCHESTRATORS } from './indexers/types.mjs';
import { resolveProjectKey } from './project-id.mjs';

const defaults = {
  dbPath: '~/.local/share/multi-sub-memory/memory.db',
  embedding: { model: 'BAAI/bge-base-en-v1.5', enabled: true },
  bootstrap: { tokenBudget: 2500 },
  dreamer: { enabled: false },
  indexers: {
    enabled: true, backgroundRefresh: false, refreshIntervalMs: 60_000,
    omp: {}, claude: {}, codex: {}, agy: {},
  },
};

const embeddingSchema = z.object({ model: z.string().min(1), enabled: z.boolean() }).strict();
const bootstrapSchema = z.object({ tokenBudget: z.number().int().positive() }).strict();
const dreamerSchema = z.object({ enabled: z.boolean() }).strict();
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

export const ConfigSchema = z.object({
  dbPath: z.string().min(1),
  embedding: embeddingSchema,
  bootstrap: bootstrapSchema,
  dreamer: dreamerSchema,
  indexers: indexersSchema,
}).strict();

const configLayerSchema = ConfigSchema.extend({
  embedding: embeddingSchema.partial(),
  bootstrap: bootstrapSchema.partial(),
  dreamer: dreamerSchema.partial(),
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

function readConfigLayer(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  try {
    return configLayerSchema.parse(parseJsonc(text));
  } catch (error) {
    throw new Error('Invalid config at ' + configPath + '\n' + error.message, { cause: error });
  }
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

export function loadConfig(options = {}) {
  const { cwd, projectRoot, env = process.env, homeDir = os.homedir() } = options;
  const userConfigPath = options.userConfigPath ?? (env.MULTI_SUB_MEMORY_CONFIG
    ? expandHome(env.MULTI_SUB_MEMORY_CONFIG, homeDir)
    : path.join(homeDir, '.config', 'multi-sub-memory', 'config.jsonc'));
  const projectConfigPath = options.projectConfigPath
    ?? path.join(projectRoot ?? resolveProjectKey(cwd).projectRoot, '.multi-sub-memory.jsonc');
  const user = readConfigLayer(userConfigPath);
  const project = readConfigLayer(projectConfigPath);
  const overrides = environmentLayer(env);
  const indexers = { ...defaults.indexers, ...user.indexers, ...project.indexers };
  for (const orchestrator of INDEXER_ORCHESTRATORS) {
    const adapter = { ...defaults.indexers[orchestrator], ...user.indexers?.[orchestrator], ...project.indexers?.[orchestrator] };
    if (adapter.sessionsDir !== undefined) adapter.sessionsDir = expandHome(adapter.sessionsDir, homeDir);
    indexers[orchestrator] = adapter;
  }

  const config = ConfigSchema.parse({
    dbPath: overrides.dbPath ?? project.dbPath ?? user.dbPath ?? defaults.dbPath,
    embedding: { ...defaults.embedding, ...user.embedding, ...project.embedding, ...overrides.embedding },
    bootstrap: { ...defaults.bootstrap, ...user.bootstrap, ...project.bootstrap },
    dreamer: { ...defaults.dreamer, ...user.dreamer, ...project.dreamer },
    indexers,
  });
  config.dbPath = expandHome(config.dbPath, homeDir);
  return config;
}

function resolveConfigDestination(configPath) {
  if (!fs.lstatSync(configPath, { throwIfNoEntry: false })?.isSymbolicLink()) return configPath;

  try {
    return fs.realpathSync.native(configPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (process.platform === 'win32') {
    // Win32 collapses `..` before following any symlinks in the target path.
    let destination = configPath;
    for (let hops = 0; hops < 40; hops++) {
      const directory = fs.realpathSync.native(path.dirname(destination));
      destination = path.resolve(directory, fs.readlinkSync(destination));
      if (!fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return destination;
      }
    }
    throw new Error('Too many symbolic links resolving config path ' + configPath);
  }

  // POSIX follows each symlink before interpreting any later `..` components.
  const remaining = [path.basename(configPath)];
  let destination = fs.realpathSync.native(path.dirname(configPath));
  let hops = 0;
  while (remaining.length > 0) {
    const component = remaining.shift();
    if (component === '.') {
      if (remaining.length === 0) {
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

    if (++hops > 40) {
      throw new Error('Too many symbolic links resolving config path ' + configPath);
    }
    const target = fs.readlinkSync(candidate);
    if (remaining.length === 0 && target.endsWith('/')) {
      throw new Error('Config symlink target must not be a directory path: ' + target);
    }
    const { root } = path.parse(target);
    if (root) destination = path.resolve(destination, root);
    remaining.unshift(...target.slice(root.length).split('/').filter(Boolean));
  }
  return destination;
}

export function writeConfig(configPath, configData, options = {}) {
  const config = configLayerSchema.parse(configData);
  const resolvedPath = expandHome(configPath, options.homeDir);
  const destination = resolveConfigDestination(resolvedPath);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });

  let existingMode;
  try {
    const stat = fs.statSync(destination);
    if (stat.isFile()) existingMode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(directory, '.multi-sub-memory-' + randomBytes(6).toString('hex') + '.tmp');
  const tempFile = fs.openSync(tempPath, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(tempFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
      if (process.platform !== 'win32' && existingMode !== undefined) {
        fs.fchmodSync(tempFile, existingMode);
      }
    } finally {
      fs.closeSync(tempFile);
    }
    fs.renameSync(tempPath, destination);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not write config or remove the temporary file');
    }
    throw error;
  }
}
