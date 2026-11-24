import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { createEmbeddingEngine, DEFAULT_EMBEDDING_MODEL, encodeFloat32Vector } from '../src/embeddings.mjs';
import { hybridSearch, sanitizeFtsQuery, truncatePreview } from '../src/search.mjs';

const boundary = '2025-01-01T00:00:00.007Z';
const now = Date.parse(boundary);

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function memory(db, id, content, {
  project = 'fixture', scope = 'project', status = 'active', orchestrator = 'codex', at = now,
} = {}) {
  db.prepare(`
    INSERT INTO memories (id, project_key, scope, category, content, normalized_hash, status,
      source_orchestrator, created_at, updated_at)
    VALUES (?, ?, ?, 'GENERAL', ?, ?, ?, ?, ?, ?)
  `).run(id, project, scope, content, id, status, orchestrator, at, at);
}

function note(db, id, { project = 'fixture', status = 'pending', orchestrator = 'codex', at = now } = {}) {
  db.prepare(`
    INSERT INTO notes (id, project_key, status, content, source_orchestrator, created_at, updated_at)
    VALUES (?, ?, ?, 'fixture needle', ?, ?, ?)
  `).run(id, project, status, orchestrator, at, at);
}

function transcript(db, session, {
  project = 'fixture', orchestrator = 'codex', timestamp = boundary, indexedAt = now,
  content = 'fixture needle', seq = 0,
} = {}) {
  const { lastInsertRowid: fileId } = db.prepare(`
    INSERT INTO transcript_files (file_path, session_id, project_key, orchestrator, mtime_ms, last_indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`fixture-${session}.jsonl`, session, project, orchestrator, indexedAt, indexedAt);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO transcript_messages (file_id, seq, role, timestamp, text, line_no)
    VALUES (?, ?, 'user', ?, ?, 1)
  `).run(fileId, seq, timestamp, content);
  return lastInsertRowid;
}

function embedMemory(db, id, vector, model = 'fixture-model', dims = vector.length) {
  db.prepare('INSERT INTO memory_embeddings VALUES (?, ?, ?, ?, ?)')
    .run(id, model, dims, encodeFloat32Vector(vector), now);
}

const engine = {
  async embed(query) {
    assert.equal(query, 'needle');
    return new Float32Array([1, 0]);
  },
  getStatus: () => ({ model: 'fixture-model' }),
};

test('hybrid search fuses both legs by exact reciprocal rank and breaks cross-leg ties with FTS rank', async (t) => {
  const db = fixture(t);
  memory(db, 'dual', 'needle found');
  memory(db, 'lexical', 'needle found', { at: now + 1 });
  memory(db, 'dimension', 'ignored vector');
  memory(db, 'model', 'ignored vector');
  memory(db, 'corrupt', 'ignored vector');
  memory(db, 'short', 'ignored vector');
  embedMemory(db, 'dual', [0, 1]);
  embedMemory(db, 'dimension', [1, 0, 0]);
  embedMemory(db, 'model', [1, 0], 'obsolete-model');
  embedMemory(db, 'corrupt', [NaN, 0]);
  embedMemory(db, 'short', [1], 'fixture-model', 2);

  const transcriptId = transcript(db, 'semantic', { content: 'distinct concept', seq: 7 });
  const { file_id: fileId } = db.prepare('SELECT file_id FROM transcript_messages WHERE id = ?').get(transcriptId);
  db.prepare('INSERT INTO transcript_embeddings VALUES (?, ?, ?, ?)')
    .run(transcriptId, 'fixture-model', 2, encodeFloat32Vector([1, 0]));

  const result = await hybridSearch(db, { query: ' needle ', projectKey: 'fixture', embeddingEngine: engine });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.query, 'needle');
  assert.deepEqual(result.results.map(({ source, id, score }) => [source, id, score]), [
    ['memory', 'dual', 2 / 62],
    ['memory', 'lexical', 1 / 61],
    ['transcript', String(transcriptId), 1 / 61],
  ]);
  assert.deepEqual(result.results[2], {
    source: 'transcript', id: String(transcriptId), score: 1 / 61, project_key: 'fixture',
    orchestrator: 'codex', session_id: 'semantic', file_id: fileId, seq: 7, timestamp: boundary, preview: 'distinct concept',
  });
});

