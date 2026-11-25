import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, writeConfig } from '../src/config.mjs';
import { acquireLease, hashNormalizedContent, MIGRATIONS, openDatabase, releaseLease } from '../src/db.mjs';
import { addNoteComment, archiveMemory, recordAccess, writeMemory, writeNote } from '../src/memory-service.mjs';
import { normalizePath, resolveProjectKey } from '../src/project-id.mjs';
import { allowedLoopbackGuards, startDashboardServer } from '../src/ui/server.mjs';
import { fixtureGit, initGit, writeProjectConfig } from './git-fixtures.mjs';

async function fixture(t, { dreamer, env = {}, embeddingEngine, gitWorkspace = true, globalMode = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'multi-sub-memory-ui-'));
  if (gitWorkspace) initGit(cwd);
  const dbPath = path.join(cwd, 'dashboard.db');
  const userConfigPath = path.join(cwd, 'config.yaml');
  let db;
  let dashboard;
  t.after(async () => {
    try {
      await dashboard?.close();
    } finally {
      db?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  await writeFile(userConfigPath, JSON.stringify({
    dbPath, embedding: { enabled: false }, ...(dreamer ? { dreamer } : {}),
  }));
  async function restart(dashboardEnv) {
    await dashboard?.close();
    db?.close();
    db = undefined;
    db = openDatabase(dbPath);
    dashboard = await startDashboardServer({ cwd, globalMode, userConfigPath, db, env: dashboardEnv, embeddingEngine, port: 0 });
    return db;
  }
  await restart(env);
  const projectKey = resolveProjectKey(cwd, { optional: true })?.projectKey ?? null;

  function request(pathname, { method = 'GET', body, rawBody, headers, authorized = false, setHost = true } = {}) {
    const payload = body === undefined ? rawBody : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: dashboard.host, port: dashboard.port, path: pathname, method, setHost,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          ...(authorized ? { 'X-MSM-Token': dashboard.csrfToken } : {}),
          ...headers,
        },
      }, async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          const text = Buffer.concat(chunks).toString('utf8');
          const json = res.headers['content-type']?.startsWith('application/json') && text ? JSON.parse(text) : null;
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  function mutate(method, pathname, body) {
    return request(pathname, { method, body, authorized: true });
  }
  return { cwd, db, dbPath, dashboard, userConfigPath, projectKey, request, mutate, restart };
}

test('dashboard binds to IPv4 loopback and keeps a supplied database open', async (t) => {
  const { dashboard, db, request } = await fixture(t);
  assert.deepEqual(dashboard.server.address(), { address: '127.0.0.1', family: 'IPv4', port: dashboard.port });
  assert.equal(dashboard.url, 'http://127.0.0.1:' + dashboard.port);
  assert.ok(dashboard.port > 0);
  assert.match(dashboard.csrfToken, /^[a-f0-9]{64}$/);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.ok(page.text.includes('content="' + dashboard.csrfToken + '"'));
  assert.ok(!page.text.includes('{{MSM_CSRF_TOKEN}}'));
  assert.equal((await request('/index.html')).text, page.text);
  const elementIds = new Set([...page.text.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id));
  for (const id of [
    'project', 'stats', 'error-banner', 'error-message', 'retry', 'toast-region',
    'view-memories', 'view-notes', 'view-dreamer',
    'memories-heading', 'mem-search', 'mem-count', 'mem-scope', 'mem-category', 'mem-status', 'mem-tag', 'memory-list',
    'notes-heading', 'note-list', 'notes-load-more',
    'dream-trigger', 'dream-dryrun', 'dream-hint', 'dream-result', 'dream-status', 'dream-config', 'dream-history',
    'edit-memory-dialog', 'edit-note-dialog', 'confirm-dialog', 'confirm-title', 'confirm-description',
  ]) {
    assert.ok(elementIds.has(id), `Served dashboard HTML is missing id="${id}"`);
  }
  assert.match((await request('/app.js')).headers['content-type'], /^text\/javascript/);
  assert.match((await request('/styles.css')).headers['content-type'], /^text\/css/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);
  assert.equal((await request('/api/overview')).headers['cache-control'], 'no-store');

  await dashboard.close();
  assert.equal(dashboard.server.listening, false);
  assert.equal(db.prepare('SELECT 1 AS value').get().value, 1);
});

test('dashboard accepts bare loopback hosts and origins only on the default HTTP port', () => {
  const bare = ['127.0.0.1', 'localhost', '[::1]'];
  for (const port of [80, 3847]) {
    const expectedHosts = bare.map((name) => name + ':' + port);
    if (port === 80) expectedHosts.push(...bare);
    const { hosts, origins } = allowedLoopbackGuards(port);
    assert.deepEqual(hosts, new Set(expectedHosts));
    assert.deepEqual(origins, new Set(expectedHosts.map((name) => 'http://' + name)));
  }
});

test('dashboard rejects invalid hosts, cross-site API reads and writes, and missing CSRF tokens', async (t) => {
  const { dashboard, request } = await fixture(t);
  for (const pathname of ['/', '/api/overview']) {
    for (const host of ['outside.invalid:' + dashboard.port, '127.0.0.1', 'localhost:1', undefined]) {
      const response = await request(pathname, { setHost: false, headers: host ? { Host: host } : {} });
      assert.equal(response.status, 403);
      assert.deepEqual(response.json, { error: 'Forbidden host' });
    }
  }
  for (const name of ['LOCALHOST', '[::1]']) {
    const host = name + ':' + dashboard.port;
    const response = await request('/api/overview', { headers: { Host: host, Origin: 'http://' + host.toLowerCase() } });
    assert.equal(response.status, 200);
  }
  for (const headers of [
    { Origin: 'https://outside.invalid' },
    { Origin: dashboard.url + '/' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    assert.equal((await request('/api/overview', { headers })).status, 403);
    assert.equal((await request('/api/dreamer/run', { method: 'POST', authorized: true, headers })).status, 403);
  }
  for (const [method, pathname] of [
    ['POST', '/api/dreamer/run'], ['PATCH', '/api/memories/x'], ['DELETE', '/api/notes/x'], ['PUT', '/index.html'],
  ]) {
    for (const token of [undefined, 'bad', 'f'.repeat(64)]) {
      const response = await request(pathname, { method, headers: token ? { 'X-MSM-Token': token } : {} });
      assert.equal(response.status, 403);
      assert.deepEqual(response.json, { error: 'Invalid or missing CSRF token' });
    }
  }
  for (const pathname of ['/../server.mjs', '/%2e%2e/server.mjs', '/%5cserver.mjs', '/%00.js']) {
    assert.ok([403, 404].includes((await request(pathname)).status), pathname);
  }
});

test('dashboard parses only bounded JSON objects for record mutations', async (t) => {
  const { request, mutate } = await fixture(t);
  const endpoint = '/api/memories/example';
  assert.equal((await request(endpoint, { method: 'PATCH', authorized: true, rawBody: '{' })).status, 400);
  assert.equal((await mutate('PATCH', endpoint, [])).status, 400);
  assert.equal((await mutate('PATCH', endpoint, { content: 'x'.repeat(256 * 1024) })).status, 413);
  assert.equal((await request(endpoint, {
    method: 'PATCH', authorized: true, headers: { 'Transfer-Encoding': 'chunked' }, rawBody: 'x'.repeat(256 * 1024 + 1),
  })).status, 413);
});

test('overview combines project and global status counts without returning local paths', async (t) => {
  const { cwd, db, projectKey, request } = await fixture(t);
  await writeMemory(db, { cwd, content: 'Local entry' });
  await writeMemory(db, { scope: 'global', content: 'Global entry' });
  writeNote(db, { cwd, content: 'Pending note', status: 'pending' });
  db.prepare("INSERT INTO notes (id, project_key, status, content, created_at, updated_at) VALUES ('global-note', 'global', 'dismissed', 'Fixture note', 1, 1)").run();
  const file = db.prepare(`
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
    VALUES (?, 'omp', 'fixture', 'transcripts-only', 1, 1)
  `).run(path.join(cwd, 'fixture.jsonl'));
  db.prepare("INSERT INTO transcript_messages (file_id, seq, role, text, line_no) VALUES (?, 0, 'user', 'Fixture', 1)")
    .run(file.lastInsertRowid);
  db.prepare("INSERT INTO dream_runs (id, project_key, runner, status, started_at) VALUES ('fixture', 'dreamer-only', 'http', 'dry-run', 1)").run();
  const response = await request('/api/overview');
  assert.equal(response.status, 200);
  const data = response.json;
  assert.equal(data.default_project_key, projectKey);
  assert.deepEqual(data.db, { ok: true, schema_version: MIGRATIONS.at(-1).version, journal_mode: 'wal' });
  assert.equal(data.embedding.enabled, false);
  const projects = new Map(data.projects.map((item) => [item.project_key, item]));
  assert.equal(projects.size, 3);
  assert.equal(projects.get(projectKey).notes.pending, 1);
  assert.equal(projects.get('dreamer-only').memories.total, 0);
  assert.deepEqual(projects.get('transcripts-only').transcripts, { files: 1, messages: 1 });
  assert.deepEqual(data.global.memories, { active: 1, archived: 0, superseded: 0, total: 1 });
  assert.deepEqual(data.totals.memories, { active: 2, archived: 0, superseded: 0, total: 2 });
  assert.deepEqual(data.totals.notes, { active: 0, pending: 1, dismissed: 1, total: 2 });
  assert.equal(projects.get(projectKey).display_name, path.basename(cwd));
  assert.equal(projects.get('dreamer-only').display_name, 'dreamer-only');
  assert.equal(projects.get('transcripts-only').display_name, 'transcripts-only');
  assert.equal(response.text.includes('fixture.jsonl'), false);
  assert.equal(response.text.includes('dashboard.db'), false);
});

test('overview disambiguates colliding project directory names with parent segments', async (t) => {
  const { cwd, db, request } = await fixture(t);
  const firstDir = path.join(cwd, 'Programming', 'GameDev', 'CoveCrawler');
  const secondDir = path.join(cwd, 'Programming', 'CoveCrawler');
  await mkdir(firstDir, { recursive: true });
  initGit(firstDir);
  await mkdir(secondDir, { recursive: true });
  initGit(secondDir);
  await writeMemory(db, { cwd: firstDir, content: 'GameDev CoveCrawler memory' });
  await writeMemory(db, { cwd: secondDir, content: 'Programming CoveCrawler memory' });

  const firstKey = resolveProjectKey(firstDir).projectKey;
  const secondKey = resolveProjectKey(secondDir).projectKey;
  const response = await request('/api/overview');
  assert.equal(response.status, 200);
  const projects = new Map(response.json.projects.map((item) => [item.project_key, item]));
  assert.equal(projects.get(firstKey).display_name, 'CoveCrawler (GameDev)');
  assert.equal(projects.get(secondKey).display_name, 'CoveCrawler (Programming)');
  assert.equal(response.text.includes('project_root'), false);
});

test('memories edit, archive, restore, rank filtered results, and delete associated search data', async (t) => {
  const { cwd, db, projectKey, request, mutate } = await fixture(t);
  const { memory } = await writeMemory(db, {
    cwd, content: 'Fixture turbine original', source_orchestrator: 'omp', source_session_id: 'session-fixture',
    metadata: { origin: 'fixture' },
  });
  await writeMemory(db, { cwd, content: 'Fixture duplicate' });
  await writeMemory(db, { scope: 'global', content: 'Fixture turbine global', category: 'ARCHITECTURE' });
  const endpoint = '/api/memories/' + memory.id;
  const search = '/api/memories?q=turbine&scope=project&project_key=' + encodeURIComponent(projectKey);
  const vectors = db.prepare("INSERT INTO memory_embeddings (memory_id, model_id, dims, vector, updated_at) VALUES (?, 'fixture', 1, ?, 1)");
  vectors.run(memory.id, Buffer.from([0, 0, 128, 63]));
  const countVectors = db.prepare('SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?');

  const list = await request('/api/memories');
  assert.equal(list.json.mode, 'list');
  assert.equal(list.json.memories.length, 3);
  assert.equal((await request(search)).json.mode, 'fts-only');
  assert.deepEqual((await request(search)).json.memories.map(({ id }) => id), [memory.id]);
  for (const body of [{ content: ' ' }, { importance: 5.5 }, { category: 'invalid' }, { status: 'invalid' }]) {
    assert.equal((await mutate('PATCH', endpoint, body)).status, 400);
  }
  assert.equal((await mutate('PATCH', endpoint, { content: '  FIXTURE   duplicate  ' })).status, 409);
  const edited = await mutate('PATCH', endpoint, {
    content: 'Fixture turbine edited', category: 'ARCHITECTURE', importance: 5,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.memory.normalized_hash, hashNormalizedContent('Fixture turbine edited'));
  assert.equal(edited.json.memory.importance, 5);
  assert.equal(edited.json.memory.source_session_id, 'session-fixture');
  assert.deepEqual(JSON.parse(edited.json.memory.metadata_json), { origin: 'fixture' });
  assert.equal(countVectors.get(memory.id).count, 0);

  assert.equal((await mutate('PATCH', endpoint, { status: 'archived' })).json.memory.status, 'archived');
  assert.equal((await request(search)).json.memories.length, 0);
  const archived = await request(search + '&status=archived&category=ARCHITECTURE&limit=1');
  assert.deepEqual(archived.json.memories.map(({ id }) => id), [memory.id]);
  assert.equal((await request(search + '&status=all&category=GENERAL')).json.memories.length, 0);
  assert.equal((await request('/api/memories?q=turbine&scope=global')).json.memories[0].project_key, 'global');
  assert.equal((await mutate('PATCH', endpoint, { status: 'active' })).json.memory.status, 'active');
  vectors.run(memory.id, Buffer.from([0, 0, 128, 63]));

  const removed = await mutate('DELETE', endpoint);
  assert.deepEqual(removed.json, { deleted: true, id: memory.id });
  assert.equal(countVectors.get(memory.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH 'edited'").get().count, 0);
  assert.equal((await request(search)).json.memories.length, 0);
  assert.equal((await mutate('DELETE', endpoint)).status, 404);
  assert.equal((await mutate('PATCH', endpoint, { status: 'active' })).status, 404);
});

test('dashboard leaves embeddings lazy and keeps memory edits when re-embedding fails', async (t) => {
  const attempts = [];
  const embeddingEngine = {
    getStatus: () => ({ enabled: true, model: 'fixture-model', available: false }),
    async embed(text) {
      attempts.push(text);
      if (text === 'Unembeddable edit') throw new Error('Fixture embedding failure');
      return new Float32Array([1, 0]);
    },
  };
  const { cwd, db, request, mutate } = await fixture(t, { embeddingEngine });
  const { memory } = await writeMemory(db, { cwd, content: 'Original memory' });
  assert.equal((await request('/api/overview')).json.embedding.status, 'uninitialized');
  assert.deepEqual(attempts, []);
  const endpoint = '/api/memories/' + memory.id;
  const embedded = await mutate('PATCH', endpoint, { content: 'Embeddable edit' });
  assert.equal(embedded.status, 200);
  const vector = db.prepare('SELECT model_id, dims FROM memory_embeddings WHERE memory_id = ?');
  assert.deepEqual({ ...vector.get(memory.id) }, { model_id: 'fixture-model', dims: 2 });
  const failedEmbedding = await mutate('PATCH', endpoint, { content: 'Unembeddable edit' });
  assert.equal(failedEmbedding.status, 200);
  assert.equal(failedEmbedding.json.memory.content, 'Unembeddable edit');
  assert.equal(vector.get(memory.id), undefined);
  assert.deepEqual(attempts, ['Embeddable edit', 'Unembeddable edit']);
});

test('record PATCHes reject stale revisions and preserve fields omitted by partial updates', async (t) => {
  const { cwd, db, mutate } = await fixture(t);
  const { memory } = await writeMemory(db, { cwd, content: 'Memory before edits', category: 'WORKFLOW' });
  const note = writeNote(db, { cwd, content: 'Note before edits', surface_condition: 'on start' });
  const staleMessage = { error: 'Record was modified by another writer; refresh and try again.' };

  for (const [table, record, status, change] of [
    ['memories', memory, 'archived', { importance: 5 }],
    ['notes', note, 'dismissed', { surface_condition: null }],
  ]) {
    const endpoint = '/api/' + table + '/' + record.id;
    const read = () => ({ ...db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(record.id) });
    const expected_updated_at = String(record.updated_at);
    recordAccess(db, { [table]: [record.id] });
    const afterAccess = read();
    assert.equal(afterAccess.updated_at, record.updated_at);
    assert.equal(afterAccess.access_count, 1);
    for (const field of ['last_accessed_at', 'access_count']) {
      const attemptedEdit = await mutate('PATCH', endpoint, { ...change, expected_updated_at, [field]: 5 });
      assert.equal(attemptedEdit.status, 400, attemptedEdit.text);
      assert.deepEqual(attemptedEdit.json, { error: 'Unexpected field' });
      assert.deepEqual(read(), afterAccess);
    }
    const invalid = await mutate('PATCH', endpoint, { ...change, expected_updated_at: record.updated_at });
    assert.equal(invalid.status, 400, invalid.text);
    assert.equal((await mutate('PATCH', endpoint, { ...change, expected_updated_at: ' ' })).status, 400);
    const quickAction = await mutate('PATCH', endpoint, { expected_updated_at, status, ...(table === 'notes' ? { comment: 'Fixture transition' } : {}) });
    assert.equal(quickAction.status, 200, quickAction.text);
    const afterStatus = read();
    assert.equal(afterStatus.status, status);
    assert.ok(afterStatus.updated_at > record.updated_at);

    const stale = await mutate('PATCH', endpoint, { ...change, expected_updated_at });
    assert.equal(stale.status, 409, stale.text);
    assert.deepEqual(stale.json, staleMessage);
    assert.deepEqual(read(), afterStatus);

    const applied = await mutate('PATCH', endpoint, { ...change, expected_updated_at: String(afterStatus.updated_at) });
    assert.equal(applied.status, 200, applied.text);
    const afterEdit = read();
    assert.deepEqual(afterEdit, { ...afterStatus, ...change, updated_at: afterEdit.updated_at });
    assert.ok(afterEdit.updated_at > afterStatus.updated_at);
    assert.equal((await mutate('PATCH', endpoint, change)).status, 200);
    assert.equal(read().status, status);
  }
});

test('memory PATCH rejects explicit superseding and supports editing and restoring superseded memories', async (t) => {
  const { cwd, db, mutate } = await fixture(t);
  const { memory } = await writeMemory(db, { cwd, content: 'Original fixture memory' });
  const { memory: successor } = await writeMemory(db, { cwd, content: 'Replacement fixture memory' });
  const endpoint = '/api/memories/' + memory.id;
  const read = () => db.prepare('SELECT * FROM memories WHERE id = ?').get(memory.id);
  const before = read();
  assert.equal(before.status, 'active');

  const rejected = await mutate('PATCH', endpoint, { status: 'superseded' });
  assert.equal(rejected.status, 400, rejected.text);
  assert.deepEqual(rejected.json, { error: 'Memories cannot be marked superseded manually.' });
  assert.deepEqual(read(), before);

  archiveMemory(db, { id: memory.id, superseded_by: successor.id });
  const edited = await mutate('PATCH', endpoint, { importance: 5 });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.memory.importance, 5);
  assert.equal(edited.json.memory.status, 'superseded');
  assert.equal(edited.json.memory.superseded_by, successor.id);

  const restored = await mutate('PATCH', endpoint, { status: 'active' });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(read().status, 'active');
  assert.equal(read().superseded_by, null);
});

test('notes filter, edit, dismiss, restore and delete', async (t) => {
  const { cwd, db, projectKey, request, mutate } = await fixture(t);
  const note = writeNote(db, { cwd, content: 'Original note', status: 'pending', surface_condition: 'on start' });
  const endpoint = '/api/notes/' + note.id;
  const listing = '/api/notes?project_key=' + encodeURIComponent(projectKey);
  assert.equal((await request(listing + '&status=active')).json.notes.length, 0);
  assert.equal((await request(listing + '&status=pending')).json.notes[0].surface_condition, 'on start');
  for (const patch of [{ surface_condition: 1 }, { content: '' }, { status: 'archived' }]) {
    assert.equal((await mutate('PATCH', endpoint, patch)).status, 400);
  }
  const edited = await mutate('PATCH', endpoint, { content: 'Edited note', surface_condition: null, status: 'dismissed', comment: 'Fixture dismissed' });
  assert.equal(edited.json.note.content, 'Edited note');
  assert.equal(edited.json.note.surface_condition, null);
  assert.equal((await request(listing + '&status=dismissed')).json.notes[0].id, note.id);
  assert.equal((await mutate('PATCH', endpoint, { status: 'active', comment: 'Fixture restored' })).json.note.status, 'active');
  assert.deepEqual((await mutate('DELETE', endpoint)).json, { deleted: true, id: note.id });
  assert.equal((await request(listing + '&status=all')).json.notes.length, 0);
  assert.equal((await mutate('PATCH', endpoint, { status: 'active' })).status, 404);
  assert.equal((await mutate('DELETE', endpoint)).status, 404);
});

test('note cursors page through tied timestamps and reject malformed boundaries', async (t) => {
  const { db, projectKey, request } = await fixture(t);
  const insert = db.prepare(`
    INSERT INTO notes (id, project_key, status, content, created_at, updated_at)
    VALUES (?, ?, ?, 'Note fixture', 1, ?)
  `);
  const ids = Array.from({ length: 105 }, (_, i) => 'fixture-' + String(i).padStart(3, '0'));
  for (const [i, id] of ids.entries()) insert.run(id, projectKey, 'active', i < 12 ? 1 : 2);
  insert.run('other-project', 'other', 'active', 2);
  insert.run('pending-note', projectKey, 'pending', 2);
  const listing = '/api/notes?project_key=' + encodeURIComponent(projectKey) + '&status=active';
  for (const size of [100, 17]) {
    const url = listing + (size === 100 ? '' : '&limit=' + size);
    const actual = [];
    let cursor = null;
    for (let page = 0; page < Math.ceil(ids.length / size); page++) {
      const response = await request(url + (cursor ? '&cursor=' + cursor : ''));
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.notes.length, Math.min(size, ids.length - actual.length));
      actual.push(...response.json.notes.map(({ id }) => id));
      cursor = response.json.next_cursor;
      if (actual.length < ids.length) assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    }
    assert.equal(cursor, null);
    assert.deepEqual(actual, ids.toReversed());
  }

  for (const cursor of ['', 'not!base64', Buffer.from('["2","fixture-001"]').toString('base64url'),
    Buffer.from('[2,""]').toString('base64url')]) {
    const response = await request(listing + '&cursor=' + encodeURIComponent(cursor));
    assert.equal(response.status, 400, response.text);
    assert.deepEqual(response.json, { error: 'Invalid cursor' });
  }
});

test('dashboard CLI dry run uses restricted arguments in an empty temporary directory', async (t) => {
  const { cwd, db, dbPath, projectKey, userConfigPath, request, mutate } = await fixture(t);
  const { memory } = await writeMemory(db, { cwd, content: 'Keep this fixture memory' });
  const script = path.join(cwd, 'cli-fixture.mjs');
  await writeFile(script, `
    import { readdirSync } from 'node:fs';
    console.log(JSON.stringify({
      summary: JSON.stringify({ cwd: process.cwd(), files: readdirSync('.'), args: process.argv.slice(2, -1) }),
      operations: [{ type: 'archive', id: ${JSON.stringify(memory.id)}, reason: 'Fixture proposal' }],
    }));
  `);
  await writeFile(userConfigPath, JSON.stringify({
    dbPath,
    dreamer: { enabled: true, mode: 'cli', cli: {
      orchestrator: 'codex', command: process.execPath,
      args: [script, '--cd', cwd, '--sandbox', 'danger-full-access', '--enable', 'shell_tool'],
    } },
  }));
  const info = await request('/api/dreamer');
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.config.authorized, true);
  const read = () => db.prepare('SELECT * FROM memories ORDER BY id').all();
  const before = read();
  const response = await mutate('POST', '/api/dreamer/run', {
    project_key: projectKey, dry_run: true, expected_config_fingerprint: info.json.config.config_fingerprint,
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.status, 'dry-run');
  assert.equal(response.json.memoriesArchived, 1);
  const invocation = JSON.parse(response.json.summary);
  assert.notEqual(invocation.cwd, await realpath(cwd));
  assert.equal(await realpath(path.dirname(invocation.cwd)), await realpath(os.tmpdir()));
  assert.match(path.basename(invocation.cwd), /^msm-dream-/);
  assert.deepEqual(invocation.files, []);
  assert.deepEqual(invocation.args, [
    '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '--ignore-rules', '-c', 'mcp_servers={}', '-c', 'features.shell_tool=false',
  ]);
  await assert.rejects(access(invocation.cwd), { code: 'ENOENT' });
  assert.deepEqual(read(), before);
  assert.equal(db.prepare('SELECT status FROM dream_runs WHERE id = ?').get(response.json.runId).status, 'dry-run');
});

test('Dreamer reports disabled and validates manual run input', async (t) => {
  const { projectKey, request, mutate } = await fixture(t);
  assert.equal((await request('/api/dreamer')).json.config.enabled, false);
  const endpoint = '/api/dreamer/run';
  for (const body of [{}, { project_key: 'global' }, { project_key: '' }, { project_key: projectKey, dry_run: 'true' }]) {
    assert.equal((await mutate('POST', endpoint, body)).status, 400);
  }
  const result = await mutate('POST', endpoint, { project_key: projectKey, dry_run: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { projectKey, skipped: true, reason: 'disabled' });
});

test('dashboard can browse global data outside Git and exposes no runnable Dreamer project', async (t) => {
  const { request, mutate } = await fixture(t, { gitWorkspace: false, dreamer: {
    enabled: true, mode: 'http', http: { baseUrl: 'https://runner.example.test/v1', model: 'fixture' },
  } });
  const overview = await request('/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.default_project_key, null);
  const status = await request('/api/dreamer');
  assert.equal(status.status, 200);
  assert.equal(status.json.runnable_project_key, null);
  assert.equal(status.json.config.authorized, false);
  assert.equal((await mutate('POST', '/api/dreamer/run', { project_key: 'example.test/owner/repo' })).status, 400);
});

test('scope-only memory PATCH outside Git keeps an existing project and requires a destination for global memories', async (t) => {
  const { cwd, db, mutate, projectKey } = await fixture(t, { gitWorkspace: false });
  assert.equal(projectKey, null);
  const repo = path.join(cwd, 'project');
  await mkdir(repo);
  initGit(repo);
  const { memory: projectMemory } = await writeMemory(db, { cwd: repo, content: 'Project fixture', importance: 2 });
  const updated = await mutate('PATCH', '/api/memories/' + projectMemory.id, { scope: 'project', importance: 4 });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.memory.scope, 'project');
  assert.equal(updated.json.memory.project_key, projectMemory.project_key);
  assert.equal(updated.json.memory.importance, 4);
  const stored = db.prepare('SELECT project_key, importance FROM memories WHERE id = ?').get(projectMemory.id);
  assert.equal(stored.project_key, projectMemory.project_key);
  assert.equal(stored.importance, 4);

  const { memory } = await writeMemory(db, { content: 'Global fixture', scope: 'global' });
  const response = await mutate('PATCH', '/api/memories/' + memory.id, { scope: 'project' });
  assert.equal(response.status, 400, response.text);
  assert.match(response.json.error, /Select a project destination/);
  assert.equal(db.prepare('SELECT project_key FROM memories WHERE id = ?').get(memory.id).project_key, 'global');
});

test('Dreamer rejects unknown checkouts and uses the launch workspace settings by default', async (t) => {
  let runnerCalls = 0;
  const runner = createServer((req, res) => {
    runnerCalls++;
    req.resume();
    res.writeHead(204).end();
  });
  t.after(() => new Promise((resolve, reject) => runner.close((error) => error ? reject(error) : resolve())));
  runner.listen(0, '127.0.0.1');
  await once(runner, 'listening');
  const dreamer = {
    enabled: true, mode: 'http',
    http: { baseUrl: 'http://127.0.0.1:' + runner.address().port, model: 'fixture-model' },
  };
  const { cwd, db, projectKey, userConfigPath, request, mutate } = await fixture(t, { dreamer });
  const otherCwd = path.join(cwd, 'other-workspace');
  await mkdir(otherCwd);
  initGit(otherCwd);
  writeProjectConfig(userConfigPath, otherCwd, { dreamer: { enabled: false } });
  const { projectKey: otherProjectKey } = resolveProjectKey(otherCwd);
  assert.notEqual(otherProjectKey, projectKey);
  assert.equal(loadConfig({ cwd: otherCwd, userConfigPath, env: {} }).dreamer.enabled, false);

  const info = await request('/api/dreamer');
  assert.equal(info.status, 200);
  assert.equal(info.json.runnable_project_key, projectKey);
  assert.equal(info.json.config.enabled, true);
  const otherHistory = await request('/api/dreamer?project_key=' + encodeURIComponent(otherProjectKey));
  assert.equal(otherHistory.status, 200);
  assert.equal(otherHistory.json.runnable_project_key, null);
  for (const dry_run of [false, true]) {
    const response = await mutate('POST', '/api/dreamer/run', { project_key: otherProjectKey, dry_run });
    assert.equal(response.status, 400);
    assert.match(response.json.error, /known local checkout/);
  }

  writeProjectConfig(userConfigPath, cwd, { dreamer: { enabled: false } });
  const disabledInfo = await request('/api/dreamer');
  assert.equal(disabledInfo.status, 200, disabledInfo.text);
  assert.equal(disabledInfo.json.config.enabled, false);
  assert.notEqual(disabledInfo.json.config.config_fingerprint, info.json.config.config_fingerprint);
  const disabled = await mutate('POST', '/api/dreamer/run', { project_key: projectKey, dry_run: true });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.json, { projectKey, skipped: true, reason: 'disabled' });
  assert.equal(runnerCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dream_runs').get().count, 0);
});

test('global Dreamer preserves a registry-only checkout after using a configured checkout and restarting', async (t) => {
  const models = [];
  const runner = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    models.push(JSON.parse(Buffer.concat(chunks)).model);
    const content = JSON.stringify({ summary: 'Fixture plan', operations: [] });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content } }],
    }));
  });
  runner.listen(0, '127.0.0.1');
  await once(runner, 'listening');
  t.after(() => new Promise((resolve, reject) => runner.close((error) => error ? reject(error) : resolve())));

  const { cwd, db, dbPath, request, mutate, userConfigPath, restart } = await fixture(t, { globalMode: true });
  const projectKey = 'example.test/owner/shared';
  const anotherKey = 'example.test/owner/another';
  const missingKey = 'example.test/owner/missing';
  async function checkout(name, key) {
    const root = path.join(cwd, name);
    await mkdir(root);
    initGit(root);
    fixtureGit(root, 'remote', 'add', 'origin', 'https://' + key + '.git');
    return normalizePath(root);
  }
  const registered = await checkout('registered', projectKey);
  const configured = await checkout('configured', projectKey);
  const unlisted = await checkout('unlisted', projectKey);
  const another = await checkout('another', anotherKey);
  const missing = path.join(cwd, 'removed');
  const nonRoot = path.join(configured, 'subdir');
  await mkdir(nonRoot);
  const register = db.prepare('INSERT INTO projects (project_key, project_root, updated_at) VALUES (?, ?, ?)');
  register.run(projectKey, registered, Date.now());
  register.run(missingKey, missing, Date.now());
  const dreamer = {
    enabled: true, mode: 'http',
    http: { baseUrl: 'http://127.0.0.1:' + runner.address().port + '/v1', model: 'default-model' },
  };
  writeConfig(userConfigPath, {
    dbPath,
    dreamer,
    projects: {
      [projectKey]: { checkouts: [configured, another, missing, nonRoot], dreamer: { http: { model: 'shared-model' } } },
      [anotherKey]: { checkouts: [another] },
    },
  });
  const configBeforeRun = await readFile(userConfigPath, 'utf8');

  const overview = await request('/api/overview');
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.json.default_project_key, null);
  assert.deepEqual(new Set(overview.json.projects.map(({ project_key }) => project_key)),
    new Set([projectKey, anotherKey, missingKey]));
  assert.ok(overview.json.projects.every((project) => !Object.hasOwn(project, 'checkouts')));
  assert.ok(!overview.text.includes(registered) && !overview.text.includes(configured));

  const endpoint = '/api/dreamer/run';
  const status = async (key) => request('/api/dreamer?project_key=' + encodeURIComponent(key));
  const info = await status(projectKey);
  assert.equal(info.status, 200, info.text);
  assert.deepEqual(info.json.checkouts, [registered, configured]);
  assert.deepEqual((await status(anotherKey)).json.checkouts, [another]);
  assert.equal(info.json.config.runner.model, 'shared-model');
  for (const checkout of [another, missing, unlisted, nonRoot]) {
    assert.equal((await mutate('POST', endpoint, { project_key: projectKey, checkout, dry_run: true })).status, 400);
  }
  assert.equal((await mutate('POST', endpoint, { project_key: missingKey, dry_run: true })).status, 400);
  assert.deepEqual(models, []);

  const response = await mutate('POST', endpoint, {
    project_key: projectKey, checkout: configured, dry_run: true,
    expected_config_fingerprint: info.json.config.config_fingerprint,
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.status, 'dry-run');
  assert.deepEqual((await status(projectKey)).json.checkouts, [configured, registered]);
  const defaultRun = await mutate('POST', endpoint, { project_key: anotherKey, dry_run: true });
  assert.equal(defaultRun.status, 200, defaultRun.text);
  assert.equal(defaultRun.json.status, 'dry-run');
  assert.deepEqual(models, ['shared-model', 'default-model']);

  const reopenedDb = await restart({});
  assert.equal(reopenedDb.prepare('SELECT project_root FROM projects WHERE project_key = ?').get(projectKey).project_root,
    registered);
  const checkoutState = JSON.parse(await readFile(dbPath + '.dreamer-checkouts.json', 'utf8'));
  assert.equal(checkoutState[projectKey].lastCheckout, configured);
  assert.deepEqual(new Set(checkoutState[projectKey].checkouts), new Set([registered, configured]));
  assert.equal(await readFile(userConfigPath, 'utf8'), configBeforeRun);
  assert.deepEqual((await status(projectKey)).json.checkouts, [configured, registered]);

  await rm(configured, { recursive: true, force: true });
  assert.deepEqual((await status(projectKey)).json.checkouts, [registered]);
  assert.equal((await mutate('POST', endpoint, { project_key: projectKey, checkout: configured, dry_run: true })).status, 400);
});

