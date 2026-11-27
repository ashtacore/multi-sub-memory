import { createHmac, randomBytes } from 'node:crypto';
import { readCcusage } from './analytics/ccusage.mjs';
import { accessesPerWeek, WEEK_MS } from './analytics/dreamer-events.mjs';
import { ATTRIBUTION_MS, DAY_MS, utcDay } from './analytics/telemetry.mjs';
import { collectTranscriptAnalytics } from './analytics/transcripts.mjs';

export { createTelemetryRecorder, estimateTokens, rollupAndPruneAnalytics } from './analytics/telemetry.mjs';
export { readCcusage } from './analytics/ccusage.mjs';

const sum = (values) => values.reduce((total, value) => total + value, 0);
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const average = (values) => ratio(sum(values), values.length);
const histogram = (values) => Object.fromEntries(
  [...Map.groupBy(values, (value) => value)].sort(([a], [b]) => a - b).map(([key, group]) => [key, group.length]),
);

export function comparisonBuckets(window = '7d', monthMode = 'calendar', now = Date.now()) {
  if (!['7d', '3w', '2m'].includes(window)) throw new RangeError('Invalid analytics window');
  if (!['calendar', 'rolling30'].includes(monthMode)) throw new RangeError('Invalid analytics month mode');
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const date = new Date(today);
  if (window === '2m' && monthMode === 'calendar') {
    return [-2, -1].map((offset) => {
      const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
      const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset + 1, 1);
      return { start, end, label: utcDay(start).slice(0, 7) };
    });
  }
  const [count, days] = window === '7d' ? [7, 1] : window === '3w' ? [3, 7] : [2, 30];
  const end = window === '3w' ? today - ((date.getUTCDay() + 6) % 7) * DAY_MS : today;
  return Array.from({ length: count }, (_, index) => {
    const start = end - (count - index) * days * DAY_MS;
    return { start, end: start + days * DAY_MS, label: utcDay(start) };
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { avg: average(sorted), p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
}

function sizeDistribution(rows) {
  const values = rows.map(({ tokens_est }) => tokens_est);
  return {
    count: values.length,
    averageTokens: average(values),
    distribution: [
      { label: '0–63', count: values.filter((value) => value < 64).length },
      { label: '64–255', count: values.filter((value) => value >= 64 && value < 256).length },
      { label: '256–1023', count: values.filter((value) => value >= 256 && value < 1024).length },
      { label: '1024+', count: values.filter((value) => value >= 1024).length },
    ],
  };
}

function collectRetrieval(events) {
  const searches = [];
  const gets = [];
  const impressions = new Map();
  const followups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.project_key, event.connection_id]);
    const previous = followups.get(key);
    followups.delete(key);
    if (event.error_flag) continue;
    if (event.tool_name === 'mem_search') {
      const search = {
        time: event.created_at, results: event.result_count, research: event.is_research,
        clicked: new Map(), memories: JSON.parse(event.returned_memory_ids_json ?? '[]'),
      };
      searches.push(search);
      for (const id of search.memories) impressions.set(JSON.stringify([key, id]), search);
      if (previous && event.created_at - previous.created_at <= ATTRIBUTION_MS) previous.followup = true;
    }
    if (event.tool_name === 'mem_get') {
      const get = { ...event, followup: false };
      gets.push(get);
      followups.set(key, get);
      if (event.origin === 'search') {
        const search = impressions.get(JSON.stringify([key, event.target_memory_id]));
        if (search && event.search_rank > 0 && event.created_at - search.time <= ATTRIBUTION_MS) {
          search.clicked.set(event.target_memory_id, event.search_rank);
        }
      }
    }
  }

  return { searches, gets };
}

