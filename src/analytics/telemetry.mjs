import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const DAY_MS = 86_400_000;
export const ATTRIBUTION_MS = 60_000;
const HISTORY_LIMIT = 1024;
const SESSION_ENV = ['MULTI_SUB_MEMORY_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'OMP_SESSION_ID'];

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function wordSet(text) {
  return new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function wordSimilarity(first, second) {
  if (!first.size || !second.size) return 0;
  const shared = [...first].filter((word) => second.has(word)).length;
  return shared / (first.size + second.size - shared);
}

export function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function pruneExpired(db, retentionDays, now) {
  const cutoff = Math.floor(now / DAY_MS) * DAY_MS - retentionDays * DAY_MS;
  db.prepare('DELETE FROM mcp_tool_events WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM analytics_daily_rollups WHERE day_utc < ?').run(utcDay(cutoff));
}

function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function rollupAndPruneAnalytics(db, { retentionDays = 93, now = Date.now() } = {}) {
  transaction(db, () => {
    pruneExpired(db, retentionDays, now);
    db.prepare(`
      INSERT INTO analytics_daily_rollups (
        day_utc, project_key, tool_name, call_count, error_count, total_duration_ms, max_duration_ms,
        total_response_tokens, total_results, zero_result_count,
        search_to_get_count, direct_get_count, bootstrap_get_count, research_count, updated_at
      )
      SELECT date(created_at / 1000.0, 'unixepoch'), project_key, tool_name,
        COUNT(*), SUM(error_flag), SUM(duration_ms), MAX(duration_ms),
        SUM(response_tokens_est), SUM(result_count), SUM(error_flag = 0 AND result_count = 0),
        SUM(CASE WHEN error_flag = 0 AND origin = 'search' THEN 1 ELSE 0 END),
        SUM(CASE WHEN error_flag = 0 AND origin = 'direct' THEN 1 ELSE 0 END),
        SUM(CASE WHEN error_flag = 0 AND origin = 'bootstrap' THEN 1 ELSE 0 END),
        SUM(is_research), ?
      FROM mcp_tool_events
      GROUP BY 1, 2, 3
      ON CONFLICT (day_utc, project_key, tool_name) DO UPDATE SET
        call_count = excluded.call_count, error_count = excluded.error_count,
        total_duration_ms = excluded.total_duration_ms, max_duration_ms = excluded.max_duration_ms,
        total_response_tokens = excluded.total_response_tokens, total_results = excluded.total_results,
        zero_result_count = excluded.zero_result_count, search_to_get_count = excluded.search_to_get_count,
        direct_get_count = excluded.direct_get_count, bootstrap_get_count = excluded.bootstrap_get_count,
        research_count = excluded.research_count, updated_at = excluded.updated_at
    `).run(now);
  });
}

export function createTelemetryRecorder(db, {
  env = process.env, now = Date.now, retentionDays = 93, connectionId = randomUUID(),
} = {}) {
  const sessionId = SESSION_ENV.map((key) => env[key]?.trim()).find(Boolean) ?? null;
  const hashKey = randomBytes(32);
  const impressions = new Map();
  const searches = new Map();
  const lastCalls = new Map();
  const queue = [];
  const deferred = [];
  let pending;
  let sink;
  let insert;
  let maintenanceDay;
  let closed = false;

  function flush() {
    clearImmediate(pending);
    pending = undefined;
    try {
      const location = db.location?.() ?? db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.file;
      sink ??= location ? new DatabaseSync(location) : db;
      if (sink !== db && !insert) sink.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = NORMAL');
      insert ??= sink.prepare(`
        INSERT INTO mcp_tool_events (
          project_key, connection_id, session_id, tool_name, duration_ms, response_tokens_est,
          result_count, origin, search_rank, target_memory_id, returned_memory_ids_json,
          query_hash, is_research, error_flag, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of deferred.splice(0)) {
        try {
          const payload = event(sink);
          if (payload) record(payload, false);
        } catch {
          // Collection is best-effort.
        }
      }
      const time = now();
      const day = utcDay(time);
      if (queue.length || day !== maintenanceDay) {
        transaction(sink, () => {
          for (const row of queue) {
            try { insert.run(...row); } catch { /* Collection is best-effort. */ }
          }
          if (day !== maintenanceDay) pruneExpired(sink, retentionDays, time);
        });
        maintenanceDay = day;
      }
    } catch {
      // Analytics never affects MCP availability, including when storage is busy.
    } finally {
      deferred.length = 0;
      queue.length = 0;
    }
  }

  function pruneHistory(map, time) {
    for (const [key, value] of map) {
      if (time - value.time > ATTRIBUTION_MS || map.size > HISTORY_LIMIT) map.delete(key);
    }
  }

  function record({
    projectKey, toolName, durationMs = 0, responseText, resultCount = 0,
    returnedMemories, targetMemoryId = null, query, error = false, createdAt = now(),
  }, schedule = true) {
    if (closed) return;
    pruneHistory(impressions, createdAt);
    pruneHistory(searches, createdAt);
    pruneHistory(lastCalls, createdAt);
    let origin = null;
    let rank = null;
    let queryHash = null;
    let research = false;
    if (toolName === 'mem_get' && !error) {
      const key = JSON.stringify([projectKey, targetMemoryId]);
      const prior = impressions.get(key);
      const search = prior?.search && createdAt - prior.search.time <= ATTRIBUTION_MS;
      const bootstrap = prior?.bootstrap && createdAt - prior.bootstrap.time <= ATTRIBUTION_MS;
      origin = search ? 'search' : bootstrap ? 'bootstrap' : 'direct';
      rank = search ? prior.search.rank : null;
    }
    if (toolName === 'mem_search' && !error && typeof query === 'string') {
      const words = wordSet(query.slice(0, 2048));
      queryHash = words.size ? createHmac('sha256', hashKey).update([...words].sort().join(' ')).digest('hex').slice(0, 16) : null;
      if (queryHash) {
        const followsGet = lastCalls.get(projectKey)?.get === true;
        research = [...searches.values()].some((past) => past.projectKey === projectKey
          && (followsGet || wordSimilarity(words, past.words) >= 0.75));
        const key = JSON.stringify([projectKey, queryHash]);
        searches.delete(key);
        searches.set(key, { projectKey, words, time: createdAt });
      }
    }
    for (const { id, rank: position } of returnedMemories ?? []) {
      const key = JSON.stringify([projectKey, id]);
      const prior = impressions.get(key);
      const search = toolName === 'mem_search' ? { rank: position, time: createdAt } : prior?.search;
      impressions.delete(key);
      impressions.set(key, {
        time: createdAt,
        search: search && createdAt - search.time <= ATTRIBUTION_MS ? search : null,
        bootstrap: toolName === 'mem_bootstrap' ? { time: createdAt } : prior?.bootstrap,
      });
    }
    lastCalls.delete(projectKey);
    lastCalls.set(projectKey, { get: toolName === 'mem_get' && !error, time: createdAt });
    queue.push([
      projectKey, connectionId, sessionId, toolName, durationMs, estimateTokens(responseText), resultCount,
      origin, rank, targetMemoryId, returnedMemories ? JSON.stringify(returnedMemories.map(({ id }) => id)) : null,
      queryHash, Number(research), Number(error), createdAt,
    ]);
    if (schedule) pending ??= setImmediate(flush);
  }

  pending = setImmediate(flush).unref();
  return {
    connectionId, sessionId, record, flush,
    defer(event) {
      if (closed) return;
      deferred.push(event);
      pending ??= setImmediate(flush);
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
      try { if (sink && sink !== db) sink.close(); } catch { /* Optional connection. */ }
    },
  };
}

