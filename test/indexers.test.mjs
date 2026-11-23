import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../src/db.mjs';
import { expandSession } from '../src/expand.mjs';
import { claudeAdapter } from '../src/indexers/claude.mjs';
import { ompAdapter } from '../src/indexers/omp.mjs';
import { INDEXER_LEASE_KEY, runIndexers, shouldEmbedMessage } from '../src/indexers/runner.mjs';
import { discoverJsonlFiles, readIncrementalJsonlLines, validateAdapter } from '../src/indexers/types.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';
import { hybridSearch } from '../src/search.mjs';

const jsonl = (...records) => records.map((record) => JSON.stringify(record) + '\n').join('');
const ompMessage = (role, content) => ({ type: 'message', message: { role, content } });
const claudeMessage = (role, content, meta) => ({ type: role, message: { content }, ...meta });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-indexers-'));
  const dbPath = path.join(root, 'memory.db');
  const db = openDatabase(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const omp = path.join(root, 'omp');
  const claude = path.join(root, 'claude');
  fs.mkdirSync(omp);
  fs.mkdirSync(claude);
  const config = { indexers: { omp: { sessionsDir: omp }, claude: { sessionsDir: claude } } };
  return { root, omp, claude, dbPath, db, config };
}

function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(cwd, 'absent-gitconfig');
  return execFileSync('git', args, { cwd, env, windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('indexes both formats incrementally and expands search hits from a linked worktree', async (t) => {
  const { root, omp, claude, db, config } = fixture(t);
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(main);
  git(main, 'init', '--template=');
  git(main, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com',
    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Fixture commit');
  git(main, 'worktree', 'add', '--detach', linked);
  const expectedKey = resolveProjectKey(main).projectKey;
  assert.match(expectedKey, /^git:/);

  const ompPath = path.join(omp, 'a.jsonl');
  const claudePath = path.join(claude, 'b.jsonl');
  const ompText = 'Copper bridge\nSpacing  stays.';
  const claudeText = 'Copper compass\n  Keep the indentation.';
  fs.writeFileSync(ompPath, jsonl(
    { type: 'session', id: 'omp-session', cwd: linked },
    { type: 'custom' },
    ompMessage('assistant', [
      { type: 'text', text: 'Copper bridge' }, { type: 'text', text: 'Spacing  stays.' },
      { type: 'toolCall', name: 'fixture_tool' }, { type: 'tool_call', function: { name: 'fixture_tool' } },
    ]),
    { type: 'custom' },
  ));
  fs.writeFileSync(claudePath, jsonl(
    { type: 'summary' },
    claudeMessage('user', [{ type: 'text', text: 'Copper compass' }, { text: '  Keep the indentation.' }],
      { sessionId: 'claude-session', cwd: main, timestamp: '2025-01-01T00:00:00Z' }),
  ));
  const options = { db, config };
  const initial = await runIndexers(options);
  assert.deepEqual(initial.errors, []);
  assert.equal(initial.filesIndexed, 2);
  assert.equal(initial.messagesIndexed, 2);
  assert.deepEqual(db.prepare('SELECT DISTINCT project_key FROM transcript_files').all().map((row) => row.project_key), [expectedKey]);
  assert.equal(db.prepare('SELECT tool_names FROM transcript_messages WHERE role = ?').get('assistant').tool_names,
    '["fixture_tool"]');

  const initialOmpOffset = fs.statSync(ompPath).size;
  const initialClaudeOffset = fs.statSync(claudePath).size;
  fs.appendFileSync(ompPath, '{malformed}\n' + jsonl(ompMessage('user', 'Next OMP entry')));
  fs.appendFileSync(claudePath, jsonl({ type: 'progress' }, claudeMessage('assistant', 'Next Claude entry')));
  const checkpoints = [];
  const adapters = [ompAdapter, claudeAdapter].map((adapter) => ({
    ...adapter,
    parseIncremental(filePath, offset, meta) {
      checkpoints.push([offset, meta.lineCount]);
      return adapter.parseIncremental(filePath, offset, meta);
    },
  }));
  const appended = await runIndexers({ ...options, adapters });
  assert.deepEqual(appended.errors, []);
  assert.equal(appended.messagesIndexed, 2);
  assert.deepEqual(checkpoints, [[initialOmpOffset, 4], [initialClaudeOffset, 2]]);
  assert.equal((await runIndexers(options)).filesSkipped, 2);
  const rows = db.prepare('SELECT seq, line_no FROM transcript_messages ORDER BY file_id, seq').all();
  assert.deepEqual(rows.map(({ seq, line_no }) => [seq, line_no]), [[0, 3], [1, 6], [0, 2], [1, 4]]);

  const server = createMcpServer({ db, defaultCwd: linked });
  const client = new Client({ name: 'indexer-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { results } = await call('mem_search', { query: 'copper', sources: ['transcript'] });
    assert.deepEqual(results.map((hit) => hit.session_id).sort(), ['claude-session', 'omp-session']);
    for (const hit of results) {
      const expanded = await call('mem_expand', {
        session_id: hit.session_id, file_id: hit.file_id, start_seq: hit.seq, end_seq: hit.seq + 1,
      });
      assert.equal(expanded.source, 'disk');
      assert.deepEqual(expanded.messages.map(({ text }) => text), hit.session_id === 'omp-session'
        ? [ompText, 'Next OMP entry'] : [claudeText, 'Next Claude entry']);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('keeps incomplete lines behind the checkpoint and rebuilds a shortened file with clean FTS', async (t) => {
  const { root, omp, db, config } = fixture(t);
  const file = path.join(omp, 'live.jsonl');
  const base = jsonl({ type: 'session', id: 'live', cwd: root }, ompMessage('user', 'obsolete searchable phrase'));
  const tail = jsonl(ompMessage('assistant', 'newly finished phrase'));
  const cut = tail.indexOf('finished');
  fs.writeFileSync(file, base + tail.slice(0, cut));
  const options = { db, config };
  const offset = () => db.prepare('SELECT byte_offset FROM transcript_files').get().byte_offset;
  assert.equal((await runIndexers(options)).messagesIndexed, 1);
  assert.equal(offset(), Buffer.byteLength(base));
  const fileState = db.prepare('SELECT file_size, last_indexed_at FROM transcript_files');
  const initial = fileState.get();
  assert.equal(initial.file_size, fs.statSync(file).size);
  const unchanged = await runIndexers(options);
  assert.equal(unchanged.filesSkipped, 1);
  assert.equal(unchanged.filesIndexed, 0);
  assert.equal(fileState.get().last_indexed_at, initial.last_indexed_at);
  fs.appendFileSync(file, tail.slice(cut, -1));
  assert.equal((await runIndexers(options)).messagesIndexed, 0);
  assert.equal(offset(), Buffer.byteLength(base));
  fs.appendFileSync(file, '\n');
  assert.equal((await runIndexers(options)).messagesIndexed, 1);
  assert.equal(offset(), Buffer.byteLength(base + tail));
  assert.equal((await runIndexers(options)).filesSkipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_messages').get().count, 2);
  fs.writeFileSync(file, jsonl({ type: 'session', id: 'rotated', cwd: root }, ompMessage('user', 'replacement')));
  const rebuilt = await runIndexers(options);
  assert.deepEqual(rebuilt.errors, []);
  assert.equal(rebuilt.filesReindexed, 1);
  assert.equal(rebuilt.messagesIndexed, 1);
  assert.deepEqual(db.prepare('SELECT seq, text FROM transcript_messages').all().map(({ seq, text }) => [seq, text]),
    [[0, 'replacement']]);
  const search = (query) => hybridSearch(db, { query, sources: ['transcript'], cwd: root });
  assert.equal((await search('obsolete')).results.length, 0);
  assert.equal((await search('finished')).results.length, 0);
  assert.equal((await search('replacement')).results[0].session_id, 'rotated');

  const previousOffset = offset();
  fs.renameSync(file, `${file}.bak`);
  fs.writeFileSync(file, jsonl({ type: 'session', id: 'new-file', cwd: root },
    ompMessage('user', 'Fresh transcript ' + 'longer '.repeat(20))));
  assert.ok(fs.statSync(file).size > previousOffset);
  const replaced = await runIndexers(options);
  assert.deepEqual(replaced.errors, []);
  assert.equal(replaced.filesReindexed, 1);
  assert.equal((await search('replacement')).results.length, 0);
  assert.equal((await search('fresh')).results[0].session_id, 'new-file');
});

test('rebuilds a growing in-place rewrite in the middle of the checkpoint', async (t) => {
  const { root, omp, db, config } = fixture(t);
  const file = path.join(omp, 'rewrite.jsonl');
  const header = { type: 'session', id: 'rewrite', cwd: root };
  const padding = { type: 'custom', padding: 'x'.repeat(64 * 1024) };
  const prefix = Buffer.from(jsonl(header, ompMessage('user', 'Unchanged first turn'), padding));
  const original = Buffer.from(jsonl(ompMessage('assistant', 'Obsolete wording')));
  const replacement = Buffer.from(jsonl(ompMessage('assistant', 'Reworked wording')));
  const suffix = Buffer.from(jsonl(padding));
  const tail = Buffer.from(jsonl(ompMessage('user', 'Added turn')));
  assert.equal(replacement.length, original.length);
  fs.writeFileSync(file, Buffer.concat([prefix, original, suffix]));
  const options = { db, config };
  const search = (query) => hybridSearch(db, { query, sources: ['transcript'], cwd: root });
  assert.equal((await runIndexers(options)).messagesIndexed, 2);
  assert.equal((await search('obsolete')).results.length, 1);
  const before = fs.statSync(file, { bigint: true });

  const fd = fs.openSync(file, 'r+');
  try {
    assert.equal(fs.writeSync(fd, replacement, 0, replacement.length, prefix.length), replacement.length);
  } finally {
    fs.closeSync(fd);
  }
  fs.appendFileSync(file, tail);
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.equal(after.size - before.size, BigInt(tail.length));

  const rebuilt = await runIndexers(options);
  assert.deepEqual(rebuilt.errors, []);
  assert.equal(rebuilt.filesReindexed, 1);
  assert.equal(rebuilt.messagesIndexed, 3);
  const { checkpoint_hash } = db.prepare('SELECT checkpoint_hash FROM transcript_files').get();
  assert.equal(checkpoint_hash, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  const rows = db.prepare('SELECT seq, text FROM transcript_messages ORDER BY seq').all();
  assert.deepEqual(rows.map(({ seq, text }) => [seq, text]),
    [[0, 'Unchanged first turn'], [1, 'Reworked wording'], [2, 'Added turn']]);
  assert.equal((await search('obsolete')).results.length, 0);
  assert.equal((await search('reworked')).results[0].seq, 1);
  assert.deepEqual((await search('added')).results.map(({ seq }) => seq), [2]);
});

test('expansion falls back when a replacement file matches the session and anchor', async (t) => {
  const { root, omp, db, config } = fixture(t);
  const file = path.join(omp, 'identity.jsonl');
  const header = { type: 'session', id: 'identity', cwd: root };
  const anchor = ompMessage('user', 'The same first turn');
  const indexedText = 'Original second turn';
  fs.writeFileSync(file, jsonl(header, anchor, ompMessage('assistant', indexedText)));
  assert.equal((await runIndexers({ db, config })).messagesIndexed, 2);
  const options = { session_id: 'identity', start_seq: 1, end_seq: 1 };
  assert.equal(expandSession(db, options).source, 'disk');

  fs.renameSync(file, `${file}.bak`);
  fs.writeFileSync(file, jsonl(header, anchor, ompMessage('assistant', 'Unrelated replacement turn')));
  const expanded = expandSession(db, options);
  assert.equal(expanded.source, 'db-fallback');
  assert.deepEqual(expanded.messages.map(({ text }) => text), [indexedText]);
});

test('normalizes OMP epoch milliseconds before search and database fallback', async (t) => {
  const { root, omp, db, config } = fixture(t);
  const file = path.join(omp, 'timed.jsonl');
  const old = 1700000000000;
  const iso = new Date(old).toISOString();
  const numeric = ompMessage('user', 'Historical numeric turn');
  numeric.message.timestamp = old;
  numeric.timestamp = new Date().toISOString();
  const digits = ompMessage('assistant', 'Historical digits turn');
  digits.message.timestamp = String(old);
  const invalid = ompMessage('user', 'Historical fallback turn');
  invalid.message.timestamp = '999999999999999999999';
  invalid.timestamp = '2023-11-14T23:13:20+01:00';
  const isoMessage = ompMessage('assistant', 'Historical ISO turn');
  isoMessage.message.timestamp = invalid.timestamp;
  isoMessage.timestamp = Date.now();
  fs.writeFileSync(file, jsonl({ type: 'session', id: 'timed', cwd: root }, numeric, digits, invalid, isoMessage));

  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await runIndexers({ db, config })).messagesIndexed, 4);
  const timestamps = db.prepare('SELECT timestamp FROM transcript_messages ORDER BY seq').all();
  assert.deepEqual(timestamps.map(({ timestamp }) => timestamp), [iso, iso, iso, iso]);
  const search = { query: 'historical', sources: ['transcript'], cwd: root };
  const { results } = await hybridSearch(db, search);
  assert.deepEqual(results.map(({ timestamp }) => timestamp), [iso, iso, iso, iso]);
  assert.equal((await hybridSearch(db, { ...search, since: today })).results.length, 0);
  fs.renameSync(file, `${file}.bak`);
  const expanded = expandSession(db, { session_id: 'timed', start_seq: 0, end_seq: 0 });
  assert.equal(expanded.source, 'db-fallback');
  assert.equal(expanded.messages[0].timestamp, iso);
});

test('Claude falls back to the record type for a malformed message role', async (t) => {
  const { root, claude, db, config } = fixture(t);
  const file = path.join(claude, 'roles.jsonl');
  const malformed = claudeMessage('user', 'First Claude turn', { sessionId: 'roles', cwd: root });
  malformed.message.role = { invalid: true };
  malformed.message.timestamp = '1700000000000';
  fs.writeFileSync(file, jsonl(malformed, claudeMessage('assistant', 'Second Claude turn')));

  const indexed = await runIndexers({ db, config });
  assert.deepEqual(indexed.errors, []);
  assert.equal(indexed.messagesIndexed, 2);
  const rows = db.prepare('SELECT seq, role, timestamp FROM transcript_messages ORDER BY seq').all();
  assert.deepEqual(rows.map(({ seq, role, timestamp }) => [seq, role, timestamp]),
    [[0, 'user', '2023-11-14T22:13:20.000Z'], [1, 'assistant', null]]);
  const expanded = expandSession(db, { session_id: 'roles', start_seq: 0, end_seq: 1 });
  assert.equal(expanded.source, 'disk');
  assert.deepEqual(expanded.messages.map(({ role }) => role), ['user', 'assistant']);
});

test('selective embeddings keep short, oversized, and tool output searchable', async (t) => {
  const { root, omp, claude, db, config } = fixture(t);
  const file = path.join(omp, 'tools.jsonl');
  fs.writeFileSync(file, jsonl(
    { type: 'session', id: 'tools', cwd: root },
    ompMessage('user', '  A substantive prompt  '),
    ompMessage('assistant', 'A substantive answer'),
    ompMessage('toolResult', 'A small tooloutput result'),
    ompMessage('assistant', 'giantoutput ' + 'x'.repeat(16_000)),
    ompMessage('user', 'tiny'),
    ompMessage('assistant', 'Searchable inferencefailure fixture'),
  ));
  fs.writeFileSync(path.join(claude, 'tools.jsonl'), jsonl(claudeMessage('user', [
    { type: 'tool_result', content: [{ type: 'text', text: 'Claude fixturetool output' }] },
  ], { sessionId: 'claude-tools', cwd: root })));
  const embedded = [];
  const embeddingEngine = {
    async embed(text) {
      if (text.includes('inferencefailure')) throw new Error('Fixture inference failed');
      embedded.push(text);
      return Float32Array.of(1, 0);
    },
    getStatus() { return { model: 'fixture-model' }; },
  };
  const result = await runIndexers({ db, config, embeddingEngine });
  assert.deepEqual(result.errors.map(({ message }) => message), ['Fixture inference failed']);
  assert.equal(result.embeddingsWritten, 2);
  assert.equal(result.messagesIndexed, 7);
  assert.deepEqual(embedded, ['A substantive prompt', 'A substantive answer']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_embeddings').get().count, 2);
  assert.equal(shouldEmbedMessage({ role: 'user', text: ' 1234567890 ' }), true);
  assert.equal(shouldEmbedMessage({ role: 'assistant', text: 'x'.repeat(16_000) }), true);
  for (const query of ['tooloutput', 'giantoutput', 'tiny', 'inferencefailure']) {
    assert.equal((await hybridSearch(db, { query, sources: ['transcript'], cwd: root })).results.length, 1);
  }
  const { results } = await hybridSearch(db, { query: 'fixturetool', sources: ['transcript'], cwd: root });
  assert.equal(results.length, 1);
  const expanded = expandSession(db, { session_id: results[0].session_id, start_seq: 0, end_seq: 0 });
  assert.equal(expanded.source, 'disk');
  assert.equal(expanded.messages[0].text, 'Claude fixturetool output');
});

test('a second connection skips a held lease, including runs with the same owner label', async (t) => {
  const { root, omp, db, dbPath, config } = fixture(t);
  const contender = openDatabase(dbPath);
  fs.writeFileSync(path.join(omp, 'lease.jsonl'), jsonl(
    { type: 'session', id: 'lease', cwd: root }, ompMessage('user', 'Index this one message'),
  ));
  let startEmbedding;
  const started = new Promise((resolve) => { startEmbedding = resolve; });
  let finishEmbedding;
  const finish = new Promise((resolve) => { finishEmbedding = resolve; });
  const owner = 'fixture-runner';
  const first = runIndexers({ db, config, owner, embeddingEngine: {
    embed() {
      startEmbedding();
      return finish;
    },
  } });
  try {
    await Promise.race([started, first.then(() => assert.fail('Expected pending inference'))]);
    const second = await runIndexers({ db: contender, config, owner });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'lease-held');
    assert.equal(second.messagesIndexed, 0);
  } finally {
    finishEmbedding(null);
    try {
      await first;
    } finally {
      contender.close();
    }
  }
  assert.equal((await first).messagesIndexed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_messages').get().count, 1);
  assert.equal(db.prepare('SELECT 1 FROM leases WHERE lease_key = ?').get(INDEXER_LEASE_KEY), undefined);
});

test('the reader keeps CRLF byte positions and decodes characters split across chunks', (t) => {
  const { omp } = fixture(t);
  const file = path.join(omp, 'bytes.jsonl');
  const first = 'ignored\r\n\n';
  const second = 'x'.repeat(65_535) + 'é🧪';
  fs.writeFileSync(file, first + second + '\r\nunfinished');
  const result = readIncrementalJsonlLines(file, Buffer.byteLength(first));
  assert.deepEqual(result.lines, [{ line: second, lineNo: 3 }]);
  assert.equal(result.newByteOffset, Buffer.byteLength(first + second + '\r\n'));
  assert.equal(result.lineCount, 3);
  assert.deepEqual(readIncrementalJsonlLines(file, result.fileSize).lines, []);
  assert.equal(readIncrementalJsonlLines(file, result.fileSize + 1).truncated, true);
  fs.truncateSync(file, result.newByteOffset);
  const next = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from('résumé\n')]);
  fs.appendFileSync(file, next);
  const resumed = readIncrementalJsonlLines(file, result.newByteOffset, result.lineCount);
  assert.deepEqual(resumed.lines, [{ line: 'résumé', lineNo: 5 }]);
  assert.equal(resumed.newByteOffset, result.newByteOffset + next.length);
});

test('discovers sorted regular JSONL files and skips linked directories', (t) => {
  const { root, omp, claude } = fixture(t);
  const nested = path.join(omp, 'nested');
  fs.mkdirSync(nested);
  const files = [path.join(omp, 'z.jsonl'), path.join(nested, 'a.jsonl')];
  for (const file of files) fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(claude, 'outside.jsonl'), '');
  fs.mkdirSync(path.join(nested, 'directory.jsonl'));
  const link = path.join(omp, 'link');
  fs.symlinkSync(claude, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(discoverJsonlFiles(omp), files.sort());
  assert.deepEqual(discoverJsonlFiles(link), []);
  assert.deepEqual(discoverJsonlFiles(path.join(root, 'missing')), []);
  assert.deepEqual(discoverJsonlFiles(files[0]), []);
  assert.throws(() => readIncrementalJsonlLines(path.join(link, 'outside.jsonl')), /regular directories/);
  assert.throws(() => validateAdapter({ orchestrator: 'unknown' }), /supported orchestrator/);
});

test('Claude uses the project folder when a transcript has no recorded cwd', (t) => {
  const { claude } = fixture(t);
  const windows = process.platform === 'win32';
  const folder = path.join(claude, windows ? 'C--work-fixture' : '-work-fixture');
  fs.mkdirSync(folder);
  const file = path.join(folder, 'fallback.jsonl');
  fs.writeFileSync(file, jsonl(claudeMessage('assistant', [{ type: 'tool_use', name: 'fixture_tool' }])));
  const parsed = claudeAdapter.parseIncremental(file, 0, { sessionsDir: claude });
  assert.equal(parsed.sessionId, 'fallback');
  assert.equal(parsed.cwd, windows ? 'C:\\work\\fixture' : '/work/fixture');
  assert.deepEqual(parsed.messages[0].toolNames, ['fixture_tool']);
});
