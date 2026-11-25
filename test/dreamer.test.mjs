import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { acquireLease, hashNormalizedContent, openDatabase, releaseLease } from '../src/db.mjs';
import { maybeTriggerAutoDream, runDream, shouldTriggerAutoDream } from '../src/dreamer/engine.mjs';
import { createCliLlmRunner, createDreamRunner, createHttpLlmRunner, extractJsonPlan } from '../src/dreamer/runners.mjs';
import { runIndexers } from '../src/indexers/runner.mjs';
import { addNoteComment, getNote, listNoteComments, recordAccess, updateNote, updateNoteComment, writeMemory } from '../src/memory-service.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';
import { initGit, writeProjectConfig } from './git-fixtures.mjs';

const projectKey = 'fixture-project';
const prompt = { systemPrompt: 'Fixture system message', userPrompt: 'Fixture user message' };
const emptyPlan = { summary: 'No changes needed', operations: [] };
const resultFor = (operations, summary = 'Fixture plan') => ({ plan: { summary, operations }, runner: 'fixture', model: 'fixture' });

function completion(content = JSON.stringify(emptyPlan)) {
  return { choices: [{ message: { content } }] };
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP Dreamer sends a fenced-plan request with a bearer token and normalized URL', async (t) => {
  const requests = [];
  const origin = await serve(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
    res.end(JSON.stringify(completion('```json\n' + JSON.stringify(emptyPlan) + '\n```')));
  });
  const options = [];
  const runner = createHttpLlmRunner({
    baseUrl: origin + '/v1///?ignored=1#ignored', model: 'fixture', apiKeyEnv: 'DREAM_TEST_KEY',
    env: { DREAM_TEST_KEY: 'synthetic-token' },
    fetchImpl: (url, init) => {
      options.push(init);
      return fetch(url, init);
    },
  });
  assert.deepEqual(await runner(prompt), { plan: emptyPlan, runner: 'http', model: 'fixture' });
  assert.deepEqual(requests, [{
    url: '/v1/chat/completions', method: 'POST', auth: 'Bearer synthetic-token',
    body: { model: 'fixture', messages: [
      { role: 'system', content: prompt.systemPrompt }, { role: 'user', content: prompt.userPrompt },
    ] },
  }]);
  assert.equal(options[0].redirect, 'error');
  assert.ok(options[0].signal instanceof AbortSignal);
});

test('HTTP Dreamer retries 503, 429, and network failures within its attempt budget', async (t) => {
  const statuses = [503, 429, 200];
  const origin = await serve(t, (req, res) => {
    req.resume();
    res.writeHead(statuses.shift());
    res.end(JSON.stringify(completion()));
  });
  const config = { baseUrl: origin, model: 'fixture', retryDelayMs: 0 };
  assert.deepEqual((await createHttpLlmRunner(config)(prompt)).plan, emptyPlan);
  assert.deepEqual(statuses, []);
  let attempts = 0;
  const runner = createHttpLlmRunner({
    ...config, maxRetries: 1, fetchImpl: async () => {
      if (attempts++ === 0) throw new TypeError('fixture network error');
      return Response.json(completion());
    },
  });
  await runner(prompt);
  assert.equal(attempts, 2);
  let failures = 0;
  const unavailable = createHttpLlmRunner({
    ...config, maxRetries: 1,
    fetchImpl: async () => { failures++; return new Response('', { status: 503 }); },
  });
  await assert.rejects(unavailable(prompt), /503/);
  assert.equal(failures, 2);
});

test('HTTP Dreamer rejects unauthorized responses, redirects, malformed output, and missing own credentials', async () => {
  for (const [response, expected] of [
    [() => new Response('synthetic-token', { status: 401 }), /401/],
    [() => new Response(null, { status: 302 }), /302/],
    [() => Response.json(completion('{broken')), /malformed JSON/],
    [() => Response.json(completion('{"summary":"fixture","operations":[{"type":"update","id":"a"}]}')), /validation/],
  ]) {
    let attempts = 0;
    const runner = createHttpLlmRunner({
      baseUrl: 'https://example.test', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', env: { FIXTURE_KEY: 'synthetic-token' },
      fetchImpl: async () => { attempts++; return response(); },
    });
    await assert.rejects(runner(prompt), (error) => expected.test(error.message) && !error.message.includes('synthetic-token'));
    assert.equal(attempts, 1);
  }
  const runner = createHttpLlmRunner({
    baseUrl: 'https://example.test', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY',
    env: Object.create({ FIXTURE_KEY: 'synthetic-token' }), fetchImpl: () => assert.fail('unexpected request'),
  });
  await assert.rejects(runner(prompt), /unset or empty/);
  assert.throws(() => createDreamRunner({ dreamer: { enabled: true, mode: 'http' } }), /misconfigured/);
  assert.throws(() => createDreamRunner({ dreamer: { enabled: false } }), /disabled/);
});

test('HTTP Dreamer reports timeout without retrying an aborted request', async (t) => {
  const origin = await serve(t, (req) => req.resume());
  let attempts = 0;
  const runner = createHttpLlmRunner({
    baseUrl: origin, model: 'fixture', timeoutMs: 50,
    fetchImpl: (...args) => { attempts++; return fetch(...args); },
  });
  await assert.rejects(runner(prompt), /timed out/);
  assert.equal(attempts, 1);
});

function spawnFixture({ stdout, stderr, code = 0, signal, pending = false } = {}) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kills: [] });
  child.kill = (signal) => {
    child.kills.push(signal);
    if (pending) queueMicrotask(() => child.emit('close', null, signal));
  };
  const calls = [];
  return {
    child, calls,
    spawnImpl(...args) {
      calls.push(args);
      if (!pending) {
        queueMicrotask(() => {
          child.stdout.end(stdout ?? JSON.stringify(emptyPlan));
          child.stderr.end(stderr);
          child.emit('close', code, signal);
        });
      }
      return child;
    },
  };
}

test('CLI Dreamer applies tool restrictions and isolates each default and legacy preset', async (t) => {
  const { root, workspace } = workspaceFixture(t);
  const { cwd: workspaceCwd } = workspace('tool-runner-workspace', {});
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.fixture]\ncommand = "fixture-mcp"\n');
  const codexRestrictions = [
    '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '--ignore-rules', '-c', 'mcp_servers={}', '-c', 'features.shell_tool=false',
  ];
  const presets = [
    ['omp', ['-p', '--no-session'], ['--no-tools'], []],
    ['claude', ['-p'], ['--tools', '', '--strict-mcp-config'], ['--']],
    ['codex', ['exec'], codexRestrictions, []],
  ];
  const workingDirectories = new Set();
  for (const [orchestrator, legacyArgs, restrictions, delimiter] of presets) {
    const savedArgs = [undefined, legacyArgs, [...legacyArgs, ...restrictions]];
    if (orchestrator === 'codex') {
      savedArgs.push(
        ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'features.shell_tool=false'],
        ['exec', '--sandbox=danger-full-access', '--profile', 'fixture', '--enable=shell_tool',
          '-c', 'mcp_servers.fixture.command="fixture-mcp"', '--config=mcp_servers={}',
          '-cfeatures.shell_tool=true', '--ephemeral', '--ephemeral'],
      );
    }
    for (const args of savedArgs) {
      const { calls, spawnImpl } = spawnFixture({ stdout: '```\n' + JSON.stringify(emptyPlan) + '\n```' });
      const env = orchestrator === 'codex' ? { CODEX_HOME: codexHome } : {};
      const cli = { orchestrator, args };
      const runner = createDreamRunner({ dreamer: { enabled: true, mode: 'cli', cli: { ...cli, model: 'fixture' } } },
        { cwd: workspaceCwd, env, userDreamer: { mode: 'cli', cli }, spawnImpl: (...invocation) => {
          const { cwd } = invocation[2];
          assert.notEqual(cwd, workspaceCwd);
          assert.deepEqual(fs.readdirSync(cwd), []);
          assert.ok(path.basename(cwd).startsWith('msm-dream-'));
          workingDirectories.add(cwd);
          return spawnImpl(...invocation);
        } });
      assert.deepEqual(await runner(prompt), { plan: emptyPlan, runner: 'cli:' + orchestrator, model: 'fixture' });
      const cwd = calls[0][2].cwd;
      assert.deepEqual(calls, [[orchestrator, [
        ...legacyArgs, ...restrictions, '--model', 'fixture', ...delimiter, prompt.systemPrompt + '\n\n' + prompt.userPrompt,
      ], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env, cwd }]]);
      assert.equal(fs.existsSync(cwd), false);
    }
  }
  assert.equal(workingDirectories.size, 11);
});

