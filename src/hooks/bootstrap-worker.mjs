import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { formatBootstrap } from '../bootstrap.mjs';
import { effectiveDatabaseFilePath, loadConfig } from '../config.mjs';
import { openDatabase } from '../db.mjs';
import { resolveProjectKey } from '../project-id.mjs';

const sqliteSignature = Buffer.from('SQLite format 3\0');

function stat(filename) {
  return fs.statSync(filename, { bigint: true, throwIfNoEntry: false });
}

function sameFile(before, after) {
  return before?.dev === after?.dev && before?.ino === after?.ino
    && before?.size === after?.size && before?.mtimeNs === after?.mtimeNs
    && before?.ctimeNs === after?.ctimeNs;
}

function hasSqliteSignature(source) {
  const fd = fs.openSync(source, 'r');
  try {
    const signature = Buffer.alloc(sqliteSignature.length);
    return fs.readSync(fd, signature, 0, signature.length, 0) === signature.length
      && signature.equals(sqliteSignature);
  } finally {
    fs.closeSync(fd);
  }
}

function canSnapshot(source, deadline) {
  const busyTimeoutMs = Math.floor(deadline - performance.now());
  if (busyTimeoutMs <= 0) return false;
  const probe = openDatabase(source, { readOnly: true, busyTimeoutMs });
  try {
    // Exclusive locking mode probes the source lock without opening a shared-memory sidecar.
    probe.exec('PRAGMA locking_mode = EXCLUSIVE; SELECT 1 FROM sqlite_master LIMIT 1;');
    return true;
  } catch (error) {
    // A read-only WAL probe can acquire the database lock and then fail to open its WAL index.
    return error.errcode === 3850 || error.errcode === 8; // SQLITE_IOERR_SHMOPEN or SQLITE_READONLY
  } finally {
    probe.close();
  }
}

function render({ cwd = process.cwd(), env, homeDir, userConfigPath, projectConfigPath, temporaryDirectory, deadline }) {
  if (performance.now() >= deadline) return '';
  const project = resolveProjectKey(cwd, {
    timeoutMs: Math.max(1, Math.min(2000, Math.floor(deadline - performance.now()))),
  });
  if (performance.now() >= deadline) return '';
  const config = loadConfig({ cwd, env, homeDir, userConfigPath, projectConfigPath, projectRoot: project.projectRoot });
  const dbPath = effectiveDatabaseFilePath(config.dbPath, { homeDir, strictHookUri: true });
  if (performance.now() >= deadline || !dbPath || !stat(dbPath)?.isFile()) return '';

  const source = fs.realpathSync(dbPath);
  const wal = source + '-wal';
  const journal = source + '-journal';
  const dbBefore = stat(source);
  const walBefore = stat(wal);
  if (!dbBefore?.isFile() || dbBefore.size < 100n || (walBefore && !walBefore.isFile()) || stat(journal)) return '';
  if (!hasSqliteSignature(source) || !canSnapshot(source, deadline) || performance.now() >= deadline) return '';

  fs.mkdirSync(temporaryDirectory, { mode: 0o700, recursive: true });
  const snapshot = path.join(temporaryDirectory, 'memory.db');
  fs.copyFileSync(source, snapshot);
  if (walBefore) fs.copyFileSync(wal, snapshot + '-wal');
  if (!sameFile(dbBefore, stat(source)) || !canSnapshot(source, deadline)) return '';
  if (!sameFile(dbBefore, stat(source)) || !sameFile(walBefore, stat(wal)) || stat(journal)) return '';

  const busyTimeoutMs = Math.floor(deadline - performance.now());
  if (busyTimeoutMs <= 0) return '';
  const db = openDatabase(snapshot, { readOnly: true, busyTimeoutMs });
  try {
    const result = formatBootstrap(db, { cwd, config, project });
    if (performance.now() >= deadline) return '';
    return result.includedMemories || result.includedNotes || result.omittedMemories || result.omittedNotes
      ? result.text : '';
  } finally {
    db.close();
  }
}

function renderForHost(data, deadline) {
  try {
    return render({ ...data, deadline });
  } catch {
    return '';
  }
}

if (parentPort) {
  parentPort.postMessage(renderForHost(workerData, workerData.deadline));
} else if (process.send) {
  process.once('message', ({ data, deadline }) => {
    process.send(renderForHost(data, deadline - performance.timeOrigin), () => {
      if (process.connected) process.disconnect();
    });
  });
}
