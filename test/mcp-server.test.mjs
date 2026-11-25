import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { estimateTokens, formatBootstrap } from '../src/bootstrap.mjs';
import { openDatabase } from '../src/db.mjs';
import { decodeFloat32Vector } from '../src/embeddings.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const toolNames = ['mem_bootstrap', 'mem_memory', 'mem_note'];
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-mcp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, { defaultCwd = tempDirectory(t), embeddingEngine, config } = {}) {
  const db = openDatabase(':memory:');
  const server = createMcpServer({ db, config, defaultCwd, embeddingEngine });
  const client = new Client({ name: 'fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    try {
      await client.close();
      await server.close();
    } finally {
      db.close();
    }
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = (name, args) => client.callTool({ name, arguments: args });
  async function readText(name, args) {
    const result = await call(name, args);
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.content[0].type, 'text');
    return result.content[0].text;
  }
  async function expectError(name, args, pattern) {
    const result = await call(name, args);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, pattern);
  }

  return {
    db, client, defaultCwd, expectError,
    memory: async (action, args) => JSON.parse(await readText('mem_memory', { action, ...args })),
    note: async (action, args) => JSON.parse(await readText('mem_note', { action, ...args })),
    bootstrap: (args = {}) => readText('mem_bootstrap', args),
  };
}

test('MCP advertises the three core tools and validates action inputs', async (t) => {
  const { client, expectError } = await fixture(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), toolNames);
  for (const { inputSchema } of tools) assert.equal(inputSchema.type, 'object');

  for (const name of ['mem_memory', 'mem_note']) {
    await expectError(name, { action: 'write' }, /content is required/);
    await expectError(name, { action: 'write', content: ' \n ' }, /blank/);
  }
  for (const action of ['get', 'archive', 'update']) {
    await expectError('mem_memory', { action }, /id is required/);
    await expectError('mem_memory', { action, id: 'missing' }, /Memory not found/);
  }
  for (const action of ['update', 'dismiss']) {
    await expectError('mem_note', { action }, /id is required/);
    await expectError('mem_note', { action, id: 'missing' }, /Note not found/);
  }
  await expectError('mem_memory', { action: 'write', content: 'Fixture', importance: 6 }, /importance/);
  await expectError('mem_memory', { action: 'write', content: 'Fixture', scope: 'all' }, /scope/);
  await expectError('mem_note', { action: 'write', content: 'Fixture', status: 'dismissed' }, /status/);
  await expectError('mem_bootstrap', { token_budget: 0 }, /token_budget/);
});