test('CLI Dreamer reports only the failure stage and exit status and kills on timeout', async () => {
  const invalid = spawnFixture({ stdout: 'a non-JSON response' });
  const failure = spawnFixture({ code: 7, stderr: 'fixture-stderr-secret' });
  const signaled = spawnFixture({ code: null, signal: 'SIGTERM' });
  const hanging = spawnFixture({ pending: true });
  const oversized = spawnFixture({ stdout: 'x'.repeat(1024 * 1024 + 1) });
  const asyncFailure = spawnFixture({ pending: true });
  const run = (spawnImpl, timeoutMs) => createCliLlmRunner({ orchestrator: 'codex', spawnImpl, timeoutMs, env: {} })(prompt);
  await assert.rejects(run(invalid.spawnImpl), { message: 'cli:codex invalid-output' });
  await assert.rejects(run(failure.spawnImpl), { message: 'cli:codex process-exit code 7' });
  await assert.rejects(run(signaled.spawnImpl), { message: 'cli:codex process-exit SIGTERM' });
  await assert.rejects(run(hanging.spawnImpl, 10), { message: 'cli:codex timeout' });
  await assert.rejects(run(oversized.spawnImpl), { message: 'cli:codex invalid-output' });
  await assert.rejects(run((...args) => {
    const child = asyncFailure.spawnImpl(...args);
    queueMicrotask(() => {
      child.emit('error', new Error('fixture async spawn details'));
      child.emit('close', -1);
    });
    return child;
  }), { message: 'cli:codex spawn-error' });
  let failedCwd;
  await assert.rejects(run((_executable, _args, { cwd }) => {
    failedCwd = cwd;
    throw new Error('fixture spawn details');
  }), { message: 'cli:codex spawn-error' });
  assert.equal(fs.existsSync(failedCwd), false);
  for (const { calls } of [invalid, failure, signaled, hanging, oversized, asyncFailure]) {
    assert.equal(fs.existsSync(calls[0][2].cwd), false);
  }
  assert.deepEqual(hanging.child.kills, ['SIGKILL']);
  assert.deepEqual(oversized.child.kills, ['SIGKILL']);
});

function addMemory(db, id, { content = id, project = projectKey, scope = 'project', status = 'active', time = 1 } = {}) {
  db.prepare(`
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, status, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, 'GENERAL', ?, ?, ?, '{"fixture":true}', ?, ?)
  `).run(id, project, scope, content, hashNormalizedContent(content), status, time, time);
}

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return {
    db,
    dream: (runner, options) => runDream({ db, projectKey, runner, ...options }),
    memory: (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id),
    allMemories: () => db.prepare('SELECT * FROM memories ORDER BY id').all(),
    runs: () => db.prepare('SELECT * FROM dream_runs ORDER BY rowid').all(),
    leases: () => db.prepare('SELECT * FROM leases').all(),
  };
}

function addTranscript(db) {
  const file = db.prepare(`
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
    VALUES ('fixture.jsonl', 'omp', 'fixture', ?, 1, 1)
  `).run(projectKey).lastInsertRowid;
  db.prepare(`
    INSERT INTO transcript_messages (file_id, seq, role, text, line_no)
    VALUES (?, 0, 'user', 'Transcript evidence for fixture facts', 1)
  `).run(file);
}

test('project lease excludes a concurrent run and releases after success and failure', async (t) => {
  const { dream, leases, runs } = fixture(t);
  const pending = Promise.withResolvers();
  const first = dream(() => pending.promise);
  assert.equal(leases()[0].lease_key, 'dream:' + projectKey);
  assert.deepEqual(await dream(() => assert.fail('runner should not start')), { skipped: true, reason: 'lease-held', projectKey });
  assert.deepEqual(runs(), []);
  pending.resolve(resultFor([]));
  assert.equal((await first).status, 'completed');
  assert.deepEqual(leases(), []);
  await assert.rejects(dream(() => { throw new Error('Runner timed out'); }), /timed out/);
  assert.deepEqual(leases(), []);
  assert.deepEqual(runs().map(({ status }) => status), ['completed', 'failed']);
});

test('expired lease owner cannot commit a stale plan', async (t) => {
  const { db, dream, memory, leases } = fixture(t);
  addMemory(db, 'a');
  let now = 100;
  const pending = Promise.withResolvers();
  const first = dream(() => pending.promise, { leaseTtlMs: 10_000, now: () => now });
  now += 10_000;
  assert.equal(acquireLease(db, 'dream:' + projectKey, 'new-owner', 10_000, now), true);
  pending.resolve(resultFor([{ type: 'archive', id: 'a', reason: 'fixture' }]));
  await assert.rejects(first, /lease expired or changed owners/);
  assert.equal(memory('a').status, 'active');
  assert.equal(leases()[0].owner, 'new-owner');
});

test('dry run records the proposed plan and leaves memories and embeddings untouched', async (t) => {
  const { db, dream, allMemories, runs, leases } = fixture(t);
  addTranscript(db);
  addMemory(db, 'a');
  addMemory(db, 'b');
  addMemory(db, 'c');
  recordAccess(db, { memories: ['a', 'b'] });
  const operations = [
    { type: 'merge', source_ids: ['a', 'b'], content: 'Consolidated fixture' },
    { type: 'archive', id: 'c', reason: 'Retired fixture' },
    { type: 'add', content: 'New fixture' },
    { type: 'add', content: 'new  FIXTURE' },
  ];
  const before = allMemories();
  const result = await dream(() => resultFor(operations), {
    dryRun: true, embeddingEngine: { embed: () => assert.fail('dry run must not embed') },
  });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.operations, operations);
  assert.equal(result.memoriesAdded, 1);
  assert.deepEqual(allMemories(), before);
  assert.equal(db.prepare('SELECT count(*) AS count FROM memory_embeddings').get().count, 0);
  const [run] = runs();
  assert.equal(run.status, 'dry-run');
  assert.equal(run.id, result.runId);
  assert.deepEqual([run.memories_reviewed, run.memories_merged, run.memories_archived], [3, 1, 1]);
  assert.deepEqual(leases(), []);
});

