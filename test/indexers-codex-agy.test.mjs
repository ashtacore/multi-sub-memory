import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../src/db.mjs';
import { expandSession } from '../src/expand.mjs';
import { agyAdapter, getDefaultAgySessionsDir } from '../src/indexers/agy.mjs';
import { codexAdapter, getDefaultCodexSessionsDir } from '../src/indexers/codex.mjs';
import { runIndexers } from '../src/indexers/runner.mjs';
import { INDEXER_ORCHESTRATORS } from '../src/indexers/types.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';

const sessionId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const time = '2025-01-01T08:30:00+02:00';
const utc = '2025-01-01T06:30:00.000Z';
const jsonl = (...records) => records.map((record) => JSON.stringify(record) + '\n').join('');
const response = (type, payload = {}) => ({ type: 'response_item', timestamp: time, payload: { type, ...payload } });
const codexUser = (text) => response('message', { role: 'user', content: [{ type: 'input_text', text }] });
const agyUser = (content) => ({ type: 'USER_INPUT', created_at: time, content });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-codex-agy-'));
  const db = openDatabase(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dirs = Object.fromEntries(INDEXER_ORCHESTRATORS.map((name) => [name, path.join(root, name)]));
  const config = { indexers: Object.fromEntries(
    Object.entries(dirs).map(([name, sessionsDir]) => [name, { sessionsDir }]),
  ) };
  return { root, db, config, dirs };
}

function writeTranscript(file, ...records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(...records));
  return file;
}

test('Codex reads conversation and tool calls, excluding private prompts and duplicate events', (t) => {
  const { root, config, dirs } = fixture(t);
  assert.equal(getDefaultCodexSessionsDir(root), path.join(root, '.codex', 'sessions'));
  const file = writeTranscript(path.join(dirs.codex, '2025', '01', '01', `rollout-2025-01-01T08-30-00-${otherId}.jsonl`),
    { type: 'session_meta', payload: { session_id: sessionId, cwd: '/workspace/initial-app' } },
    { type: 'turn_context', payload: { cwd: '/workspace/example-app' } },
    codexUser('  Mark the sample map.  '),
    response('message', { role: 'assistant', timestamp: '2025-01-01T00:00:00Z', content: [
      { type: 'output_text', text: 'Added a marker.' },
      { type: 'tool_result', content: 'A synthetic result.' },
    ] }),
    response('message', { role: 'developer', content: 'Synthetic developer prompt.' }),
    response('message', { role: 'system', content: 'Synthetic system prompt.' }),
    { type: 'event_msg', payload: { type: 'agent_message', text: 'Added a marker.' } },
    response('reasoning', { text: 'Synthetic private reasoning.' }),
    response('custom_tool_call', { name: ' fixture_draw ', input: 'circle' }),
    response('function_call', { name: 'fixture_lookup', arguments: '{}' }),
    response('web_search_call'),
    response('function_call', { name: ' ' }),
    response('function_call_output', { output: 'Synthetic lookup output.' }),
    response('custom_tool_call_output', { output: 'Synthetic drawing output.' }),
    response('agent_message', { text: 'Map complete.', content: [{ type: 'toolCall', name: 'fixture_check' }] }),
    response('agent_message', { content: [{ type: 'output_text', text: 'Fixture complete.' }] }),
  );
  assert.deepEqual(codexAdapter.discoverFiles(config), [file]);
  const parsed = codexAdapter.parseIncremental(file);
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(parsed.cwd, '/workspace/example-app');
  assert.deepEqual(parsed.messages, [
    { seq: 0, lineNo: 3, role: 'user', text: '  Mark the sample map.  ', toolNames: [], timestamp: utc, skipEmbedding: false },
    { seq: 1, lineNo: 4, role: 'assistant', text: 'Added a marker.\nA synthetic result.', toolNames: [],
      timestamp: '2025-01-01T00:00:00.000Z', skipEmbedding: true },
    { seq: 2, lineNo: 9, role: 'assistant', text: '', toolNames: ['fixture_draw'], timestamp: utc, skipEmbedding: true },
    { seq: 3, lineNo: 10, role: 'assistant', text: '', toolNames: ['fixture_lookup'], timestamp: utc, skipEmbedding: true },
    { seq: 4, lineNo: 11, role: 'assistant', text: '', toolNames: ['web_search'], timestamp: utc, skipEmbedding: true },
    { seq: 5, lineNo: 15, role: 'assistant', text: 'Map complete.', toolNames: ['fixture_check'], timestamp: utc, skipEmbedding: false },
    { seq: 6, lineNo: 16, role: 'assistant', text: 'Fixture complete.', toolNames: [], timestamp: utc, skipEmbedding: false },
  ]);

  fs.writeFileSync(file, jsonl(codexUser('A headerless rollout.')));
  assert.equal(codexAdapter.parseIncremental(file).sessionId, otherId);
  const flat = writeTranscript(path.join(dirs.codex, 'flat.jsonl'),
    { type: 'session_meta', payload: { session_id: ' \t ', id: ` ${sessionId} ` } });
  assert.equal(codexAdapter.parseIncremental(flat).sessionId, sessionId);
});

