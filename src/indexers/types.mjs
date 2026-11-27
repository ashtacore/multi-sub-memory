import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INDEXER_ORCHESTRATORS = Object.freeze(['omp', 'claude', 'codex', 'agy']);
const CHUNK_BYTES = 64 * 1024;
const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
const TRANSCRIPT_OPEN_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;

/**
 * @typedef {{seq: number, role: string, timestamp?: string|number, text: string,
 *   toolNames: string[], lineNo: number, skipEmbedding?: boolean}} TranscriptMessage
 * @typedef {{sessionId?: string, cwd?: string, sessionsDir?: string,
 *   nextSeq?: number, lineCount?: number, checkpointHash?: string, signal?: AbortSignal, recoverHeaderCwd?: boolean}} TranscriptMeta
 * @typedef {{sessionId: string, cwd?: string, messages: TranscriptMessage[],
 *   newByteOffset: number, lineCount: number, mtimeMs: number, fileSize: number,
 *   fileIdentity?: string, checkpointHash?: string|null, checkpointMismatch?: boolean,
 *   recognized?: boolean, headerCwd?: string}} TranscriptBatch
 * @typedef {{orchestrator: 'omp'|'claude'|'codex'|'agy', discoverFiles: (config: object) => string[],
 *   parseIncremental: (filePath: string, byteOffset: number, existingMeta: TranscriptMeta) => TranscriptBatch|Promise<TranscriptBatch>}} TranscriptAdapter
 */

export function validateAdapter(adapter) {
  if (!INDEXER_ORCHESTRATORS.includes(adapter?.orchestrator)
    || typeof adapter.discoverFiles !== 'function' || typeof adapter.parseIncremental !== 'function') {
    throw new TypeError('Expected a transcript adapter with a supported orchestrator, discoverFiles, and parseIncremental');
  }
  return adapter;
}

function* transcriptPathComponents(absolutePath) {
  const { root } = path.parse(absolutePath);
  let current = root;
  yield current;
  for (const component of absolutePath.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    yield current;
  }
}

function checkParent(stat) {
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error('Transcript path must use regular directories');
  }
}

export function statWithoutLinks(absolutePath) {
  let stat;
  for (const component of transcriptPathComponents(absolutePath)) {
    checkParent(stat);
    stat = fs.lstatSync(component, { bigint: true });
  }
  return stat;
}

async function statWithoutLinksAsync(absolutePath) {
  let stat;
  for (const component of transcriptPathComponents(absolutePath)) {
    checkParent(stat);
    stat = await fs.promises.lstat(component, { bigint: true });
  }
  return stat;
}

export function transcriptFileIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

export function discoverJsonlFiles(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir) return [];
  const root = path.resolve(rootDir);
  const files = [];
  const pending = [root];
  while (pending.length) {
    const candidate = pending.pop();
    try {
      const stat = statWithoutLinks(candidate);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(candidate)) pending.push(path.join(candidate, name));
      } else if (candidate !== root && stat.isFile() && path.extname(candidate) === '.jsonl') {
        files.push(candidate);
      }
    } catch {
      // A missing, inaccessible, or replaced path does not prevent discovery elsewhere.
    }
  }
  return files.sort();
}

function validateOffset(byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError('Transcript byte offset must be a non-negative safe integer');
  }
}

function checkRegularFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular transcript file');
}

function checkOpenedFile(before, opened, current) {
  if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
    || opened.dev !== before.dev || opened.ino !== before.ino
    || current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new Error('Transcript changed while opening');
  }
}

export function readIncrementalJsonlLines(filePath, byteOffset = 0, previousLineCount, previousCheckpointHash,
  captureHeader = false) {
  validateOffset(byteOffset);
  const resolved = path.resolve(filePath);
  const before = statWithoutLinks(resolved);
  checkRegularFile(before);
  const fd = fs.openSync(resolved, TRANSCRIPT_OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    checkOpenedFile(before, stat, statWithoutLinks(resolved));
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const reader = readChunks(stat, buffer, byteOffset, previousLineCount, previousCheckpointHash, captureHeader);
    let step = reader.next();
    while (!step.done) {
      const { position, length } = step.value;
      step = reader.next(fs.readSync(fd, buffer, 0, length, position));
    }
    return step.value;
  } finally {
    fs.closeSync(fd);
  }
}

