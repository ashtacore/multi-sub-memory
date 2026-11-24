import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_EXPAND_MAX_CHARS = 16000;

function validateInteger(name, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be ${minimum === 0 ? 'a non-negative' : 'a positive'} integer`);
  }
}

function validateRange(startName, start, endName, end, minimum) {
  if (start !== undefined) validateInteger(startName, start, minimum);
  if (end !== undefined) validateInteger(endName, end, minimum);
  if (start !== undefined && end !== undefined && start > end) {
    throw new Error(`${endName} must be greater than or equal to ${startName}`);
  }
}

function statIndexedPath(resolved) {
  const { root } = path.parse(resolved);
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; ; index++) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error('Indexed transcript path must not traverse symbolic links or junctions');
    }
    const isLeaf = index === components.length;
    if (isLeaf ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error('Indexed transcript path must name a regular file');
    }
    if (isLeaf) return stat;
    current = path.join(current, components[index]);
  }
}

function openIndexedFile(db, file) {
  const { file_path: filePath, byte_offset } = file;
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')
    || !path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) {
    throw new Error('Invalid indexed transcript path');
  }

  const resolved = path.resolve(filePath);
  let stat;
  let fd;
  try {
    stat = statIndexedPath(resolved);
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
    fd = fs.openSync(resolved, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    if (error.code === 'ELOOP') throw new Error('Indexed transcript path must name a regular file');
    throw error;
  }

  let keepOpen = false;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Indexed transcript changed while opening');
    }
    const current = statIndexedPath(resolved);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error('Indexed transcript changed while opening');
    }
    if (byte_offset > 0 && opened.size < BigInt(byte_offset)) return null;
    if (!matchesIndexedTranscript(db, file, fd)) return null;
    keepOpen = true;
    return fd;
  } finally {
    if (!keepOpen) fs.closeSync(fd);
  }
}

function* readLines(fd) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let position = 0;
  let bytesRead;
  while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
    position += bytesRead;
    const chunk = decoder.write(buffer.subarray(0, bytesRead));
    let start = 0;
    let end;
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      const line = pending + chunk.slice(start, end);
      pending = '';
      start = end + 1;
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    pending += chunk.slice(start);
  }
  pending += decoder.end();
  if (pending) yield pending;
}

function normalizeToolNames(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) value = parsed;
    } catch {
      // Indexed rows can store plain comma-separated names.
    }
    if (typeof value === 'string') value = value.split(',');
  }
  return Array.isArray(value)
    ? value.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean)
    : [];
}

function toolName(call) {
  return call?.function?.name ?? call?.name ?? call?.recipient_name;
}

function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

function matchesIndexedTranscript(db, file, fd) {
  const anchor = db.prepare(`
    SELECT line_no, role, text FROM transcript_messages WHERE file_id = ? ORDER BY line_no ASC LIMIT 1
  `).get(file.id);
  let lineNo = 0;
  for (const line of readLines(fd)) {
    lineNo++;
    if (lineNo === 1) {
      const record = parseRecord(line);
      const sessionIds = [
        record?.session_id, record?.sessionId, record?.message?.session_id, record?.message?.sessionId,
        record?.type === 'session' ? record.id : undefined,
      ];
      if (sessionIds.some((id) => typeof id === 'string' && id !== file.session_id)) return false;
      if (!anchor) return true;
    }
    if (lineNo === anchor.line_no) {
      const { role, text } = parseLine(line);
      return role === anchor.role && text === anchor.text;
    }
  }
  return !anchor;
}

function parseLine(line) {
  const record = parseRecord(line);
  if (!record) return { role: 'raw', text: line };

  const message = record.message ?? record;
  const content = message.content ?? record.content;
  const tools = [...normalizeToolNames(record.tool_names)];
  if (message !== record) tools.push(...normalizeToolNames(message.tool_names));
  const calls = message.tool_calls ?? record.tool_calls;
  if (Array.isArray(calls)) tools.push(...calls.map(toolName));
  const textBlocks = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block?.text === 'string') textBlocks.push(block.text);
      if (['tool_use', 'tool_call', 'function_call', 'toolCall'].includes(block?.type)) tools.push(toolName(block));
    }
  }
  const names = [...new Set(normalizeToolNames(tools))];
  const timestamp = message.timestamp ?? record.timestamp;
  return {
    role: message.role ?? record.role ?? record.type ?? 'raw',
    ...(timestamp == null ? {} : { timestamp }),
    text: typeof message.text === 'string' ? message.text
      : typeof record.text === 'string' ? record.text
      : typeof content === 'string' ? content : textBlocks.join('\n'),
    ...(names.length ? { tool_names: names } : {}),
  };
}

function* diskMessages(db, fileId, fd, options) {
  const { start_seq, end_seq, line_start = 1, line_end = Infinity } = options;
  const hasSeqRange = start_seq !== undefined || end_seq !== undefined;
  const hasIndexedRows = db.prepare('SELECT 1 FROM transcript_messages WHERE file_id = ? LIMIT 1').get(fileId);
  const lineToSeq = new Map();
  let maxTargetLineNo = line_end;
  if (hasIndexedRows) {
    const { where, params } = messageRange(fileId, options);
    if (hasSeqRange) maxTargetLineNo = 0;
    const rows = db.prepare(`
      SELECT line_no, seq FROM transcript_messages WHERE ${where} ORDER BY seq DESC
    `).iterate(...params);
    for (const { line_no, seq } of rows) {
      lineToSeq.set(line_no, seq);
      if (hasSeqRange) maxTargetLineNo = Math.max(maxTargetLineNo, line_no);
    }
  }
  if (maxTargetLineNo === 0) return;

  let nonEmptySeq = 0;
  let line_no = 0;

  for (const line of readLines(fd)) {
    line_no++;
    const seq = hasIndexedRows ? lineToSeq.get(line_no) : line.trim() ? nonEmptySeq++ : undefined;
    if (line_no >= line_start && (!hasSeqRange || (seq !== undefined && seq >= (start_seq ?? 0)))) {
      yield { ...(seq === undefined ? {} : { seq }), line_no, ...parseLine(line) };
    }
    if (line_no >= maxTargetLineNo || (!hasIndexedRows && seq === end_seq && end_seq !== undefined)) break;
  }
}

function messageRange(fileId, { start_seq, end_seq, line_start, line_end }) {
  const range = [
    ['seq >= ?', start_seq], ['seq <= ?', end_seq],
    ['line_no >= ?', line_start], ['line_no <= ?', line_end],
  ].filter(([, value]) => value !== undefined);
  return {
    where: ['file_id = ?', ...range.map(([clause]) => clause)].join(' AND '),
    params: [fileId, ...range.map(([, value]) => value)],
  };
}

function* indexedMessages(db, fileId, options) {
  const { where, params } = messageRange(fileId, options);
  const statement = db.prepare(`
    SELECT seq, line_no, role, timestamp, text, tool_names
    FROM transcript_messages WHERE ${where}
    ORDER BY seq ASC, line_no ASC
  `);
  for (const { timestamp, tool_names, ...row } of statement.iterate(...params)) {
    const names = normalizeToolNames(tool_names);
    yield {
      ...row,
      ...(timestamp == null ? {} : { timestamp }),
      ...(names.length ? { tool_names: names } : {}),
    };
  }
}

function truncateMessage(message, remaining) {
  const { text } = message;
  const textBudget = remaining - JSON.stringify({ ...message, text: '' }).length;
  let low = 1;
  let high = Math.min(text.length, textBudget);
  let truncatedText;
  // Escaping can make a prefix longer in JSON than it is in the transcript.
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = text.slice(0, middle - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
    if (JSON.stringify(prefix).length - 2 <= textBudget) {
      truncatedText = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return truncatedText === undefined ? null : { ...message, text: truncatedText };
}

export function expandSession(db, options = {}) {
  const { session_id, file_id, start_seq, end_seq, line_start, line_end, max_chars = DEFAULT_EXPAND_MAX_CHARS } = options;
  if (typeof session_id !== 'string' || !session_id.trim()) throw new Error('session_id must be a non-empty string');
  if (file_id !== undefined) validateInteger('file_id', file_id, 1);
  validateRange('start_seq', start_seq, 'end_seq', end_seq, 0);
  validateRange('line_start', line_start, 'line_end', line_end, 1);
  validateInteger('max_chars', max_chars, 1);

  const files = 'SELECT id, session_id, orchestrator, project_key, file_path, byte_offset FROM transcript_files';
  const file = file_id === undefined
    ? db.prepare(`${files} WHERE session_id = ? ORDER BY last_indexed_at DESC, id DESC LIMIT 1`).get(session_id.trim())
    : db.prepare(`${files} WHERE id = ? AND session_id = ?`).get(file_id, session_id.trim());
  if (!file) throw new Error(`Session not found: ${session_id.trim()}`);

  const fd = openIndexedFile(db, file);
  const messages = [];
  let total_chars = 0;
  let truncated = false;
  try {
    const candidates = fd === null ? indexedMessages(db, file.id, options) : diskMessages(db, file.id, fd, options);
    for (const message of candidates) {
      const remaining = max_chars - total_chars;
      const cost = JSON.stringify(message).length;
      if (cost > remaining) {
        truncated = true;
        const partial = remaining > 0 && message.text.length > 0 ? truncateMessage(message, remaining) : null;
        if (partial) {
          messages.push(partial);
          total_chars += JSON.stringify(partial).length;
        }
        break;
      }
      messages.push(message);
      total_chars += cost;
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  return {
    session_id: file.session_id,
    file_id: file.id,
    orchestrator: file.orchestrator,
    project_key: file.project_key,
    source: fd === null ? 'db-fallback' : 'disk',
    truncated,
    total_chars,
    messages,
  };
}
