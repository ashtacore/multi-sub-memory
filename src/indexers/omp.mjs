import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expandHome } from '../config.mjs';
import {
  discoverJsonlFiles, extractMessageContent, normalizeTranscriptRole, normalizeTranscriptTimestamp,
  parseJsonlRecord, readIncrementalJsonlLinesAsync,
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
  async parseIncremental(filePath, byteOffset = 0, existingMeta = {}) {
    const { lineCount, checkpointHash, signal, nextSeq } = existingMeta;
    const { lines, ...checkpoint } = await readIncrementalJsonlLinesAsync(filePath, byteOffset, lineCount, checkpointHash, signal);
    let { sessionId, cwd } = existingMeta;
    let seq = nextSeq ?? 0;
    let recognized = false;
    const messages = [];

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
      const { text, toolNames, hasToolResult } = extractMessageContent(message.content);
      if (!text && !toolNames.length) continue;
      messages.push({
        seq: seq++, role, text, toolNames, lineNo,
        timestamp: normalizeTranscriptTimestamp(message.timestamp) ?? normalizeTranscriptTimestamp(record.timestamp),
        skipEmbedding: hasToolResult,
      });
    }
    return { sessionId: sessionId ?? path.basename(filePath, '.jsonl'), cwd, messages, recognized, ...checkpoint };
  },
};