test('overview includes a YAML-only project with no checkout on disk', async (t) => {
  const { cwd, db, dbPath, request, userConfigPath } = await fixture(t, { globalMode: true });
  const projectKey = 'example.test/owner/yaml-only';
  const missing = path.join(cwd, 'missing-checkout');
  writeConfig(userConfigPath, { dbPath, projects: { [projectKey]: { checkouts: [missing] } } });
  assert.equal(db.prepare('SELECT 1 FROM projects WHERE project_key = ?').get(projectKey), undefined);

  const overview = await request('/api/overview');
  assert.equal(overview.status, 200, overview.text);
  const project = overview.json.projects.find(({ project_key }) => project_key === projectKey);
  assert.equal(project?.display_name, 'yaml-only');
  assert.ok(!Object.hasOwn(project, 'checkouts'));
  assert.ok(!overview.text.includes('missing-checkout'));

  const info = await request('/api/dreamer?project_key=' + encodeURIComponent(projectKey));
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.project_key, projectKey);
  assert.equal(info.json.runnable_project_key, null);
  assert.deepEqual(info.json.checkouts, []);
});

test('Dreamer uses fresh authorization, redacts secrets, and records a dry run without applying it', async (t) => {
  const secret = 'example-test-credential-for-dashboard';
  const env = { OPENAI_API_KEY: secret };
  let reply;
  const received = [];
  const runner = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    received.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  t.after(() => new Promise((resolve, reject) => runner.close((error) => error ? reject(error) : resolve())));
  runner.listen(0, '127.0.0.1');
  await once(runner, 'listening');
  const endpointHost = '127.0.0.1:' + runner.address().port;
  const dreamer = {
    enabled: true, mode: 'http',
    http: { baseUrl: 'http://' + endpointHost + '/v1?credential=' + secret, model: 'fixture-model', apiKeyEnv: 'OPENAI_API_KEY' },
  };
  const originalDreamer = { ...dreamer, http: { ...dreamer.http, baseUrl: 'https://previous-runner.invalid/v1' } };
  const { cwd, db, dbPath, projectKey, userConfigPath, request, mutate, restart } = await fixture(t, {
    dreamer: originalDreamer, env,
  });
  const { memory } = await writeMemory(db, { cwd, content: 'Review this fixture memory' });
  const signedUrl = 'https://bucket.example.com/obj?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    + '&X-Amz-Signature=deadbeef123456&X-Amz-Credential=fixture-credential';
  reply = {
    summary: 'Confirmed ' + secret + ' at https://plan-user@fixture.invalid?access_token=plan-token&label=public ' + signedUrl
      + " GET '/obj?X-Amz-Signature=fixture-signature' //plan-user:plan-pass@bucket.example.com/obj?token=fixture-token"
      + ' GET `/obj?X-Amz-Signature=fixture-backtick-signature`'
      + ' See /var/log/dreamer //comment',
    operations: [{ type: 'archive', id: memory.id, reason: 'Review ' + secret }],
  };
  const expectedSummary = 'Confirmed [redacted] at https://[REDACTED]@fixture.invalid?access_token=[REDACTED]&label=[REDACTED]'
    + ' https://bucket.example.com/obj?X-Amz-Algorithm=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]'
    + " GET '/obj?X-Amz-Signature=[REDACTED]' //[REDACTED]@bucket.example.com/obj?token=[REDACTED]"
    + ' GET `/obj?X-Amz-Signature=[REDACTED]`'
    + ' See /var/log/dreamer //comment';
  const original = await request('/api/dreamer');
  assert.equal(original.status, 200, original.text);
  assert.equal(original.json.config.runner.endpoint_host, 'previous-runner.invalid');
  assert.match(original.json.config.config_fingerprint, /^[a-f0-9]{64}$/);
  await writeFile(userConfigPath, JSON.stringify({ dbPath, dreamer }));

  const lease = 'dream:' + projectKey;
  const leasedAt = Date.now();
  assert.equal(acquireLease(db, lease, 'fixture-owner', 60_000, leasedAt), true);
  acquireLease(db, 'dream:expired', 'fixture-owner', 1, leasedAt - 100);
  acquireLease(db, 'index:fixture', 'fixture-owner', 60_000, leasedAt);
  const endpoint = '/api/dreamer/run';
  const body = { project_key: projectKey, dry_run: true };
  const info = await request('/api/dreamer');
  assert.equal(info.status, 200);
  assert.notEqual(info.json.config.config_fingerprint, original.json.config.config_fingerprint);
  assert.equal(info.json.config.config_fingerprint, (await request('/api/dreamer')).json.config.config_fingerprint);
  assert.deepEqual(info.json.active_leases, [{
    lease_key: lease, project_key: projectKey, owner: 'fixture-owner', acquired_at: leasedAt, expires_at: leasedAt + 60_000,
  }]);
  assert.deepEqual(info.json.config.runner, {
    type: 'http', model: 'fixture-model', endpoint_host: endpointHost, executable: null, api_key_configured: true,
  });
  assert.ok(!info.text.includes(secret));
  assert.ok(!info.text.includes('OPENAI_API_KEY'));
  assert.ok(!info.text.includes('?credential='));
  assert.equal((await mutate('POST', endpoint, body)).json.reason, 'lease-held');
  releaseLease(db, lease, 'fixture-owner');
  const invalidFingerprint = await mutate('POST', endpoint, { ...body, expected_config_fingerprint: true });
  assert.equal(invalidFingerprint.status, 400, invalidFingerprint.text);
  const stale = await mutate('POST', endpoint, { ...body, expected_config_fingerprint: original.json.config.config_fingerprint });
  assert.equal(stale.status, 409, stale.text);
  assert.deepEqual(stale.json, { error: 'Dreamer configuration changed; refresh before running.' });
  assert.equal(received.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dream_runs').get().count, 0);

  await writeFile(path.join(cwd, '.multi-sub-memory.jsonc'), JSON.stringify({ dreamer }));
  await writeFile(userConfigPath, '{}');
  const unauthorized = await request('/api/dreamer');
  assert.equal(unauthorized.status, 200, unauthorized.text);
  assert.equal(unauthorized.json.config.authorized, false);
  assert.notEqual(unauthorized.json.config.config_fingerprint, info.json.config.config_fingerprint);
  const revoked = await mutate('POST', endpoint, { ...body, expected_config_fingerprint: info.json.config.config_fingerprint });
  assert.equal(revoked.status, 409, revoked.text);
  const disabled = await mutate('POST', endpoint, body);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.reason, 'disabled');
  assert.equal(received.length, 0);
  await writeFile(userConfigPath, JSON.stringify({ dbPath, dreamer }));

  const result = await mutate('POST', endpoint, { ...body, expected_config_fingerprint: info.json.config.config_fingerprint });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.status, 'dry-run');
  assert.equal(result.json.memoriesArchived, 1);
  assert.equal(result.json.summary, expectedSummary);
  assert.ok(!result.text.includes(secret));
  assert.equal(received.length, 1);
  assert.equal(new URL(received[0].url, 'http://' + endpointHost).pathname, '/v1/chat/completions');
  assert.equal(received[0].authorization, 'Bearer ' + secret);
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(memory.id).status, 'active');
  const legacyUrl = 'https://old-user:old-pass@example.invalid/v1?format=json&AcCeSs_ToKeN=rotated-legacy-token'
    + '&%61pi_key=rotated-api-key&session_id=rotated-session#result';
  const legacySignedUrl = 'https://legacy.example.com/obj?X-Goog-Signature=old-signature&%ZZ=opaque-value#object';
  const legacyText = 'Bearer old-bearer-value, ' + legacyUrl + ', ' + legacySignedUrl + ', '
    + 'sk-legacy-test-token, api_key=old-assignment-value, Authorization: Basic dXNlcjpzZWNyZXQ=, '
    + 'Basic dGVzdDpmaXh0dXJl, Token old-token-value, Authorization: Custom old-custom-value '
    + 'GET /obj?X-Amz-Signature=old-target-signature //old-user:old-pass@legacy.example.com/obj?X-Amz-Signature=old-rel-sig'
    + ' GET `/obj?X-Amz-Signature=old-backtick-signature`';
  db.prepare(`
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, summary, error)
    VALUES ('legacy', ?, 'http', 'failed', 1, ?, ?)
  `).run(projectKey, legacyText, legacyText);
  const reopenedDb = await restart({ OPENAI_API_KEY: 'rotated-example-test-credential' });
  const storedRun = reopenedDb.prepare('SELECT * FROM dream_runs WHERE id = ?').get(result.json.runId);
  assert.ok(!JSON.stringify(storedRun).includes(secret));
  assert.equal(storedRun.summary, expectedSummary);
  const history = await request('/api/dreamer?project_key=' + encodeURIComponent(projectKey));
  assert.equal(history.status, 200);
  assert.ok(!history.text.includes(secret));
  assert.equal(history.json.active_leases.length, 0);
  const dryRun = history.json.runs.find((run) => run.id === result.json.runId);
  assert.equal(dryRun.status, 'dry-run');
  assert.equal(dryRun.summary, storedRun.summary);
  assert.ok(history.json.runs.some(({ id, status }) => id !== 'legacy' && status === 'dry-run'));
  const legacy = history.json.runs.find(({ id }) => id === 'legacy');
  const sanitized = 'Bearer [redacted], https://[REDACTED]@example.invalid/v1?format=[REDACTED]&AcCeSs_ToKeN=[REDACTED]'
    + '&%61pi_key=[REDACTED]&session_id=[REDACTED]#result, '
    + 'https://legacy.example.com/obj?X-Goog-Signature=[REDACTED]&%ZZ=[REDACTED]#object, [redacted], api_key=[redacted], '
    + 'Authorization: [redacted], Basic [redacted], Token [redacted], Authorization: [redacted] '
    + 'GET /obj?X-Amz-Signature=[REDACTED] //[REDACTED]@legacy.example.com/obj?X-Amz-Signature=[REDACTED]'
    + ' GET `/obj?X-Amz-Signature=[REDACTED]`';
  assert.equal(legacy.summary, sanitized);
  assert.equal(legacy.error, sanitized);
});

