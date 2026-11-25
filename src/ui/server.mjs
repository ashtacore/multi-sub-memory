import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, loadWorkspaceConfig, resolveConfigProject } from '../config.mjs';
import { openDatabase } from '../db.mjs';
import { createEmbeddingEngine } from '../embeddings.mjs';
import { createApi, RequestError } from './routes.mjs';

export const DEFAULT_UI_PORT = 3847;
const host = '127.0.0.1';
const mutating = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);
const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function json(res, status, body) {
  send(res, status, contentTypes['.json'], JSON.stringify(body));
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; "
    + "img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function validToken(value, expected) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requestPath(target) {
  const queryStart = target.indexOf('?');
  const rawPath = queryStart < 0 ? target : target.slice(0, queryStart);
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    throw new RequestError(400, 'Invalid URL path');
  }
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('..') || /[\\\0]/.test(pathname)) {
    throw new RequestError(403, 'Forbidden path');
  }
  return { pathname, params: new URLSearchParams(queryStart < 0 ? '' : target.slice(queryStart + 1)) };
}

function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function staticFile(req, res, pathname, publicRoot, csrfToken) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(404, 'Not found');
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicRoot, '.' + requested);
  if (requested.includes(':') || !isInside(publicRoot, file)) throw new RequestError(403, 'Forbidden path');
  const extension = path.extname(file);
  const type = contentTypes[extension];
  if (!type) throw new RequestError(404, 'Not found');

  let body;
  try {
    const resolved = await realpath(file);
    if (!isInside(publicRoot, resolved)) throw new RequestError(403, 'Forbidden path');
    body = await readFile(resolved);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw new RequestError(404, 'Not found');
    throw error;
  }
  if (extension === '.html') {
    res.setHeader('Cache-Control', 'no-store');
    body = body.toString('utf8').replace('{{MSM_CSRF_TOKEN}}', csrfToken);
  }
  send(res, 200, type, body);
}

export function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const command = { win32: 'explorer.exe', darwin: 'open' }[process.platform] ?? 'xdg-open';
    const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function allowedLoopbackGuards(port) {
  const loopbackNames = [host, 'localhost', '[::1]'];
  const hosts = new Set(loopbackNames.map((name) => name + ':' + port));
  if (port === 80) {
    for (const name of loopbackNames) hosts.add(name);
  }
  const origins = new Set([...hosts].map((name) => 'http://' + name));
  return { hosts, origins };
}

export async function startDashboardServer(options = {}) {
  const { port = DEFAULT_UI_PORT, cwd: directory, userConfigPath, homeDir, env = process.env } = options;
  const cwd = path.resolve(directory ?? process.cwd());
  const configOptions = { userConfigPath, homeDir, env };
  const { config: baseConfig, project } = options.config
    ? { config: options.config, project: resolveConfigProject(cwd, options.config, { optional: true }) }
    : loadWorkspaceConfig({ cwd, ...configOptions });
  const config = options.dbPath === undefined
    ? baseConfig : { ...baseConfig, dbPath: expandHome(options.dbPath, homeDir) };
  const { projectKey: defaultProjectKey = null, projectRoot: defaultProjectRoot = null } = project ?? {};
  const publicRoot = await realpath(publicDir);
  const csrfToken = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(csrfToken);
  const embeddingEngine = options.embeddingEngine === undefined
    ? createEmbeddingEngine({ embedding: config.embedding, env }) : options.embeddingEngine;
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(config.dbPath);
  const api = createApi({ db, config, tagConfig: baseConfig, cwd, defaultProjectKey, defaultProjectRoot, embeddingEngine, env, configOptions });
  const inFlight = new Set();
  let hosts;
  let origins;

  async function handle(req, res) {
    setSecurityHeaders(res);
    if (req.url?.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.headersDistinct.host?.length !== 1 || !hosts.has(req.headers.host.toLowerCase())) {
        throw new RequestError(403, 'Forbidden host');
      }
      const { pathname, params } = requestPath(req.url);
      const isApi = pathname.startsWith('/api/');
      if (isApi) res.setHeader('Cache-Control', 'no-store');
      const writes = mutating.has(req.method);
      if (isApi || writes) {
        const site = req.headers['sec-fetch-site'];
        const origin = req.headers.origin;
        if ((site !== undefined && site !== 'same-origin' && site !== 'none')
          || (origin !== undefined && !origins.has(origin))) {
          throw new RequestError(403, 'Forbidden cross-site request');
        }
      }
      if (writes && !validToken(req.headers['x-msm-token'], tokenBytes)) {
        throw new RequestError(403, 'Invalid or missing CSRF token');
      }
      if (isApi) json(res, 200, await api(req, pathname, params));
      else await staticFile(req, res, pathname, publicRoot, csrfToken);
    } catch (error) {
      req.resume();
      if (!res.destroyed) {
        if (error instanceof RequestError) json(res, error.status, { error: error.message });
        else json(res, 500, { error: 'Dashboard request failed' });
      }
    }
  }

  // Handle a missing Host in the same JSON guard as an invalid Host.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    const request = handle(req, res);
    inFlight.add(request);
    void request.finally(() => inFlight.delete(request));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        ({ hosts, origins } = allowedLoopbackGuards(server.address().port));
        resolve();
      });
    });
  } catch (error) {
    if (ownsDb) db.close();
    throw error;
  }

  const actualPort = server.address().port;
  let closing;
  function close() {
    closing ??= (async () => {
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          });
        });
      } finally {
        await Promise.allSettled(inFlight);
        if (ownsDb) db.close();
      }
    })();
    return closing;
  }

  return { server, url: 'http://' + host + ':' + actualPort, port: actualPort, host, csrfToken, close };
}