test('Antigravity discovers canonical transcripts and maps attributable turns', (t) => {
  const { root, config, dirs } = fixture(t);
  assert.equal(getDefaultAgySessionsDir(root), path.join(root, '.gemini', 'antigravity-cli', 'brain'));
  const logs = path.join(dirs.agy, sessionId, '.system_generated', 'logs');
  const file = writeTranscript(path.join(logs, 'transcript.jsonl'),
    { ...agyUser('  Draw the sample map.  '), workspace_root: '/workspace/example-app', timestamp: 0 },
    { type: 'PLANNER_RESPONSE', timestamp: 0, content: [
      { type: 'text', text: 'Drew a marker.' }, { type: 'tool_use', name: 'fixture_draw' },
    ], tool_calls: [{ name: ' fixture_draw ', args: {} }, { function: { name: 'fixture_lookup' } }] },
    { type: 'PLANNER_RESPONSE', thinking: 'Synthetic private reasoning.' },
    { type: 'GENERIC', source: 'MODEL', content: 'Map ready.' },
    { type: 'GENERIC', source: 'USER_EXPLICIT', content: 'Please add a legend.' },
    { type: 'GENERIC', source: 'TOOL', content: 'Synthetic tool output.' },
    { type: 'SYSTEM_MESSAGE', content: 'Synthetic system prompt.' },
    { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'fixture_check' }] },
  );
  writeTranscript(path.join(logs, 'transcript_full.jsonl'), agyUser('Aggregate fixture duplicate.'));
  writeTranscript(path.join(logs, 'chunks', 'transcript', '00000000.jsonl'), agyUser('Chunk fixture duplicate.'));
  const flat = writeTranscript(path.join(dirs.agy, 'flat.jsonl'), agyUser('Flat fixture.'));
  assert.deepEqual(agyAdapter.discoverFiles(config), [file, flat].sort());
  assert.equal(agyAdapter.parseIncremental(flat).sessionId, 'flat');

  const parsed = agyAdapter.parseIncremental(file);
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(parsed.cwd, '/workspace/example-app');
  assert.deepEqual(parsed.messages, [
    { seq: 0, lineNo: 1, role: 'user', text: '  Draw the sample map.  ', toolNames: [], timestamp: utc, skipEmbedding: false },
    { seq: 1, lineNo: 2, role: 'assistant', text: 'Drew a marker.', toolNames: ['fixture_draw', 'fixture_lookup'],
      timestamp: '1970-01-01T00:00:00.000Z', skipEmbedding: false },
    { seq: 2, lineNo: 4, role: 'assistant', text: 'Map ready.', toolNames: [], timestamp: null, skipEmbedding: false },
    { seq: 3, lineNo: 5, role: 'user', text: 'Please add a legend.', toolNames: [], timestamp: null, skipEmbedding: false },
    { seq: 4, lineNo: 8, role: 'assistant', text: '', toolNames: ['fixture_check'], timestamp: null, skipEmbedding: false },
  ]);
  for (const field of ['sessionId', 'session_id', 'conversationId', 'conversation_id']) {
    fs.writeFileSync(flat, jsonl({ ...agyUser('Flat fixture.'), [field]: otherId }));
    assert.equal(agyAdapter.parseIncremental(flat).sessionId, otherId);
    assert.equal(agyAdapter.parseIncremental(flat, 0, { sessionId }).sessionId, otherId);
  }
});

