import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readConfigLayer, writeConfig } from '../src/config.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';

export function initGit(cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(cwd, 'absent-gitconfig');
  execFileSync('git', ['init', '--template='], { cwd, env, timeout: 10_000, windowsHide: true, stdio: 'pipe' });
  return cwd;
}

export function writeProjectConfig(configPath, cwd, layer) {
  const settings = readConfigLayer(configPath);
  const { projectKey } = resolveProjectKey(cwd);
  writeConfig(configPath, { ...settings, projects: { ...settings.projects, [projectKey]: layer } });
}