test('memory writes deduplicate, merge metadata, and reactivate archived or superseded rows', async (t) => {
  const { db, memory } = await fixture(t);
  const first = await memory('write', {
    content: 'Remember the fixture', source_orchestrator: 'fixture-host',
    metadata: { a: 1, nesting: { old: true } },
  });
  const { id } = first.memory;
  assert.match(id, uuidV7Pattern);
  assert.equal(first.deduplicated, false);
  assert.equal(first.reactivated, false);
  assert.equal(first.memory.category, 'GENERAL');
  assert.equal(first.memory.scope, 'project');
  assert.equal(first.memory.importance, 3);
  assert.deepEqual(await memory('get', { id }), first.memory);
  db.prepare('UPDATE memories SET updated_at = 0 WHERE id = ?').run(id);

  const duplicate = await memory('write', {
    content: '  remember THE \n fixture ', category: 'WORKFLOW', importance: 5,
    source_session_id: 'fixture-session', metadata: { b: 2, nesting: { new: true } },
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.reactivated, false);
  assert.equal(duplicate.memory.id, id);
  assert.equal(duplicate.memory.content, first.memory.content);
  assert.equal(duplicate.memory.created_at, first.memory.created_at);
  assert.ok(duplicate.memory.updated_at > 0);
  assert.equal(duplicate.memory.source_orchestrator, 'fixture-host');
  assert.equal(duplicate.memory.source_session_id, 'fixture-session');
  assert.deepEqual(duplicate.memory.metadata, { a: 1, b: 2, nesting: { new: true } });
  assert.deepEqual(await memory('list'), [duplicate.memory]);

  const replacement = (await memory('write', { content: 'Use the replacement fixture' })).memory;
  for (const supersededBy of [undefined, replacement.id]) {
    const archived = await memory('archive', { id, superseded_by: supersededBy });
    assert.equal(archived.status, supersededBy ? 'superseded' : 'archived');
    assert.equal(archived.superseded_by, supersededBy ?? null);
    assert.deepEqual(await memory('list', { status: archived.status }), [archived]);
    assert.deepEqual(await memory('list'), [replacement]);

    const reactivated = await memory('write', { content: 'REMEMBER the fixture', metadata: { c: 3 } });
    assert.equal(reactivated.deduplicated, true);
    assert.equal(reactivated.reactivated, true);
    assert.equal(reactivated.memory.id, id);
    assert.equal(reactivated.memory.status, 'active');
    assert.equal(reactivated.memory.superseded_by, null);
    assert.equal(reactivated.memory.category, 'WORKFLOW');
    assert.equal(reactivated.memory.importance, 5);
    assert.equal(reactivated.memory.content, 'REMEMBER the fixture');
    assert.deepEqual(reactivated.memory.metadata, { a: 1, b: 2, c: 3, nesting: { new: true } });
  }
  assert.equal((await memory('list', { status: 'all' })).length, 2);
});

test('marking a memory as superseded requires an existing successor with a different ID', async (t) => {
  const { memory, expectError } = await fixture(t);
  const original = (await memory('write', { content: 'Original fixture' })).memory;
  const { id } = original;

  await expectError('mem_memory', { action: 'archive', id, superseded_by: 'missing' }, /not found for superseded_by/);
  assert.deepEqual(await memory('get', { id }), original);
  await expectError('mem_memory', { action: 'archive', id, superseded_by: id }, /cannot supersede itself/);
  assert.deepEqual(await memory('get', { id }), original);
  await expectError('mem_memory', { action: 'update', id, status: 'superseded' }, /archive with superseded_by/);
  assert.deepEqual(await memory('get', { id }), original);

  const archived = await memory('archive', { id });
  await expectError('mem_memory', { action: 'update', id, status: 'superseded' }, /archive with superseded_by/);
  assert.deepEqual(await memory('get', { id }), archived);

  const successor = (await memory('write', { content: 'Successor fixture' })).memory;
  const superseded = await memory('archive', { id, superseded_by: successor.id });
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.superseded_by, successor.id);
  const updated = await memory('update', { id, category: 'DECISIONS' });
  assert.equal(updated.category, 'DECISIONS');
  assert.equal(updated.status, 'superseded');
  assert.equal(updated.superseded_by, successor.id);
  assert.deepEqual(await memory('get', { id }), updated);
});