test('memories, notes, and dreamer endpoints support sorting and dreamer status filtering', async (t) => {
  const { db, projectKey, request } = await fixture(t);
  const insertMemory = db.prepare(`
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, importance, status, created_at, updated_at)
    VALUES (?, ?, 'project', 'GENERAL', ?, ?, ?, 'active', ?, ?)
  `);
  insertMemory.run('m1', projectKey, 'First memory', hashNormalizedContent('First memory'), 2, 100, 300);
  insertMemory.run('m2', projectKey, 'Second memory', hashNormalizedContent('Second memory'), 5, 200, 200);
  insertMemory.run('m3', projectKey, 'Third memory', hashNormalizedContent('Third memory'), 3, 300, 100);

  assert.deepEqual((await request('/api/memories?sort=importance&order=asc')).json.memories.map(({ id }) => id), ['m1', 'm3', 'm2']);
  assert.deepEqual((await request('/api/memories?sort=created_at&order=desc')).json.memories.map(({ id }) => id), ['m3', 'm2', 'm1']);
  assert.deepEqual((await request('/api/memories?sort=updated_at&order=desc')).json.memories.map(({ id }) => id), ['m1', 'm2', 'm3']);
  assert.equal((await request('/api/memories?sort=bogus')).status, 400);
  assert.equal((await request('/api/memories?order=sideways')).status, 400);

  const insertNote = db.prepare(`
    INSERT INTO notes (id, project_key, status, content, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, ?)
  `);
  insertNote.run('n1', projectKey, 'First note', 100, 300);
  insertNote.run('n2', projectKey, 'Second note', 200, 200);
  insertNote.run('n3', projectKey, 'Third note', 300, 100);

  const page1 = await request('/api/notes?status=active&sort=created_at&order=asc&limit=2');
  assert.deepEqual(page1.json.notes.map(({ id }) => id), ['n1', 'n2']);
  assert.ok(page1.json.next_cursor);
  const page2 = await request('/api/notes?status=active&sort=created_at&order=asc&limit=2&cursor=' + page1.json.next_cursor);
  assert.deepEqual(page2.json.notes.map(({ id }) => id), ['n3']);
  assert.equal(page2.json.next_cursor, null);
  assert.deepEqual((await request('/api/notes?status=active&sort=updated_at&order=asc')).json.notes.map(({ id }) => id), ['n3', 'n2', 'n1']);
  assert.equal((await request('/api/notes?sort=bogus')).status, 400);

  const insertRun = db.prepare(`
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at, summary, error)
    VALUES (?, ?, 'http', ?, ?, ?, ?, ?)
  `);
  insertRun.run('r1', projectKey, 'completed', 1000, 9000, 'Slow run', null);
  insertRun.run('r2', projectKey, 'failed', 2000, 4000, null, 'Quick failure');
  insertRun.run('r3', projectKey, 'running', 3000, null, null, null);

  assert.deepEqual((await request('/api/dreamer?status=failed')).json.runs.map(({ id }) => id), ['r2']);
  assert.deepEqual((await request('/api/dreamer?sort=started_at&order=asc')).json.runs.map(({ id }) => id), ['r1', 'r2', 'r3']);
  assert.deepEqual((await request('/api/dreamer?sort=finished_at&order=desc')).json.runs.map(({ id }) => id), ['r1', 'r2', 'r3']);
  assert.deepEqual((await request('/api/dreamer?sort=finished_at&order=asc')).json.runs.map(({ id }) => id), ['r2', 'r1', 'r3']);
  assert.deepEqual((await request('/api/dreamer?sort=duration&order=desc')).json.runs.map(({ id }) => id), ['r1', 'r2', 'r3']);
  assert.deepEqual((await request('/api/dreamer?sort=duration&order=asc')).json.runs.map(({ id }) => id), ['r2', 'r1', 'r3']);
  assert.equal((await request('/api/dreamer?status=bogus')).status, 400);
  assert.equal((await request('/api/dreamer?sort=bogus')).status, 400);
});