export async function readIncrementalJsonlLinesAsync(filePath, byteOffset = 0, previousLineCount,
  previousCheckpointHash, signal, captureHeader = false) {
  validateOffset(byteOffset);
  signal?.throwIfAborted();
  const resolved = path.resolve(filePath);
  const before = await statWithoutLinksAsync(resolved);
  checkRegularFile(before);
  const fh = await fs.promises.open(resolved, TRANSCRIPT_OPEN_FLAGS);
  try {
    const stat = await fh.stat({ bigint: true });
    checkOpenedFile(before, stat, await statWithoutLinksAsync(resolved));
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const reader = readChunks(stat, buffer, byteOffset, previousLineCount, previousCheckpointHash, captureHeader);
    let step = reader.next();
    while (!step.done) {
      const { position, length } = step.value;
      const { bytesRead } = await fh.read(buffer, 0, length, position);
      signal?.throwIfAborted();
      step = reader.next(bytesRead);
    }
    return step.value;
  } finally {
    await fh.close();
  }
}

// The drivers fill the same buffer. Only this generator interprets the bytes.
function* readChunks(stat, buffer, byteOffset, previousLineCount, previousCheckpointHash, captureHeader = false) {
  const fileSize = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  const fileIdentity = transcriptFileIdentity(stat);
  const truncated = byteOffset > fileSize;
  const lines = [];
  let newByteOffset = truncated ? 0 : byteOffset;
  if (truncated) return { truncated, lines, newByteOffset, lineCount: 0, mtimeMs, fileSize, fileIdentity };

  let lineCount = previousLineCount ?? 0;
  const hash = createHash('sha256');
  let endsAtNewline = false;
  let headerLine;
  // Capture the header during prefix validation so recovery uses the same file and bytes as the checkpoint.
  let headerParts = captureHeader && previousCheckpointHash != null ? [] : undefined;
  for (let position = 0; position < byteOffset;) {
    const count = yield { position, length: Math.min(buffer.length, byteOffset - position) };
    if (count === 0) throw new Error('Transcript shrank while reading');
    const chunk = buffer.subarray(0, count);
    hash.update(chunk);
    endsAtNewline = chunk.at(-1) === 0x0A;
    if (headerParts) {
      const newline = chunk.indexOf(0x0A);
      if (newline === -1) headerParts.push(Buffer.from(chunk));
      else {
        const part = chunk.subarray(0, newline);
        const header = headerParts.length ? Buffer.concat([...headerParts, part]) : part;
        if (isUtf8(header)) headerLine = header.toString('utf8');
        headerParts = undefined;
      }
    }
    // Older checkpoints and standalone callers can recover the count during validation.
    if (previousLineCount == null) {
      for (let newline = chunk.indexOf(0x0A); newline !== -1; newline = chunk.indexOf(0x0A, newline + 1)) {
        lineCount++;
      }
    }
    position += count;
  }
  if (previousCheckpointHash != null && (!endsAtNewline || hash.copy().digest('hex') !== previousCheckpointHash)) {
    return { checkpointMismatch: true, lines, newByteOffset, lineCount, mtimeMs, fileSize, fileIdentity };
  }

  let pending = [];
  for (let position = byteOffset; position < fileSize;) {
    const count = yield { position, length: Math.min(buffer.length, fileSize - position) };
    if (count === 0) throw new Error('Transcript shrank while reading');
    const chunk = buffer.subarray(0, count);
    const continuedLine = pending;
    let start = 0;
    for (let end = chunk.indexOf(0x0A); end !== -1; end = chunk.indexOf(0x0A, start)) {
      const part = chunk.subarray(start, end);
      const bytes = pending.length ? Buffer.concat([...pending, part]) : part;
      const record = bytes.at(-1) === 0x0D ? bytes.subarray(0, -1) : bytes;
      lineCount++;
      if (isUtf8(record)) lines.push({ line: record.toString('utf8'), lineNo: lineCount });
      pending = [];
      start = end + 1;
      newByteOffset = position + start;
    }
    // Commit raw bytes through the last complete line, including any earlier fragments.
    if (start > 0) {
      for (const part of continuedLine) hash.update(part);
      hash.update(chunk.subarray(0, start));
      endsAtNewline = true;
    }
    if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
    position += count;
  }
  const checkpointHash = endsAtNewline ? hash.digest('hex') : null;
  return { truncated, lines, newByteOffset, lineCount, mtimeMs, fileSize, fileIdentity, checkpointHash, headerLine };
}