function analyzeRetrieval(retrieval, compactionTimes, start, end) {
  const searches = retrieval.searches.filter(({ time }) => time >= start && time < end);
  const gets = retrieval.gets.filter(({ created_at }) => created_at >= start && created_at < end);
  const byClass = { original: { impressions: 0, clicks: 0 }, compacted: { impressions: 0, clicks: 0 } };
  const isCompacted = (id, timestamp) => (compactionTimes.get(id) ?? Infinity) <= timestamp;
  for (const search of searches) {
    for (const id of search.memories) {
      const cohort = byClass[isCompacted(id, search.time) ? 'compacted' : 'original'];
      cohort.impressions++;
      cohort.clicks += Number(search.clicked.has(id));
    }
  }
  for (const cohort of Object.values(byClass)) cohort.ctr = ratio(cohort.clicks, cohort.impressions);
  const converted = searches.filter(({ clicked }) => clicked.size > 0);
  const eligible = searches.filter(({ results }) => results > 0);
  const compactedGets = gets.filter((get) => isCompacted(get.target_memory_id, get.created_at));
  return {
    quality: {
      searchCount: searches.length,
      convertedSearchCount: converted.length,
      searchToGetConversionRate: ratio(converted.length, searches.length),
      meanReciprocalRank: ratio(sum(converted.map(({ clicked }) => 1 / Math.min(...clicked.values()))), searches.length),
      rankDistribution: histogram(gets.filter(({ search_rank }) => search_rank != null).map(({ search_rank }) => search_rank)),
      zeroHitSearchRate: ratio(searches.length - eligible.length, searches.length),
      abandonedSearchRate: ratio(eligible.length - converted.length, eligible.length),
      researchRate: ratio(sum(searches.map(({ research }) => research)), searches.length),
      getOrigins: Object.fromEntries(['search', 'bootstrap', 'direct'].map((origin) =>
        [origin, gets.filter((get) => get.origin === origin).length])),
    },
    byClass,
    compactedGetResearchRate: ratio(compactedGets.filter(({ followup }) => followup).length, compactedGets.length),
  };
}

function toolPerformance(events) {
  return Object.fromEntries([...Map.groupBy(events, (event) => event.tool_name)].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rows]) => [name, {
      callCount: rows.length,
      errorCount: sum(rows.map(({ error_flag }) => error_flag)),
      durationMs: stats(rows.map(({ duration_ms }) => duration_ms)),
      responseTokens: stats(rows.map(({ response_tokens_est }) => response_tokens_est)),
      resultCount: sum(rows.map(({ result_count }) => result_count)),
    }]));
}

function evaluateCost(sessions, usage, excludedSessions, start, end, cutoff) {
  const cohorts = { no: [], lite: [], heavy: [] };
  let unclassifiedSessionCount = 0;
  let matchedSessionCount = 0;
  for (const session of sessions.values()) {
    if (session.time < start || session.time >= end || excludedSessions.has(session.id)) continue;
    if (session.time < cutoff || session.ambiguous || (session.calls === 0 && session.observedMemoryUse)) {
      unclassifiedSessionCount++;
      continue;
    }
    const values = usage.sessions?.get(session.id);
    if (values) matchedSessionCount++;
    const totalInput = values?.inputTokens == null ? null
      : values.inputTokens + (values.cacheReadTokens ?? 0) + (values.cacheCreationTokens ?? 0);
    cohorts[session.calls === 0 ? 'no' : session.calls < 5 ? 'lite' : 'heavy'].push({
      ...values,
      contextTax: totalInput ? session.tokens / totalInput : null,
      cacheHitRatio: totalInput && values.cacheReadTokens != null ? values.cacheReadTokens / totalInput : null,
      turns: session.indexed ? session.turns : null,
    });
  }
  const metric = (rows, field) => average(rows.map((row) => row[field]).filter(Number.isFinite));
  return {
    available: matchedSessionCount > 0,
    adapterAvailable: usage.available,
    matchedSessionCount,
    unclassifiedSessionCount,
    ...(matchedSessionCount === 0 && { reason: usage.reason ?? 'No local usage matched sessions in this selection' }),
    cohorts: Object.fromEntries(Object.entries(cohorts).map(([name, rows]) => [name, {
      sessionCount: rows.length, sessionsWithCost: rows.filter(({ costUsd }) => costUsd != null).length,
      averageCostUsd: metric(rows, 'costUsd'), averageInputTokens: metric(rows, 'inputTokens'),
      averageOutputTokens: metric(rows, 'outputTokens'), averageCacheReadTokens: metric(rows, 'cacheReadTokens'),
      averageCacheCreationTokens: metric(rows, 'cacheCreationTokens'), cacheHitRatio: metric(rows, 'cacheHitRatio'),
      memoryContextTax: metric(rows, 'contextTax'), averageTurnsPerSession: metric(rows, 'turns'),
    }])),
  };
}