test('memories expose project provenance and can move between projects or promote to global', async (t) => {
  const { db, cwd, projectKey, request, mutate } = await fixture(t);
  const otherCwd = path.join(path.dirname(cwd), 'other-app');
  await mkdir(otherCwd, { recursive: true });
  initGit(otherCwd);
  const { memory: projectMem } = await writeMemory(db, {
    content: 'Project memory to move', category: 'ARCHITECTURE', importance: 4,
  }, { defaultCwd: cwd });
  const { memory: otherMem } = await writeMemory(db, {
    content: 'Already in other project', category: 'GENERAL', importance: 3, cwd: otherCwd,
  }, { defaultCwd: cwd });
  const { memory: globalMem } = await writeMemory(db, {
    content: 'Existing global memory', scope: 'global', category: 'WORKFLOW', importance: 5,
  }, { defaultCwd: cwd });

  const listed = await request('/api/memories');
  assert.equal(listed.status, 200);
  const listedProject = listed.json.memories.find(({ id }) => id === projectMem.id);
  const listedGlobal = listed.json.memories.find(({ id }) => id === globalMem.id);
  assert.equal(listedProject.project_name, path.basename(cwd));
  assert.equal(listedProject.project_root, resolveProjectKey(cwd).projectRoot);
  assert.equal(listedGlobal.project_name, 'Global');
  assert.equal(listedGlobal.project_root, null);

  // Move project memory to another project.
  const moved = await mutate('PATCH', '/api/memories/' + projectMem.id, {
    scope: 'project',
    project_key: otherMem.project_key,
    expected_updated_at: String(projectMem.updated_at),
  });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.memory.scope, 'project');
  assert.equal(moved.json.memory.project_key, otherMem.project_key);
  assert.equal(moved.json.memory.project_name, 'other-app');
  assert.equal(moved.json.memory.project_root, resolveProjectKey(otherCwd).projectRoot);

  // Promote to global.
  const promoted = await mutate('PATCH', '/api/memories/' + projectMem.id, {
    scope: 'global',
    project_key: 'global',
    expected_updated_at: String(moved.json.memory.updated_at),
  });
  assert.equal(promoted.status, 200, promoted.text);
  assert.equal(promoted.json.memory.scope, 'global');
  assert.equal(promoted.json.memory.project_key, 'global');
  assert.equal(promoted.json.memory.project_name, 'Global');
  assert.equal(promoted.json.memory.project_root, null);

  // Demote global back to original project.
  const demoted = await mutate('PATCH', '/api/memories/' + projectMem.id, {
    scope: 'project',
    project_key: projectKey,
    expected_updated_at: String(promoted.json.memory.updated_at),
  });
  assert.equal(demoted.status, 200, demoted.text);
  assert.equal(demoted.json.memory.scope, 'project');
  assert.equal(demoted.json.memory.project_key, projectKey);

  // Reject invalid scope/project_key combinations.
  const badGlobal = await mutate('PATCH', '/api/memories/' + projectMem.id, {
    scope: 'global',
    project_key: otherMem.project_key,
    expected_updated_at: String(demoted.json.memory.updated_at),
  });
  assert.equal(badGlobal.status, 400);
  const badProject = await mutate('PATCH', '/api/memories/' + projectMem.id, {
    scope: 'project',
    project_key: 'global',
    expected_updated_at: String(demoted.json.memory.updated_at),
  });
  assert.equal(badProject.status, 400);

  // Reject duplicate content conflict in target project.
  const { memory: dupSource } = await writeMemory(db, {
    content: 'Already in other project', category: 'GENERAL', importance: 3,
  }, { defaultCwd: cwd });
  const conflict = await mutate('PATCH', '/api/memories/' + dupSource.id, {
    scope: 'project',
    project_key: otherMem.project_key,
    expected_updated_at: String(dupSource.updated_at),
  });
  assert.equal(conflict.status, 409, conflict.text);
});

