import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { expandSession } from '../src/expand.mjs';

const timestamp = '2025-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-expand-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return { db, directory };
}

function indexedFile(db, filePath, { session = 'session', orchestrator = 'claude', indexedAt = 1, byteOffset = 0 } = {}) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO transcript_files (file_path, session_id, project_key, orchestrator, mtime_ms, last_indexed_at, byte_offset)
    VALUES (?, ?, 'fixture', ?, ?, ?, ?)
  `).run(filePath, session, orchestrator, indexedAt, indexedAt, byteOffset);
  return lastInsertRowid;
}

function indexedMessage(db, fileId, seq, line, text = 'Indexed fixture text', tools = null, role = 'assistant') {
  db.prepare(`
    INSERT INTO transcript_messages (file_id, seq, line_no, role, timestamp, text, tool_names)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, seq, line, role, timestamp, text, tools);
}

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\r\n') + '\r\n');
}

test('expansion reads original JSONL text using intersecting indexed sequence and line ranges', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'transcript.jsonl');
  writeLines(filePath, [
    { role: 'user', text: 'Original  request  ', timestamp, tool_names: ['fixture'] },
    { type: 'assistant', timestamp, message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First block' },
        { type: 'input_text', text: 'Second  block' },
        { type: 'tool_use', name: 'read' },
        { type: 'function_call', name: 'lookup' },
        { type: 'tool_call', function: { name: 'inspect' } },
      ],
      tool_calls: [{ function: { name: 'inspect' } }, { function: { name: 'summarize' } }],
    } },
    '  broken JSONL {',
    { role: 'user', content: 'Trailing record' },
  ]);
  const fileId = indexedFile(db, filePath);
  indexedMessage(db, fileId, 5, 1, 'Original  request  ', '["fixture"]', 'user');
  indexedMessage(db, fileId, 13, 2, 'First block\nSecond  block', 'inspect, summarize , read, lookup');
  indexedMessage(db, fileId, 21, 4, 'Trailing record', null, 'user');

  const result = expandSession(db, { session_id: ' session ', start_seq: 5, end_seq: 20 });
  assert.deepEqual(result, {
    session_id: 'session', file_id: fileId, orchestrator: 'claude', project_key: 'fixture', source: 'disk', truncated: false,
    total_chars: 'Original  request  First block\nSecond  block'.length,
    messages: [
      { seq: 5, line_no: 1, role: 'user', timestamp, text: 'Original  request  ', tool_names: ['fixture'] },
      {
        seq: 13, line_no: 2, role: 'assistant', timestamp, text: 'First block\nSecond  block',
        tool_names: ['inspect', 'summarize', 'read', 'lookup'],
      },
    ],
  });
  const lineRange = expandSession(db, { session_id: 'session', line_start: 2, line_end: 3 });
  assert.deepEqual(lineRange.messages, [
    result.messages[1], { line_no: 3, role: 'raw', text: '  broken JSONL {' },
  ]);
  const intersection = expandSession(db, {
    session_id: 'session', start_seq: 5, end_seq: 20, line_start: 2, line_end: 3,
  });
  assert.deepEqual(intersection.messages, [result.messages[1]]);
  assert.deepEqual(expandSession(db, { session_id: 'session', start_seq: 5, end_seq: 5, line_start: 2 }).messages, []);
});

test('unindexed sequence ranges count non-empty lines from zero', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'transcript.jsonl');
  writeLines(filePath, [
    { role: 'user', content: 'one' }, '', '  ', { role: 'assistant', text: 'two' }, 'raw three',
  ]);
  indexedFile(db, filePath);
  const { messages } = expandSession(db, { session_id: 'session', start_seq: 1, line_start: 3 });
  assert.deepEqual(messages, [
    { seq: 1, line_no: 4, role: 'assistant', text: 'two' },
    { seq: 2, line_no: 5, role: 'raw', text: 'raw three' },
  ]);
  assert.equal(expandSession(db, { session_id: 'session' }).messages.length, 5);
});

