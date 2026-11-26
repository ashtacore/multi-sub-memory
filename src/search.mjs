import {
  cosineSimilarity, decodeFloat32Vector, DEFAULT_EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL,
} from './embeddings.mjs';
import { MAX_LIST_LIMIT, memoryTags, normalizeTag, resolveCachedProjectKey } from './memory-service.mjs';

export const SEARCH_SOURCES = Object.freeze(['memory', 'note', 'transcript']);
export const SEARCH_SCOPES = Object.freeze(['current_project', 'all_projects']);
export const SEARCH_ORCHESTRATORS = Object.freeze(['omp', 'claude', 'codex', 'agy']);
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_RRF_K = 60;
export const MAX_PREVIEW_CHARS = 400;

const iso8601Date = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
// Julian day arithmetic can drift across an inclusive millisecond boundary.
const transcriptTimestamp = 'COALESCE(ROUND((julianday(tm.timestamp) - 2440587.5) * 86400000.0), tf.last_indexed_at)';
const sourceQueries = {
  memory: {
    id: 'm.id',
    select: 'm.project_key, m.source_session_id AS session_id, m.content AS text, m.category',
    from: 'memories m',
    fts: 'memories_fts',
    ftsRowId: 'm.rowid',
    embedding: 'JOIN memory_embeddings e ON e.memory_id = m.id',
    status: "m.status = 'active'",
    project: "((m.scope = 'project' AND m.project_key = ?) OR (m.scope = 'global' AND m.project_key = 'global'))",
    orchestrator: 'm.source_orchestrator',
    timestamp: 'm.updated_at',
  },
  note: {
    id: 'n.id',
    select: 'n.project_key, n.source_session_id AS session_id, n.content AS text',
    from: 'notes n',
    fts: 'notes_fts',
    ftsRowId: 'n.rowid',
    status: "n.status IN ('active', 'pending')",
    project: 'n.project_key = ?',
    orchestrator: 'n.source_orchestrator',
    timestamp: 'n.updated_at',
  },
  transcript: {
    id: 'tm.id',
    select: 'tf.project_key, tf.session_id, tf.id AS file_id, tm.seq, tm.text',
    from: 'transcript_messages tm JOIN transcript_files tf ON tf.id = tm.file_id',
    fts: 'transcript_messages_fts',
    ftsRowId: 'tm.id',
    embedding: 'JOIN transcript_embeddings e ON e.message_id = tm.id',
    project: 'tf.project_key = ?',
    orchestrator: 'tf.orchestrator',
    timestamp: transcriptTimestamp,
  },
};

function quoteTokens(tokens) {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' ') || null;
}

export function sanitizeFtsQuery(query) {
  if (typeof query !== 'string') return null;
  return quoteTokens(query.split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)));
}