test('scope-only memory PATCH uses the launch fork and preserves existing project assignments', async (t) => {
  const { cwd, dbPath, userConfigPath, request, mutate, restart } = await fixture(t);
  fixtureGit(cwd, 'remote', 'add', 'upstream', 'https://example.test/Team/Repo.git');
  fixtureGit(cwd, 'remote', 'add', 'origin', 'https://example.test:8443/Fork/Repo.git');
  const forkKey = 'example.test:8443/Fork/Repo';
  const upstreamKey = 'example.test/Team/Repo';
  writeConfig(userConfigPath, { dbPath, embedding: { enabled: false }, projects: { [forkKey]: { forkMode: 'origin' } } });
  const db = await restart({});
  assert.equal((await request('/api/overview')).json.default_project_key, forkKey);
  const { memory } = await writeMemory(db, { content: 'Global fixture to move', scope: 'global' });
  const response = await mutate('PATCH', '/api/memories/' + memory.id, { scope: 'project' });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.memory.project_key, forkKey);
  assert.equal(response.json.memory.project_root, resolveProjectKey(cwd).projectRoot);
  assert.equal(db.prepare('SELECT project_key FROM memories WHERE id = ?').get(memory.id).project_key, forkKey);

  const { memory: upstream } = await writeMemory(db, { content: 'Existing upstream fixture', cwd });
  assert.equal(upstream.project_key, upstreamKey);
  const existing = await mutate('PATCH', '/api/memories/' + upstream.id, { scope: 'project' });
  assert.equal(existing.status, 200, existing.text);
  assert.equal(existing.json.memory.project_key, upstreamKey);
});

