import { DAY_MS, wordSet, wordSimilarity } from './telemetry.mjs';

export const WEEK_MS = 7 * DAY_MS;

export function accessesPerWeek(accessCount, startedAt, now) {
  return accessCount * WEEK_MS / Math.max(DAY_MS, now - startedAt);
}

export function recordDreamerEvent(db, {
  projectKey, runId = null, memoryId, type, sourceIds, sourceRate = null,
  compactionCount = null, accessCount = null, now,
}) {
  db.prepare(`
    INSERT INTO dreamer_memory_events (project_key, dream_run_id, memory_id, event_type,
      source_memory_ids_json, source_access_rate_per_week, compaction_count_after, target_access_count_at_event, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectKey, runId, memoryId, type, sourceIds ? JSON.stringify(sourceIds) : null, sourceRate,
    compactionCount, accessCount, now);
}

export function recordResurrection(db, memory, { now, previous }) {
  try {
    const candidates = db.prepare(`
      WITH recent AS (
        SELECT dream_run_id, memory_id, event_type, source_memory_ids_json, created_at
        FROM dreamer_memory_events
        WHERE project_key = ? AND created_at BETWEEN ? AND ? AND event_type IN ('archived', 'compacted')
      ), lineage AS (
        SELECT memory_id AS id, dream_run_id, created_at FROM recent WHERE event_type = 'archived'
        UNION ALL
        SELECT source.value, dream_run_id, created_at
        FROM recent, json_each(source_memory_ids_json) AS source
        WHERE event_type = 'compacted' AND source.value <> memory_id
      ), latest AS (
        SELECT id, dream_run_id, ROW_NUMBER() OVER (PARTITION BY id ORDER BY created_at DESC) AS entry
        FROM lineage
      )
      SELECT m.id, m.content, l.dream_run_id FROM latest l JOIN memories m ON m.id = l.id
      WHERE l.entry = 1 AND m.project_key = ? AND (m.status IN ('archived', 'superseded') OR m.id = ?)
      ORDER BY m.dreamer_touched_at DESC, m.id LIMIT 100
    `).all(memory.project_key, now - 30 * DAY_MS, now, memory.project_key, previous?.id ?? null);
    let matched = candidates.find((candidate) => candidate.id === previous?.id || candidate.content === memory.content);
    if (!matched && candidates.length) {
      const query = wordSet(memory.content.slice(0, 16_000));
      let score = 0.79;
      if (query.size >= 4) {
        for (const candidate of candidates) {
          const similarity = wordSimilarity(query, wordSet(candidate.content.slice(0, 16_000)));
          if (similarity > score) {
            matched = candidate;
            score = similarity;
          }
        }
      }
    }
    if (matched) recordDreamerEvent(db, {
      projectKey: memory.project_key, runId: matched.dream_run_id, memoryId: memory.id, type: 'resurrected',
      sourceIds: [matched.id], now,
    });
  } catch {
    // Detection is advisory and must not disrupt memory writes.
  }
}