function readSnapshot(db, read) {
  db.exec('SAVEPOINT analytics_report');
  try {
    return read();
  } finally {
    db.exec('RELEASE analytics_report');
  }
}

function dreamCost(runs, usage) {
  const details = runs.map(({ id, started_at, input_tokens, output_tokens, cost_usd, session_id }) => {
    const matched = usage.sessions?.get(session_id);
    return {
      runId: id, startedAt: started_at,
      inputTokens: input_tokens ?? matched?.inputTokens ?? null,
      outputTokens: output_tokens ?? matched?.outputTokens ?? null,
      costUsd: cost_usd ?? matched?.costUsd ?? null,
    };
  });
  const total = (field) => {
    const values = details.map((run) => run[field]).filter(Number.isFinite);
    return values.length ? sum(values) : null;
  };
  return { runCount: runs.length, inputTokens: total('inputTokens'), outputTokens: total('outputTokens'),
    costUsd: total('costUsd'), runs: details };
}

function dreamQuality({ events, allCompactions, memories, now, retrieval, touchedIds }) {
  const memoryMap = new Map(memories.map((memory) => [memory.id, memory]));
  const compacted = events.filter(({ event_type }) => event_type === 'compacted');
  const archived = events.filter(({ event_type }) => event_type === 'archived');
  const resurrected = events.filter(({ event_type }) => event_type === 'resurrected');
  const undo = new Set(events.filter(({ event_type }) => event_type === 'human_undo').map(({ memory_id }) => memory_id));
  const edit = new Set(events.filter(({ event_type }) => event_type === 'human_edit').map(({ memory_id }) => memory_id));
  const sources = new Set(archived.map(({ memory_id }) => memory_id));
  for (const event of compacted) {
    for (const id of JSON.parse(event.source_memory_ids_json ?? '[]')) {
      if (id !== event.memory_id) sources.add(id);
    }
  }
  const revivedSources = new Set(resurrected.flatMap(({ source_memory_ids_json }) => JSON.parse(source_memory_ids_json ?? '[]')));
  const latestCompactions = new Map(allCompactions.map((event) => [event.memory_id, event.id]));
  const velocity = compacted.flatMap((event) => {
    const target = memoryMap.get(event.memory_id);
    if (!target || latestCompactions.get(event.memory_id) !== event.id || event.target_access_count_at_event == null) return [];
    return [{
      memoryId: target.id, compactedAt: event.created_at, before: event.source_access_rate_per_week,
      after: accessesPerWeek(Math.max(0, target.access_count - event.target_access_count_at_event), event.created_at, now),
    }];
  });
  const rapidRepeats = new Set();
  const previousCompactions = new Map();
  for (const { memory_id, source_memory_ids_json, created_at } of allCompactions) {
    const lineage = [memory_id, ...JSON.parse(source_memory_ids_json ?? '[]')];
    if (lineage.some((id) => created_at - (previousCompactions.get(id) ?? -Infinity) <= WEEK_MS)) {
      rapidRepeats.add(memory_id);
    }
    previousCompactions.set(memory_id, created_at);
  }
  const churn = memories.filter(({ id, compaction_count }) => compaction_count >= 3 || rapidRepeats.has(id))
    .map(({ id, compaction_count }) => ({ memoryId: id, compactionCount: compaction_count }))
    .sort((a, b) => b.compactionCount - a.compactionCount || a.memoryId.localeCompare(b.memoryId));
  return {
    compactionCountDistribution: histogram(memories.map(({ compaction_count }) => compaction_count)),
    repeatCompaction: { count: churn.length, memories: churn },
    velocity: { samples: velocity, before: average(velocity.map(({ before }) => before)),
      after: average(velocity.map(({ after }) => after)) },
    searchImpressions: retrieval.byClass,
    compactedGetResearchRate: retrieval.compactedGetResearchRate,
    resurrection: {
      count: resurrected.length, rate: ratio([...revivedSources].filter((id) => sources.has(id)).length, sources.size),
      sourceCount: sources.size,
      events: resurrected.map(({ memory_id, created_at, source_memory_ids_json }) => ({
        memoryId: memory_id, time: created_at, sourceMemoryIds: JSON.parse(source_memory_ids_json ?? '[]'),
      })),
    },
    human: {
      touchedMemoryCount: touchedIds.size, undoCount: undo.size, editCount: edit.size,
      undoRate: ratio(undo.size, touchedIds.size), editRate: ratio(edit.size, touchedIds.size),
    },
    accessVelocityByCompactionCount: [...Map.groupBy(memories, ({ compaction_count }) => compaction_count)]
      .sort(([a], [b]) => a - b).map(([compactionCount, rows]) => ({
        compactionCount, memoryCount: rows.length,
        averageAccessesPerWeek: average(rows.map(({ access_count, created_at }) => accessesPerWeek(access_count, created_at, now))),
      })),
  };
}

