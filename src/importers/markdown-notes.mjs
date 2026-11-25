import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.mjs';
import { createImportState, emptyImportResult, importNoteRecord, resolveLegacyProjectKey } from './common.mjs';

export const DEFAULT_NOTES_DIR = '~/AgentWork/notes';

export function discoverMarkdownNotes({
  notesDir, env = process.env, homeDir,
  defaultNotesDirs = process.platform === 'win32' ? ['C:/Dev/AgentWork/notes', DEFAULT_NOTES_DIR] : [DEFAULT_NOTES_DIR],
}) {
  const override = notesDir ?? (env.MULTI_SUB_MEMORY_NOTES_DIR || undefined);
  const candidates = override === undefined ? defaultNotesDirs : [override];
  const files = [];
  const seenFiles = new Set();
  const visited = new Set();
  function canonicalKey(filename) {
    const resolved = fs.realpathSync(filename);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  function visit(directory, rootFiles) {
    const key = canonicalKey(directory);
    if (visited.has(key)) return;
    visited.add(key);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename, rootFiles);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        const fileKey = canonicalKey(filename);
        if (seenFiles.has(fileKey)) continue;
        seenFiles.add(fileKey);
        rootFiles.push(filename);
      }
    }
  }
  for (const candidate of candidates) {
    const directory = expandHome(candidate, homeDir);
    let stat;
    try {
      stat = fs.statSync(directory, { throwIfNoEntry: false });
    } catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
    }
    if (stat?.isDirectory()) {
      const rootFiles = [];
      visit(directory, rootFiles);
      for (const filename of rootFiles.sort()) files.push(filename);
    }
  }
  return files;
}

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'")) return /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(trimmed)?.[1].replaceAll("''", "'");
  if (trimmed.startsWith('"')) {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(trimmed)?.[0];
    if (!quoted) return;
    try {
      return JSON.parse(quoted);
    } catch {
      return;
    }
  }
  const plain = trimmed.replace(/(?:^|\s)#.*$/, '').trim();
  if (plain && !/^(?:null|~)$/i.test(plain)) return plain;
}

function readFrontmatter(lines) {
  const fields = {};
  if (lines[0]?.trimEnd() !== '---') return { fields, body: lines };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (end === -1) return { fields, body: lines };
  for (const line of lines.slice(1, end)) {
    const match = /^(project|project_key|project_path|cwd|surface_condition):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = scalar(match[2]);
  }
  return { fields, body: lines.slice(end + 1) };
}

function* uncheckedItems(lines) {
  let fence;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const content = /^\s*[-*]\s+\[ \]\s+(.*)$/.exec(line)?.[1].trim();
    if (content) yield content;
  }
}

export function importMarkdownNotes(options) {
  const { targetDb, dryRun, projectMap } = options;
  const files = options.markdownFiles ?? discoverMarkdownNotes(options);
  const result = emptyImportResult(files.length > 0);
  if (!result.found) return result;
  const state = options.state ?? createImportState(targetDb);
  for (const filename of files) {
    const lines = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const { fields, body } = readFrontmatter(lines);
    const basename = path.basename(filename);
    const filenameKey = [path.parse(basename).name, basename].find((key) => projectMap && Object.hasOwn(projectMap, key));
    const rawProject = fields.project_key || fields.project_path || fields.project || fields.cwd || filenameKey;
    const { projectKey } = resolveLegacyProjectKey(rawProject, { projectMap, defaultScope: 'global' });
    const { birthtimeMs, mtimeMs } = fs.statSync(filename);
    const updatedAt = Math.trunc(mtimeMs);
    const createdAt = birthtimeMs > 0 ? Math.trunc(birthtimeMs) : updatedAt;
    for (const content of uncheckedItems(body)) {
      const inserted = importNoteRecord(targetDb, {
        projectKey, status: 'active', content, surfaceCondition: fields.surface_condition,
        sourceOrchestrator: 'markdown-notes', createdAt, updatedAt,
      }, state, { dryRun });
      result[inserted ? 'notesImported' : 'notesSkippedDuplicate']++;
    }
  }
  return result;
}
