import { transcriptMemoryToolName } from '../indexers/types.mjs';
import { ATTRIBUTION_MS } from './telemetry.mjs';

export function collectTranscriptAnalytics(db, { projectKey, start, end, events }) {
  const startIso = new Date(start - ATTRIBUTION_MS).toISOString();
  const endIso = new Date(end + ATTRIBUTION_MS).toISOString();
  const files = db.prepare(`
    SELECT f.id, f.project_key, f.session_id, MIN(m.timestamp) AS first_at, MAX(m.timestamp) AS last_at
    FROM transcript_files f JOIN transcript_messages m ON m.file_id = f.id
    WHERE m.timestamp IS NOT NULL ${projectKey ? 'AND f.project_key = ?' : ''}
    GROUP BY f.id HAVING last_at >= ? AND first_at < ?
  `).all(...(projectKey ? [projectKey] : []), startIso, endIso);
  const sessions = new Map();
  const activeByProject = new Map();
  const eventSessions = new Map();
  const detours = [];
  const rows = db.prepare(`
    SELECT line_no, timestamp, role, tool_names, NULL AS activity_json
    FROM transcript_messages WHERE file_id = ?
    UNION ALL
    SELECT line_no, timestamp, NULL, NULL, activity_json FROM transcript_tool_activity WHERE file_id = ?
    ORDER BY line_no
  `);

  function sessionFor(id, time) {
    if (!sessions.has(id)) sessions.set(id, { id, time, calls: 0, tokens: 0, turns: 0, indexed: false, ambiguous: false, observedMemoryUse: false });
    const session = sessions.get(id);
    session.time = Math.max(time, session.time);
    return session;
  }
  for (const file of files) {
    const first = Date.parse(file.first_at);
    const last = Date.parse(file.last_at);
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    const session = sessionFor(file.session_id, -Infinity);
    session.indexed = true;
    if (!activeByProject.has(file.project_key)) activeByProject.set(file.project_key, []);
    activeByProject.get(file.project_key).push({ id: file.session_id, first, last });

    const pending = new Map();
    const results = [];
    let line = null;
    function completeDetours(time) {
      for (const { startedAt, resultAt } of results) {
        if (startedAt >= start && startedAt < end && time >= resultAt) {
          detours.push({ time: startedAt, duration: time - startedAt, toolDuration: resultAt - startedAt });
        }
      }
      results.length = 0;
    }
    function processLine() {
      if (!line || !Number.isFinite(line.time)) return;
      const { time, role, tools, activity } = line;
      if (time >= start && time < end) session.time = Math.max(session.time, time);
      const hasResult = activity.some(({ type }) => type === 'result');
      if (time >= start && time < end && tools.some(transcriptMemoryToolName)) session.observedMemoryUse = true;
      // A user prompt starts a new turn, making the previous result ineligible.
      if (role === 'user' && !hasResult) {
        pending.clear();
        results.length = 0;
      }
      if (role === 'assistant') {
        completeDetours(time);
        if (time >= start && time < end && !tools.length && !activity.length) session.turns++;
      }
      for (const { type, callId, name, action } of activity) {
        if (type === 'call') {
          const tool = transcriptMemoryToolName(name);
          if (tool && time >= start && time < end) session.observedMemoryUse = true;
          if (tool === 'mem_search' || tool === 'mem_get' || (tool === 'mem_memory' && action === 'get')) {
            pending.set(callId, time);
          }
        }
        if (type === 'result' && pending.has(callId)) {
          const startedAt = pending.get(callId);
          pending.delete(callId);
          if (time >= startedAt) results.push({ startedAt, resultAt: time });
        }
      }
    }

    for (const row of rows.iterate(file.id, file.id)) {
      if (line?.number !== row.line_no) {
        processLine();
        line = { number: row.line_no, time: Date.parse(row.timestamp), role: null, tools: [], activity: [] };
      }
      if (row.role) {
        line.role = row.role;
        line.tools = row.tool_names ? JSON.parse(row.tool_names) : [];
      }
      if (row.activity_json) line.activity = JSON.parse(row.activity_json);
    }
    processLine();
  }

  const groups = Map.groupBy(events, ({ project_key, connection_id }) => JSON.stringify([project_key, connection_id]));
  for (const group of groups.values()) {
    const explicit = new Set(group.map(({ session_id }) => session_id).filter(Boolean));
    const candidates = activeByProject.get(group[0].project_key) ?? [];
    for (const event of group) {
      let id = event.session_id;
      if (!id) {
        const overlaps = new Set(candidates.filter(({ id, first, last }) =>
          (explicit.size === 0 || explicit.has(id))
          && last >= event.created_at - ATTRIBUTION_MS && first <= event.created_at + ATTRIBUTION_MS
        ).map(({ id }) => id));
        if (overlaps.size === 1) id = overlaps.values().next().value;
        if (overlaps.size > 1) {
          for (const candidate of overlaps) sessions.get(candidate).ambiguous = true;
        }
      }
      if (!id) continue;
      const session = sessionFor(id, event.created_at);
      session.calls++;
      session.tokens += event.response_tokens_est;
      eventSessions.set(event.id, id);
    }
  }

  return { sessions, eventSessions, detours };
}

