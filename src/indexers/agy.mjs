import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../config.mjs';
import {
  discoverJsonlFiles, extractMessageContent, firstNonBlankString, firstNonEmptyString, normalizeTranscriptTimestamp,
  parseJsonlRecord, readIncrementalJsonlLines,
} from './types.mjs';

export function getDefaultAgySessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
}

export function agySessionId(record) {
  return firstNonBlankString(record?.sessionId, record?.session_id, record?.conversationId, record?.conversation_id);
}

function isCanonicalTranscript(segments) {
  const [conversation, generated, logs, file] = segments;
  return segments.length === 4 && Boolean(conversation) && conversation !== '.' && conversation !== '..'
    && generated === '.system_generated' && logs === 'logs' && file === 'transcript.jsonl';
}

function agyRole(record) {
  switch (record.type) {
    case 'USER_INPUT': return 'user';
    case 'PLANNER_RESPONSE': return 'assistant';
    case 'SYSTEM_MESSAGE': return 'system';
    case 'GENERIC':
      if (record.source === 'USER_EXPLICIT') return 'user';
      if (record.source === 'MODEL') return 'assistant';
      return undefined;
    default: return undefined;
  }
}

export function parseAgyMessage(record) {
  const role = agyRole(record);
  if (!role) return undefined;
  const { text, toolNames, hasToolResult } = extractMessageContent(record.content);
  const names = new Set(toolNames);
  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      const name = firstNonEmptyString(call?.name, call?.function?.name)?.trim();
      if (name) names.add(name);
    }
  }
  return {
    role, text, toolNames: [...names], skipEmbedding: hasToolResult,
    timestamp: normalizeTranscriptTimestamp(record.created_at) ?? normalizeTranscriptTimestamp(record.timestamp),
  };
}

/** @type {import('./types.mjs').TranscriptAdapter} */
export const agyAdapter = {
  orchestrator: 'agy',
  discoverFiles(config) {
    const override = config?.indexers?.agy?.sessionsDir;
    const root = override ? expandHome(override) : getDefaultAgySessionsDir();
    return discoverJsonlFiles(root).filter((file) => {
      const segments = path.relative(root, file).split(path.sep);
      if (segments.length === 1) return segments[0] !== 'transcript_full.jsonl';
      return isCanonicalTranscript(segments);
    });
  },
  parseIncremental(filePath, byteOffset = 0, existingMeta = {}) {
    const root = path.resolve(existingMeta.sessionsDir ? expandHome(existingMeta.sessionsDir) : getDefaultAgySessionsDir());
    const resolvedFile = path.resolve(filePath);
    const relative = path.relative(root, resolvedFile);
    let segments = relative.split(path.sep);
    if (existingMeta.sessionsDir === undefined && (segments[0] === '..' || path.isAbsolute(relative))) {
      // Standalone callers can parse canonical transcripts outside the default root.
      segments = resolvedFile.slice(path.parse(resolvedFile).root.length).split(path.sep).slice(-4);
    }
    const fallbackId = isCanonicalTranscript(segments) ? segments[0] : path.basename(filePath, '.jsonl');
    const { lines, ...checkpoint } =
      readIncrementalJsonlLines(filePath, byteOffset, existingMeta.lineCount, existingMeta.checkpointHash);
    let { sessionId, cwd } = existingMeta;
    let seq = existingMeta.nextSeq ?? 0;
    const messages = [];

    for (const { line, lineNo } of lines) {
      const record = parseJsonlRecord(line);
      if (!record) continue;
      sessionId = agySessionId(record) ?? sessionId;
      cwd = firstNonEmptyString(record.cwd, record.workspace, record.workspace_root) ?? cwd;
      const message = parseAgyMessage(record);
      if (!message || message.role === 'system' || (!message.text && !message.toolNames.length)) continue;
      messages.push({ seq: seq++, lineNo, ...message });
    }

    return { sessionId: sessionId ?? fallbackId, cwd, messages, ...checkpoint };
  },
};