test('hybrid search continues in FTS-only mode when embeddings are unavailable', async (t) => {
  const db = fixture(t);
  memory(db, 'lexical', 'needle');
  embedMemory(db, 'lexical', [1, 0], DEFAULT_EMBEDDING_MODEL);
  const disabled = createEmbeddingEngine({ enabled: false, env: {} });
  const broken = { embed: () => { throw new Error('fixture inference failure'); } };
  for (const embeddingEngine of [undefined, disabled, { embed: async () => null }, broken]) {
    const { mode, results } = await hybridSearch(db, { query: 'needle', projectKey: 'fixture', embeddingEngine });
    assert.equal(mode, 'fts-only');
    assert.deepEqual(results.map(({ id }) => id), ['lexical']);
  }
});

test('search skips query embedding when vector tables are empty', async (t) => {
  const db = fixture(t);
  memory(db, 'lexical', 'needle');
  const embed = t.mock.fn(engine.embed);
  const embeddingEngine = { ...engine, embed };
  const result = await hybridSearch(db, { query: 'needle', projectKey: 'fixture', embeddingEngine });
  assert.equal(embed.mock.callCount(), 0);
  assert.equal(result.mode, 'fts-only');
  assert.deepEqual(result.results.map(({ id }) => id), ['lexical']);
});

test('search skips query embedding when active filters exclude all stored vectors', async (t) => {
  const db = fixture(t);
  memory(db, 'lexical', 'needle');
  memory(db, 'wrong-project', 'distinct concept', { project: 'elsewhere' });
  embedMemory(db, 'wrong-project', [1, 0]);
  memory(db, 'wrong-model', 'distinct concept');
  embedMemory(db, 'wrong-model', [1, 0], 'obsolete-model');
  const oldTranscript = transcript(db, 'old', { timestamp: null, indexedAt: now - 1 });
  const otherOrchestrator = transcript(db, 'other-orchestrator', { orchestrator: 'omp' });
  const insert = db.prepare('INSERT INTO transcript_embeddings VALUES (?, ?, ?, ?)');
  for (const id of [oldTranscript, otherOrchestrator]) {
    insert.run(id, 'fixture-model', 2, encodeFloat32Vector([1, 0]));
  }
  const embed = t.mock.fn(engine.embed);
  const embeddingEngine = { ...engine, embed };
  const result = await hybridSearch(db, {
    query: 'needle', projectKey: 'fixture', since: boundary, orchestrators: ['codex'], embeddingEngine,
  });
  assert.equal(embed.mock.callCount(), 0);
  assert.equal(result.mode, 'fts-only');
  assert.deepEqual(result.results.map(({ id }) => id), ['lexical']);
});

test('search reports FTS-only when eligible vectors have incompatible dimensions', async (t) => {
  const db = fixture(t);
  memory(db, 'lexical', 'needle');
  embedMemory(db, 'lexical', [1, 0, 0]);
  const embed = t.mock.fn(engine.embed);
  const embeddingEngine = { ...engine, embed };
  const result = await hybridSearch(db, { query: 'needle', projectKey: 'fixture', embeddingEngine });
  assert.equal(embed.mock.callCount(), 1);
  assert.equal(result.mode, 'fts-only');
  assert.deepEqual(result.results.map(({ id, score }) => [id, score]), [['lexical', 1 / 61]]);
});

test('FTS sanitization quotes punctuation and reserved words and treats them literally', async (t) => {
  const db = fixture(t);
  memory(db, 'literal', 'node sqlite AND OR NOT NEAR (tag) doubled "quote"');
  memory(db, 'prefix', 'tagalong');
  assert.equal(
    sanitizeFtsQuery('node:sqlite AND OR NOT NEAR (tag)* doubled "quote"'),
    '"node:sqlite" "AND" "OR" "NOT" "NEAR" "(tag)*" "doubled" """quote"""',
  );
  assert.equal(sanitizeFtsQuery('*** () {} : " + - ^'), null);
  assert.equal(sanitizeFtsQuery('café 東京 Ⅳ'), '"café" "東京" "Ⅳ"');
  for (const query of [
    'node:sqlite', 'AND OR NOT NEAR', '(tag)*', 'doubled "quote"', '"quote', 'node\0sqlite',
  ]) {
    const { results } = await hybridSearch(db, { query, projectKey: 'fixture' });
    assert.deepEqual(results.map(({ id }) => id), ['literal'], query);
  }
  for (const query of ['', '   ', '" --* (:)']) {
    const { mode, results } = await hybridSearch(db, { query, projectKey: 'fixture' });
    assert.equal(mode, 'fts-only');
    assert.deepEqual(results, []);
  }
});