export function truncatePreview(text, maxChars = MAX_PREVIEW_CHARS) {
  if (text.length <= maxChars) return text;
  if (maxChars < 1) return '';
  // Avoid emitting half of a surrogate pair at the cutoff.
  return text.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

function validateSelection(name, values, allowed) {
  const selection = Array.isArray(values) ? [...new Set(values)] : null;
  if (!selection || selection.some((value) => !allowed.includes(value))) {
    throw new Error(`${name} must be an array of ${allowed.join(', ')}`);
  }
  return selection;
}

function parseSince(since) {
  if (typeof since === 'string' && iso8601Date.exec(since)?.[0] === since) {
    const timestamp = Date.parse(since);
    const date = since.slice(0, 10);
    const midnight = Date.parse(date);
    if (Number.isFinite(timestamp) && Number.isFinite(midnight)
      && new Date(midnight).toISOString().startsWith(date)) return timestamp;
  }
  throw new Error('since must be a valid ISO 8601 date');
}

function sourceFilter(source, { scope, projectKey, orchestrators, sinceMs, memoryFilters, tag }) {
  const clauses = [];
  const params = [];
  if (source === sourceQueries.memory && memoryFilters) {
    for (const [column, value] of [
      ['project_key', memoryFilters.projectKey], ['scope', memoryFilters.scope],
      ['category', memoryFilters.category], ['status', memoryFilters.status],
    ]) {
      if (value !== undefined) {
        clauses.push(`m.${column} = ?`);
        params.push(value);
      }
    }
  } else if (source.status) clauses.push(source.status);
  if (source === sourceQueries.memory && tag !== undefined) {
    clauses.push('m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)');
    params.push(tag);
  }
  if (scope === 'current_project') {
    clauses.push(source.project);
    params.push(projectKey);
  }
  if (orchestrators?.length) {
    clauses.push(`${source.orchestrator} IN (${orchestrators.map(() => '?').join(', ')})`);
    params.push(...orchestrators);
  }
  if (sinceMs !== undefined) {
    clauses.push(`${source.timestamp} >= ?`);
    params.push(sinceMs);
  }
  return { clauses, params };
}

function vectorFilter(filter, model, dims) {
  const clauses = [...filter.clauses];
  const params = [...filter.params];
  if (typeof model === 'string' && model.length > 0) {
    clauses.push('e.model_id = ?');
    params.push(model);
  }
  if (dims !== undefined) {
    clauses.push('e.dims = ?');
    params.push(dims);
  }
  return { clauses, params };
}

function hasEligibleVectors(db, sources, filters, engine) {
  const embeddingSources = sources.filter((source) => sourceQueries[source].embedding);
  if (!embeddingSources.length) return false;
  let status;
  let expectedDims;
  try {
    status = engine.getStatus?.();
    if (status?.enabled === false || status?.reason) return false;
    if (typeof engine.getExpectedDims === 'function') {
      expectedDims = engine.getExpectedDims();
    } else if (status && (status.available || status.model === DEFAULT_EMBEDDING_MODEL
      || status.dims !== DEFAULT_EMBEDDING_DIMS)) {
      // Status-only engines can report the default width as a placeholder.
      expectedDims = status.dims;
    }
  } catch {
    return false;
  }

  const dims = Number.isInteger(expectedDims) && expectedDims > 0 ? expectedDims : undefined;
  return embeddingSources.some((source) => {
    const spec = sourceQueries[source];
    const { clauses, params } = vectorFilter(sourceFilter(spec, filters), status?.model, dims);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return Boolean(db.prepare(`SELECT 1 FROM ${spec.from} ${spec.embedding} ${where} LIMIT 1`).get(...params));
  });
}

function selectFields(source) {
  return `${source.id} AS id, ${source.select}, ${source.orchestrator} AS orchestrator, ${source.timestamp} AS sort_timestamp`;
}

function readFtsCandidates(db, source, filter, query, match, limit) {
  const statement = db.prepare(`
    SELECT ${selectFields(source)}, bm25(${source.fts}) AS rank_score
    FROM ${source.from} JOIN ${source.fts} ON ${source.fts}.rowid = ${source.ftsRowId}
    WHERE ${[...filter.clauses, `${source.fts} MATCH ?`].join(' AND ')}
    ORDER BY rank_score ASC, sort_timestamp DESC, id ASC
    LIMIT ?
  `);

  // SQLite's FTS parser treats a NUL as the end of its input.
  const fallback = () => quoteTokens(query.match(/[\p{L}\p{N}]+/gu) ?? []);
  if (match.includes('\0')) match = fallback();
  if (!match) return [];
  try {
    return statement.all(...filter.params, match, limit);
  } catch (error) {
    if (!/fts5: syntax error|unterminated string|no such column/i.test(error.message)) throw error;
    const plainMatch = fallback();
    return plainMatch ? statement.all(...filter.params, plainMatch, limit) : [];
  }
}

async function embedQuery(engine, query) {
  try {
    const vector = await engine.embed(query);
    if (!(Array.isArray(vector) || ArrayBuffer.isView(vector))
      || !vector.length || !vector.every(Number.isFinite)) return null;
    return { vector, model: engine.getStatus?.()?.model };
  } catch {
    return null;
  }
}

function* scanVectors(db, source, filter, { vector, model }) {
  const { clauses, params } = vectorFilter(filter, model, vector.length);
  const statement = db.prepare(`
    SELECT ${source.id} AS id, ${source.timestamp} AS sort_timestamp, e.vector AS stored_vector
    FROM ${source.from} ${source.embedding}
    WHERE ${clauses.join(' AND ')}
  `);
  for (const { stored_vector, ...row } of statement.iterate(...params)) {
    if (!(stored_vector instanceof Uint8Array)
      || stored_vector.byteLength !== vector.length * Float32Array.BYTES_PER_ELEMENT) continue;
    let similarity;
    try {
      similarity = cosineSimilarity(vector, decodeFloat32Vector(stored_vector));
    } catch {
      // Invalid stored vectors leave the lexical result available.
      continue;
    }
    yield { ...row, similarity };
  }
}

function compareAscending(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidates(a, b) {
  return b.sort_timestamp - a.sort_timestamp
    || compareAscending(a.source, b.source)
    || compareAscending(a.id, b.id);
}

function compareVectors(a, b) {
  return b.similarity - a.similarity || compareCandidates(a, b);
}

function readVectorCandidates(db, sources, filters, embedding, candidateLimit) {
  if (!(candidateLimit > 0)) return [];
  const top = [];
  const sourceFilters = new Map();
  for (const source of sources) {
    const spec = sourceQueries[source];
    if (!spec.embedding) continue;
    const filter = sourceFilter(spec, filters);
    sourceFilters.set(source, filter);
    for (const row of scanVectors(db, spec, filter, embedding)) {
      const candidate = { ...row, source };
      if (top.length === candidateLimit && compareVectors(candidate, top.at(-1)) >= 0) continue;
      let low = 0;
      let high = top.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (compareVectors(candidate, top[middle]) < 0) high = middle;
        else low = middle + 1;
      }
      if (top.length === candidateLimit) top.pop();
      top.splice(low, 0, candidate);
    }
  }

  const hydrated = new Map();
  for (const [source, filter] of sourceFilters) {
    const ids = top.filter((candidate) => candidate.source === source).map(({ id }) => id);
    if (!ids.length) continue;
    const spec = sourceQueries[source];
    const clauses = [...filter.clauses, `${spec.id} IN (${ids.map(() => '?').join(', ')})`];
    const rows = db.prepare(`
      SELECT ${selectFields(spec)} FROM ${spec.from} WHERE ${clauses.join(' AND ')}
    `).all(...filter.params, ...ids);
    for (const row of rows) hydrated.set(`${source}:${row.id}`, { ...row, source });
  }
  return top.map(({ source, id }) => hydrated.get(`${source}:${id}`)).filter(Boolean);
}

function fuseRanks(fts, vectors, rrfK, limit) {
  const merged = new Map();
  for (const [leg, rankField] of [[fts, 'ftsRank'], [vectors, 'vectorRank']]) {
    leg.forEach((row, index) => {
      const key = `${row.source}:${row.id}`;
      const hit = merged.get(key) ?? { row, score: 0, ftsRank: Infinity, vectorRank: Infinity };
      const rank = index + 1;
      hit[rankField] = rank;
      hit.score += 1 / (rrfK + rank);
      merged.set(key, hit);
    });
  }
  return [...merged.values()].sort((a, b) =>
    b.score - a.score
    || compareAscending(Math.min(a.ftsRank, a.vectorRank), Math.min(b.ftsRank, b.vectorRank))
    || compareAscending(a.ftsRank, b.ftsRank)
    || compareAscending(a.row.source, b.row.source)
    || compareAscending(String(a.row.id), String(b.row.id)),
  ).slice(0, limit).map(({ row, score }) => ({
    source: row.source,
    id: String(row.id),
    score,
    project_key: row.project_key,
    ...(row.orchestrator == null ? {} : { orchestrator: row.orchestrator }),
    ...(row.session_id == null ? {} : { session_id: row.session_id }),
    ...(row.source === 'transcript' ? { file_id: row.file_id, seq: row.seq } : {}),
    timestamp: new Date(row.sort_timestamp).toISOString(),
    ...(row.source === 'memory' ? { category: row.category } : {}),
    preview: truncatePreview(row.text),
  }));
}

export async function hybridSearch(db, options = {}) {
  const {
    query, cwd, defaultCwd, embeddingEngine, since, memoryFilters,
    sources: requestedSources = SEARCH_SOURCES,
    scope = 'current_project', rrfK = DEFAULT_RRF_K,
  } = options;
  if (!SEARCH_SCOPES.includes(scope)) throw new Error('scope must be current_project or all_projects');
  if (!Number.isFinite(rrfK) || rrfK <= 0) throw new Error('rrfK must be positive and finite');
  const tag = options.tag === undefined ? undefined : normalizeTag(options.tag);
  const sources = validateSelection('sources', requestedSources, SEARCH_SOURCES)
    .filter((source) => tag === undefined || source === 'memory');
  const orchestrators = options.orchestrators === undefined
    ? undefined : validateSelection('orchestrators', options.orchestrators, SEARCH_ORCHESTRATORS);
  const sinceMs = since === undefined ? undefined : parseSince(since);
  const maxLimit = memoryFilters ? MAX_LIST_LIMIT : MAX_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(maxLimit, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)));
  const projectKey = options.projectKey ?? resolveCachedProjectKey(cwd ?? defaultCwd, options.config, { optional: true })?.projectKey ?? 'global';
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  const result = { mode: 'fts-only', query: trimmedQuery, scope, project_key: projectKey, results: [] };
  if (!trimmedQuery || !sources.length || orchestrators?.length === 0) return result;

  const candidateLimit = Math.min(Math.max(limit * 4, 50), 200);
  const match = sanitizeFtsQuery(trimmedQuery);
  const filters = { scope, projectKey, orchestrators, sinceMs, memoryFilters, tag };
  const fts = [];
  const embedding = embeddingEngine && hasEligibleVectors(db, sources, filters, embeddingEngine)
    ? await embedQuery(embeddingEngine, trimmedQuery) : null;

  for (const source of sources) {
    const spec = sourceQueries[source];
    const filter = sourceFilter(spec, filters);
    if (match) {
      for (const row of readFtsCandidates(db, spec, filter, trimmedQuery, match, candidateLimit)) {
        fts.push({ ...row, source });
      }
    }
  }

  fts.sort((a, b) => a.rank_score - b.rank_score || compareCandidates(a, b));
  const vectors = embedding ? readVectorCandidates(db, sources, filters, embedding, candidateLimit) : [];
  result.mode = vectors.length > 0 ? 'hybrid' : 'fts-only';
  result.results = fuseRanks(fts.slice(0, candidateLimit), vectors, rrfK, limit).map((hit) =>
    hit.source === 'memory' ? { ...hit, tags: memoryTags(db, hit.id) } : hit);
  return result;
}