test('engine applies all four operations and embeds committed content, with exact run counts', async (t) => {
  const { db, dream, memory, runs, leases, allMemories } = fixture(t);
  addTranscript(db);
  for (const id of ['a', 'b', 'c', 'd']) addMemory(db, id);
  addMemory(db, 'global', { scope: 'global' });
  db.exec("UPDATE memories SET last_accessed_at = 500, access_count = 3 WHERE id = 'a'");
  const operations = [
    { type: 'merge', source_ids: ['a', 'b'], content: 'Consolidated fixture', reason: 'Duplicate facts' },
    { type: 'archive', id: 'c', reason: 'Retired fixture' },
    { type: 'update', id: 'd', content: 'Updated fixture', importance: 5, reason: 'Clarified' },
    { type: 'add', content: 'New fixture', category: 'WORKFLOW', reason: 'Durable detail' },
    { type: 'add', content: ' new  FIXTURE ' },
  ];
  const embedded = [];
  const result = await dream(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).memories.map(({ id }) => id), ['a', 'b', 'c', 'd']);
    return resultFor(operations);
  }, {
    embeddingEngine: {
      embed(content) {
        assert.equal(runs()[0].status, 'completed');
        embedded.push(content);
        return Float32Array.of(1, 0);
      },
      getStatus: () => ({ model: 'fixture-model' }),
    },
  });
  assert.deepEqual([
    result.status, result.memoriesReviewed, result.memoriesMerged, result.memoriesArchived,
    result.memoriesUpdated, result.memoriesAdded, result.embeddingsWritten,
  ], ['completed', 4, 1, 1, 1, 1, 3]);
  assert.deepEqual(embedded, ['Consolidated fixture', 'Updated fixture', 'New fixture']);
  const merged = memory(memory('a').superseded_by);
  assert.equal(memory('a').status, 'superseded');
  assert.equal(memory('b').superseded_by, merged.id);
  assert.equal(merged.status, 'active');
  assert.equal(merged.source_orchestrator, 'dreamer');
  assert.equal(merged.last_accessed_at, 500);
  assert.equal(merged.access_count, 3);
  assert.deepEqual(JSON.parse(merged.metadata_json), {
    dream_run_id: result.runId, merged_from: ['a', 'b'], merge_reason: 'Duplicate facts',
  });
  assert.equal(memory('c').status, 'archived');
  assert.deepEqual(JSON.parse(memory('c').metadata_json), {
    fixture: true, dream_run_id: result.runId, archive_reason: 'Retired fixture',
  });
  assert.equal(memory('d').importance, 5);
  assert.equal(memory('d').normalized_hash, hashNormalizedContent('Updated fixture'));
  assert.equal(JSON.parse(memory('d').metadata_json).update_reason, 'Clarified');
  const added = allMemories().find(({ content }) => content === 'New fixture');
  assert.equal(added.category, 'WORKFLOW');
  assert.equal(added.source_orchestrator, 'dreamer');
  assert.deepEqual(JSON.parse(added.metadata_json), { dream_run_id: result.runId, reason: 'Durable detail' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM memory_embeddings').get().count, 3);
  const [run] = runs();
  assert.deepEqual([run.id, run.status, run.runner, run.model, run.memories_reviewed, run.memories_merged,
    run.memories_archived, run.summary], [result.runId, 'completed', 'fixture', 'fixture', 4, 1, 1, 'Fixture plan']);
  assert.ok(run.finished_at >= run.started_at);
  assert.deepEqual(leases(), []);
});

test('merge reuses either a source or an existing archived row with the same normalized hash', async (t) => {
  const { db, dream, memory } = fixture(t);
  addMemory(db, 'a', { content: 'Fixture A' });
  addMemory(db, 'b');
  addMemory(db, 'c');
  addMemory(db, 'd');
  addMemory(db, 'e', { content: 'Fixture target', status: 'archived' });
  db.exec(`
    UPDATE memories SET last_accessed_at = 100, access_count = 1 WHERE id = 'a';
    UPDATE memories SET last_accessed_at = 200, access_count = 2 WHERE id = 'b';
    UPDATE memories SET last_accessed_at = 400, access_count = 4 WHERE id = 'e';
  `);
  await dream(() => resultFor([
    { type: 'merge', source_ids: ['a', 'b'], content: 'fixture  A' },
    { type: 'merge', source_ids: ['c', 'd'], content: 'Fixture target' },
  ]), { embeddingEngine: { embed: () => { throw new Error('Optional inference failure'); } } });
  assert.equal(memory('a').status, 'active');
  assert.equal(memory('a').content, 'fixture  A');
  assert.equal(memory('b').superseded_by, 'a');
  assert.equal(memory('c').superseded_by, 'e');
  assert.equal(memory('d').superseded_by, 'e');
  assert.equal(memory('e').status, 'active');
  assert.equal(memory('e').superseded_by, null);
  assert.equal(memory('a').last_accessed_at, 200);
  assert.equal(memory('a').access_count, 3);
  assert.equal(memory('e').last_accessed_at, 400);
  assert.equal(memory('e').access_count, 4);
});

test('Dreamer includes accesses recorded during planning and preserves null for untouched sources', async (t) => {
  const { db, dream, memory } = fixture(t);
  for (const id of ['a', 'b', 'target', 'c', 'd']) addMemory(db, id);
  const pending = Promise.withResolvers();
  const running = dream(() => pending.promise);

  recordAccess(db, { memories: ['a', 'target'] });
  recordAccess(db, { memories: ['a'] });
  const latest = Math.max(memory('a').last_accessed_at, memory('target').last_accessed_at);
  pending.resolve(resultFor([
    { type: 'merge', source_ids: ['a', 'b'], content: 'target' },
    { type: 'merge', source_ids: ['c', 'd'], content: 'Untouched sources' },
  ]));
  assert.equal((await running).status, 'completed');
  assert.equal(memory('target').access_count, 3);
  assert.equal(memory('target').last_accessed_at, latest);
  const merged = memory(memory('c').superseded_by);
  assert.equal(merged.access_count, 0);
  assert.equal(merged.last_accessed_at, null);
});

test('automatic Dreamer preserves array metadata on update, archive, and merge target reuse', async (t) => {
  const { db, dream, memory } = fixture(t);
  for (const id of ['updated', 'archived', 'target', 'source-a', 'source-b']) addMemory(db, id);
  const metadata = ['tag-a', { k: 1 }];
  db.prepare("UPDATE memories SET metadata_json = ? WHERE id IN ('updated', 'archived', 'target')")
    .run(JSON.stringify(metadata));
  const config = autoConfig(1);
  const { status, runId } = await dream(() => resultFor([
    { type: 'update', id: 'updated', content: 'Updated fixture content' },
    { type: 'archive', id: 'archived', reason: 'Obsolete fixture' },
    { type: 'merge', source_ids: ['source-a', 'source-b'], content: 'target' },
  ]), { config, automatic: true, now: () => 100 });
  assert.equal(status, 'completed');
  assert.deepEqual(JSON.parse(memory('updated').metadata_json), { user_metadata: metadata, dream_run_id: runId });
  assert.deepEqual(JSON.parse(memory('archived').metadata_json), {
    user_metadata: metadata, dream_run_id: runId, archive_reason: 'Obsolete fixture',
  });
  assert.deepEqual(JSON.parse(memory('target').metadata_json), {
    user_metadata: metadata, dream_run_id: runId, merged_from: ['source-a', 'source-b'],
  });
  assert.equal(memory('source-a').superseded_by, 'target');
  const next = await dream(() => resultFor([{ type: 'update', id: 'updated', importance: 5 }]), { now: () => 200 });
  assert.deepEqual(JSON.parse(memory('updated').metadata_json), { user_metadata: metadata, dream_run_id: next.runId });
});

test('Dreamer distinguishes absent metadata from explicit JSON null on update and archive', async (t) => {
  for (const { name, input, stored, expected } of [
    { name: 'absent metadata', input: {}, stored: null, expected: {} },
    { name: 'explicit JSON null', input: { metadata: null }, stored: 'null', expected: { user_metadata: null } },
  ]) {
    await t.test(name, async (t) => {
      const { db, dream, memory } = fixture(t);
      const cwd = process.cwd();
      const { memory: updated } = await writeMemory(db, { cwd, content: 'Update fixture', ...input });
      const { memory: archived } = await writeMemory(db, { cwd, content: 'Archive fixture', ...input });
      assert.equal(memory(updated.id).metadata_json, stored);
      assert.equal(memory(archived.id).metadata_json, stored);

      const { runId } = await dream(() => resultFor([
        { type: 'update', id: updated.id, importance: 5 },
        { type: 'archive', id: archived.id, reason: 'Obsolete fixture' },
      ]), { projectKey: updated.project_key });
      assert.deepEqual(JSON.parse(memory(updated.id).metadata_json), { ...expected, dream_run_id: runId });
      assert.deepEqual(JSON.parse(memory(archived.id).metadata_json), {
        ...expected, dream_run_id: runId, archive_reason: 'Obsolete fixture',
      });
    });
  }
});

