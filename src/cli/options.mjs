import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_PATH, expandHome } from '../config.mjs';
import { resolveProjectKey } from '../project-id.mjs';
import { HOSTS } from './hosts.mjs';

export function parseOptions(argv, commandOptions) {
  const hostOptions = Object.fromEntries(Object.keys(HOSTS).map((host) => [host + '-config', { type: 'string' }]));
  return parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      db: { type: 'string' },
      config: { type: 'string' },
      home: { type: 'string' },
      ...hostOptions,
      ...commandOptions,
    },
  }).values;
}

export function cliContext(values, options) {
  const { env = process.env } = options;
  const cwd = path.resolve(options.cwd ?? process.cwd(), expandHome(values.cwd ?? '.', options.homeDir));
  const homeDir = path.resolve(cwd, expandHome(values.home ?? options.homeDir ?? os.homedir(), options.homeDir));
  const resolvePath = (value) => path.resolve(cwd, expandHome(value, homeDir));
  const userConfigPath = resolvePath(values.config ?? (env.MULTI_SUB_MEMORY_CONFIG || DEFAULT_CONFIG_PATH));
  const projectConfigPath = path.join(resolveProjectKey(cwd).projectRoot, '.multi-sub-memory.jsonc');
  const hostConfigPaths = { ...options.hostConfigPaths };
  for (const host of Object.keys(HOSTS)) {
    if (values[host + '-config'] !== undefined) hostConfigPaths[host] = values[host + '-config'];
  }
  return { env, cwd, homeDir, userConfigPath, projectConfigPath, resolvePath, hostConfigPaths };
}

export function transformersAvailable() {
  try {
    const entry = fileURLToPath(import.meta.resolve('@huggingface/transformers'));
    return fs.statSync(entry, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    return false;
  }
}

export function configErrorMessage(error) {
  const cause = error.cause ?? error;
  if (Array.isArray(cause.issues)) {
    const fields = new Set(cause.issues.map(({ path }) => path.join('.') || 'root'));
    return 'Invalid config fields: ' + [...fields].join(', ');
  }
  if (cause instanceof SyntaxError) return 'Invalid JSONC syntax';
  return error.message;
}