export function normalizeTranscriptRole(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

export function firstNonBlankString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function normalizeTranscriptTimestamp(value) {
  if (typeof value === 'string') {
    const timestamp = value.trim();
    if (/^\d+$/.test(timestamp)) value = Number(timestamp);
    else if (ISO_TIMESTAMP.test(timestamp)) value = Date.parse(timestamp);
    else return null;
  }
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseJsonlRecord(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

const MEMORY_TOOLS = new Set(['mem_search', 'mem_get', 'mem_remember', 'mem_memory', 'mem_bootstrap', 'mem_note', 'mem_expand']);

export function transcriptMemoryToolName(name) {
  if (MEMORY_TOOLS.has(name)) return name;
  const suffix = /(?:^|__)multi[-_]sub[-_]memory__(mem_[a-z]+)$/.exec(name)?.[1];
  return MEMORY_TOOLS.has(suffix) ? suffix : undefined;
}

export function transcriptToolCall(callId, name, args) {
  const event = { type: 'call', callId, name };
  if (transcriptMemoryToolName(name) === 'mem_memory') {
    const input = typeof args === 'string' ? parseJsonlRecord(args) : args;
    if (input?.action === 'get') event.action = 'get';
  }
  return event;
}

export function transcriptToolActivity(content) {
  if (!Array.isArray(content)) return [];
  const activities = [];
  for (const block of content) {
    const name = firstNonBlankString(block?.function?.name, block?.name, block?.recipient_name);
    const callId = firstNonBlankString(block?.id, block?.call_id, block?.tool_use_id);
    if (callId && name && ['toolCall', 'tool_use', 'tool_call', 'function_call'].includes(block?.type)) {
      activities.push(transcriptToolCall(callId, name, block.input ?? block.arguments ?? block.function?.arguments));
    }
    if (['tool_result', 'toolResult', 'function_call_output'].includes(block?.type)) {
      const resultId = firstNonBlankString(block.tool_use_id, block.toolCallId, block.call_id);
      if (resultId) activities.push({ type: 'result', callId: resultId });
    }
  }
  return activities;
}

export function appendToolActivity(activity, lineNo, timestamp, calls, role, resultId) {
  const events = [...calls];
  if (role === 'toolResult' || role === 'tool') {
    if (typeof resultId === 'string' && resultId) events.push({ type: 'result', callId: resultId });
  }
  if (events.length) activity.push({ lineNo, timestamp, events });
}

export function extractMessageContent(content) {
  if (!Array.isArray(content)) {
    return { text: typeof content === 'string' ? content : '', toolNames: [], hasToolResult: false };
  }
  const blocks = [];
  const toolNames = new Set();
  let hasToolResult = false;
  for (const block of content) {
    if (typeof block?.text === 'string') blocks.push(block.text);
    if (block?.type === 'tool_result') {
      hasToolResult = true;
      if (typeof block.content === 'string') blocks.push(block.content);
      if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (typeof part?.text === 'string') blocks.push(part.text);
        }
      }
    }
    if (['toolCall', 'tool_use', 'tool_call', 'function_call'].includes(block?.type)) {
      const name = block.function?.name ?? block.name ?? block.recipient_name;
      if (typeof name === 'string' && name.trim()) toolNames.add(name.trim());
    }
  }
  return { text: blocks.join('\n'), toolNames: [...toolNames], hasToolResult };
}