test('memory PATCH rejects unknown project destinations without moving the memory', async (t) => {
  const { db, cwd, projectKey, request, mutate } = await fixture(t);
  const { memory } = await writeMemory(db, { content: 'Keep in this project' }, { defaultCwd: cwd });
  const endpoint = '/api/memories/' + memory.id;
  for (const destination of [cwd, 'all', 'example.test/unknown/repo']) {
    const response = await mutate('PATCH', endpoint, { scope: 'project', project_key: destination });
    assert.equal(response.status, 400, response.text);
    assert.equal(response.json.error, 'Unknown project destination.');
  }
  const listed = await request('/api/memories');
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.memories.find(({ id }) => id === memory.id)?.project_key, projectKey);
});

test('a registered project stays in the overview after its last memory moves to global', async (t) => {
  const { db, cwd, projectKey, request, mutate } = await fixture(t);
  const otherCwd = path.join(cwd, 'other-app');
  await mkdir(otherCwd, { recursive: true });
  initGit(otherCwd);
  const { memory } = await writeMemory(db, { content: 'Only memory in the other project', cwd: otherCwd }, { defaultCwd: cwd });
  const otherKey = memory.project_key;
  assert.notEqual(otherKey, projectKey);
  const endpoint = '/api/memories/' + memory.id;

  const promoted = await mutate('PATCH', endpoint, { project_key: 'global' });
  assert.equal(promoted.status, 200, promoted.text);
  assert.equal(promoted.json.memory.scope, 'global');

  const overview = await request('/api/overview');
  assert.equal(overview.status, 200, overview.text);
  const otherProject = overview.json.projects.find(({ project_key }) => project_key === otherKey);
  assert.equal(otherProject?.display_name, 'other-app');
  assert.deepEqual(otherProject.memories, { active: 0, archived: 0, superseded: 0, total: 0 });
  assert.equal(overview.json.global.memories.total, 1);

  const restored = await mutate('PATCH', endpoint, { project_key: otherKey });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.memory.scope, 'project');
  assert.equal(restored.json.memory.project_key, otherKey);
  assert.equal(restored.json.memory.project_root, resolveProjectKey(otherCwd).projectRoot);

  const updatedOverview = await request('/api/overview');
  assert.equal(updatedOverview.status, 200, updatedOverview.text);
  assert.equal(updatedOverview.json.projects.find(({ project_key }) => project_key === otherKey)?.memories.active, 1);
  assert.equal(updatedOverview.json.global.memories.total, 0);

  // A project known only from a transcript_files row with project_root = NULL is also a valid move target.
  const transcriptOnlyKey = 'example.test/fixtures/transcript-only';
  db.prepare(`
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, project_root, mtime_ms, byte_offset, last_indexed_at)
    VALUES ('null-root.jsonl', 'codex', 'session-null-root', ?, NULL, 1, 0, 1)
  `).run(transcriptOnlyKey);
  const overviewWithTranscript = await request('/api/overview');
  assert.equal(overviewWithTranscript.status, 200, overviewWithTranscript.text);
  assert.ok(overviewWithTranscript.json.projects.some(({ project_key }) => project_key === transcriptOnlyKey));
  const movedToTranscriptOnly = await mutate('PATCH', endpoint, {
    project_key: transcriptOnlyKey,
    expected_updated_at: String(restored.json.memory.updated_at),
  });
  assert.equal(movedToTranscriptOnly.status, 200, movedToTranscriptOnly.text);
  assert.equal(movedToTranscriptOnly.json.memory.project_key, transcriptOnlyKey);
  assert.equal(movedToTranscriptOnly.json.memory.project_root, null);
});

