import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expandHome } from '../config.mjs';
import {
  appendToolActivity, transcriptToolActivity, discoverJsonlFiles, extractMessageContent, normalizeTranscriptRole, normalizeTranscriptTimestamp,
  parseJsonlRecord, readIncrementalJsonlLinesAsync,
} from './types.mjs';

export function getDefaultOmpSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.omp', 'agent', 'sessions');
}

function readHeaderCwd(line) {
  if (line === undefined) return undefined;
  const record = parseJsonlRecord(line);
  if (record?.type === 'session' && typeof record.cwd === 'string' && record.cwd.trim()) return record.cwd;
}

/** @type {import('./types.mjs').TranscriptAdapter} */
export const ompAdapter = {
  orchestrator: 'omp',
  discoverFiles(config) {
    const root = config?.indexers?.omp?.sessionsDir;
    return discoverJsonlFiles(root ? expandHome(root) : getDefaultOmpSessionsDir());
  },
  async parseIncremental(filePath, byteOffset = 0, existingMeta = {}) {
    const { lineCount, checkpointHash, signal, nextSeq, recoverHeaderCwd } = existingMeta;
    const { lines, headerLine, ...checkpoint } = await readIncrementalJsonlLinesAsync(
      filePath, byteOffset, lineCount, checkpointHash, signal, recoverHeaderCwd,
    );
    let { sessionId, cwd } = existingMeta;
    let seq = nextSeq ?? 0;
    let recognized = false;
    const messages = [];
    const toolActivity = [];

    signal?.throwIfAborted();
    for (const [index, { line, lineNo }] of lines.entries()) {
      if (index > 0 && index % 256 === 0) {
        await setImmediate();
        signal?.throwIfAborted();
      }
      const record = parseJsonlRecord(line);
      if (record?.type === 'session') {
        recognized = true;
        if (typeof record.id === 'string' && record.id) sessionId = record.id;
        if (typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
      }
      const message = record?.message;
      const role = normalizeTranscriptRole(message?.role);
      if (record?.type !== 'message' || role === null) continue;
      recognized = true;
      const timestamp = normalizeTranscriptTimestamp(message.timestamp) ?? normalizeTranscriptTimestamp(record.timestamp);
      appendToolActivity(toolActivity, lineNo, timestamp, transcriptToolActivity(message.content), role, message.toolCallId);
      const { text, toolNames, hasToolResult } = extractMessageContent(message.content);
      if (!text && !toolNames.length) continue;
      messages.push({
        seq: seq++, role, text, toolNames, lineNo,
        timestamp,
        skipEmbedding: hasToolResult,
      });
    }
    return {
      sessionId: sessionId ?? path.basename(filePath, '.jsonl'), cwd, messages, toolActivity, recognized, ...checkpoint,
      headerCwd: readHeaderCwd(headerLine),
    };
  },
};