export async function buildAnalyticsReport(db, {
  projectKey, window = '7d', monthMode = 'calendar', now = Date.now(), ccusageRunner,
  includeSessions = true, retentionDays = 93,
} = {}) {
  const buckets = comparisonBuckets(window, monthMode, now);
  const start = buckets[0].start;
  const end = buckets.at(-1).end;
  const cutoff = Math.floor(now / DAY_MS) * DAY_MS - retentionDays * DAY_MS;
  const eventStart = Math.max(start, cutoff);
  const {
    eventTimeline, events, memories, notes, dreamEvents, allCompactions, compactionTimes, runs, excludedSessions, touchedIds, transcripts, rollups,
  } = readSnapshot(db, () => {
    const projectFilter = projectKey ? 'AND project_key = ?' : '';
    const projectArgs = projectKey ? [projectKey] : [];
    const eventTimeline = db.prepare(`
      SELECT * FROM mcp_tool_events WHERE created_at >= ? AND created_at < ? ${projectFilter} ORDER BY created_at, id
    `).all(eventStart, Math.min(end + ATTRIBUTION_MS, now), ...projectArgs);
    const events = eventTimeline.filter(({ created_at }) => created_at < end);
    const memories = db.prepare(`
      SELECT id, access_count, tokens_est, created_at, compaction_count, dreamer_touched_at
      FROM memories WHERE 1 ${projectFilter}
    `).all(...projectArgs);
    const notes = db.prepare(`SELECT tokens_est FROM notes WHERE 1 ${projectFilter}`).all(...projectArgs);
    const dreamEvents = db.prepare(`
      SELECT * FROM dreamer_memory_events WHERE created_at >= ? AND created_at < ? ${projectFilter} ORDER BY created_at, id
    `).all(start, end, ...projectArgs);
    const allCompactions = db.prepare(`
      SELECT id, memory_id, created_at, source_memory_ids_json FROM dreamer_memory_events
      WHERE event_type = 'compacted' ORDER BY created_at, id
    `).all();
    const compactionTimes = new Map();
    for (const event of allCompactions) {
      if (!compactionTimes.has(event.memory_id)) compactionTimes.set(event.memory_id, event.created_at);
    }
    const runs = db.prepare(`
      SELECT id, session_id, started_at, input_tokens, output_tokens, cost_usd
      FROM dream_runs WHERE started_at >= ? AND started_at < ? ${projectFilter} ORDER BY started_at, id
    `).all(start, end, ...projectArgs);
    const excludedSessions = new Set(db.prepare('SELECT DISTINCT session_id FROM dream_runs WHERE session_id IS NOT NULL')
      .all().map(({ session_id }) => session_id));
    const touchedIds = new Set(memories.filter(({ dreamer_touched_at }) => dreamer_touched_at != null).map(({ id }) => id));
    for (const { memory_id, event_type } of dreamEvents) {
      if (event_type !== 'resurrected') touchedIds.add(memory_id);
    }

    const transcripts = includeSessions
      ? collectTranscriptAnalytics(db, { projectKey, start, end, events })
      : { sessions: new Map(), eventSessions: new Map(), detours: [] };
    // The write transaction updates daily totals with their raw event.
    // Percentiles and per-impression attribution still use exact samples.
    const rollups = db.prepare(`
      SELECT day_utc, SUM(call_count) AS calls, SUM(error_count) AS errors,
        SUM(total_response_tokens) AS responseTokens
      FROM analytics_daily_rollups WHERE day_utc >= ? AND day_utc < ? ${projectFilter}
      GROUP BY day_utc
    `).all(utcDay(eventStart), utcDay(end), ...projectArgs);
    return { eventTimeline, events, memories, notes, dreamEvents, allCompactions, compactionTimes, runs, excludedSessions, touchedIds, transcripts, rollups };
  });
  const selected = (rows, field, bucket) => rows.filter((row) => row[field] >= bucket.start && row[field] < bucket.end);
  const detourStats = (rows) => ({
    count: rows.length, durationMs: stats(rows.map(({ duration }) => duration)),
    toolResultDurationMs: stats(rows.map(({ toolDuration }) => toolDuration)),
  });

  const usage = includeSessions || runs.some(({ session_id }) => session_id)
    ? await readCcusage({ runner: ccusageRunner, since: utcDay(start), until: utcDay(end - 1) })
    : { available: false, reason: 'Session analysis disabled' };
  const retrievalTimeline = collectRetrieval(eventTimeline);
  const retrieval = analyzeRetrieval(retrievalTimeline, compactionTimes, start, end);
  const series = buckets.map((bucket) => {
    const samples = selected(events, 'created_at', bucket);
    const daily = rollups.filter(({ day_utc }) => day_utc >= utcDay(bucket.start) && day_utc < utcDay(bucket.end));
    const totals = {
      calls: sum(daily.map(({ calls }) => calls)), errors: sum(daily.map(({ errors }) => errors)),
      responseTokens: sum(daily.map(({ responseTokens }) => responseTokens)),
    };
    const completeTelemetry = bucket.start >= cutoff;
    const bucketRuns = selected(runs, 'started_at', bucket);
    const bucketDreamEvents = selected(dreamEvents, 'created_at', bucket);
    return {
      ...bucket,
      completeTelemetry,
      totals,
      quality: analyzeRetrieval(retrievalTimeline, compactionTimes, bucket.start, bucket.end).quality,
      cost: evaluateCost(transcripts.sessions, usage, excludedSessions, bucket.start, bucket.end, cutoff),
      speedAndTokens: { tools: toolPerformance(samples), memoryDetour: detourStats(selected(transcripts.detours, 'time', bucket)) },
      dreamer: {
        cost: dreamCost(bucketRuns, usage),
        eventCounts: Object.fromEntries(['compacted', 'archived', 'resurrected', 'human_undo', 'human_edit']
          .map((type) => [type, bucketDreamEvents.filter(({ event_type }) => event_type === type).length])),
      },
    };
  });

  return {
    window, monthMode, start, end, retentionDays,
    quality: {
      ...retrieval.quality,
      corpus: {
        unusedMemoryRatio: ratio(memories.filter(({ access_count }) => access_count === 0).length, memories.length),
        memories: sizeDistribution(memories), notes: sizeDistribution(notes),
      },
    },
    cost: {
      ...evaluateCost(transcripts.sessions, usage, excludedSessions, start, end, cutoff),
      thresholds: { no: 0, liteMin: 1, heavyMin: 5 },
      correlatedCallCount: transcripts.eventSessions.size,
      uncorrelatedCallCount: events.length - transcripts.eventSessions.size,
    },
    speedAndTokens: { tools: toolPerformance(events), memoryDetour: detourStats(transcripts.detours) },
    dreamer: {
      cost: dreamCost(runs, usage),
      ...dreamQuality({ events: dreamEvents, allCompactions, memories, now, retrieval, touchedIds }),
    },
    series,
  };
}

