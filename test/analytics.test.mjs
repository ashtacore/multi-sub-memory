import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildAnalyticsReport, comparisonBuckets, createTelemetryRecorder, estimateTokens, formatAnalyticsExport,
  readCcusage, rollupAndPruneAnalytics,
} from '../src/analytics.mjs';
import { loadConfig } from '../src/config.mjs';
import { hashNormalizedContent, MIGRATIONS, openDatabase, runMigrations } from '../src/db.mjs';
import { runDream } from '../src/dreamer/engine.mjs';
import { createCliLlmRunner, createHttpLlmRunner } from '../src/dreamer/runners.mjs';
import { runIndexers } from '../src/indexers/runner.mjs';
import { recordAccess, updateMemory, updateNote, writeMemory, writeNote } from '../src/memory-service.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';
import { startDashboardServer } from '../src/ui/server.mjs';
import { initGit } from './git-fixtures.mjs';

const day = 86_400_000;
const now = Date.parse('2026-03-18T12:00:00Z');
const sampleTime = Date.parse('2026-03-17T12:00:00Z');
const iso = (timestamp) => new Date(timestamp).toISOString();
const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

function tempDir(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'msm-analytics-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function withDb(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function memoryFixture(db, projectKey, id, content, { createdAt = sampleTime, accesses = 0, compactions = 0 } = {}) {
  db.prepare(`
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, created_at, updated_at,
      access_count, compaction_count)
    VALUES (?, ?, 'project', 'GENERAL', ?, ?, ?, ?, ?, ?)
  `).run(id, projectKey, content, hashNormalizedContent(content), createdAt, createdAt, accesses, compactions);
}

test('migration 11 upgrades v10, backfills estimates and can run twice', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const { version, up } of MIGRATIONS.filter(({ version }) => version < 11)) {
    up(db);
    db.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(version);
  }
  db.exec(`
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, created_at, updated_at)
      VALUES ('memory', 'global', 'global', 'GENERAL', 'abcde', 'fixture', 1, 1);
    INSERT INTO notes (id, project_key, content, created_at, updated_at) VALUES ('note','global','abcdefghi',1,1);
  `);
  runMigrations(db);
  MIGRATIONS.find(({ version }) => version === 11).up(db);
  runMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 11').get().count, 1);
  assert.deepEqual({ ...db.prepare('SELECT tokens_est, compaction_count, dreamer_touched_at FROM memories').get() },
    { tokens_est: 2, compaction_count: 0, dreamer_touched_at: null });
  assert.equal(db.prepare('SELECT tokens_est FROM notes').get().tokens_est, 3);
  assert.equal((await updateMemory(db, { id: 'memory', content: 'one' })).tokens_est, 1);
  assert.equal(updateNote(db, { id: 'note', content: 'updated' }).tokens_est, 2);
  const cwd = initGit(tempDir(t));
  assert.equal(writeNote(db, { content: 'test note' }, { defaultCwd: cwd }).tokens_est, 3);
  assert.equal((await writeMemory(db, { scope: 'global', content: 'remember this' })).memory.tokens_est, 4);
  assert.equal(estimateTokens('🙂🙂🙂'), 2);
  assert.throws(() => db.exec('UPDATE memories SET compaction_count = -1'), /CHECK/);
  assert.throws(() => db.exec(`
    INSERT INTO mcp_tool_events
      (project_key, connection_id, tool_name, duration_ms, created_at) VALUES ('p','c','mem_search',-1,1)
  `), /CHECK/);
});

test('migration 12 corrects first-search re-search flags and preserves post-get follow-ups', async (t) => {
  const db = withDb(t);
  db.exec('DELETE FROM schema_migrations WHERE version = 12');
  memoryFixture(db, 'project', 'compacted', 'fixture', { compactions: 1 });
  db.prepare(`
    INSERT INTO dreamer_memory_events (project_key, memory_id, event_type, created_at)
    VALUES ('project', 'compacted', 'compacted', ?)
  `).run(sampleTime - day);
  const insert = db.prepare(`
    INSERT INTO mcp_tool_events (project_key, connection_id, tool_name, duration_ms, target_memory_id, query_hash, is_research, created_at)
    VALUES ('project', 'connection', ?, 1, ?, ?, ?, ?)
  `);
  insert.run('mem_get', 'compacted', null, 0, sampleTime);
  insert.run('mem_search', null, 'first-hash', 1, sampleTime + 1);
  insert.run('mem_search', null, 'first-hash', 1, sampleTime + 2);
  runMigrations(db);
  const searches = db.prepare("SELECT is_research FROM mcp_tool_events WHERE tool_name = 'mem_search' ORDER BY id").all();
  assert.deepEqual(searches.map(({ is_research }) => is_research), [0, 1]);
  assert.equal(db.prepare("SELECT research_count FROM analytics_daily_rollups WHERE tool_name = 'mem_search'").get().research_count, 1);
  const report = await buildAnalyticsReport(db, { now, includeSessions: false, projectKey: 'project' });
  assert.equal(report.quality.researchRate, 0.5);
  assert.equal(report.dreamer.compactedGetResearchRate, 1);
});

