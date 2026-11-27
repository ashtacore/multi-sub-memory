import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../config.mjs';
import {
  appendToolActivity, transcriptToolActivity, discoverJsonlFiles, extractMessageContent, firstNonBlankString, firstNonEmptyString, normalizeTranscriptRole,
  normalizeTranscriptTimestamp, parseJsonlRecord, readIncrementalJsonlLines,
} from './types.mjs';

export function getDefaultCodexSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.codex', 'sessions');
}

export function codexSessionId(record) {
  if (record?.type !== 'session_meta') return undefined;
  return firstNonBlankString(record.payload?.session_id, record.payload?.id);
}

export function parseCodexResponseItem(record, { includeToolOutput = false } = {}) {
  const payload = record.payload;
  if (record.type !== 'response_item' || !payload || typeof payload !== 'object') return undefined;

  const timestamp = normalizeTranscriptTimestamp(payload.timestamp) ?? normalizeTranscriptTimestamp(record.timestamp);
  switch (payload.type) {
    case 'message':
    case 'agent_message': {
      const role = payload.type === 'agent_message' ? 'assistant' : normalizeTranscriptRole(payload.role);
      if (role === null) return undefined;
      const { text, toolNames, hasToolResult } = extractMessageContent(payload.content);
      return {
        role, timestamp, toolNames, skipEmbedding: hasToolResult,
        text: payload.type === 'agent_message' && typeof payload.text === 'string' ? payload.text : text,
      };
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'web_search_call': {
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const tool = name || (payload.type === 'web_search_call' ? 'web_search' : '');
      return { role: 'assistant', text: '', toolNames: tool ? [tool] : [], timestamp, skipEmbedding: true };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      if (!includeToolOutput) return undefined;
      const { text, toolNames } = extractMessageContent(payload.output ?? payload.content);
      return { role: 'toolResult', text, toolNames, timestamp, skipEmbedding: true };
    }
    default:
      return undefined;
  }
}

/** @type {import('./types.mjs').TranscriptAdapter} */
export const codexAdapter = {
  orchestrator: 'codex',
  discoverFiles(config) {
    const root = config?.indexers?.codex?.sessionsDir;
    return discoverJsonlFiles(root ? expandHome(root) : getDefaultCodexSessionsDir());
  },
  parseIncremental(filePath, byteOffset = 0, existingMeta = {}) {
    const { lines, ...checkpoint } =
      readIncrementalJsonlLines(filePath, byteOffset, existingMeta.lineCount, existingMeta.checkpointHash);
    let { sessionId, cwd } = existingMeta;
    let seq = existingMeta.nextSeq ?? 0;
    const messages = [];
    const toolActivity = [];

    for (const { line, lineNo } of lines) {
      const record = parseJsonlRecord(line);
      if (!record) continue;
      if (record.type === 'session_meta') sessionId = codexSessionId(record) ?? sessionId;
      if (record.type === 'session_meta' || record.type === 'turn_context') {
        cwd = firstNonEmptyString(record.payload?.cwd) ?? cwd;
      }
      const message = parseCodexResponseItem(record, { includeToolOutput: true });
      if (message) {
        const payload = record.payload;
        const calls = transcriptToolActivity(payload.content);
        const callId = firstNonBlankString(payload.call_id, payload.id);
        if (callId && ['function_call', 'custom_tool_call'].includes(payload.type) && message.toolNames.length) {
          calls.push({ type: 'call', callId, name: message.toolNames[0] });
        }
        appendToolActivity(toolActivity, lineNo, message.timestamp, calls, message.role, callId);
      }
      if ((message?.role !== 'user' && message?.role !== 'assistant')
        || (!message.text && !message.toolNames.length)) continue;
      messages.push({ seq: seq++, lineNo, ...message });
    }

    const stem = path.basename(filePath, '.jsonl');
    const rolloutId = /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(stem)?.[1];
    return { sessionId: sessionId ?? rolloutId ?? stem, cwd, messages, toolActivity, ...checkpoint };
  },
};