export function formatAnalyticsExport(report, format = 'json') {
  if (format === 'json') {
    const key = randomBytes(32);
    // Importers can supply IDs, so pseudonymize even identifiers that look opaque.
    const pseudonym = (id) => createHmac('sha256', key).update(id).digest('hex').slice(0, 16);
    return JSON.parse(JSON.stringify(report, (field, value) => {
      if (['runId', 'memoryId'].includes(field)) return pseudonym(value);
      if (field === 'sourceMemoryIds') return value.map(pseudonym);
      return value;
    }));
  }
  if (format !== 'markdown') throw new RangeError('Invalid analytics export format');
  const number = (value) => value == null ? '—' : String(Number(value.toFixed(3)));
  const percent = (value) => value == null ? '—' : number(100 * value) + '%';
  const quality = report.quality;
  const dreamer = report.dreamer;
  return [
    '# Memory analytics', '',
    'UTC window ' + utcDay(report.start) + ' through ' + utcDay(report.end - 1) + ' (' + report.window + ', ' + report.monthMode + ')',
    '', '## Quality', '',
    '- Searches ' + quality.searchCount + ', search-to-get conversion ' + percent(quality.searchToGetConversionRate)
      + ', mean reciprocal rank ' + number(quality.meanReciprocalRank),
    '- Zero hits ' + percent(quality.zeroHitSearchRate) + ', abandoned ' + percent(quality.abandonedSearchRate)
      + ', re-search ' + percent(quality.researchRate),
    '- Unused memories ' + percent(quality.corpus.unusedMemoryRatio) + ', mean memory/note tokens '
      + number(quality.corpus.memories.averageTokens) + '/' + number(quality.corpus.notes.averageTokens),
    '', '## Cost', '',
    ...(report.cost.reason ? [report.cost.reason, ''] : []),
    '| Memory use | Sessions | Mean USD | Cache hit | Context tax |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.cost.cohorts).map(([name, row]) =>
      `| ${name} | ${row.sessionCount} | ${number(row.averageCostUsd)} | ${percent(row.cacheHitRatio)} | ${percent(row.memoryContextTax)} |`),
    '', '## Speed and tokens', '',
    '| Tool | Calls | Mean ms | p95 ms | Mean tokens | p95 tokens |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.speedAndTokens.tools).map(([name, row]) =>
      `| ${name} | ${row.callCount} | ${number(row.durationMs.avg)} | ${number(row.durationMs.p95)} | ${number(row.responseTokens.avg)} | ${number(row.responseTokens.p95)} |`),
    '- Memory detour p95 ' + number(report.speedAndTokens.memoryDetour.durationMs.p95) + ' ms',
    '', '## Dreamer', '',
    '- Runs ' + dreamer.cost.runCount + ', usage ' + number(dreamer.cost.inputTokens) + '/' + number(dreamer.cost.outputTokens)
      + ' input/output tokens, USD ' + number(dreamer.cost.costUsd),
    '- Repeat compactions ' + dreamer.repeatCompaction.count + ', resurrected ' + dreamer.resurrection.count,
    '- Undo ' + percent(dreamer.human.undoRate) + ', edit ' + percent(dreamer.human.editRate),
    '- Mean accesses/week before and after compaction ' + number(dreamer.velocity.before) + '/' + number(dreamer.velocity.after),
    '', '## Comparison buckets', '',
    '| UTC bucket | Calls | Errors | Response tokens | Complete telemetry |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.series.map(({ label, totals, completeTelemetry }) =>
      `| ${label} | ${totals.calls} | ${totals.errors} | ${totals.responseTokens} | ${completeTelemetry ? 'yes' : 'no'} |`),
    '',
  ].join('\n');
}

