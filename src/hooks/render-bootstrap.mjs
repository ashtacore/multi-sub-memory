import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const maxTimerDelay = 2 ** 31 - 1;
const bootstrapModule = new URL('./bootstrap-worker.mjs', import.meta.url);

export async function renderHookBootstrap(options = {}) {
  let timer;
  let worker;
  let child;
  let childClosed;
  let temporaryDirectory;
  let work;
  function cleanupOnExit() {
    try {
      if (child && child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL');
    } catch {
      // The child may have already exited.
    }
    try {
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch {
      // An interrupted child may still be closing its snapshot.
    }
  }
  try {
    const {
      cwd, env = process.env, homeDir = os.homedir(), timeoutMs = 500,
      userConfigPath, projectConfigPath, useChildProcess = false,
    } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return '';
    const deadline = performance.now() + Math.min(timeoutMs, maxTimerDelay);
    temporaryDirectory = path.join(os.tmpdir(), 'multi-sub-memory-hook-' + randomUUID());
    if (useChildProcess) process.once('exit', cleanupOnExit);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.min(timeoutMs, maxTimerDelay), '');
    });
    work = (async () => {
      if (performance.now() >= deadline) return '';
      const data = { cwd, env, homeDir, userConfigPath, projectConfigPath, temporaryDirectory };
      // Closing a raw database descriptor on POSIX can release SQLite locks held in the same process.
      // The CLI also needs a child because Node joins worker threads during process exit.
      if (useChildProcess || process.platform !== 'win32') {
        child = fork(bootstrapModule, {
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
        childClosed = new Promise((resolve) => child.once('close', resolve));
        // Allow the Git timeout to finish and IPC output to arrive before the parent deadline.
        const childDeadline = performance.timeOrigin + deadline - Math.min(25, timeoutMs / 10);
        return new Promise((resolve) => {
          child.once('message', resolve);
          child.on('error', () => resolve(''));
          child.once('exit', () => resolve(''));
          child.send({ data, deadline: childDeadline }, (error) => {
            if (error) resolve('');
          });
          child.unref();
          child.channel?.unref();
        });
      }
      worker = new Worker(bootstrapModule, {
        workerData: { ...data, deadline },
        execArgv: [],
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      return new Promise((resolve) => {
        worker.once('message', resolve);
        worker.on('error', () => resolve(''));
        worker.once('exit', () => resolve(''));
        worker.unref();
      });
    })();
    const block = await Promise.race([work, timeout]);
    return performance.now() < deadline ? block : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    // Cleanup can finish independently of the host's startup deadline.
    if (work) void (async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await childClosed;
        if (worker) await worker.terminate();
        await work;
      } catch {
        // The worker or its setup failed.
      } finally {
        if (temporaryDirectory) {
          try {
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
            process.off('exit', cleanupOnExit);
          } catch {
            // CLI exit still attempts cleanup if asynchronous removal failed.
          }
        }
      }
    })();
  }
}