test('memory update and list preserve project boundaries, filters, and uniqueness', async (t) => {
  const { memory, expectError } = await fixture(t);
  const other = tempDirectory(t);
  const local = (await memory('write', { content: 'Local rule', category: 'CONSTRAINTS' })).memory;
  const global = (await memory('write', { content: 'Local rule', scope: 'global', importance: 5 })).memory;
  assert.notEqual(local.id, global.id);
  assert.equal(global.project_key, 'global');
  assert.equal(global.metadata, null);
  assert.deepEqual(await memory('list'), [global, local]);
  assert.deepEqual(await memory('list', { cwd: other }), [global]);
  assert.deepEqual(await memory('list', { scope: 'project', category: 'CONSTRAINTS' }), [local]);
  assert.deepEqual(await memory('list', { scope: 'global' }), [global]);
  assert.deepEqual(await memory('list', { limit: 0 }), [global]);
  await expectError('mem_memory', { action: 'update', id: local.id, scope: 'global' }, /conflicts/);
  assert.deepEqual(await memory('get', { id: local.id }), local);

  const moved = await memory('update', {
    id: local.id, content: 'Updated rule', category: 'DECISIONS',
    importance: 4, scope: 'global', metadata: { updated: true },
  });
  assert.equal(moved.normalized_hash.length, 64);
  assert.notEqual(moved.normalized_hash, local.normalized_hash);
  assert.equal(moved.project_key, 'global');
  assert.equal(moved.created_at, local.created_at);
  assert.equal(moved.content, 'Updated rule');
  assert.equal(moved.category, 'DECISIONS');
  assert.equal(moved.importance, 4);
  assert.deepEqual(moved.metadata, { updated: true });
  const restored = await memory('update', { id: local.id, scope: 'project', cwd: other, metadata: null });
  assert.notEqual(restored.project_key, local.project_key);
  assert.equal(restored.scope, 'project');
  assert.equal(restored.metadata, null);
  assert.deepEqual(await memory('list', { scope: 'project', cwd: other }), [restored]);
  assert.deepEqual(await memory('list', { scope: 'project' }), []);

  const blocker = (await memory('write', { content: 'Conflicting rule', cwd: other })).memory;
  await expectError('mem_memory', { action: 'update', id: blocker.id, content: ' UPDATED RULE ' }, /conflicts/);
  await expectError('mem_memory', { action: 'update', id: blocker.id, content: '  ' }, /blank/);
  const archived = await memory('update', { id: blocker.id, status: 'archived' });
  assert.deepEqual(await memory('list', { cwd: other, status: 'archived' }), [archived]);
});

test('embeddings follow content changes and failures leave searchable text', async (t) => {
  let fail = false;
  const inputs = [];
  const embeddingEngine = {
    async embed(content) {
      inputs.push(content);
      if (fail) throw new Error('Fixture inference failed');
      return Float32Array.of(1, 0);
    },
    getStatus: () => ({ model: 'fixture-model' }),
  };
  const { db, memory } = await fixture(t, { embeddingEngine });
  const row = (await memory('write', { content: 'Alpha fixture' })).memory;
  const embedding = db.prepare('SELECT * FROM memory_embeddings WHERE memory_id = ?');
  const stored = embedding.get(row.id);
  assert.equal(stored.model_id, 'fixture-model');
  assert.equal(stored.dims, 2);
  assert.deepEqual(decodeFloat32Vector(stored.vector), Float32Array.of(1, 0));
  await memory('write', { content: 'ALPHA fixture' });
  await memory('update', { id: row.id, content: 'Beta fixture' });
  await memory('archive', { id: row.id });
  await memory('write', { content: 'BETA fixture' });
  assert.deepEqual(inputs, ['Alpha fixture', 'Beta fixture', 'BETA fixture']);
  assert.ok(embedding.get(row.id));

  fail = true;
  await memory('update', { id: row.id, content: 'Gamma fixture' });
  assert.equal(embedding.get(row.id), undefined);
  const newRow = (await memory('write', { content: 'Delta fixture' })).memory;
  assert.equal(embedding.get(newRow.id), undefined);
  const search = db.prepare('SELECT content FROM memories_fts WHERE memories_fts MATCH ?');
  assert.equal(search.get('Gamma').content, 'Gamma fixture');
  assert.equal(search.get('Delta').content, 'Delta fixture');
  assert.equal(search.get('Beta'), undefined);
});

test('MCP memory writes respond while embedding inference is pending', async (t) => {
  const inference = Promise.withResolvers();
  const vector = Float32Array.of(1, 0);
  const embeddingEngine = {
    embed: () => inference.promise,
    getStatus: () => ({ model: 'fixture-model' }),
  };
  const { db, client } = await fixture(t, { embeddingEngine });
  const embedding = db.prepare('SELECT vector FROM memory_embeddings WHERE memory_id = ?');
  let id;
  try {
    const result = await client.callTool({
      name: 'mem_memory', arguments: { action: 'write', content: 'Deferred fixture' },
    }, undefined, { timeout: 5000 });
    assert.equal(result.isError, undefined, result.content[0].text);
    const { memory } = JSON.parse(result.content[0].text);
    id = memory.id;
    assert.equal(memory.content, 'Deferred fixture');
    assert.equal(embedding.get(id), undefined);
  } finally {
    inference.resolve(vector);
    await setImmediate();
  }
  assert.deepEqual(decodeFloat32Vector(embedding.get(id).vector), vector);
});

