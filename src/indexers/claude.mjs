import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expandHome } from '../config.mjs';
import {
  discoverJsonlFiles, extractMessageContent, normalizeTranscriptRole, normalizeTranscriptTimestamp,
  parseJsonlRecord, readIncrementalJsonlLinesAsync,
} from './types.mjs';

export function getDefaultClaudeSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'projects');
}

function getSessionsDir(config) {
  const root = config?.indexers?.claude?.sessionsDir;
  return root ? expandHome(root) : getDefaultClaudeSessionsDir();
}

function decodeProjectFolder(filePath, sessionsDir) {
  const relative = path.relative(sessionsDir, filePath);
  const [folder, ...rest] = relative.split(path.sep);
  if (!rest.length || folder === '..' || path.isAbsolute(relative)) return undefined;

  // The directory encoding is lossy. Prefer a recorded cwd whenever available.
  const drivePath = /^([a-z])--?(.*)$/i.exec(folder);
  if (drivePath) return path.win32.join(drivePath[1] + ':\\', drivePath[2].replaceAll('-', '\\'));
  return folder.startsWith('-') ? folder.replaceAll('-', '/') : undefined;
}

/** @type {import('./types.mjs').TranscriptAdapter} */
export const claudeAdapter = {
  orchestrator: 'claude',
  discoverFiles(config) {
    return discoverJsonlFiles(getSessionsDir(config));
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
      if (!record) continue;
      if (typeof record.sessionId === 'string' && record.sessionId) {
        sessionId = record.sessionId;
        recognized = true;
      }
      if (typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      recognized = true;
      const { text, toolNames, hasToolResult } = extractMessageContent(record.message?.content);
      if (!text && !toolNames.length) continue;
      messages.push({
        seq: seq++, role: normalizeTranscriptRole(record.message?.role) ?? record.type, text, toolNames, lineNo,
        timestamp: normalizeTranscriptTimestamp(record.message?.timestamp) ?? normalizeTranscriptTimestamp(record.timestamp),
        skipEmbedding: hasToolResult,
      });
    }
    if (!cwd && byteOffset === 0) {
      const root = existingMeta.sessionsDir ? expandHome(existingMeta.sessionsDir) : getDefaultClaudeSessionsDir();
      cwd = decodeProjectFolder(filePath, root);
    }
    return { sessionId: sessionId ?? path.basename(filePath, '.jsonl'), cwd, messages, recognized, ...checkpoint };
  },
};
