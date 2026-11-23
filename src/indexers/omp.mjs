import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../config.mjs';
import {
  discoverJsonlFiles, extractMessageContent, normalizeTranscriptRole, normalizeTranscriptTimestamp,
  parseJsonlRecord, readIncrementalJsonlLines,
} from './types.mjs';

export function getDefaultOmpSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.omp', 'agent', 'sessions');
}

/** @type {import('./types.mjs').TranscriptAdapter} */
export const ompAdapter = {
  orchestrator: 'omp',
  discoverFiles(config) {
    const root = config?.indexers?.omp?.sessionsDir;
    return discoverJsonlFiles(root ? expandHome(root) : getDefaultOmpSessionsDir());
  },
  parseIncremental(filePath, byteOffset = 0, existingMeta = {}) {
    const { lines, ...checkpoint } =
      readIncrementalJsonlLines(filePath, byteOffset, existingMeta.lineCount, existingMeta.checkpointHash);
    let { sessionId, cwd } = existingMeta;
    let seq = existingMeta.nextSeq ?? 0;
    const messages = [];

    for (const { line, lineNo } of lines) {
      const record = parseJsonlRecord(line);
      if (record?.type === 'session') {
        if (typeof record.id === 'string' && record.id) sessionId = record.id;
        if (typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
      }
      const message = record?.message;
      const role = normalizeTranscriptRole(message?.role);
      if (record?.type !== 'message' || role === null) continue;
      const { text, toolNames, hasToolResult } = extractMessageContent(message.content);
      if (!text && !toolNames.length) continue;
      messages.push({
        seq: seq++, role, text, toolNames, lineNo,
        timestamp: normalizeTranscriptTimestamp(message.timestamp) ?? normalizeTranscriptTimestamp(record.timestamp),
        skipEmbedding: hasToolResult,
      });
    }
    return { sessionId: sessionId ?? path.basename(filePath, '.jsonl'), cwd, messages, ...checkpoint };
  },
};