test('a missing transcript falls back to indexed rows and normalizes stored tool names', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'transcript.jsonl');
  writeLines(filePath, [{ role: 'user', text: 'original disk text' }]);
  const fileId = indexedFile(db, filePath);
  indexedMessage(db, fileId, 4, 5, 'First selected text', '["read", "edit"]');
  indexedMessage(db, fileId, 3, 6, 'Earlier sequence', 'inspect, summarize ,');
  indexedMessage(db, fileId, 2, 4, 'Outside both ranges');
  indexedMessage(db, fileId, 5, 8, 'Outside line range');
  fs.unlinkSync(filePath);
  const result = expandSession(db, { session_id: 'session', start_seq: 3, end_seq: 5, line_start: 5, line_end: 6 });
  assert.equal(result.source, 'db-fallback');
  assert.deepEqual(result.messages, [
    { seq: 3, line_no: 6, role: 'assistant', timestamp, text: 'Earlier sequence', tool_names: ['inspect', 'summarize'] },
    { seq: 4, line_no: 5, role: 'assistant', timestamp, text: 'First selected text', tool_names: ['read', 'edit'] },
  ]);
});

test('expansion keeps appends and falls back when a transcript is replaced at the same path', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'transcript.jsonl');
  const header = { type: 'session', session_id: 'session' };
  const anchor = { role: 'assistant', text: 'Original indexed message', timestamp };
  const original = { role: 'assistant', text: 'Original follow-up', timestamp };
  writeLines(filePath, [header, anchor, original]);
  const byteOffset = fs.statSync(filePath).size;
  const fileId = indexedFile(db, filePath, { byteOffset });
  indexedMessage(db, fileId, 1, 3, original.text);
  indexedMessage(db, fileId, 0, 2, anchor.text);

  fs.appendFileSync(filePath, JSON.stringify({ role: 'user', text: 'Appended message' }) + '\r\n');
  const appended = expandSession(db, { session_id: 'session', line_start: 2 });
  assert.equal(appended.source, 'disk');
  assert.deepEqual(appended.messages.map(({ text }) => text), [anchor.text, original.text, 'Appended message']);

  const other = { role: 'assistant', text: 'Replacement message '.repeat(byteOffset) };
  const replacements = [
    { name: 'shortened with matching anchor', lines: [header, anchor], shrunk: true },
    { name: 'smaller different session', lines: [{ session_id: 'other' }, 'replacement'], shrunk: true },
    { name: 'larger different session with matching anchor', lines: [{ sessionId: 'other' }, anchor, other] },
    { name: 'nested different session ID', lines: [{ message: { session_id: 'other' } }, anchor, other] },
    { name: 'different anchor role', lines: [header, { ...anchor, role: 'user' }, other] },
    { name: 'plain-text anchor line with role mismatch', lines: [header, anchor.text, other] },
    { name: 'different anchor text', lines: [{ type: 'session' }, other] },
    { name: 'missing anchor line', lines: [other] },
  ];
  for (const { name, lines, shrunk } of replacements) {
    writeLines(filePath, lines);
    assert.equal(fs.statSync(filePath).size < byteOffset, Boolean(shrunk), name);
    const result = expandSession(db, { session_id: 'session' });
    assert.equal(result.source, 'db-fallback', name);
    assert.deepEqual(result.messages, [
      { seq: 0, line_no: 2, ...anchor },
      { seq: 1, line_no: 3, ...original },
    ], name);
  }
});

test('expansion includes the tool name from an OMP toolCall-only assistant turn', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'omp.jsonl');
  writeLines(filePath, [{
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'inspect' }] },
  }]);
  const fileId = indexedFile(db, filePath, { orchestrator: 'omp' });
  indexedMessage(db, fileId, 0, 1, '', '["inspect"]');
  const result = expandSession(db, { session_id: 'session' });
  assert.equal(result.source, 'disk');
  assert.deepEqual(result.messages, [{ seq: 0, line_no: 1, role: 'assistant', text: '', tool_names: ['inspect'] }]);
});