test('analytics retention defaults to 93 and validates its bounds', () => {
  const load = (analytics) => loadConfig({ cwd: null, env: {}, userConfigData: { analytics } }).analytics.retention_days;
  assert.equal(load(undefined), 93);
  assert.equal(load({ retention_days: 7 }), 7);
  assert.equal(load({ retention_days: 3650 }), 3650);
  for (const retention_days of [6, 7.5, '93', 3651]) assert.throws(() => load({ retention_days }), /retention_days/);
});

test('stdio records all core tools passively and flushes at EOF without stray output', { timeout: 20_000 }, async (t) => {
  const cwd = initGit(tempDir(t));
  const dbPath = path.join(cwd, 'fixture.sqlite');
  const nonRepo = tempDir(t);
  const probeMarker = path.join(nonRepo, 'unexpected-git');
  const ageMarker = path.join(nonRepo, 'age-workspace-cache');
  const preload = path.join(cwd, 'slow-git.cjs');
  writeFileSync(preload, `
    const childProcess = require('node:child_process');
    const realSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      if (command === 'git' && options.cwd === ${JSON.stringify(nonRepo)}) {
        require('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'probe');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
      }
      return realSpawnSync(command, args, options);
    };
    require('node:module').syncBuiltinESMExports();
    const performanceNow = performance.now.bind(performance);
    performance.now = () => performanceNow()
      + (require('node:fs').existsSync(${JSON.stringify(ageMarker)}) ? 6000 : 0);
  `);
  const child = spawn(process.execPath, ['--require', preload, cli, 'serve', '--cwd', cwd], {
    cwd, windowsHide: true, stdio: 'pipe',
    env: {
      ...process.env, MULTI_SUB_MEMORY_DB: dbPath, MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
      MULTI_SUB_MEMORY_CONFIG: path.join(cwd, 'absent.yaml'), MULTI_SUB_MEMORY_SESSION_ID: 'fixture-session',
    },
  });
  const exited = once(child, 'close');
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  let id = 0;
  function send(method, params, requestId) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id: requestId }) + '\n');
  }
  async function request(method, params) {
    const expected = ++id;
    send(method, params, expected);
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    const response = JSON.parse(line.value);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, expected);
    assert.equal(response.error, undefined);
    return response.result;
  }
  const call = (name, args) => request('tools/call', { name, arguments: args });
  const write = async (content, scope) =>
    JSON.parse((await call('mem_memory', { action: 'write', content, scope })).content[0].text).memory.id;
  const get = (memoryId) => call('mem_memory', { action: 'get', id: memoryId });
  await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'analytics-fixture', version: '1' },
  });
  send('notifications/initialized');
  const names = (await request('tools/list', {})).tools.map(({ name }) => name).sort();
  assert.deepEqual(names, ['mem_bootstrap', 'mem_expand', 'mem_memory', 'mem_note', 'mem_search']);
  const direct = await write('fixture for a direct read');
  const first = await write('fixture shared search phrase alpha');
  const second = await write('fixture shared search phrase beta', 'global');
  const read = await call('mem_memory', { action: 'get', id: direct, cwd: nonRepo });
  assert.equal(JSON.parse(read.content[0].text).id, direct);
  let pingTimeout;
  try {
    await Promise.race([
      request('ping', {}),
      new Promise((_, reject) => {
        pingTimeout = setTimeout(() => reject(new Error('Git discovery blocked the second stdio request')), 2500);
      }),
    ]);
  } finally {
    clearTimeout(pingTimeout);
  }
  await call('mem_bootstrap', {});
  await get(first);
  const result = JSON.parse((await call('mem_search', { query: 'shared search phrase', sources: ['memory'] })).content[0].text);
  const rank = result.results.findIndex(({ id: hit }) => hit === second) + 1;
  assert.ok(rank > 0);
  writeFileSync(ageMarker, '');
  await get(second);
  await call('mem_search', { query: 'a separate query' });
  await call('mem_search', { query: 'phrase SHARED search!', sources: ['memory'] });
  await call('mem_note', { action: 'read' });
  await call('mem_memory', { action: 'update', id: direct, importance: 3 });
  await call('mem_memory', { action: 'archive', id: direct });
  await call('mem_memory', { action: 'list' });
  assert.equal((await call('mem_expand', { session_id: 'missing-fixture' })).isError, true);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null], stderr);
  assert.equal((await lines.next()).done, true);
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM mcp_tool_events ORDER BY id').all();
    assert.equal(existsSync(probeMarker), false, 'get-by-ID telemetry must not launch Git on a cache miss');
    assert.equal(rows.length, 15);
    assert.deepEqual(rows.filter(({ tool_name }) => tool_name.startsWith('mem_memory:'))
      .map(({ tool_name, error_flag }) => [tool_name, error_flag]),
    [['mem_memory:update', 0], ['mem_memory:archive', 0], ['mem_memory:list', 0]]);
    assert.equal(new Set(rows.map(({ connection_id }) => connection_id)).size, 1);
    assert.ok(rows.every(({ session_id, duration_ms }) => session_id === 'fixture-session' && duration_ms >= 0));
    assert.deepEqual(rows.filter(({ tool_name }) => tool_name === 'mem_get')
      .map(({ origin, search_rank }) => [origin, search_rank]), [['direct', null], ['bootstrap', null], ['search', rank]]);
    const searches = rows.filter(({ tool_name }) => tool_name === 'mem_search');
    assert.deepEqual(searches.map(({ is_research }) => is_research), [0, 1, 1]);
    assert.equal(searches[0].query_hash, searches[2].query_hash);
    assert.match(searches[0].query_hash, /^[a-f\d]{16}$/);
    assert.deepEqual(JSON.parse(searches[0].returned_memory_ids_json), result.results.map(({ id: hit }) => hit));
    assert.ok(rows.find(({ tool_name }) => tool_name === 'mem_expand').error_flag);
    assert.ok(rows.find(({ tool_name }) => tool_name === 'mem_note'));
  } finally {
    db.close();
  }
});