test('validation and runner failures leave all memory rows unchanged and log failed runs', async (t) => {
  const { db, dream, allMemories, runs, leases } = fixture(t);
  addTranscript(db);
  addMemory(db, 'a');
  addMemory(db, 'b');
  addMemory(db, 'foreign', { project: 'different-project' });
  const before = allMemories();
  const archive = (id) => ({ type: 'archive', id, reason: 'Fixture reason' });
  const cases = [
    [() => extractJsonPlan('broken'), /malformed JSON/],
    [() => { throw new Error('Fixture runner timed out'); }, /timed out/],
    [() => resultFor([archive('missing')]), /outside/],
    [() => resultFor([archive('foreign')]), /outside/],
    [() => resultFor([{ type: 'merge', source_ids: ['a', ' a '], content: 'duplicate' }]), /duplicate/i],
    [() => resultFor([archive('a'), { type: 'update', id: 'a', importance: 5 }]), /conflicting/],
    [() => resultFor([{ type: 'update', id: 'a', content: 'b' }]), /collides/],
    [() => resultFor([{ type: 'add', content: 'collision' }, { type: 'update', id: 'a', content: 'collision' }]), /collides/],
  ];
  for (const [runner, expected] of cases) {
    await assert.rejects(dream(runner), expected);
    assert.deepEqual(allMemories(), before);
    assert.deepEqual(leases(), []);
  }
  assert.equal(runs().length, cases.length);
  for (const run of runs()) {
    assert.equal(run.status, 'failed');
    assert.ok(run.error);
    assert.ok(run.finished_at >= run.started_at);
  }
});

test('dry run rejects the same normalized-content conflicts as a live run', async (t) => {
  const { db, dream, allMemories, runs, leases } = fixture(t);
  addTranscript(db);
  addMemory(db, 'a');
  const before = allMemories();
  const runner = () => resultFor([
    { type: 'add', content: 'collision' },
    { type: 'update', id: 'a', content: 'COLLISION' },
  ]);
  await assert.rejects(dream(runner, { dryRun: true }), /collides/);
  assert.deepEqual(allMemories(), before);
  assert.equal(runs()[0].status, 'failed');
  assert.deepEqual(leases(), []);
});

test('a SQLite error rolls back earlier operations and records a sanitized error', async (t) => {
  const { db, dream, allMemories, runs, leases } = fixture(t);
  addTranscript(db);
  addMemory(db, 'a');
  const before = allMemories();
  db.exec(`
    CREATE TRIGGER fixture_reject_dream_insert BEFORE INSERT ON memories
    WHEN NEW.source_orchestrator = 'dreamer'
    BEGIN
      SELECT RAISE(ABORT, 'Fixture failure Bearer synthetic-token');
    END
  `);
  await assert.rejects(dream(() => resultFor([
    { type: 'archive', id: 'a', reason: 'Fixture reason' },
    { type: 'add', content: 'New fixture' },
  ])), { message: 'Fixture failure Bearer [redacted]' });
  assert.deepEqual(allMemories(), before);
  const [run] = runs();
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Fixture failure Bearer \[redacted\]/);
  assert.deepEqual(leases(), []);
});

function addCompletedRun(db, finishedAt) {
  db.prepare(`
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at)
    VALUES (?, ?, 'fixture', 'completed', ?, ?)
  `).run('completed-' + finishedAt, projectKey, finishedAt, finishedAt);
}

test('runner receives only bounded recent transcripts from the selected project', async (t) => {
  const { db, dream } = fixture(t);
  addCompletedRun(db, Date.parse('2026-01-02T00:00:00.000Z'));
  const file = db.prepare(`
    INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
    VALUES (?, 'omp', 'fixture', ?, 1, 1767398400000)
  `);
  const own = file.run('project.jsonl', projectKey).lastInsertRowid;
  const other = file.run('other.jsonl', 'other-project').lastInsertRowid;
  const message = db.prepare(`
    INSERT INTO transcript_messages (file_id, seq, role, timestamp, text, line_no) VALUES (?, ?, 'user', ?, ?, 1)
  `);
  message.run(own, 0, '2026-01-01T00:00:00.000Z', 'old');
  message.run(own, 1, '2026-01-04T00:00:00.000Z', 'a'.repeat(14_000));
  message.run(other, 0, '2026-01-04T00:00:00.000Z', 'unrelated');
  const runner = ({ userPrompt }) => {
    const { transcripts } = JSON.parse(userPrompt);
    assert.deepEqual(transcripts.map(({ text }) => text), ['a'.repeat(12_000)]);
    return resultFor([]);
  };
  await dream(runner, { dryRun: true });
  await dream(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).transcripts, []);
    return resultFor([]);
  }, { includeTranscripts: false });
  await assert.rejects(dream(() => resultFor([
    { type: 'add', content: 'New fixture' },
  ]), { includeTranscripts: false }), /require transcript excerpts/);
});

test('dry and live runs reject additions when the prompt has no transcript evidence', async (t) => {
  const { dream, runs, allMemories } = fixture(t);
  for (const dryRun of [true, false]) {
    await assert.rejects(dream(({ userPrompt }) => {
      assert.deepEqual(JSON.parse(userPrompt).transcripts, []);
      return resultFor([{ type: 'add', content: 'Unsupported fixture fact' }]);
    }, { dryRun }), /require transcript excerpts/);
  }
  assert.deepEqual(allMemories(), []);
  assert.deepEqual(runs().map(({ status }) => status), ['failed', 'failed']);
});

test('the next Dreamer prompt includes an older transcript message indexed during planning', async (t) => {
  const { db, dream, runs } = fixture(t);
  const start = Date.parse('2026-01-01T00:00:01Z');
  let time = start;
  const now = () => time;
  addTranscript(db);
  const firstId = db.prepare('SELECT id FROM transcript_messages').get().id;
  let lateId;
  await dream(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).transcripts.map(({ text }) => text), ['Transcript evidence for fixture facts']);
    const fileId = db.prepare('SELECT id FROM transcript_files').get().id;
    lateId = db.prepare(`
      INSERT INTO transcript_messages (file_id, seq, role, timestamp, text, line_no)
      VALUES (?, 1, 'user', ?, 'Indexed during planning', 2)
    `).run(fileId, new Date(start - 1_000).toISOString()).lastInsertRowid;
    time += 2_000;
    return resultFor([]);
  }, { now });
  assert.deepEqual([runs()[0].started_at, runs()[0].finished_at], [start, start + 2_000]);
  assert.equal(runs()[0].last_transcript_message_id, firstId);
  const review = ({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).transcripts.map(({ text }) => text), ['Indexed during planning']);
    return resultFor([]);
  };
  await dream(review, { now, dryRun: true });
  assert.equal(runs()[1].last_transcript_message_id, null);
  await dream(review, { now });
  assert.equal(runs()[2].last_transcript_message_id, lateId);
  await dream(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).transcripts, []);
    return resultFor([]);
  }, { now });
});