test('dashboard pages comment chains and protects transition comments', async (t) => {
  const { db, cwd, request, mutate } = await fixture(t);
  const topic = writeNote(db, { cwd, content: 'Fixture topic', status: 'pending' });
  const other = writeNote(db, { cwd, content: 'Other topic' });
  const path = '/api/notes/' + topic.id;
  const comments = path + '/comments';
  assert.deepEqual((await request(comments)).json, { comments: [], next_cursor: null });
  for (const body of [{ status: 'active' }, { status: 'active', comment: ' \t ' }]) {
    assert.equal((await mutate('PATCH', path, body)).status, 400);
  }
  assert.equal((await request(comments)).json.comments.length, 0);
  const changed = await mutate('PATCH', path, { status: 'active', comment: 'Approved' });
  assert.equal(changed.status, 200, changed.text);
  const [transition] = (await request(comments)).json.comments;
  assert.deepEqual([transition.from_status, transition.to_status, transition.body], ['pending', 'active', 'Approved']);
  const immutable = await mutate('PATCH', comments + '/' + transition.id, { body: 'Rewrite' });
  assert.equal(immutable.status, 400);
  assert.match(immutable.json.error, /immutable/);
  const immutableDelete = await mutate('DELETE', comments + '/' + transition.id);
  assert.equal(immutableDelete.status, 400);
  assert.match(immutableDelete.json.error, /immutable/);
  assert.equal((await mutate('POST', comments, { body: ' \t ' })).status, 400);
  const body = 'Progress '.repeat(25);
  const appended = await mutate('POST', comments, { body });
  assert.equal(appended.status, 200, appended.text);
  const { note, comment } = appended.json;
  assert.ok(note.updated_at > changed.json.note.updated_at);
  assert.deepEqual([comment.from_status, comment.to_status], [null, null]);
  db.prepare('UPDATE note_comments SET created_at = ? WHERE id = ?')
    .run(transition.created_at + 1, comment.id);
  const { notes } = (await request('/api/notes')).json;
  assert.equal(notes[0].id, topic.id);
  assert.equal(notes[0].comment_count, 2);
  assert.equal(notes[0].latest_comment_preview, body.slice(0, 120) + '…');

  const page = (await request(comments + '?limit=1')).json;
  assert.equal(page.comments[0].id, comment.id);
  assert.ok(page.next_cursor);
  const last = (await request(comments + '?limit=1&cursor=' + page.next_cursor)).json;
  assert.equal(last.comments[0].id, transition.id);
  assert.equal(last.next_cursor, null);
  assert.equal((await request(comments + '?cursor=invalid')).status, 400);
  assert.equal((await mutate('PATCH', '/api/notes/' + other.id + '/comments/' + comment.id, { body: 'Wrong topic' })).status, 404);
  const editPath = comments + '/' + comment.id;
  const expected_updated_at = String(comment.updated_at);
  const edited = await mutate('PATCH', editPath, { body: 'Updated progress', expected_updated_at });
  assert.equal(edited.status, 200, edited.text);
  assert.ok(edited.json.comment.updated_at > comment.updated_at);
  assert.equal((await mutate('PATCH', editPath, { body: 'Stale edit', expected_updated_at })).status, 409);
  const updatedList = (await request('/api/notes')).json.notes;
  assert.equal(updatedList[0].updated_at, note.updated_at);
  assert.equal(updatedList[0].latest_comment_preview, 'Updated progress');

  assert.equal((await mutate('DELETE', '/api/notes/' + other.id + '/comments/' + comment.id)).status, 404);
  const staleDelete = await mutate('DELETE', editPath + '?expected_updated_at=' + expected_updated_at);
  assert.equal(staleDelete.status, 409);
  assert.equal((await request(comments)).json.comments.length, 2);
  const deleted = await mutate('DELETE', editPath + '?expected_updated_at=' + edited.json.comment.updated_at);
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.json, { deleted: true, id: comment.id });
  assert.deepEqual((await request(comments)).json.comments, [transition]);
  const afterDelete = (await request('/api/notes')).json.notes.find(({ id }) => id === topic.id);
  assert.equal(afterDelete.comment_count, 1);
  assert.equal(afterDelete.latest_comment_preview, 'Approved');
  assert.ok(afterDelete.updated_at > note.updated_at);
  assert.equal((await mutate('DELETE', editPath)).status, 404);

  assert.equal((await mutate('DELETE', path)).status, 200);
  assert.equal((await request(comments)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_comments').get().count, 0);
});

test('a note delete with a stale confirmation preserves the note and its new comment', async (t) => {
  const { db, dbPath, cwd, request, mutate } = await fixture(t);
  const { id } = writeNote(db, { cwd, content: 'Topic awaiting delete confirmation' });
  const path = '/api/notes/' + id;
  const [before] = (await request('/api/notes')).json.notes;
  assert.equal(before.comment_count, 0);
  const writer = openDatabase(dbPath);
  let appended;
  try {
    appended = addNoteComment(writer, { id, body: 'New progress since confirmation opened' });
  } finally {
    writer.close();
  }

  for (const query of ['?expected_updated_at=', '?expected_updated_at=1&expected_updated_at=2']) {
    assert.equal((await mutate('DELETE', path + query)).status, 400);
  }
  const stale = await mutate('DELETE', path + '?expected_updated_at=' + before.updated_at);
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.json.error, /modified by another writer/);
  const [fresh] = (await request('/api/notes')).json.notes;
  assert.equal(fresh.id, id);
  assert.equal(fresh.comment_count, 1);
  assert.equal(fresh.updated_at, appended.note.updated_at);
  assert.deepEqual((await request(path + '/comments')).json.comments, [{ ...appended.comment }]);

  const confirmed = await mutate('DELETE', path + '?expected_updated_at=' + fresh.updated_at);
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.deepEqual(confirmed.json, { deleted: true, id });
  assert.equal((await request(path + '/comments')).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_comments WHERE note_id = ?').get(id).count, 0);
});

test('dashboard lists scoped tag dictionaries and filters, validates, and clears memory tags', async (t) => {
  const { cwd, db, projectKey, request, mutate } = await fixture(t);
  const { memory: saved } = await writeMemory(db, { cwd, content: 'Searchable deployment', tags: ['Audit'] });
  const { memory: global } = await writeMemory(db, { scope: 'global', content: 'Searchable setup', tags: ['tools'] });
  assert.deepEqual((await request('/api/tags?project_key=' + encodeURIComponent(projectKey))).json, {
    tags: [{ tag: 'audit', description: '', count: 1 }],
  });
  assert.deepEqual((await request('/api/tags?project_key=global')).json, {
    tags: [{ tag: 'tools', description: '', count: 1 }],
  });
  assert.equal((await request('/api/tags?project_key=all')).status, 400);
  assert.equal((await request('/api/memories?tag=-bad')).status, 400);
  for (const suffix of ['', '&q=searchable']) {
    const { json } = await request('/api/memories?tag=Audit' + suffix);
    assert.deepEqual(json.memories.map(({ id, tags }) => ({ id, tags })), [{ id: saved.id, tags: ['audit'] }]);
  }
  const url = '/api/memories/' + saved.id;
  const invalid = await mutate('PATCH', url, { tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /at most 5/);
  const updated = await mutate('PATCH', url, { tags: ['CI_Checks', 'Security', 'CI checks'] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.memory.tags, ['ci-checks', 'security']);
  assert.deepEqual((await request('/api/memories?tag=ci-checks')).json.memories.map(({ id }) => id), [saved.id]);
  assert.deepEqual((await mutate('PATCH', url, { tags: [] })).json.memory.tags, []);
  assert.deepEqual((await request('/api/memories?tag=ci-checks')).json.memories, []);
  assert.deepEqual((await request('/api/memories?tag=tools')).json.memories.map(({ id }) => id), [global.id]);
});