test('expansion falls back when a requested tool-only turn names a different tool', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'omp.jsonl');
  const anchor = { role: 'user', text: 'Unchanged request' };
  const toolTurn = (name) => ({
    type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name }] },
  });
  writeLines(filePath, [anchor, toolTurn('inspect')]);
  const fileId = indexedFile(db, filePath, { orchestrator: 'omp', byteOffset: fs.statSync(filePath).size });
  indexedMessage(db, fileId, 0, 1, anchor.text, null, 'user');
  indexedMessage(db, fileId, 1, 2, '', '["inspect"]');
  const options = { session_id: 'session', start_seq: 1, end_seq: 1 };
  assert.equal(expandSession(db, options).source, 'disk');

  writeLines(filePath, [anchor, toolTurn('replace')]);
  const result = expandSession(db, options);
  assert.equal(result.source, 'db-fallback');
  assert.deepEqual(result.messages, [{ seq: 1, line_no: 2, role: 'assistant', timestamp, text: '', tool_names: ['inspect'] }]);
});

test('expansion discards collected disk turns when EOF arrives before a requested indexed row', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'transcript.jsonl');
  writeLines(filePath, [{ role: 'user', text: 'Present turn' }]);
  const fileId = indexedFile(db, filePath);
  indexedMessage(db, fileId, 0, 1, 'Present turn', null, 'user');
  indexedMessage(db, fileId, 1, 2, 'Missing turn');

  const result = expandSession(db, { session_id: 'session', end_seq: 1 });
  assert.equal(result.source, 'db-fallback');
  assert.deepEqual(result.messages.map(({ text }) => text), ['Present turn', 'Missing turn']);
});

test('expansion rejects unknown sessions and invalid input ranges', (t) => {
  const { db } = fixture(t);
  assert.throws(() => expandSession(db, { session_id: 'unknown' }), /Session not found: unknown/);
  for (const [input, pattern] of [
    [{ session_id: ' ' }, /session_id/], [{ start_seq: -1 }, /start_seq/],
    [{ file_id: 0 }, /file_id/], [{ file_id: 1.5 }, /file_id/],
    [{ end_seq: 1.5 }, /end_seq/], [{ start_seq: 2, end_seq: 1 }, /end_seq/],
    [{ line_start: 0 }, /line_start/], [{ line_start: 2, line_end: 1 }, /line_end/],
    [{ max_chars: 0 }, /max_chars/],
  ]) {
    assert.throws(() => expandSession(db, { session_id: 'session', ...input }), pattern);
  }
});

test('expansion refuses invalid indexed paths and directories', (t) => {
  const { db, directory } = fixture(t);
  for (const [filePath, session] of [
    ['relative.jsonl', 'relative'],
    [`${directory}${path.sep}..${path.sep}transcript.jsonl`, 'traversal'],
    [directory, 'directory'],
    ['', 'empty'],
  ]) {
    const fileId = indexedFile(db, filePath, { session });
    indexedMessage(db, fileId, 0, 1);
    assert.throws(() => expandSession(db, { session_id: session }), /Invalid indexed transcript path|regular file/);
  }
});

