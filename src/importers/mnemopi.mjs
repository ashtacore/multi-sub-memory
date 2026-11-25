import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.mjs';
import {
  clampImportance, createImportState, emptyImportResult, hasTable, importMemoryRecord, legacyTimestamps, mapCategory,
  openReadOnlySnapshot, parseLegacyMetadata, resolveLegacyProjectKey,
} from './common.mjs';

export const DEFAULT_MNEMOPI_DIR = '~/.omp/agent/memories/mnemopi';

export function discoverMnemopiDatabases({ mnemopiDir, homeDir }) {
  const directory = expandHome(mnemopiDir ?? DEFAULT_MNEMOPI_DIR, homeDir);
  const found = [];
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return found;
  function add(bank, parent, defaultScope) {
    const dbPath = path.join(parent, 'mnemopi.db');
    if (fs.lstatSync(dbPath, { throwIfNoEntry: false })?.isFile()) found.push({ bank, dbPath, defaultScope });
  }
  add('default', directory, 'global');
  const banks = path.join(directory, 'banks');
  if (fs.lstatSync(banks, { throwIfNoEntry: false })?.isDirectory()) {
    for (const bank of fs.readdirSync(banks).sort()) {
      const bankPath = path.join(banks, bank);
      if (fs.lstatSync(bankPath, { throwIfNoEntry: false })?.isDirectory()) add(bank, bankPath, 'project');
    }
  }
  return found;
}

export function importMnemopi(options) {
  const { targetDb, dryRun, includeArchived, projectMap } = options;
  const databases = options.mnemopiDatabases ?? discoverMnemopiDatabases(options);
  const result = emptyImportResult(databases.length > 0);
  if (!result.found) return result;
  const state = options.state ?? createImportState(targetDb);
  for (const { bank, dbPath, defaultScope } of databases) {
    const snapshot = openReadOnlySnapshot(dbPath);
    const { db } = snapshot;
    try {
      for (const table of ['memories', 'facts']) {
        if (!hasTable(db, table)) continue;
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
        const contentFields = ['content', 'text', 'fact', 'fact_text', 'value'].filter((name) => columns.has(name));
        if (!contentFields.length) continue;
        for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
          const content = contentFields.map((field) => row[field]).find((value) => typeof value === 'string' && value.trim());
          if (content === undefined) continue;
          const status = String(row.status ?? 'active').trim().toLowerCase();
          if (status !== 'active' && !(includeArchived && status === 'archived')) continue;
          const legacyMetadata = { ...parseLegacyMetadata(row.metadata), ...parseLegacyMetadata(row.metadata_json) };
          const magicId = row.magic_context_id ?? row.magicContextId ?? legacyMetadata.magic_context_id ?? legacyMetadata.magicContextId;
          const metadata = {
            ...legacyMetadata, imported_from: 'mnemopi', mnemopi_bank: bank, mnemopi_id: row.id ?? row.memory_id ?? row.fact_id ?? null,
          };
          if (magicId != null) metadata.magic_context_id = magicId;
          const rawProject = row.scope === 'global' ? 'global' : [
            row.project_path, row.project_key, row.project, legacyMetadata.project_key, legacyMetadata.project_path,
          ].find((value) => typeof value === 'string' && value.trim().length > 0)
            ?? (defaultScope === 'project' ? bank : null);
          const project = resolveLegacyProjectKey(rawProject, { projectMap, defaultScope, config: options.config });
          if (project.unresolved) {
            result.memoriesSkippedUnresolved++;
            result.errors.push({ source: 'mnemopi', kind: 'memory', id: row.id ?? null,
              message: 'Unresolved project-scoped mnemopi memory. Map its project with --project-map and rerun.' });
            continue;
          }
          const inserted = importMemoryRecord(targetDb, {
            ...project, ...legacyTimestamps(row), content, status, metadata,
            category: mapCategory(row.category ?? legacyMetadata.category),
            importance: clampImportance(row.importance ?? legacyMetadata.importance),
            sourceOrchestrator: row.source_orchestrator ?? 'mnemopi', sourceSessionId: row.source_session_id ?? legacyMetadata.source_session_id,
          }, state, { dryRun });
          result[inserted ? 'memoriesImported' : 'memoriesSkippedDuplicate']++;
        }
      }
    } finally {
      try {
        snapshot.close();
      } finally {
        result.sourceFiles.push(snapshot.verifyUnmodified());
      }
    }
  }
  return result;
}