test('empty selections and note-only search skip query embedding', async (t) => {
  const db = fixture(t);
  note(db, 'note');
  let embedCalls = 0;
  const embeddingEngine = { embed: () => { embedCalls++; } };
  const options = { query: 'needle', projectKey: 'fixture', embeddingEngine };
  for (const selection of [{ query: ' \t ' }, { sources: [] }, { orchestrators: [] }]) {
    const result = await hybridSearch(db, { ...options, ...selection });
    assert.equal(result.mode, 'fts-only');
    assert.deepEqual(result.results, []);
  }
  const result = await hybridSearch(db, { ...options, sources: ['note', 'note'] });
  assert.deepEqual(result.results.map(({ id }) => id), ['note']);
  assert.equal(embedCalls, 0);
});

test('search filters by source, project, status, orchestrator, and inclusive update time', async (t) => {
  const db = fixture(t);
  memory(db, 'project', 'needle');
  memory(db, 'global', 'needle', { project: 'global', scope: 'global' });
  memory(db, 'other', 'needle', { project: 'elsewhere' });
  memory(db, 'old-memory', 'needle', { at: now - 1 });
  memory(db, 'archived', 'needle', { status: 'archived' });
  memory(db, 'wrong-orchestrator', 'needle', { orchestrator: 'agy' });
  note(db, 'pending-note');
  note(db, 'dismissed-note', { status: 'dismissed' });
  note(db, 'old-note', { at: now - 1 });
  note(db, 'other-note', { project: 'elsewhere' });
  note(db, 'global-note', { project: 'global' });
  transcript(db, 'iso-at-boundary', { indexedAt: now - 1 });
  transcript(db, 'iso-old', { timestamp: new Date(now - 1).toISOString() });
  transcript(db, 'missing-timestamp', { timestamp: null });
  transcript(db, 'invalid-timestamp', { timestamp: 'invalid' });
  transcript(db, 'old-index', { timestamp: null, indexedAt: now - 1 });
  transcript(db, 'other-transcript', { project: 'elsewhere' });
  transcript(db, 'wrong-transcript-orchestrator', { orchestrator: 'claude' });

  const options = { query: 'needle', projectKey: 'fixture', since: boundary, orchestrators: ['codex', 'codex'] };
  const keys = ({ results }) => results.map(({ id, session_id }) => session_id ?? id).sort();
  assert.deepEqual(keys(await hybridSearch(db, options)), [
    'global', 'invalid-timestamp', 'iso-at-boundary', 'missing-timestamp', 'pending-note', 'project',
  ]);
  assert.deepEqual(keys(await hybridSearch(db, { ...options, scope: 'all_projects' })), [
    'global', 'global-note', 'invalid-timestamp', 'iso-at-boundary', 'missing-timestamp',
    'other', 'other-note', 'other-transcript', 'pending-note', 'project',
  ]);
  assert.deepEqual(keys(await hybridSearch(db, { ...options, sources: ['memory'] })), ['global', 'project']);
});