test('a late embedding cannot overwrite the vector for newer content', async (t) => {
  const olderStarted = Promise.withResolvers();
  const finishOlder = Promise.withResolvers();
  const embeddingEngine = {
    async embed(content) {
      if (content === 'Older fixture') {
        olderStarted.resolve();
        await finishOlder.promise;
        return Float32Array.of(1, 0);
      }
      return Float32Array.of(0, 1);
    },
    getStatus: () => ({ model: 'fixture-model' }),
  };
  const { db, memory } = await fixture(t, { embeddingEngine });
  const { id } = (await memory('write', { content: 'Initial fixture' })).memory;
  const older = memory('update', { id, content: 'Older fixture' });
  try {
    await Promise.race([olderStarted.promise, older]);
    await memory('update', { id, content: 'Newer fixture' });
  } finally {
    finishOlder.resolve();
    await older;
    await setImmediate();
  }
  const row = db.prepare('SELECT vector FROM memory_embeddings WHERE memory_id = ?').get(id);
  assert.deepEqual(decodeFloat32Vector(row.vector), Float32Array.of(0, 1));
  assert.equal((await memory('get', { id })).content, 'Newer fixture');
});

test('notes read by status and project, update their condition, and dismiss by id', async (t) => {
  const { db, note, expectError } = await fixture(t);
  const pending = await note('write', {
    content: 'Check the fixture', status: 'pending', surface_condition: 'During review',
    source_orchestrator: 'fixture-host', source_session_id: 'fixture-session',
  });
  const active = await note('write', { content: 'Review the draft' });
  await note('write', { content: 'Other workspace', cwd: tempDirectory(t) });
  assert.match(pending.id, uuidV7Pattern);
  assert.match(active.id, uuidV7Pattern);
  assert.equal(active.status, 'active');
  assert.equal(pending.source_orchestrator, 'fixture-host');
  assert.equal(pending.source_session_id, 'fixture-session');
  assert.equal(pending.surface_condition, 'During review');
  assert.deepEqual(await note('read'), [active, pending]);
  assert.deepEqual(await note('read', { status: 'pending' }), [pending]);

  db.prepare(`
    INSERT INTO notes (id, project_key, status, content, created_at, updated_at)
    VALUES ('fixture-global-note', 'global', 'active', 'Global reminder', 0, 0)
  `).run();
  assert.deepEqual((await note('read', { include_global: true })).map(({ id }) => id),
    [active.id, 'fixture-global-note', pending.id]);
  assert.deepEqual(await note('read', { status: 'active' }), [active]);

  const updated = await note('update', { id: pending.id, content: 'Inspect the fixture', surface_condition: null });
  assert.equal(updated.surface_condition, null);
  assert.equal(updated.content, 'Inspect the fixture');
  assert.equal(updated.status, 'pending');
  assert.equal(updated.created_at, pending.created_at);
  await expectError('mem_note', { action: 'update', id: pending.id, content: '' }, /blank/);
  const dismissed = await note('dismiss', { id: active.id });
  assert.equal(dismissed.status, 'dismissed');
  assert.deepEqual(await note('read', { status: 'dismissed' }), [dismissed]);
  assert.deepEqual(await note('read'), [updated]);
  assert.deepEqual(await note('read', { status: 'all' }), [updated, dismissed]);
  assert.equal((await note('update', { id: pending.id, status: 'active' })).status, 'active');
  const search = db.prepare('SELECT content FROM notes_fts WHERE notes_fts MATCH ?');
  assert.equal(search.get('Inspect').content, 'Inspect the fixture');
  assert.equal(search.get('Check'), undefined);
});