for (const [orchestrator, entry] of [['codex', codexUser], ['agy', agyUser]]) {
  test(`${orchestrator} resumes complete lines and rebuilds after truncation and prefix rewrite`, async (t) => {
    const { db, config, dirs } = fixture(t);
    const file = writeTranscript(path.join(dirs[orchestrator], 'incremental.jsonl'), entry('Initial fixture record.'));
    const run = async (messages, rebuilt = 0) => {
      const result = await runIndexers({ db, config });
      assert.deepEqual(result.errors, []);
      assert.equal(result.messagesIndexed, messages);
      assert.equal(result.filesReindexed, rebuilt);
      return result;
    };
    const rows = () => db.prepare('SELECT seq, line_no, text FROM transcript_messages ORDER BY seq')
      .all().map(({ seq, line_no, text }) => [seq, line_no, text]);
    const offset = () => db.prepare('SELECT byte_offset FROM transcript_files').get().byte_offset;
    await run(1);
    const tail = jsonl(entry('Appended fixture record.'));
    const partial = jsonl(entry('Completed fixture record.'));
    const initialOffset = offset();
    fs.appendFileSync(file, tail + partial.slice(0, -1));
    await run(1);
    assert.equal(offset(), initialOffset + Buffer.byteLength(tail));
    assert.equal((await run(0)).filesSkipped, 1);
    fs.appendFileSync(file, '\n');
    await run(1);
    assert.deepEqual(rows(), [
      [0, 1, 'Initial fixture record.'], [1, 2, 'Appended fixture record.'], [2, 3, 'Completed fixture record.'],
    ]);

    fs.writeFileSync(file, jsonl(entry('Shortened.')));
    await run(1, 1);
    assert.deepEqual(rows(), [[0, 1, 'Shortened.']]);
    fs.writeFileSync(file, jsonl(entry('Rewritten prefix is longer than the prior checkpoint.'), entry('Replacement tail.')));
    await run(2, 1);
    assert.deepEqual(rows(), [[0, 1, 'Rewritten prefix is longer than the prior checkpoint.'], [1, 2, 'Replacement tail.']]);
  });
}

test('Antigravity indexes the canonical transcript when a diagnostic log shares its directory', async (t) => {
  const { db, config, dirs } = fixture(t);
  const logs = path.join(dirs.agy, sessionId, '.system_generated', 'logs');
  const message = agyUser('Canonical Antigravity message.');
  const file = writeTranscript(path.join(logs, 'transcript.jsonl'), message);
  writeTranscript(path.join(logs, 'zzz-diagnostics.jsonl'), { text: 'diagnostic' });

  const indexed = await runIndexers({ db, config });
  assert.deepEqual(indexed.errors, []);
  assert.equal(indexed.filesIndexed, 1);
  assert.deepEqual(db.prepare('SELECT file_path FROM transcript_files').all().map((row) => row.file_path), [file]);

  const expanded = expandSession(db, { session_id: sessionId });
  assert.equal(expanded.source, 'disk');
  assert.deepEqual(expanded.messages, [
    { seq: 0, line_no: 1, role: 'user', text: message.content, timestamp: utc },
  ]);
});

