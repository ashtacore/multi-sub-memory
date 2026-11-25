#!/usr/bin/env node
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { renderHookBootstrap } from '../../src/hooks/render-bootstrap.mjs';

function readPayload(stdin, deadline) {
  return new Promise((resolve, reject) => {
    if (stdin.readableEnded || stdin.destroyed) {
      resolve('');
      return;
    }
    const chunks = [];
    const wasFlowing = stdin.readableFlowing;
    function cleanup() {
      clearTimeout(timer);
      stdin.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
      if (!wasFlowing) stdin.pause();
    }
    function onData(chunk) {
      try {
        if (performance.now() >= deadline) return onClose();
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        onError(error);
      }
    }
    function onEnd() {
      cleanup();
      try {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        reject(error);
      }
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onClose() {
      cleanup();
      resolve('');
    }
    const timer = setTimeout(onClose, Math.min(deadline - performance.now(), 2 ** 31 - 1));
    stdin.once('end', onEnd).once('error', onError).once('close', onClose).on('data', onData);
  });
}

function writeBlock(stdout, block) {
  if (!(stdout instanceof Writable)) return stdout.write(block);
  return new Promise((resolve) => {
    // A failed Writable callback is followed by an error event.
    const onError = () => resolve();
    stdout.once('error', onError);
    try {
      stdout.write(block, (error) => {
        if (error) setImmediate(() => stdout.off('error', onError));
        else stdout.off('error', onError);
        resolve();
      });
    } catch {
      stdout.off('error', onError);
      resolve();
    }
  });
}

export async function runClaudeSessionStartHook(options = {}) {
  try {
    const { stdin = process.stdin, stdout = process.stdout, env = process.env, homeDir, timeoutMs = 500 } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    const deadline = performance.now() + timeoutMs;
    const payload = JSON.parse(await readPayload(stdin, deadline));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
    const block = await renderHookBootstrap({
      cwd, env, homeDir, timeoutMs: deadline - performance.now(), useChildProcess: options.useChildProcess,
    });
    if (block) await writeBlock(stdout, block + '\n');
  } catch {
    // An optional startup hook must leave the session usable on failure.
  }
}

function isMainScript() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export async function runClaudeSessionStartCli(options = {}) {
  const { exitProcess = true, timeoutMs = 500 } = options;
  const deadline = exitProcess && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => process.exit(0), Math.min(timeoutMs, 2 ** 31 - 1)) : undefined;
  try {
    await runClaudeSessionStartHook({ ...options, useChildProcess: exitProcess });
  } finally {
    clearTimeout(deadline);
    if (exitProcess) {
      process.exit(0);
    }
  }
}

if (isMainScript()) await runClaudeSessionStartCli();