test('bootstrap renders deterministic sections and enforces a whole-item token budget', async (t) => {
  const config = { bootstrap: { tokenBudget: 2400 } };
  const { db, defaultCwd, memory, note, bootstrap, expectError } = await fixture(t, { config });
  assert.doesNotMatch(await bootstrap(), /<active-notes>/);
  await memory('write', { content: 'Priority <fixture>\nsecond line', importance: 5, category: 'WORKFLOW' });
  await memory('write', { content: 'Oversized memory '.repeat(100), importance: 4, category: 'GENERAL' });
  await memory('write', { content: 'Shared decision', scope: 'global', importance: 2, category: 'DECISIONS' });
  const archived = (await memory('write', { content: 'Archived fixture memory' })).memory;
  await memory('archive', { id: archived.id });
  await note('write', { content: 'Review the draft', surface_condition: 'After a review' });
  await note('write', { content: 'Oversized note '.repeat(100), status: 'pending' });
  const dismissed = await note('write', { content: 'Dismissed fixture note' });
  await note('dismiss', { id: dismissed.id });

  const full = await bootstrap();
  assert.match(full, /^<project-memory project="[^"]+" key="dir:[a-f0-9]+">/);
  assert.match(full, /### DECISIONS\n- Shared decision\n### WORKFLOW\n- Priority &lt;fixture&gt; second line\n/);
  assert.match(full, /<active-notes>\n- \[active\] Review the draft \(surface when: After a review\)\n- \[pending\]/);
  assert.match(full, /<\/active-notes>$/);
  assert.doesNotMatch(full, /Archived fixture|Dismissed fixture|omitted/);
  assert.equal(await bootstrap(), full);
  assert.doesNotMatch(await bootstrap({ include_notes: false }), /active-notes|Review the draft/);

  const budget = 90;
  const compact = await bootstrap({ token_budget: budget });
  assert.ok(estimateTokens(compact) <= budget);
  assert.match(compact, /- Priority &lt;fixture&gt; second line\n… 1 memories omitted\.\n<\/project-memory>/);
  assert.match(compact, /- \[active\] Review the draft \(surface when: After a review\)\n… 1 notes omitted\.\n<\/active-notes>$/);
  assert.doesNotMatch(compact, /Oversized/);
  assert.equal(await bootstrap({ token_budget: budget }), compact);

  const formatted = formatBootstrap(db, { defaultCwd, tokenBudget: budget });
  assert.equal(formatted.text, compact);
  assert.equal(formatted.includedMemories, 2);
  assert.equal(formatted.omittedMemories, 1);
  assert.equal(formatted.includedNotes, 1);
  assert.equal(formatted.omittedNotes, 1);
  assert.equal(formatted.estimatedTokens, estimateTokens(compact));
  assert.equal(formatted.tokenBudget, budget);
  assert.equal(formatBootstrap(db, { defaultCwd, config }).tokenBudget, 2400);

  const opening = full.split('\n', 1)[0];
  const minimumMemory = `${opening}\n… 3 memories omitted.\n</project-memory>`;
  const minimumSummary = `${minimumMemory}\n<active-notes>\n… 2 notes omitted.\n</active-notes>`;
  const minimumBudget = estimateTokens(minimumSummary);
  const minimumError = (budget) => new RegExp(
    `^token_budget \\(${budget}\\) is too small to render bootstrap summary; minimum required is ${minimumBudget} tokens$`,
  );
  await expectError('mem_bootstrap', { token_budget: 1 }, minimumError(1));

  const memoryOnlyBudget = estimateTokens(minimumMemory);
  await expectError('mem_bootstrap', { token_budget: memoryOnlyBudget }, minimumError(memoryOnlyBudget));
  assert.equal(await bootstrap({ token_budget: memoryOnlyBudget, include_notes: false }), minimumMemory);
  assert.equal(await bootstrap({ token_budget: minimumBudget }), minimumSummary);

  const elapsed = [];
  for (let index = 0; index < 3; index++) {
    const started = performance.now();
    assert.equal(formatBootstrap(db, { defaultCwd, tokenBudget: budget }).text, compact);
    elapsed.push(performance.now() - started);
  }
  const median = elapsed.sort((a, b) => a - b)[1];
  assert.ok(median < 50, `Median warm bootstrap took ${median.toFixed(1)} ms`);
});

test('bootstrap accepts a budget that fits a complete short note', async (t) => {
  const { note, bootstrap } = await fixture(t);
  await note('write', { content: 'x' });

  const completeSummary = await bootstrap();
  assert.match(completeSummary, /<active-notes>\n- \[active\] x\n<\/active-notes>$/);
  assert.equal(await bootstrap({ token_budget: Math.ceil(completeSummary.length / 4) }), completeSummary);
});

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(cwd, 'absent-gitconfig');
  execFileSync('git', args, { cwd, env, timeout: 10000, windowsHide: true, stdio: 'pipe' });
}