test('the transcript cursor advances only to the highest message ID included within the prompt budget', async (t) => {
  const { db, dream, runs } = fixture(t);
  addTranscript(db);
  const { id: previousId, file_id: fileId } = db.prepare('SELECT id, file_id FROM transcript_messages').get();
  db.prepare(`
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at, last_transcript_message_id)
    VALUES ('previous', ?, 'fixture', 'completed', 1, 2, ?)
  `).run(projectKey, previousId);
  const insertMessage = db.prepare(`
    INSERT INTO transcript_messages (file_id, seq, role, text, line_no) VALUES (?, ?, 'user', ?, ?)
  `);
  const excerpt = 'Pending transcript evidence '.repeat(60).trimEnd();
  const pendingId = insertMessage.run(fileId, 1, excerpt, 2).lastInsertRowid;
  insertMessage.run(fileId, 2, 'x'.repeat(5_000), 3);
  addMemory(db, 'large', { content: 'm'.repeat(2_800) });

  const promptBudget = { limit: 4_096, measure: (value) => value.length };
  await dream(Object.assign(({ userPrompt }) => {
    const { memories, transcripts } = JSON.parse(userPrompt);
    assert.deepEqual(memories.map(({ id }) => id), ['large']);
    assert.deepEqual(transcripts, []);
    return resultFor([{ type: 'archive', id: 'large', reason: 'Obsolete fixture' }]);
  }, { promptBudget }), { now: () => 100 });
  assert.equal(runs().at(-1).last_transcript_message_id, previousId);

  await dream(Object.assign(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).transcripts, [{ role: 'user', timestamp: null, text: excerpt }]);
    return resultFor([]);
  }, { promptBudget }), { now: () => 200 });
  assert.equal(runs().at(-1).last_transcript_message_id, pendingId);
});

test('review coverage rotates across the 200-memory limit without changing activity timestamps', async (t) => {
  const { db, dream, allMemories } = fixture(t);
  const moreImportant = Array.from({ length: 200 }, (_, index) => 'high-' + String(index).padStart(3, '0'));
  const lessImportant = Array.from({ length: 5 }, (_, index) => 'low-' + index);
  for (const id of [...moreImportant, ...lessImportant]) addMemory(db, id);
  db.prepare("UPDATE memories SET importance = 5 WHERE id LIKE 'high-%'").run();
  const reviewed = [];
  const runner = ({ userPrompt }) => {
    reviewed.push(JSON.parse(userPrompt).memories.map(({ id }) => id));
    return resultFor([]);
  };
  await dream(runner, { now: () => 100, dryRun: true });
  assert.ok(allMemories().every(({ last_dreamed_at }) => last_dreamed_at === null));
  assert.equal((await dream(runner, { now: () => 200 })).memoriesReviewed, 200);
  assert.equal((await dream(runner, { now: () => 300 })).memoriesReviewed, 200);
  assert.deepEqual(reviewed, [moreImportant, moreImportant, [...lessImportant, ...moreImportant.slice(0, 195)]]);
  for (const { id, updated_at, last_dreamed_at } of allMemories()) {
    assert.equal(updated_at, 1);
    assert.equal(last_dreamed_at, reviewed[2].includes(id) ? 300 : 200);
  }
});

test('CLI Dreamer pages past oversized memories and caps review at 200 selected rows', async (t) => {
  const { db, dream } = fixture(t);
  const { calls, spawnImpl } = spawnFixture();
  const runner = createCliLlmRunner({ orchestrator: 'codex', spawnImpl });
  const largerBudget = 32_000;
  const oversized = 'x'.repeat(Math.max(runner.promptBudget.limit, largerBudget) + 1);
  for (let index = 0; index < 200; index++) {
    addMemory(db, 'large-' + index, { content: index + oversized });
  }
  db.prepare("UPDATE memories SET importance = 5 WHERE id LIKE 'large-%'").run();
  const firstSmall = Array.from({ length: 5 }, (_, index) => 'small-' + index);
  for (const id of firstSmall) addMemory(db, id);
  assert.equal((await dream(runner, { now: () => 100 })).memoriesReviewed, 5);
  const argvPrompt = calls[0][1].at(-1);
  assert.deepEqual(JSON.parse(argvPrompt.slice(argvPrompt.indexOf('\n\n') + 2)).memories.map(({ id }) => id), firstSmall);

  const nextSmall = Array.from({ length: 200 }, (_, index) => 'next-' + String(index).padStart(3, '0'));
  for (const id of nextSmall) addMemory(db, id);
  // Use enough budget to distinguish the review cap from the Windows argv limit.
  const largerBudgetRunner = Object.assign(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).memories.map(({ id }) => id), nextSmall);
    return resultFor([]);
  }, { promptBudget: { limit: largerBudget, measure: (value) => value.length } });
  assert.equal((await dream(largerBudgetRunner, { now: () => 200 })).memoriesReviewed, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE id LIKE 'large-%' AND last_dreamed_at IS NOT NULL")
    .get().count, 0);
});

function workspaceFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'msmDream'));
  const dbPath = path.join(root, 'shared.db');
  const db = openDatabase(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const configOptions = { userConfigPath: path.join(root, 'user.yaml'), env: {} };
  function workspace(name, settings) {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    initGit(cwd);
    if (Object.keys(settings).length) writeProjectConfig(configOptions.userConfigPath, cwd, settings);
    return { cwd, projectKey: resolveProjectKey(cwd).projectKey, config: loadConfig({ cwd, ...configOptions }) };
  }
  const launched = [];
  const spawnDream = (_executable, _args, { env }) => {
    launched.push(JSON.parse(env.MULTI_SUB_MEMORY_AUTO_DREAM_CONTEXT));
    return { pid: 123 };
  };
  return { root, dbPath, db, configOptions, workspace, launched, spawnDream };
}

test('the engine records and throws only the safe diagnostic when a native CLI writes a secret to stderr', async (t) => {
  const { root, db, configOptions, workspace } = workspaceFixture(t);
  const script = path.join(root, 'stderr fixture.mjs');
  fs.writeFileSync(script, 'console.error("fixture-private-disk-secret"); process.exitCode = 7;');
  const cli = { orchestrator: 'codex', command: process.execPath, args: [script] };
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { enabled: true, mode: 'cli', cli } }));
  const { config, projectKey } = workspace('native-cli', {});
  const diagnostic = 'cli:codex process-exit code 7';
  await assert.rejects(runDream({ db, config, projectKey, userConfigPath: configOptions.userConfigPath }),
    { message: diagnostic });
  const run = db.prepare('SELECT status, error FROM dream_runs').get();
  assert.deepEqual({ ...run }, { status: 'failed', error: diagnostic });
});

test('a native CLI runner launches the PATH executable in the selected workspace', async (t) => {
  const { root, workspace } = workspaceFixture(t);
  const { cwd } = workspace('cli-workspace', {});
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const windows = process.platform === 'win32';
  const command = 'dreamer-cli-fixture';
  const filename = command + (windows ? '.exe' : '');
  const executable = path.join(bin, filename);
  for (const destination of [executable, path.join(cwd, filename)]) {
    fs.copyFileSync(process.execPath, destination);
    if (!windows) fs.chmodSync(destination, 0o700);
  }
  const script = path.join(root, 'report cwd.mjs');
  fs.writeFileSync(script, `
    const summary = JSON.stringify([process.execPath, process.cwd()]);
    console.log(JSON.stringify({ summary, operations: [] }));
  `);
  const options = { orchestrator: 'codex', command, args: [script], cwd };
  const pathKey = windows ? 'Path' : 'PATH';
  const runner = createCliLlmRunner({ ...options, env: { [pathKey]: ['', '.', bin].join(path.delimiter) } });
  const { plan } = await runner(prompt);
  const [launchedExecutable, isolatedCwd] = JSON.parse(plan.summary);
  assert.equal(launchedExecutable, executable);
  assert.notEqual(isolatedCwd, cwd);
  assert.ok(path.basename(isolatedCwd).startsWith('msm-dream-'));
  assert.equal(fs.existsSync(isolatedCwd), false);

  const missing = createCliLlmRunner({ ...options, env: { [pathKey]: ['', '.', 'bin'].join(path.delimiter) } });
  await assert.rejects(missing(prompt), { message: 'cli:codex spawn-error' });

  const relative = createCliLlmRunner({ ...options, command: './' + filename });
  await assert.rejects(relative(prompt), { message: 'cli:codex spawn-error' });
});

