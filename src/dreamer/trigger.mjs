import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDreamerTrust, loadWorkspaceConfig, resolveUserConfigPath } from '../config.mjs';

const defaultCliPath = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url));
export const AUTO_DREAM_CONTEXT_ENV = 'MULTI_SUB_MEMORY_AUTO_DREAM_CONTEXT';

export function lastCompletedDream(db, projectKey) {
  return db.prepare(`
    SELECT id, started_at, finished_at, last_transcript_message_id FROM dream_runs
    WHERE project_key = ? AND status = 'completed' AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, rowid DESC LIMIT 1
  `).get(projectKey);
}

export function shouldTriggerAutoDream(db, config, projectKey, now = Date.now()) {
  const dreamer = config?.dreamer;
  if (!dreamer?.enabled || dreamer.mode === 'disabled' || dreamer.cadence?.mode !== 'auto') return false;
  const { minIntervalHours, minNewMemories } = dreamer.cadence;
  const lastRun = lastCompletedDream(db, projectKey);
  if (lastRun && now - lastRun.finished_at < minIntervalHours * 3_600_000) return false;
  const cutoff = lastRun?.started_at ?? -1;
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM memories
    WHERE project_key = ? AND scope = 'project' AND status = 'active'
      AND (created_at > ? OR updated_at > ?)
      AND NOT COALESCE(json_extract(metadata_json, '$.dream_run_id') = ? AND updated_at <= ?, 0)
  `).get(projectKey, cutoff, cutoff, lastRun?.id ?? null, lastRun?.finished_at ?? null);
  return count >= minNewMemories;
}

export function maybeTriggerAutoDream({
  db, config, projectKey, cwd, reloadProjectConfig = false, configOptions,
  spawnImpl = spawn, cliPath = defaultCliPath,
}) {
  try {
    if (reloadProjectConfig && !cwd) return false;
    const env = configOptions?.env ?? process.env;
    const userConfigPath = path.resolve(resolveUserConfigPath(configOptions));
    const { config: trusted, project } = loadWorkspaceConfig({ ...configOptions, cwd, env, userConfigPath });
    if (!project || (projectKey && projectKey !== project.projectKey)) return false;
    projectKey = project.projectKey;
    const targetConfig = reloadProjectConfig ? trusted : config;
    const now = Date.now();
    if (!shouldTriggerAutoDream(db, targetConfig, projectKey, now)) return false;
    assertDreamerTrust(targetConfig.dreamer, { userDreamer: trusted.dreamer });
    const held = db.prepare('SELECT 1 FROM leases WHERE lease_key = ? AND expires_at > ?').get('dream:' + projectKey, now);
    if (held) return false;
    // Use target settings with the same database in which the activity was recorded.
    const databaseFile = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get().file;
    if (!databaseFile) return false;
    const dbPath = path.resolve(databaseFile);
    const context = JSON.stringify({ dbPath, projectKey });
    const child = spawnImpl(process.execPath, [cliPath, 'dream'], {
      cwd: path.resolve(cwd ?? process.cwd()), detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...env, MULTI_SUB_MEMORY_CONFIG: userConfigPath, [AUTO_DREAM_CONTEXT_ENV]: context },
    });
    child.on?.('error', () => {});
    child.unref?.();
    return !('pid' in child) || child.pid !== undefined;
  } catch {
    return false;
  }
}