test('the vector leg applies the same filters to semantic-only results', async (t) => {
  const db = fixture(t);
  for (const [id, fields] of [
    ['valid', {}], ['wrong-project', { project: 'elsewhere' }],
    ['archived', { status: 'archived' }], ['wrong-orchestrator', { orchestrator: 'agy' }],
    ['too-old', { at: now - 1 }],
  ]) {
    memory(db, id, 'a distinct concept', fields);
    embedMemory(db, id, [1, 0]);
  }
  for (const [session, fields] of [
    ['valid-transcript', {}], ['wrong-project', { project: 'elsewhere' }],
    ['wrong-orchestrator', { orchestrator: 'agy' }], ['too-old', { timestamp: null, indexedAt: now - 1 }],
  ]) {
    const id = transcript(db, session, { ...fields, content: 'another concept' });
    db.prepare('INSERT INTO transcript_embeddings VALUES (?, ?, ?, ?)')
      .run(id, 'fixture-model', 2, encodeFloat32Vector([1, 0]));
  }
  const result = await hybridSearch(db, {
    query: 'needle', projectKey: 'fixture', since: boundary, orchestrators: ['codex'], embeddingEngine: engine,
  });
  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(result.results.map(({ id, session_id }) => session_id ?? id), ['valid', 'valid-transcript']);
});

test('the vector leg keeps the best candidates across sources before fusion', async (t) => {
  const db = fixture(t);
  memory(db, 'lexical', 'needle');
  embedMemory(db, 'lexical', [0, 1]);
  for (let index = 0; index < 49; index++) {
    const id = `semantic-${String(index).padStart(2, '0')}`;
    memory(db, id, 'distinct concept');
    embedMemory(db, id, [1, 1]);
  }
  const transcriptId = transcript(db, 'late-vector', { content: 'another concept' });
  db.prepare('INSERT INTO transcript_embeddings VALUES (?, ?, ?, ?)')
    .run(transcriptId, 'fixture-model', 2, encodeFloat32Vector([1, 0]));

  const { results } = await hybridSearch(db, {
    query: 'needle', projectKey: 'fixture', embeddingEngine: engine, limit: 3,
  });
  assert.deepEqual(results.map(({ id, score }) => [id, score]), [
    ['lexical', 1 / 61], [String(transcriptId), 1 / 61], ['semantic-00', 1 / 62],
  ]);
});

test('search clamps its limit and returns bounded previews', async (t) => {
  const db = fixture(t);
  for (let index = 0; index < 52; index++) memory(db, String(index), `needle ${'x'.repeat(420)}`);
  const options = { query: 'needle', projectKey: 'fixture', sources: ['memory'] };
  assert.equal((await hybridSearch(db, options)).results.length, 10);
  assert.equal((await hybridSearch(db, { ...options, limit: -10 })).results.length, 1);
  assert.equal((await hybridSearch(db, { ...options, limit: 3.9 })).results.length, 3);
  const { results } = await hybridSearch(db, { ...options, limit: 100 });
  assert.equal(results.length, 50);
  assert.ok(results.every(({ category, preview }) => category === 'GENERAL' && preview.length === 400 && preview.endsWith('…')));
  assert.equal(truncatePreview('a😀b', 3), 'a…');
});

test('search rejects invalid filters and ranking parameters', async (t) => {
  const db = fixture(t);
  const options = { query: 'needle', projectKey: 'fixture' };
  for (const [selection, pattern] of [
    [{ scope: 'elsewhere' }, /scope/], [{ sources: ['unknown'] }, /sources/],
    [{ orchestrators: ['unknown'] }, /orchestrators/], [{ since: 'yesterday' }, /since/],
    [{ rrfK: 0 }, /rrfK/], [{ rrfK: Infinity }, /rrfK/],
  ]) {
    await assert.rejects(hybridSearch(db, { ...options, ...selection }), pattern);
  }
});

test('since rejects ambiguous and invalid calendar dates and applies ISO offsets', async (t) => {
  const db = fixture(t);
  const at = Date.parse('2026-06-01T10:00:00Z');
  memory(db, 'at-boundary', 'needle', { at });
  memory(db, 'before-boundary', 'needle', { at: at - 1 });
  const options = { query: 'needle', projectKey: 'fixture' };
  for (const since of ['01/02/2025', '2026-02-31', '2026-02-29T12:00:00+02:00']) {
    await assert.rejects(hybridSearch(db, { ...options, since }), /since must be a valid ISO 8601 date/);
  }
  const offset = await hybridSearch(db, { ...options, since: '2026-06-01T12:00:00+02:00' });
  assert.deepEqual(offset.results.map(({ id }) => id), ['at-boundary']);
  const dateOnly = await hybridSearch(db, { ...options, since: '2026-06-01' });
  assert.equal(dateOnly.results.length, 2);
});