test('memory writes resolve automatic cadence for the selected workspace on a shared database', async (t) => {
  const { db, dbPath, root, configOptions, workspace, launched, spawnDream } = workspaceFixture(t);
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { http: autoConfig().dreamer.http } }));
  const a = workspace('a', { dbPath: path.join(root, 'other.db'), ...autoConfig(1) });
  const b = workspace('b', { dbPath, dreamer: { enabled: false } });
  const context = { config: { ...a.config, dbPath }, defaultCwd: a.cwd, configOptions, spawnDream };

  const { memory } = await writeMemory(db, { content: 'Project B fixture', cwd: b.cwd }, context);
  assert.equal(memory.project_key, b.projectKey);
  await setImmediate();
  assert.deepEqual(launched, []);

  await writeMemory(db, { content: 'Project A fixture', cwd: a.cwd },
    { ...context, config: b.config, defaultCwd: b.cwd });
  await setImmediate();
  assert.deepEqual(launched.map((entry) => [entry.projectKey, entry.dbPath]), [[a.projectKey, dbPath]]);
});

test('indexing triggers only targets with a known workspace and enabled Dreamer on a shared database', async (t) => {
  const { root, db, dbPath, configOptions, workspace, launched, spawnDream } = workspaceFixture(t);
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { http: autoConfig().dreamer.http } }));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir);
  const indexers = { omp: { sessionsDir } };
  const a = workspace('a', { dbPath, indexers, ...autoConfig(0) });
  const b = workspace('b', { dbPath, indexers, dreamer: { enabled: false } });
  const message = { type: 'message', message: { role: 'user', content: 'Fixture transcript' } };
  const session = (id, cwd) => fs.writeFileSync(path.join(sessionsDir, id + '.jsonl'),
    [JSON.stringify({ type: 'session', id, cwd }), JSON.stringify(message), ''].join('\n'));
  session('a', a.cwd);
  session('b', b.cwd);
  session('unknown');

  const index = (config) => runIndexers({ db, config, configOptions, spawnDream, orchestrators: ['omp'] });
  const first = await index(a.config);
  assert.deepEqual(first.errors, []);
  assert.equal(first.messagesIndexed, 3);
  assert.deepEqual(launched.map(({ projectKey }) => projectKey), [a.projectKey]);

  session('a-second', a.cwd);
  assert.equal((await index(b.config)).messagesIndexed, 1);
  assert.deepEqual(launched.map(({ projectKey }) => projectKey), [a.projectKey, a.projectKey]);
});

test('an incremental OMP append triggers Dreamer using the recorded workspace root when cadence is due', async (t) => {
  const { root, db, dbPath, configOptions, workspace, launched, spawnDream } = workspaceFixture(t);
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { http: autoConfig().dreamer.http } }));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir);
  const { cwd, projectKey, config } = workspace('target', { dbPath, ...autoConfig(1), indexers: { omp: { sessionsDir } } });
  const file = path.join(sessionsDir, 'fixture.jsonl');
  const message = (content) => JSON.stringify({ type: 'message', message: { role: 'user', content } }) + '\n';
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'fixture', cwd }) + '\n' + message('First message'));
  addMemory(db, 'fresh', { project: projectKey, time: Date.now() });
  db.prepare(`
    INSERT INTO dream_runs (id, project_key, runner, status, started_at, finished_at)
    VALUES ('fixture-run', ?, 'fixture', 'completed', 1, ?)
  `).run(projectKey, Date.now());
  const index = () => runIndexers({ db, config, configOptions, spawnDream, orchestrators: ['omp'] });
  const first = await index();
  assert.deepEqual(first.errors, []);
  assert.equal(first.messagesIndexed, 1);
  assert.deepEqual(launched, []);
  const getFile = db.prepare('SELECT project_root, byte_offset FROM transcript_files WHERE file_path = ?');
  const initial = getFile.get(file);
  assert.equal(initial.project_root, resolveProjectKey(cwd).projectRoot);

  db.prepare("UPDATE dream_runs SET finished_at = 2 WHERE id = 'fixture-run'").run();
  fs.appendFileSync(file, message('Appended without a session header'));
  const second = await index();
  assert.deepEqual(second.errors, []);
  assert.equal(second.filesReindexed, 0);
  assert.equal(second.messagesIndexed, 1);
  const updated = getFile.get(file);
  assert.equal(updated.project_root, initial.project_root);
  assert.ok(updated.byte_offset > initial.byte_offset);
  assert.deepEqual(launched.map((entry) => [entry.projectKey, entry.dbPath]), [[projectKey, dbPath]]);
});

test('an OMP append recovers a missing v2 workspace root only when the verified header matches the project key', async (t) => {
  const { root, db, dbPath, configOptions, workspace, launched, spawnDream } = workspaceFixture(t);
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { http: autoConfig().dreamer.http } }));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir);
  const a = workspace('matching', { dbPath, ...autoConfig(1), indexers: { omp: { sessionsDir } } });
  const b = workspace('different', { dbPath, ...autoConfig(1) });
  const session = (id, cwd) => JSON.stringify({ type: 'session', id, cwd }) + '\n';
  const message = (content) => JSON.stringify({ type: 'message', message: { role: 'user', content } }) + '\n';
  const matching = path.join(sessionsDir, 'matching.jsonl');
  const different = path.join(sessionsDir, 'different.jsonl');
  fs.writeFileSync(matching, session('matching', a.cwd) + message('First message in matching session'));
  fs.writeFileSync(different, session('different', b.cwd) + message('First message in different session'));
  const index = () => runIndexers({ db, config: a.config, configOptions, spawnDream, orchestrators: ['omp'] });
  assert.deepEqual((await index()).errors, []);
  assert.deepEqual(launched, []);

  const getFile = db.prepare('SELECT project_key, project_root, byte_offset, checkpoint_hash FROM transcript_files WHERE file_path = ?');
  const initialOffset = getFile.get(matching).byte_offset;
  assert.ok(initialOffset > 0);
  assert.ok(getFile.get(matching).checkpoint_hash);
  // Simulate migrated v2 checkpoints, including a file whose header resolves to another project.
  const setLegacyProject = db.prepare('UPDATE transcript_files SET project_root = NULL, project_key = ? WHERE file_path = ?');
  setLegacyProject.run(a.projectKey, matching);
  setLegacyProject.run(a.projectKey, different);
  addMemory(db, 'fresh', { project: a.projectKey, time: Date.now() });
  fs.appendFileSync(matching, message('Matching append'));
  fs.appendFileSync(different, message('Different append'));

  const result = await index();
  assert.deepEqual(result.errors, []);
  assert.equal(result.filesReindexed, 0);
  assert.equal(result.messagesIndexed, 2);
  assert.equal(getFile.get(matching).project_root, resolveProjectKey(a.cwd).projectRoot);
  assert.ok(getFile.get(matching).byte_offset > initialOffset);
  assert.equal(getFile.get(different).project_root, null);
  assert.equal(getFile.get(different).project_key, a.projectKey);
  assert.deepEqual(launched.map(({ projectKey, dbPath }) => [projectKey, dbPath]), [[a.projectKey, dbPath]]);
});

test('Claude indexes an inferred workspace without triggering Dreamer for that workspace', async (t) => {
  const { root, db, dbPath, configOptions, workspace, launched, spawnDream } = workspaceFixture(t);
  if (root.includes('-')) {
    t.skip('The temporary directory cannot round-trip through Claude folder encoding');
    return;
  }
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { http: autoConfig().dreamer.http } }));
  const sessionsDir = path.join(root, 'sessions');
  const source = workspace('source', { dbPath, indexers: { claude: { sessionsDir } } });
  const target = workspace('target', autoConfig(0));
  const folder = target.cwd.replace(':', '').replace(/[/\\]/g, '-');
  const transcriptDir = path.join(sessionsDir, folder);
  fs.mkdirSync(transcriptDir, { recursive: true });
  const file = path.join(transcriptDir, 'fixture.jsonl');
  const message = { type: 'user', message: { role: 'user', content: 'Fixture transcript' } };
  fs.writeFileSync(file, JSON.stringify(message) + '\n');

  const index = () => runIndexers({ db, config: source.config, configOptions, spawnDream, orchestrators: ['claude'] });
  const first = await index();
  assert.deepEqual(first.errors, []);
  assert.equal(first.messagesIndexed, 1);
  assert.equal(db.prepare('SELECT project_key FROM transcript_files WHERE file_path = ?').get(file).project_key,
    target.projectKey);
  assert.deepEqual(launched, []);

  fs.appendFileSync(file, JSON.stringify({ ...message, cwd: target.cwd }) + '\n');
  assert.equal((await index()).messagesIndexed, 1);
  assert.deepEqual(launched.map(({ projectKey }) => projectKey), [target.projectKey]);
});