test('memory update moves a global memory to a previously unused Git workspace', async (t) => {
  const { memory } = await fixture(t);
  const workspace = tempDirectory(t);
  git(workspace, 'init', '--template=');
  const global = (await memory('write', { content: 'Workspace fixture', scope: 'global' })).memory;

  const moved = await memory('update', { id: global.id, scope: 'project', cwd: workspace });
  assert.equal(moved.id, global.id);
  assert.equal(moved.scope, 'project');
  assert.match(moved.project_key, /^git:/);
  assert.deepEqual(await memory('list', { scope: 'project', cwd: workspace }), [moved]);
  assert.deepEqual(await memory('list'), []);
});

test('linked Git worktrees share memories through MCP', async (t) => {
  const directory = tempDirectory(t);
  const main = path.join(directory, 'main repo');
  const linked = path.join(directory, 'linked tree');
  fs.mkdirSync(main);
  git(main, 'init', '--template=');
  git(main, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com',
    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Fixture commit');
  git(main, 'worktree', 'add', '--detach', linked);

  const { memory, bootstrap } = await fixture(t, { defaultCwd: main });
  const written = (await memory('write', { content: 'Preserve the worktree fixture' })).memory;
  assert.match(written.project_key, /^git:/);
  const summary = await bootstrap({ cwd: linked });
  assert.ok(summary.includes(`<project-memory project="linked tree" key="${written.project_key}">`));
  assert.ok(summary.includes(`- ${written.content}\n`));
  assert.deepEqual(await memory('list', { cwd: linked }), [written]);
});

test('real stdio speaks JSON-RPC only and shuts down on EOF', { timeout: 20000 }, async (t) => {
  const directory = tempDirectory(t);
  const workspace = path.join(directory, 'fixture workspace');
  fs.mkdirSync(workspace);
  const dbPath = path.join(directory, 'state.db');
  const child = spawn(process.execPath, [cliPath, 'serve', '--cwd', workspace], {
    cwd: directory,
    env: {
      ...process.env,
      MULTI_SUB_MEMORY_CONFIG: path.join(directory, 'absent-config.jsonc'),
      MULTI_SUB_MEMORY_DB: dbPath,
      MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
    },
    stdio: 'pipe',
    timeout: 15000,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'close');
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  t.after(async () => {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });

  function send(method, params, id) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
  }
  async function receive(id) {
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    const message = JSON.parse(line.value);
    assert.equal(message.jsonrpc, '2.0');
    assert.equal(message.id, id);
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return message.result;
  }

  send('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1.0.0' },
  }, 1);
  assert.equal((await receive(1)).serverInfo.name, 'multi-sub-memory');
  send('notifications/initialized');
  send('tools/list', {}, 2);
  assert.deepEqual((await receive(2)).tools.map(({ name }) => name).sort(), toolNames);
  send('tools/call', { name: 'mem_bootstrap', arguments: {} }, 3);
  const summary = await receive(3);
  assert.match(summary.content[0].text, /<project-memory project="fixture workspace"/);

  child.stdin.end();
  assert.equal((await lines.next()).done, true);
  assert.deepEqual(await exited, [0, null], stderr);
  assert.ok(fs.existsSync(dbPath));
});