test('Antigravity replaces a fallback session ID when the first record completes', async (t) => {
  const { db, config, dirs } = fixture(t);
  const logs = path.join(dirs.agy, 'provisional', '.system_generated', 'logs');
  const file = path.join(logs, 'transcript.jsonl');
  const partial = `{"sessionId":" ","conversation_id":" ${otherId} ",`;
  const message = agyUser('Completed Antigravity message.');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(file, partial);

  const indexedSessionId = (database) => database.prepare('SELECT session_id FROM transcript_files').get().session_id;
  const first = await runIndexers({ db, config });
  assert.deepEqual(first.errors, []);
  assert.equal(first.messagesIndexed, 0);
  assert.equal(indexedSessionId(db), 'provisional');

  fs.appendFileSync(file, jsonl(message).slice(1));
  const second = await runIndexers({ db, config });
  assert.deepEqual(second.errors, []);
  assert.equal(second.messagesIndexed, 1);

  const freshDb = openDatabase(':memory:');
  t.after(() => freshDb.close());
  const fresh = await runIndexers({ db: freshDb, config });
  assert.deepEqual(fresh.errors, []);
  assert.equal(indexedSessionId(db), indexedSessionId(freshDb));
  assert.equal(indexedSessionId(db), otherId);
  const expanded = expandSession(db, { session_id: otherId, start_seq: 0, end_seq: 0 });
  assert.equal(expanded.source, 'disk');
  assert.equal(expanded.messages[0].text, message.content);
});

test('Antigravity uses the latest declared session ID regardless of refresh timing', async (t) => {
  const { db, config, dirs } = fixture(t);
  const logs = path.join(dirs.agy, sessionId, '.system_generated', 'logs');
  const file = writeTranscript(path.join(logs, 'transcript.jsonl'),
    { ...agyUser('Initial Antigravity message.'), conversation_id: sessionId });
  const indexedSessionId = (database) => database.prepare('SELECT session_id FROM transcript_files').get().session_id;

  const first = await runIndexers({ db, config });
  assert.deepEqual(first.errors, []);
  assert.equal(first.messagesIndexed, 1);
  assert.equal(indexedSessionId(db), sessionId);

  const systemMessage = { type: 'SYSTEM_MESSAGE', content: 'Synthetic system context.' };
  fs.appendFileSync(file, jsonl(
    { ...agyUser('Appended Antigravity message.'), conversation_id: otherId },
    systemMessage,
  ));
  const second = await runIndexers({ db, config });
  assert.deepEqual(second.errors, []);
  assert.equal(second.messagesIndexed, 1);
  assert.equal(second.filesReindexed, 0);

  const freshDb = openDatabase(':memory:');
  t.after(() => freshDb.close());
  const fresh = await runIndexers({ db: freshDb, config });
  assert.deepEqual(fresh.errors, []);
  assert.equal(fresh.messagesIndexed, 2);
  assert.equal(indexedSessionId(db), indexedSessionId(freshDb));
  assert.equal(indexedSessionId(db), otherId);

  const range = { session_id: otherId, line_start: 3, line_end: 3 };
  for (const database of [db, freshDb]) {
    const expanded = expandSession(database, range);
    assert.equal(expanded.source, 'disk');
    assert.deepEqual(expanded.messages, [{ line_no: 3, role: 'system', text: systemMessage.content }]);
  }

  const offset = fs.readFileSync(file).indexOf(sessionId);
  assert.ok(offset >= 0);
  const fd = fs.openSync(file, 'r+');
  try {
    const replacementId = '00000000-0000-4000-8000-000000000099';
    assert.equal(fs.writeSync(fd, replacementId, offset), Buffer.byteLength(sessionId));
  } finally {
    fs.closeSync(fd);
  }
  const fallback = expandSession(db, range);
  assert.equal(fallback.source, 'db-fallback');
  assert.deepEqual(fallback.messages, []);
});