test('repository YAML authorizes a Dreamer HTTP endpoint and its explicitly selected key', async (t) => {
  const { db, configOptions, workspace, launched, spawnDream } = workspaceFixture(t);
  const requests = [];
  const baseUrl = await serve(t, (req, res) => {
    requests.push(req.headers.authorization);
    res.end(JSON.stringify(completion()));
  });
  const apiKeyEnv = 'FIXTURE_DREAM_KEY';
  configOptions.env[apiKeyEnv] = 'fixture-credential';
  const settings = autoConfig(0).dreamer;
  const { cwd, config, projectKey } = workspace('project-http', {
    dreamer: { ...settings, http: { ...settings.http, baseUrl, apiKeyEnv } },
  });
  const untrusted = { dreamer: { ...config.dreamer, http: { ...config.dreamer.http, baseUrl: 'https://other.test/v1' } } };
  assert.throws(() => createDreamRunner(untrusted, { ...configOptions, cwd }), /HTTP endpoint and API key must be authorized/);
  assert.equal((await runDream({ db, config, projectKey, cwd, dryRun: true, ...configOptions })).status, 'dry-run');
  assert.deepEqual(requests, ['Bearer fixture-credential']);
  assert.equal(maybeTriggerAutoDream({
    db, config, cwd, projectKey, reloadProjectConfig: true, configOptions, spawnImpl: spawnDream,
  }), true);
  assert.deepEqual(launched.map((entry) => entry.projectKey), [projectKey]);
});

test('repository YAML authorizes CLI runners and rejects changed executable arguments', async (t) => {
  const { root, db, configOptions, workspace } = workspaceFixture(t);
  const script = path.join(root, 'runner.mjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify({ summary: "Fixture runner", operations: [] }));');
  const cli = { orchestrator: 'codex', command: process.execPath, args: [script] };
  const { cwd, config, projectKey } = workspace('project-cli', { dreamer: { enabled: true, mode: 'cli', cli } });
  const changed = { dreamer: { ...config.dreamer, cli: { ...cli, args: ['unexpected.mjs'] } } };
  assert.throws(() => createDreamRunner(changed, { ...configOptions, cwd }), /CLI orchestrator, command, and arguments must be authorized/);
  assert.equal((await runDream({ db, config, projectKey, cwd, ...configOptions })).summary, 'Fixture runner');
});

test('a native CLI runner starts with a serialized prompt from many long memories', async (t) => {
  const { root, db, configOptions, workspace } = workspaceFixture(t);
  const script = path.join(root, 'runner fixture.mjs');
  fs.writeFileSync(script, `
    const prompt = process.argv.at(-1);
    const { memories } = JSON.parse(prompt.slice(prompt.indexOf('\\n\\n') + 2));
    if (!memories.length) process.exit(8);
    if (process.platform !== 'win32' && Buffer.byteLength(prompt, 'utf8') > 96 * 1024) process.exit(9);
    console.log(JSON.stringify({ summary: String(memories.length), operations: [] }));
  `);
  const cli = { orchestrator: 'codex', command: process.execPath, args: [script] };
  fs.writeFileSync(configOptions.userConfigPath, JSON.stringify({ dreamer: { enabled: true, mode: 'cli', cli } }));
  const { config, projectKey } = workspace('native-cli', {});
  for (let index = 0; index < 60; index++) {
    addMemory(db, 'long-' + index, { project: projectKey, content: index + '界😀"\\'.repeat(400) });
  }
  const result = await runDream({ db, config, projectKey, userConfigPath: configOptions.userConfigPath });
  assert.equal(result.status, 'completed');
  assert.ok(result.memoriesReviewed > 0);
  assert.equal(Number(result.summary), result.memoriesReviewed);
  assert.ok(result.memoriesReviewed < 60);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM memories WHERE last_dreamed_at IS NOT NULL').get();
  assert.equal(count, result.memoriesReviewed);
});

test('POSIX CLI counts UTF-8 bytes and rejects a prompt one byte above the limit before spawn',
  { skip: process.platform === 'win32' }, async () => {
    const { calls, spawnImpl } = spawnFixture();
    const runner = createCliLlmRunner({ orchestrator: 'codex', spawnImpl });
    const userPrompt = '界'.repeat(32_767) + 'x';
    assert.equal(Buffer.byteLength('\n\n' + userPrompt), 96 * 1024);
    await runner({ systemPrompt: '', userPrompt });
    await assert.rejects(runner({ systemPrompt: '', userPrompt: userPrompt + 'y' }), { message: 'cli:codex spawn-error' });
    assert.equal(calls.length, 1);
  });

test('Windows CLI rejects a command that exceeds the quote-adjusted argument budget before spawn',
  { skip: process.platform !== 'win32' }, async () => {
    let spawnCalls = 0;
    const runner = createCliLlmRunner({
      orchestrator: 'codex', args: ['x'.repeat(8_000)], spawnImpl: () => { spawnCalls++; },
    });
    await assert.rejects(runner({ ...prompt, userPrompt: '"'.repeat(8_000) }), { message: 'cli:codex spawn-error' });
    assert.equal(spawnCalls, 0);
  });

function autoConfig(minNewMemories = 2) {
  return { dreamer: {
    enabled: true, mode: 'http', http: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' },
    cadence: { mode: 'auto', minIntervalHours: 1, minNewMemories },
  } };
}

test('auto cadence requires an enabled automatic backend, interval, and enough project changes', (t) => {
  const { db } = fixture(t);
  const config = autoConfig();
  const cadence = config.dreamer.cadence;
  const due = (settings, now = 3_600_100) => shouldTriggerAutoDream(db, settings, projectKey, now);
  assert.equal(due(config), false);
  addCompletedRun(db, 100);
  addMemory(db, 'old', { time: 100 });
  addMemory(db, 'new', { time: 101 });
  addMemory(db, 'unrelated', { time: 101, project: 'other-project' });
  addMemory(db, 'global', { time: 101, scope: 'global' });
  assert.equal(due(config), false);
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(102, 'old');
  assert.equal(due(config, 3_600_099), false);
  assert.equal(due(config), true);
  assert.equal(due({ dreamer: { ...config.dreamer, enabled: false } }), false);
  assert.equal(due({ dreamer: { ...config.dreamer, mode: 'disabled' } }), false);
  assert.equal(due({ dreamer: { ...config.dreamer, cadence: { ...cadence, mode: 'manual' } } }), false);
});

test('automatic cadence counts active memories created or updated during planning after the completion cooldown', async (t) => {
  const { db, dream, runs } = fixture(t);
  const config = autoConfig(2);
  let time = 100;
  addMemory(db, 'existing');
  await dream(({ userPrompt }) => {
    assert.deepEqual(JSON.parse(userPrompt).memories.map(({ id }) => id), ['existing']);
    addMemory(db, 'during-planning', { time: 150 });
    db.prepare("UPDATE memories SET updated_at = 175 WHERE id = 'existing'").run();
    time = 200;
    return resultFor([]);
  }, { now: () => time });
  assert.equal(runs()[0].finished_at, 200);
  assert.equal(shouldTriggerAutoDream(db, config, projectKey, 3_600_199), false);
  assert.equal(shouldTriggerAutoDream(db, config, projectKey, 3_600_200), true);
});