test('recorder attribution expires, respects the project, and fails open on a closed database', (t) => {
  const db = withDb(t);
  const recorder = createTelemetryRecorder(db, { now: () => now, env: { CODEX_SESSION_ID: 'fixture' } });
  const record = (toolName, extra = {}) => recorder.record({ projectKey: 'one', toolName, createdAt: sampleTime, ...extra });
  record('mem_search', { query: 'distinctive search', returnedMemories: [{ id: 'item', rank: 3 }], resultCount: 1 });
  record('mem_get', { projectKey: 'two', targetMemoryId: 'item' });
  record('mem_get', { targetMemoryId: 'item', createdAt: sampleTime + 60_001 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mcp_tool_events').get().count, 0);
  recorder.flush();
  assert.deepEqual(db.prepare("SELECT origin FROM mcp_tool_events WHERE tool_name = 'mem_get' ORDER BY id")
    .all().map(({ origin }) => origin), ['direct', 'direct']);
  recorder.close();
  const another = openDatabase(':memory:');
  const optional = createTelemetryRecorder(another);
  another.close();
  optional.record({ projectKey: 'one', toolName: 'mem_note' });
  assert.doesNotThrow(() => optional.close());
});

test('UTC windows exclude today and align complete weeks, calendar months, and rolling months', () => {
  assert.deepEqual(comparisonBuckets('7d', 'calendar', now).map(({ label }) => label), [
    '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15', '2026-03-16', '2026-03-17',
  ]);
  const weeks = comparisonBuckets('3w', 'calendar', now);
  assert.deepEqual(weeks.map(({ label }) => label), ['2026-02-23', '2026-03-02', '2026-03-09']);
  assert.ok(weeks.every(({ start, end }) => end - start === 7 * day));
  assert.deepEqual(comparisonBuckets('2m', 'calendar', Date.parse('2024-03-31T22:00Z'))
    .map(({ label, start, end }) => [label, (end - start) / day]), [['2024-01', 31], ['2024-02', 29]]);
  const rolling = comparisonBuckets('2m', 'rolling30', now);
  assert.equal(rolling[0].end, rolling[1].start);
  assert.equal(rolling[1].end - rolling[0].start, 60 * day);
  assert.equal(iso(rolling[1].end), '2026-03-18T00:00:00.000Z');
});

test('daily rollup is repeatable and expires only rows before the UTC retention boundary', async (t) => {
  const db = withDb(t);
  const cutoff = Math.floor(now / day) * day - 93 * day;
  const insert = db.prepare(`
    INSERT INTO mcp_tool_events (project_key, connection_id, tool_name, duration_ms, response_tokens_est,
      result_count, origin, search_rank, is_research, error_flag, created_at)
      VALUES ('fixture', 'connection', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('mem_note', 1, 2, 0, null, null, 0, 0, cutoff - 1);
  rollupAndPruneAnalytics(db, { now: cutoff + 90 * day });
  insert.run('mem_note', 2, 4, 0, null, null, 0, 0, cutoff);
  insert.run('mem_search', 1, 3, 0, null, null, 1, 0, sampleTime);
  insert.run('mem_search', 3, 8, 5, null, null, 0, 0, sampleTime + 10);
  insert.run('mem_search', 2, 6, 0, null, null, 0, 1, sampleTime + 15);
  insert.run('mem_get', 1, 3, 1, 'search', 2, 0, 0, sampleTime + 20);
  rollupAndPruneAnalytics(db, { now });
  rollupAndPruneAnalytics(db, { now });
  assert.equal(db.prepare('SELECT MIN(created_at) AS cutoff FROM mcp_tool_events').get().cutoff, cutoff);
  assert.equal(db.prepare('SELECT MIN(day_utc) AS cutoff FROM analytics_daily_rollups').get().cutoff, iso(cutoff).slice(0, 10));
  const row = db.prepare("SELECT * FROM analytics_daily_rollups WHERE tool_name = 'mem_search'").get();
  assert.deepEqual([row.call_count, row.error_count, row.total_duration_ms, row.max_duration_ms, row.total_response_tokens,
    row.total_results, row.zero_result_count, row.research_count], [3, 1, 6, 3, 17, 5, 1, 1]);
  const report = await buildAnalyticsReport(db, { now, retentionDays: 7, window: '2m', includeSessions: false });
  assert.equal(report.series[0].completeTelemetry, false);
});

test('bucket attribution crosses UTC midnight and raw events share a snapshot with totals', async (t) => {
  const db = withDb(t);
  const recorder = createTelemetryRecorder(db, { now: () => now, env: {} });
  const midnight = Math.floor(sampleTime / day) * day;
  const record = (toolName, createdAt, extra = {}) =>
    recorder.record({ projectKey: 'project', toolName, createdAt, ...extra });
  record('mem_search', midnight - 100, { resultCount: 1, query: 'fixture', returnedMemories: [{ id: 'fixture', rank: 1 }] });
  record('mem_get', midnight + 100, { targetMemoryId: 'fixture', resultCount: 1 });
  recorder.flush();
  const report = await buildAnalyticsReport(db, { now, ccusageRunner: () => {
    record('mem_note', midnight + 200);
    recorder.flush();
    return { sessions: [] };
  } });
  assert.equal(report.series.at(-2).quality.searchToGetConversionRate, 1);
  assert.equal(report.series.at(-1).quality.getOrigins.search, 1);
  assert.equal(report.series.at(-1).totals.calls, 1);
  assert.equal(report.series.at(-1).speedAndTokens.tools.mem_note, undefined);
  recorder.close();
});

test('uncertain overlaps stay out of the no-memory cost cohort', async (t) => {
  const db = withDb(t);
  for (const name of ['a', 'b', 'dormant']) {
    const id = db.prepare(`
      INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, last_indexed_at)
      VALUES (?, 'claude', ?, 'project', 0, 0)
    `).run('fixture-' + name, name).lastInsertRowid;
    const add = db.prepare(`
      INSERT INTO transcript_messages (file_id, seq, role, timestamp, text, line_no) VALUES (?, ?, ?, ?, 'fixture', ?)
    `);
    const dormant = name === 'dormant';
    add.run(id, 0, 'user', iso(sampleTime - (dormant ? 10 * day : 1000)), 1);
    add.run(id, 1, 'assistant', iso(sampleTime + (dormant ? 2 * day : 1000)), 2);
  }
  const recorder = createTelemetryRecorder(db, { now: () => now, env: {} });
  recorder.record({ projectKey: 'project', toolName: 'mem_search', createdAt: sampleTime });
  recorder.close();
  const report = await buildAnalyticsReport(db, {
    now, projectKey: 'project', ccusageRunner: () => ({ sessions: [{ sessionId: 'a', totalCost: 1 }] }),
  });
  assert.equal(report.cost.cohorts.no.sessionCount, 0);
  assert.equal(report.cost.uncorrelatedCallCount, 1);
  assert.equal(report.cost.unclassifiedSessionCount, 2);
  assert.equal(report.cost.available, false);
  assert.equal(report.cost.adapterAvailable, true);
});

test('ccusage reads both JSON report shapes, degrades gracefully, and shares in-flight reads', async () => {
  let calls = 0;
  const runner = async (args, options) => {
    calls++;
    assert.ok(args.includes('--json') && args.includes('--offline'));
    assert.equal(options.env.DO_NOT_TRACK, '1');
    return { stdout: JSON.stringify({ session: [
      { period: 'codex-session', agent: 'codex', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, totalCost: 0.1 },
      { period: '2026\\03\\17\\rollout-2026-03-17T12-00-00-abcdef01-2345-6789-abcd-ef0123456789.jsonl', agent: 'codex', inputTokens: 0 },
      { sessionId: 'abcdef01-2345-6789-abcd-ef0123456789', agent: 'claude', inputTokens: 0 },
    ] }) };
  };
  const [first, second] = await Promise.all([readCcusage({ runner }), readCcusage({ runner })]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(first.sessions.get('codex-session'), {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: null, costUsd: 0.1,
  });
  assert.equal(first.sessions.has('abcdef01-2345-6789-abcd-ef0123456789'), false);
  const focused = await readCcusage({ runner: () => ({ sessions: [{ session_id: 'focused', input_tokens: 42 }] }) });
  assert.equal(focused.sessions.get('focused').inputTokens, 42);
  const missing = await readCcusage({ runner: () => ({ sessions: [] }) });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /No local/);
  const failed = await readCcusage({ runner: () => { throw Error('D:/private/secret.jsonl'); } });
  assert.equal(failed.available, false);
  assert.doesNotMatch(failed.reason, /private|secret/);
});

test('bundled ccusage joins Codex rollouts and bare Claude session IDs', async (t) => {
  const require = createRequire(import.meta.url);
  const fromCcusage = createRequire(require.resolve('ccusage/package.json'));
  const binary = fromCcusage.resolve(`@ccusage/ccusage-${process.platform}-${process.arch}/bin/ccusage${process.platform === 'win32' ? '.exe' : ''}`);
  const cwd = initGit(tempDir(t));
  const db = withDb(t);
  const codexHome = path.join(cwd, '.codex');
  const claudeHome = path.join(cwd, '.claude');
  const codexSessions = path.join(codexHome, 'sessions');
  const datedSessions = path.join(codexSessions, '2026', '03', '17');
  const claudeProject = path.join(claudeHome, 'projects', 'fixture');
  mkdirSync(datedSessions, { recursive: true });
  mkdirSync(claudeProject, { recursive: true });
  const codexId = '01234567-89ab-7def-8123-456789abcdef';
  const claudeId = '87654321-89ab-7def-8123-456789abcdef';
  const rollout = 'rollout-2026-03-17T12-00-00-' + codexId;
  const timestamp = iso(sampleTime);
  const counts = { input_tokens: 110, cached_input_tokens: 10, output_tokens: 20, total_tokens: 130 };
  writeFileSync(path.join(datedSessions, rollout + '.jsonl'), [
    { type: 'session_meta', payload: { id: codexId, cwd, timestamp, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-5', cwd } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts, last_token_usage: counts } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture' }] } },
  ].map((item) => JSON.stringify({ timestamp, ...item })).join('\n') + '\n');
  writeFileSync(path.join(claudeProject, claudeId + '.jsonl'), JSON.stringify({
    type: 'assistant', timestamp, sessionId: claudeId, cwd, requestId: 'fixture-request',
    message: { id: 'fixture-message', role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 40, output_tokens: 8 },
      content: [{ type: 'text', text: 'fixture' }] },
  }) + '\n');
  const index = await runIndexers({
    db, config: { indexers: { enabled: true, codex: { sessionsDir: codexSessions }, claude: { sessionsDir: path.dirname(claudeProject) } } },
    orchestrators: ['codex', 'claude'],
  });
  assert.deepEqual(index.errors, []);
  const runner = async (args, options) => {
    return (await promisify(execFile)(binary, args, {
      ...options, cwd, env: {
        ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
        HOME: cwd, USERPROFILE: cwd, APPDATA: cwd, LOCALAPPDATA: cwd,
        XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd, XDG_CACHE_HOME: cwd,
        CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, DO_NOT_TRACK: '1',
      },
    })).stdout;
  };
  const flags = ['session', '--json', '--offline', '--timezone', 'UTC', '--no-color'];
  const { session } = JSON.parse(await runner(flags, { timeout: 4000, windowsHide: true }));
  assert.ok(session.some(({ agent, period }) => agent === 'codex' && period === '2026/03/17/' + rollout));
  const result = await readCcusage({ runner });
  assert.ok(result.sessions.get(codexId).costUsd > 0);
  assert.equal(result.sessions.get(claudeId).outputTokens, 8);
  const report = await buildAnalyticsReport(db, { now, ccusageRunner: runner });
  assert.equal(report.cost.matchedSessionCount, 2);
});

test('indexed Codex call IDs correlate sessions and measure only matched detours', async (t) => {
  const db = withDb(t);
  const cwd = initGit(tempDir(t));
  const projectKey = resolveProjectKey(cwd).projectKey;
  const sessionsDir = path.join(cwd, 'sessions');
  mkdirSync(sessionsDir);
  function record(type, payload, offset) {
    return { type, payload, timestamp: iso(sampleTime + offset) };
  }
  function transcript(sessionId, offset, lines) {
    writeFileSync(path.join(sessionsDir, sessionId + '.jsonl'),
      [record('session_meta', { id: sessionId, cwd }, offset), ...lines].map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  const turn = (text, offset) => record('response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
  }, offset);
  transcript('memory-session', 0, [
    record('response_item', { type: 'function_call', name: 'mcp__multi_sub_memory__mem_search', call_id: 'match' }, 0),
    record('response_item', { type: 'function_call_output', call_id: 'other', output: 'Ignore' }, 50),
    record('response_item', { type: 'function_call_output', call_id: 'match', output: 'Private result' }, 200),
    turn('An assistant reply', 800),
    ...['mem_note', 'mem_memory:write', 'mem_memory:list', 'mem_memory:get'].flatMap((operation, index) => {
      const [name, action] = operation.split(':');
      const offset = (index + 1) * 1000;
      return [
        record('response_item', {
          type: 'function_call', name: 'mcp__multi_sub_memory__' + name,
          call_id: operation, arguments: JSON.stringify({ action, id: 'private-argument' }),
        }, offset),
        record('response_item', { type: 'function_call_output', call_id: operation, output: 'Private result' }, offset + 200),
        turn('A subsequent assistant reply', offset + 800),
      ];
    }),
  ]);
  transcript('no-memory-session', 3 * 60_000, [turn('A later session', 3 * 60_000)]);
  const index = await runIndexers({ db, config: { indexers: { enabled: true, codex: { sessionsDir } } }, orchestrators: ['codex'] });
  assert.deepEqual(index.errors, []);
  assert.equal(index.messagesIndexed, 11, 'standalone Codex results remain outside searchable transcript messages');
  const messageIds = db.prepare('SELECT id FROM transcript_messages ORDER BY id').all();
  db.exec("UPDATE transcript_tool_activity SET activity_json = replace(activity_json, ',\"action\":\"get\"', '')");
  db.exec('DELETE FROM schema_migrations WHERE version = 12');
  runMigrations(db);
  assert.equal(db.prepare('SELECT MAX(tool_activity_indexed) AS indexed FROM transcript_files').get().indexed, 0);
  const skipped = await runIndexers({
    db, config: { indexers: { enabled: true, codex: { sessionsDir } } }, orchestrators: ['codex'],
  });
  assert.deepEqual(skipped.errors, []);
  assert.equal(skipped.messagesIndexed, 0);
  assert.deepEqual(db.prepare('SELECT id FROM transcript_messages ORDER BY id').all(), messageIds);
  const activity = db.prepare('SELECT activity_json FROM transcript_tool_activity').all()
    .flatMap(({ activity_json }) => JSON.parse(activity_json));
  assert.deepEqual(activity.filter(({ action }) => action), [
    { type: 'call', callId: 'mem_memory:get', name: 'mcp__multi_sub_memory__mem_memory', action: 'get' },
  ]);
  assert.doesNotMatch(JSON.stringify(activity), /private-argument/);
  const recorder = createTelemetryRecorder(db, { now: () => now, env: {} });
  recorder.record({ projectKey, toolName: 'mem_search', createdAt: sampleTime - 3 * 60 * 60_000, responseText: 'distant morning' });
  recorder.record({ projectKey, toolName: 'mem_search', createdAt: sampleTime + 100, responseText: '12345678' });
  recorder.record({ projectKey, toolName: 'mem_search', createdAt: sampleTime + 5 * 60 * 60_000, responseText: 'distant afternoon' });
  recorder.close();
  const report = await buildAnalyticsReport(db, {
    projectKey, now, ccusageRunner: () => ({ session: [
      { period: 'memory-session', inputTokens: 15, cacheReadTokens: 5, outputTokens: 4, totalCost: 0.02 },
      { period: 'no-memory-session', inputTokens: 8, outputTokens: 5, totalCost: 0.01 },
    ] }),
  });
  assert.equal(report.cost.cohorts.no.sessionCount, 1);
  assert.equal(report.cost.cohorts.lite.sessionCount, 1);
  assert.equal(report.cost.cohorts.lite.memoryContextTax, 0.1);
  assert.equal(report.cost.cohorts.lite.cacheHitRatio, 0.25);
  assert.equal(report.cost.cohorts.lite.averageTurnsPerSession, 5);
  assert.equal(report.cost.correlatedCallCount, 1);
  assert.equal(report.cost.uncorrelatedCallCount, 2);
  assert.deepEqual(report.speedAndTokens.memoryDetour, {
    count: 2, durationMs: { avg: 800, p95: 800 }, toolResultDurationMs: { avg: 200, p95: 200 },
  });
  assert.doesNotMatch(JSON.stringify(formatAnalyticsExport(report)), /memory-session|Private result|sessionsDir/);
});

test('churn requires compactions within seven days or a lineage depth of three', async (t) => {
  const db = withDb(t);
  for (const [id, compactions] of [['rapid', 2], ['slow', 2], ['deep', 3], ['source', 1], ['merged', 2]]) {
    memoryFixture(db, 'project', id, id, { compactions });
  }
  const addCompaction = db.prepare(`
    INSERT INTO dreamer_memory_events (project_key, memory_id, event_type, source_memory_ids_json, created_at)
    VALUES ('project', ?, 'compacted', ?, ?)
  `);
  for (const [id, days] of [['rapid', 7], ['slow', 730], ['source', 1]]) {
    addCompaction.run(id, null, sampleTime - days * day);
  }
  addCompaction.run('rapid', null, sampleTime);
  addCompaction.run('slow', null, sampleTime);
  addCompaction.run('merged', '["source"]', sampleTime);
  db.prepare('UPDATE memories SET project_key = ? WHERE id = ?').run('destination', 'merged');
  const moved = await buildAnalyticsReport(db, { now, includeSessions: false, projectKey: 'destination' });
  assert.deepEqual(moved.dreamer.repeatCompaction.memories, [{ memoryId: 'merged', compactionCount: 2 }]);
  const { dreamer } = await buildAnalyticsReport(db, { now, includeSessions: false, projectKey: 'project' });
  assert.deepEqual(dreamer.repeatCompaction.memories, [
    { memoryId: 'deep', compactionCount: 3 },
    { memoryId: 'rapid', compactionCount: 2 },
  ]);
});

test('Dreamer captures HTTP and CLI usage, lineage, resurrection, retrieval quality, and dashboard changes', async (t) => {
  const db = withDb(t);
  const cwd = initGit(tempDir(t));
  const projectKey = resolveProjectKey(cwd).projectKey;
  memoryFixture(db, projectKey, 'source-1', 'one blue durable audited memory fact', { createdAt: sampleTime - 7 * day, accesses: 4, compactions: 1 });
  memoryFixture(db, projectKey, 'source-2', 'another durable memory fact', { createdAt: sampleTime - 14 * day, accesses: 6 });
  memoryFixture(db, projectKey, 'archive', 'another separate legacy durable workflow unique');
  memoryFixture(db, projectKey, 'original', 'original project decision');
  const plan = { summary: 'Fixture exclusively', operations: [
    { type: 'merge', source_ids: ['source-1', 'source-2'], content: 'a combined but final memory for analytics' },
    { type: 'archive', id: 'archive', reason: 'Fixture archive' },
  ] };
  const runner = createHttpLlmRunner({
    baseUrl: 'https://api.example.test/v1', model: 'fixture',
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 140, completion_tokens: 25, cost_usd: 0.04 },
    }),
  });
  const result = await runDream({ db, projectKey, runner, now: () => sampleTime });
  const run = db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(result.runId);
  assert.deepEqual([run.input_tokens, run.output_tokens, run.cost_usd], [140, 25, 0.04]);

  const codex = createCliLlmRunner({
    orchestrator: 'codex',
    spawnImpl: () => spawn(process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify([
      { type: 'thread.started', thread_id: 'dream-cli-session' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Checking fixture records.' } },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ summary: '', operations: [] }) } },
      { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } },
    ].map((row) => JSON.stringify(row)).join('\n')) + ')']),
  });
  await runDream({ db, projectKey, runner: codex, now: () => sampleTime + 2000 });
  const cliRun = db.prepare("SELECT * FROM dream_runs WHERE runner = 'cli:codex'").get();
  assert.deepEqual([cliRun.session_id, cliRun.input_tokens, cliRun.output_tokens], ['dream-cli-session', 50, 5]);

  const merged = db.prepare("SELECT * FROM memories WHERE source_orchestrator = 'dreamer' AND status = 'active'").get();
  assert.deepEqual([merged.compaction_count, merged.dreamer_touched_at, merged.access_count], [2, sampleTime, 10]);
  const archive = db.prepare("SELECT * FROM memories WHERE id = 'archive'").get();
  assert.equal(archive.dreamer_touched_at, sampleTime);
  db.prepare("UPDATE dreamer_memory_events SET created_at = ? WHERE event_type = 'archived'").run(Date.now());
  const { memory: resurrection } = await writeMemory(db, {
    cwd, content: 'another separate legacy durable workflow unique restored',
  }, { trackAccess: true });
  assert.deepEqual(JSON.parse(db.prepare("SELECT source_memory_ids_json FROM dreamer_memory_events WHERE event_type = 'resurrected'").get()
    .source_memory_ids_json), ['archive']);
  assert.notEqual(resurrection.id, archive.id);
  db.prepare("UPDATE dreamer_memory_events SET created_at = ? WHERE event_type = 'archived'").run(sampleTime);
  recordAccess(db, { memories: [merged.id] });

  const recorder = createTelemetryRecorder(db, { now: () => now, env: { CLAUDE_SESSION_ID: 'working-session' } });
  const telemetry = (toolName, offset, extra) => recorder.record({
    toolName, projectKey, createdAt: sampleTime + offset, ...extra,
  });
  telemetry('mem_search', 100, { query: 'memory decision', resultCount: 2, returnedMemories: [
    { id: 'original', rank: 1 }, { id: merged.id, rank: 2 },
  ] });
  telemetry('mem_get', 200, { targetMemoryId: merged.id, resultCount: 1 });
  telemetry('mem_search', 300, { query: 'revised', resultCount: 0 });
  telemetry('mem_get', 400, { targetMemoryId: 'original', resultCount: 1 });
  telemetry('mem_note', 500, {});
  recorder.close();

  const dashboard = await startDashboardServer({
    db, cwd, port: 0, config: { embedding: { enabled: false } },
    ccusageRunner: () => ({ sessions: [
      { sessionId: 'dream-cli-session', inputTokens: 52, outputTokens: 7, totalCost: 0.07 },
      { sessionId: 'working-session', inputTokens: 20, outputTokens: 3, totalCost: 0.02 },
    ] }),
    analyticsNow: () => now,
  });
  try {
    const patch = (id, body) => fetch(dashboard.url + '/api/memories/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-MSM-Token': dashboard.csrfToken },
      body: JSON.stringify(body),
    });
    assert.equal((await patch('archive', { status: 'active' })).status, 200);
    assert.equal((await patch(merged.id, { content: 'Updated compacted memory' })).status, 200);
    assert.equal((await patch(merged.id, { content: 'Updated compacted memory' })).status, 200);
    const human = db.prepare("SELECT event_type FROM dreamer_memory_events WHERE event_type LIKE 'human_%' ORDER BY id").all();
    assert.deepEqual(human.map(({ event_type }) => event_type), ['human_undo', 'human_edit']);
    // Move events written by real-time UI/MCP actions into the fixed comparison window.
    db.prepare("UPDATE dreamer_memory_events SET created_at = ? WHERE event_type IN ('human_undo', 'human_edit', 'resurrected')")
      .run(sampleTime + 900);

    const filters = '?window=7d&project=' + encodeURIComponent(projectKey);
    const response = await fetch(dashboard.url + '/api/analytics' + filters);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.series.length, 7);
    assert.equal(report.quality.searchToGetConversionRate, 0.5);
    assert.equal(report.quality.meanReciprocalRank, 0.5);
    assert.deepEqual(report.quality.rankDistribution, { 1: 1, 2: 1 });
    assert.equal(report.quality.zeroHitSearchRate, 0.5);
    assert.equal(report.cost.cohorts.heavy.sessionCount, 1);
    assert.equal(report.dreamer.cost.inputTokens, 190);
    assert.ok(Math.abs(report.dreamer.cost.costUsd - 0.11) < 1e-9);
    assert.equal(report.dreamer.repeatCompaction.count, 0, 'lineage depth two alone does not establish rapid churn');
    assert.equal(report.dreamer.velocity.before, 7);
    assert.ok(report.dreamer.velocity.after > 0);
    assert.equal(report.dreamer.searchImpressions.compacted.ctr, 1);
    assert.equal(report.dreamer.searchImpressions.original.ctr, 1);
    assert.equal(report.dreamer.compactedGetResearchRate, 1);
    assert.equal(report.dreamer.resurrection.count, 1);
    assert.equal(report.dreamer.human.undoCount, 1);
    assert.equal(report.dreamer.human.editCount, 1);
    assert.equal(report.dreamer.accessVelocityByCompactionCount.at(-1).compactionCount, 2);
    const otherProject = await fetch(dashboard.url + '/api/analytics?project=unrelated').then((res) => res.json());
    assert.equal(otherProject.quality.corpus.memories.count, 0);

    const json = await fetch(dashboard.url + '/api/analytics/export' + filters + '&format=json');
    assert.match(json.headers.get('content-disposition'), /attachment; filename="memory-analytics\.json"/);
    const exported = await json.text();
    assert.doesNotMatch(exported, /dream-cli-session|workflow unique|Updated compacted memory|source-1/);
    assert.equal(JSON.parse(exported).dreamer.cost.runCount, 2);
    const md = await fetch(dashboard.url + '/api/analytics/export' + filters + '&format=markdown');
    assert.match(md.headers.get('content-type'), /text\/markdown/);
    assert.match(md.headers.get('content-disposition'), /memory-analytics\.md/);
    assert.match(await md.text(), /## Quality[\s\S]+## Cost[\s\S]+## Speed and tokens[\s\S]+## Dreamer/);
    for (const monthMode of ['calendar', 'rolling30']) {
      const monthFilters = new URLSearchParams({ project: 'all', window: '2m', monthMode });
      const monthly = await fetch(dashboard.url + '/api/analytics?' + monthFilters);
      assert.equal(monthly.status, 200);
      const comparison = await monthly.json();
      assert.equal(comparison.window, '2m');
      assert.equal(comparison.monthMode, monthMode);
      assert.deepEqual(comparison.series.map(({ start, end, label }) => ({ start, end, label })),
        comparisonBuckets('2m', monthMode, now));

      monthFilters.set('format', 'json');
      const monthlyExport = await fetch(dashboard.url + '/api/analytics/export?' + monthFilters);
      assert.equal(monthlyExport.status, 200);
      const exportedComparison = await monthlyExport.json();
      assert.deepEqual(exportedComparison.series.map(({ label }) => label), comparison.series.map(({ label }) => label));
      assert.equal(exportedComparison.quality.searchCount, comparison.quality.searchCount);
    }
    for (const invalid of ['/api/analytics?window=invalid', '/api/analytics?monthMode=invalid', '/api/analytics/export?format=xml']) {
      assert.equal((await fetch(dashboard.url + invalid)).status, 400);
    }
  } finally {
    await dashboard.close();
  }
});