test('expansion reads OMP tool calls stored alongside string content from disk', async (t) => {
  const { db, config, dirs } = fixture(t);
  const content = 'Preparing the sample map.';
  writeTranscript(path.join(dirs.omp, 'omp.jsonl'),
    { type: 'session', id: sessionId },
    { type: 'message', message: { role: 'assistant', content, tool_calls: [{ function: { name: 'fixture_draw' } }] } });
  const indexed = await runIndexers({ db, config });
  assert.deepEqual(indexed.errors, []);
  assert.equal(indexed.messagesIndexed, 1);
  assert.equal(db.prepare('SELECT tool_names FROM transcript_messages').get().tool_names, null);

  const expanded = expandSession(db, { session_id: sessionId });
  assert.equal(expanded.source, 'disk');
  assert.deepEqual(expanded.messages, [
    { line_no: 1, role: 'session', text: '' },
    { seq: 0, line_no: 2, role: 'assistant', text: content, tool_names: ['fixture_draw'] },
  ]);
});

test('expansion falls back when the first indexed tool call is renamed in place', async (t) => {
  const { db, config, dirs } = fixture(t);
  const originalName = 'fixture_draw';
  const replacementName = 'fixture_read';
  const file = writeTranscript(path.join(dirs.codex, 'tool-call.jsonl'),
    { type: 'session_meta', payload: { id: sessionId } },
    response('custom_tool_call', { name: originalName }));
  const indexed = await runIndexers({ db, config });
  assert.deepEqual(indexed.errors, []);
  assert.equal(indexed.messagesIndexed, 1);
  assert.equal(db.prepare('SELECT session_id FROM transcript_files').get().session_id, sessionId);

  const range = { session_id: sessionId, start_seq: 0, end_seq: 0 };
  const disk = expandSession(db, range);
  assert.equal(disk.source, 'disk');
  assert.deepEqual(disk.messages, [
    { seq: 0, line_no: 2, role: 'assistant', text: '', timestamp: utc, tool_names: [originalName] },
  ]);

  const before = fs.statSync(file, { bigint: true });
  const offset = fs.readFileSync(file).indexOf(originalName);
  assert.ok(offset >= 0);
  const fd = fs.openSync(file, 'r+');
  try {
    assert.equal(fs.writeSync(fd, replacementName, offset), Buffer.byteLength(originalName));
  } finally {
    fs.closeSync(fd);
  }
  const after = fs.statSync(file, { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.size], [before.dev, before.ino, before.size]);
  const fallback = expandSession(db, range);
  assert.equal(fallback.source, 'db-fallback');
  assert.deepEqual(fallback.messages, disk.messages);
});

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(cwd, 'absent-gitconfig');
  execFileSync('git', args, { cwd, env, windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('MCP searches four formats in one Git project and expands Codex and Antigravity from disk and SQLite', async (t) => {
  const { root, db, config, dirs } = fixture(t);
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(main);
  git(main, 'init', '--template=');
  git(main, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com',
    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Fixture commit');
  git(main, 'worktree', 'add', '--detach', linked);
  const projectKey = resolveProjectKey(main).projectKey;
  assert.match(projectKey, /^git:/);

  const codexText = '  Quartz map\n  Preserve the indentation.  ';
  const agyText = '  Quartz legend\n  Preserve the indentation.  ';
  writeTranscript(path.join(dirs.omp, 'omp.jsonl'),
    { type: 'session', id: 'omp-fixture', cwd: main },
    { type: 'message', message: { role: 'user', content: 'Quartz marker' } });
  writeTranscript(path.join(dirs.claude, 'claude.jsonl'),
    { type: 'assistant', sessionId: 'claude-fixture', cwd: main, message: { content: 'Quartz compass' } });
  const codex = writeTranscript(path.join(dirs.codex, 'codex.jsonl'),
    { type: 'session_meta', payload: { id: sessionId, cwd: root } },
    { type: 'turn_context', payload: { cwd: linked } },
    codexUser(codexText),
    response('custom_tool_call', { name: 'fixture_draw' }),
    response('function_call_output', { output: '  Synthetic tool output.  ' }),
    response('custom_tool_call_output', { output: [{ type: 'output_text', text: 'Synthetic drawing.' }] }));
  const agy = writeTranscript(path.join(dirs.agy, 'agy.jsonl'),
    { type: 'SYSTEM_MESSAGE', conversation_id: otherId, workspace: linked, created_at: time, content: 'Fixture system context.' },
    agyUser(agyText),
    { type: 'PLANNER_RESPONSE', created_at: time, tool_calls: [{ name: 'fixture_draw' }] });
  const result = await runIndexers({ db, config });
  assert.deepEqual(result.errors, []);
  assert.equal(result.filesIndexed, 4);
  assert.equal(result.messagesIndexed, 6);
  for (const row of db.prepare('SELECT project_key FROM transcript_files').all()) assert.equal(row.project_key, projectKey);

  const server = createMcpServer({ db, defaultCwd: main });
  const client = new Client({ name: 'fixture-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, response.content[0].text);
    return JSON.parse(response.content[0].text);
  }
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const search = { query: 'quartz', sources: ['transcript'] };
    const { results } = await call('mem_search', search);
    assert.deepEqual(results.map(({ orchestrator }) => orchestrator).sort(), ['agy', 'claude', 'codex', 'omp']);
    for (const [orchestrator, file, originalText, line] of [['codex', codex, codexText, 3], ['agy', agy, agyText, 2]]) {
      const { results: hits } = await call('mem_search', { ...search, orchestrators: [orchestrator] });
      assert.deepEqual(hits.map((hit) => hit.orchestrator), [orchestrator]);
      const { session_id, file_id, seq } = hits[0];
      const range = { session_id, file_id, start_seq: seq, end_seq: seq + 1 };
      const disk = await call('mem_expand', range);
      assert.equal(disk.source, 'disk');
      assert.deepEqual(disk.messages, [
        { seq: 0, line_no: line, role: 'user', text: originalText, timestamp: utc },
        { seq: 1, line_no: line + 1, role: 'assistant', text: '', timestamp: utc, tool_names: ['fixture_draw'] },
      ]);
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, original.replace(session_id, '00000000-0000-4000-8000-000000000099'));
      assert.equal((await call('mem_expand', range)).source, 'db-fallback');
      fs.writeFileSync(file, original);
      fs.unlinkSync(file);
      const fallback = await call('mem_expand', range);
      assert.equal(fallback.source, 'db-fallback');
      assert.deepEqual(fallback.messages, disk.messages);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('physical disk ranges include Codex tool output and Antigravity system messages', async (t) => {
  const { db, config, dirs } = fixture(t);
  writeTranscript(path.join(dirs.codex, 'codex.jsonl'),
    { ...codexUser('Example question.'), session_id: ' \t ', sessionId: ' codex ' },
    response('function_call_output', { output: '  Synthetic lookup result.  ' }),
    response('custom_tool_call_output', { output: [{ type: 'output_text', text: 'Synthetic drawing.' }] }));
  writeTranscript(path.join(dirs.agy, 'agy.jsonl'), agyUser('Example question.'),
    { type: 'SYSTEM_MESSAGE', created_at: time, content: 'Synthetic system context.' });
  assert.equal((await runIndexers({ db, config })).messagesIndexed, 2);
  const codex = expandSession(db, { session_id: 'codex', line_start: 2, line_end: 3 });
  assert.equal(codex.source, 'disk');
  assert.deepEqual(codex.messages, [
    { line_no: 2, role: 'toolResult', text: '  Synthetic lookup result.  ', timestamp: utc },
    { line_no: 3, role: 'toolResult', text: 'Synthetic drawing.', timestamp: utc },
  ]);
  const agy = expandSession(db, { session_id: 'agy', line_start: 2, line_end: 2 });
  assert.equal(agy.source, 'disk');
  assert.deepEqual(agy.messages, [{ line_no: 2, role: 'system', text: 'Synthetic system context.', timestamp: utc }]);
});

test('missing session roots yield no files or errors', async (t) => {
  const { db, config } = fixture(t);
  const result = await runIndexers({ db, config });
  assert.deepEqual(result.errors, []);
  assert.equal(result.filesScanned, 0);
  assert.equal(result.filesIndexed, 0);
});