test('expansion refuses an indexed symlink', (t) => {
  const { db, directory } = fixture(t);
  const target = path.join(directory, 'target.jsonl');
  const linkPath = path.join(directory, 'link.jsonl');
  writeLines(target, ['fixture']);
  try {
    fs.symlinkSync(target, linkPath, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('Windows file symlinks require Developer Mode or elevation');
    return;
  }
  indexedFile(db, linkPath);
  assert.throws(() => expandSession(db, { session_id: 'session' }), /must not traverse symbolic links or junctions/);
});

test('expansion refuses a regular file reached through a directory symlink or junction', (t) => {
  const { db, directory } = fixture(t);
  const target = path.join(directory, 'target');
  const linkPath = path.join(directory, 'link');
  fs.mkdirSync(target);
  writeLines(path.join(target, 'transcript.jsonl'), ['fixture']);
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  indexedFile(db, path.join(linkPath, 'transcript.jsonl'));
  assert.throws(() => expandSession(db, { session_id: 'session' }), /must not traverse symbolic links or junctions/);
});

test('incremental expansion preserves UTF-8 and CRLF across chunk boundaries', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'chunked.jsonl');
  const chunkSize = 64 * 1024;
  const first = 'a'.repeat(chunkSize - 1) + '😀' + 'b'.repeat(chunkSize - 4);
  fs.writeFileSync(filePath, first + '\r\nlast line');
  const fileId = indexedFile(db, filePath);
  indexedMessage(db, fileId, 2, 1, first, null, 'raw');
  indexedMessage(db, fileId, 10, 2, 'last line', null, 'raw');

  const result = expandSession(db, { session_id: 'session', line_end: 1, max_chars: first.length });
  assert.deepEqual(result.messages, [{ seq: 2, line_no: 1, role: 'raw', text: first }]);
  assert.equal(result.truncated, false);
  const tail = expandSession(db, { session_id: 'session', start_seq: 10, end_seq: 10 });
  assert.deepEqual(tail.messages, [{ seq: 10, line_no: 2, role: 'raw', text: 'last line' }]);
});

test('expansion truncates the final message within its text budget on disk and in fallback', (t) => {
  const { db, directory } = fixture(t);
  const filePath = path.join(directory, 'transcript.jsonl');
  writeLines(filePath, ['abc', 'defghi', 'third']);
  const fileId = indexedFile(db, filePath);
  indexedMessage(db, fileId, 0, 1, 'abc', null, 'raw');
  indexedMessage(db, fileId, 1, 2, 'defghi', null, 'raw');
  for (const source of ['disk', 'db-fallback']) {
    if (source === 'db-fallback') fs.unlinkSync(filePath);
    const { messages, total_chars, truncated, source: actualSource } = expandSession(db, {
      session_id: 'session', max_chars: 6,
    });
    assert.equal(actualSource, source);
    assert.equal(truncated, true);
    assert.equal(total_chars, 6);
    assert.deepEqual(messages.map(({ text }) => text), ['abc', 'de…']);
    const filled = expandSession(db, { session_id: 'session', max_chars: 3 });
    assert.equal(filled.truncated, true);
    assert.deepEqual(filled.messages.map(({ text }) => text), ['abc']);
    const exact = expandSession(db, { session_id: 'session', end_seq: 0, max_chars: 3 });
    assert.equal(exact.truncated, false);
  }
});

test('expansion selects the most recently indexed row, breaking ties with descending id', (t) => {
  const { db, directory } = fixture(t);
  const fileIds = new Map();
  for (const [text, orchestrator, indexedAt] of [
    ['earlier row', 'claude', 10], ['latest tie', 'codex', 10], ['older time', 'omp', 9],
  ]) {
    const filePath = path.join(directory, `${orchestrator}.jsonl`);
    writeLines(filePath, [text]);
    fileIds.set(orchestrator, indexedFile(db, filePath, { orchestrator, indexedAt }));
  }
  const result = expandSession(db, { session_id: 'session' });
  assert.equal(result.orchestrator, 'codex');
  assert.equal(result.file_id, fileIds.get('codex'));
  assert.deepEqual(result.messages, [{ seq: 0, line_no: 1, role: 'raw', text: 'latest tie' }]);
  const older = expandSession(db, { session_id: 'session', file_id: fileIds.get('omp') });
  assert.equal(older.file_id, fileIds.get('omp'));
  assert.deepEqual(older.messages, [{ seq: 0, line_no: 1, role: 'raw', text: 'older time' }]);
  assert.throws(() => expandSession(db, { session_id: 'other', file_id: older.file_id }), /Session not found: other/);
});