test('the last completed Dreamer run cannot satisfy its own automatic memory threshold', async (t) => {
  const { db, dream } = fixture(t);
  addTranscript(db);
  for (const id of ['a', 'b', 'c']) addMemory(db, id);
  let time = 100;
  await dream(() => {
    time = 200;
    return resultFor([
      { type: 'merge', source_ids: ['a', 'b'], content: 'Consolidated fixture' },
      { type: 'update', id: 'c', importance: 5 },
      { type: 'add', content: 'Transcript-supported fixture' },
    ]);
  }, { now: () => time });
  addMemory(db, 'archived', { status: 'archived', time: 250 });
  const config = autoConfig(1);
  assert.equal(shouldTriggerAutoDream(db, config, projectKey, 3_600_200), false);
  db.prepare("UPDATE memories SET updated_at = 300 WHERE id = 'c'").run();
  assert.equal(shouldTriggerAutoDream(db, config, projectKey, 3_600_200), true);
});

test('opportunistic trigger skips held leases and spawns a quiet detached child with the indexed project key', (t) => {
  const { db, dbPath, configOptions, workspace } = workspaceFixture(t);
  const { cwd, config, projectKey } = workspace('auto', { ...autoConfig(0), dbPath: 'fixture.db' });
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 123, unref: () => calls.push('unref') });
  const spawnImpl = (...args) => { calls.push(args); return child; };
  const options = { db, config, projectKey, cwd, configOptions, spawnImpl, cliPath: 'fixture-cli.mjs' };
  acquireLease(db, 'dream:' + projectKey, 'active', 600_000);
  assert.equal(maybeTriggerAutoDream(options), false);
  assert.deepEqual(calls, []);
  releaseLease(db, 'dream:' + projectKey, 'active');
  assert.equal(maybeTriggerAutoDream(options), true);
  const [[executable, args, spawnOptions], unref] = calls;
  assert.equal(executable, process.execPath);
  assert.deepEqual(args, ['fixture-cli.mjs', 'dream']);
  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.stdio, 'ignore');
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.cwd, cwd);
  assert.deepEqual(JSON.parse(spawnOptions.env.MULTI_SUB_MEMORY_AUTO_DREAM_CONTEXT), {
    dbPath, projectKey,
  });
  assert.equal(unref, 'unref');
  assert.doesNotThrow(() => child.emit('error', new Error('fixture async spawn failure')));
  assert.equal(maybeTriggerAutoDream({ ...options, spawnImpl: () => { throw new Error('fixture spawn failure'); } }), false);
  assert.equal(maybeTriggerAutoDream({ ...options, db: null }), false);
});

function noteChain(db, id, progressCount, project = projectKey) {
  db.prepare(`
    INSERT INTO notes (id, project_key, status, content, created_at, updated_at)
    VALUES (?, ?, 'pending', 'Note topic', 1, 1)
  `).run(id, project);
  updateNote(db, { id, status: 'active', comment: 'Transition reason' });
  const progress = Array.from({ length: progressCount }, (_, index) =>
    addNoteComment(db, { id, body: 'Progress ' + (index + 1) }).comment);
  const comments = () => listNoteComments(db, id).comments;
  return { progress, comments, transition: comments().find(({ from_status }) => from_status) };
}

test('Dreamer compacts eligible standalone chains to three or one and keeps transitions intact', async (t) => {
  const { db, dream, runs } = fixture(t);
  const full = noteChain(db, 'full', 5);
  const partial = noteChain(db, 'partial', 6);
  const small = noteChain(db, 'small', 4);
  const unrelated = noteChain(db, 'unrelated', 5, 'other-project');
  const summary = 'Consolidated fixture progress';
  const operations = [
    { type: 'compact_note_comments', note_id: 'full', source_comment_ids: full.progress.map(({ id }) => id), summary },
    { type: 'compact_note_comments', note_id: 'partial', source_comment_ids: partial.progress.slice(0, 4).map(({ id }) => id), summary },
  ];
  const runner = ({ systemPrompt, userPrompt }) => {
    assert.match(systemPrompt, /compact_note_comments/);
    const { notes } = JSON.parse(userPrompt);
    assert.deepEqual(notes.map(({ id }) => id).sort(), ['full', 'partial']);
    assert.ok(notes.every(({ comments }) => comments.every(({ body }) => /^Progress /.test(body))));
    return resultFor(operations);
  };
  const originalComments = [full, partial, small, unrelated].map(({ comments }) => comments());
  const before = getNote(db, 'full');
  const proposal = await dream(runner, { dryRun: true });
  assert.deepEqual(proposal.operations, operations);
  assert.equal(runs().at(-1).status, 'dry-run');
  assert.deepEqual([full, partial, small, unrelated].map(({ comments }) => comments()), originalComments);
  assert.deepEqual(getNote(db, 'full'), before);

  const applied = await dream(runner);
  assert.equal(applied.status, 'completed');
  assert.ok(getNote(db, 'full').updated_at > before.updated_at);
  for (const [index, chain, expected] of [[0, full, 1], [1, partial, 3]]) {
    const comments = chain.comments();
    assert.equal(comments.filter(({ from_status }) => from_status === null).length, expected);
    assert.deepEqual(comments.find(({ from_status }) => from_status), chain.transition);
    const compacted = comments.find(({ compacted_from_json }) => compacted_from_json);
    assert.equal(compacted.body, summary);
    assert.equal(compacted.source_orchestrator, 'dreamer');
    assert.deepEqual(JSON.parse(compacted.compacted_from_json), {
      run_id: applied.runId, source_comment_ids: operations[index].source_comment_ids,
    });
  }
  assert.deepEqual(small.comments(), originalComments[2]);
  assert.deepEqual(unrelated.comments(), originalComments[3]);
});

test('Dreamer rejects transition sources and rolls back compaction when comment revisions change', async (t) => {
  const { db, dream, runs } = fixture(t);
  const first = noteChain(db, 'first', 5);
  const other = noteChain(db, 'other', 5);
  const [source] = other.progress;
  const plan = (note_id, source_comment_ids) =>
    ({ type: 'compact_note_comments', note_id, source_comment_ids, summary: 'Fixture summary' });
  const otherIds = other.progress.map(({ id }) => id);
  const firstBefore = first.comments();
  await assert.rejects(dream(() => resultFor([plan('other', [...otherIds, other.transition.id])])),
    /unreviewed progress comment/);
  await assert.rejects(dream(() => {
    updateNoteComment(db, { note_id: 'other', id: source.id, body: 'Human edit' });
    return resultFor([plan('first', first.progress.map(({ id }) => id)), plan('other', otherIds)]);
  }), /comment chain changed/);
  assert.deepEqual(first.comments(), firstBefore);
  const comments = other.comments();
  assert.equal(comments.length, 6);
  assert.equal(comments.find(({ id }) => id === source.id).body, 'Human edit');
  assert.ok(comments.every(({ compacted_from_json }) => compacted_from_json === null));
  assert.equal(runs().at(-1).status, 'failed');
});

test('Dreamer rejects a comment summary planned before a human topic edit', async (t) => {
  const { db, dream, runs } = fixture(t);
  const id = 'edited-topic';
  const chain = noteChain(db, id, 5);
  const original = chain.comments();
  const revisedContent = 'Human rewrite during planning';
  await assert.rejects(dream(({ userPrompt }) => {
    const [topic] = JSON.parse(userPrompt).notes;
    assert.equal(topic.id, id);
    assert.equal(topic.content, 'Note topic');
    updateNote(db, { id, content: revisedContent });
    return resultFor([{
      type: 'compact_note_comments', note_id: id,
      source_comment_ids: chain.progress.map(({ id }) => id), summary: 'Summary of the prior topic',
    }]);
  }), /reviewed note topic changed/);
  assert.equal(getNote(db, id).content, revisedContent);
  assert.deepEqual(chain.comments(), original);
  assert.equal(runs().at(-1).status, 'failed');
});
