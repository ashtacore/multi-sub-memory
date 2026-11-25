import fs from 'node:fs';
import path from 'node:path';
import { expandHome, writeTextAtomically } from '../config.mjs';
import { openDatabase } from '../db.mjs';
import { inWriteTransaction } from '../memory-service.mjs';
import { normalizePath } from '../project-id.mjs';
import { createImportState, loadProjectMap, openReadOnlySnapshot } from './common.mjs';
import { importMagicContext, magicContextPath, withMagicContextSource } from './magic-context.mjs';
import { discoverMarkdownNotes, importMarkdownNotes } from './markdown-notes.mjs';
import { DEFAULT_MNEMOPI_DIR, discoverMnemopiDatabases, importMnemopi } from './mnemopi.mjs';

const importers = new Map([
  ['magic-context', importMagicContext], ['mnemopi', importMnemopi], ['notes', importMarkdownNotes],
]);
export const IMPORT_SOURCES = Object.freeze([...importers.keys(), 'all']);

function resolvePathThroughNearestAncestor(targetPath, depth = 0) {
  if (depth > 40) throw new Error(`Too many symbolic link levels: ${targetPath}`);
  const absolute = path.resolve(targetPath);
  let ancestor = absolute;
  while (true) {
    try {
      let resolved;
      try {
        resolved = fs.realpathSync.native(ancestor);
      } catch {
        resolved = fs.realpathSync(ancestor);
      }
      const relative = path.relative(ancestor, absolute);
      if (ancestor !== absolute) {
        const [nextSegment, ...remainingSegments] = relative.split(path.sep).filter(Boolean);
        const nextPath = path.join(ancestor, nextSegment);
        const stat = fs.lstatSync(nextPath, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) {
          let linkTarget = fs.readlinkSync(nextPath);
          if (process.platform === 'win32') linkTarget = linkTarget.replace(/^\\\\\?\\/, '');
          const expanded = path.join(path.resolve(resolved, linkTarget), ...remainingSegments);
          return resolvePathThroughNearestAncestor(expanded, depth + 1);
        }
      }
      return normalizePath(path.join(resolved, relative));
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      if (parent === ancestor) return normalizePath(absolute);
      ancestor = parent;
    }
  }
}

function databasePaths(filename) {
  const absolute = path.resolve(filename);
  const resolved = resolvePathThroughNearestAncestor(absolute);
  return [...new Set([absolute, resolved])].flatMap((file) => ['', '-wal', '-shm', '-journal'].map((suffix) => file + suffix));
}

function fileIdentity(filename) {
  const realPath = resolvePathThroughNearestAncestor(filename);
  let stat;
  try {
    stat = fs.statSync(filename, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    if (error.code !== 'ENOTDIR') throw error;
  }
  return {
    path: process.platform === 'win32' ? realPath.toLowerCase() : realPath,
    inode: stat?.ino ? `${stat.dev}:${stat.ino}` : undefined,
  };
}

function pathContains(parent, child) {
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

function assertDistinct(writablePaths, protectedPaths) {
  const paths = new Set();
  const inodes = new Set();
  for (const filename of protectedPaths) {
    const identity = fileIdentity(filename);
    paths.add(identity.path);
    if (identity.inode) inodes.add(identity.inode);
  }
  for (const filename of writablePaths) {
    const identity = fileIdentity(filename);
    const nested = [...paths].some((protectedPath) =>
      pathContains(protectedPath, identity.path) || pathContains(identity.path, protectedPath));
    if (paths.has(identity.path) || inodes.has(identity.inode) || nested) {
      throw new Error(`Choose separate paths for the target database, import sources, and report: ${filename}`);
    }
  }
}

export function runImport(options) {
  const { from, homeDir, dryRun = false } = options;
  if (!IMPORT_SOURCES.includes(from)) throw new Error(`--from must be ${IMPORT_SOURCES.join(', ')}`);
  if (typeof options.dbPath !== 'string' || !options.dbPath) throw new Error('Import requires a target database path');
  const dbPath = expandHome(options.dbPath, homeDir);
  if (/^file:/i.test(dbPath)) throw new Error('Import requires a filesystem path for the target database');
  const projectMapPath = options.projectMapPath && expandHome(options.projectMapPath, homeDir);
  const projectMap = projectMapPath ? loadProjectMap(projectMapPath) : options.projectMap;
  const reportPath = options.reportPath && expandHome(options.reportPath, homeDir);
  const selected = from === 'all' ? [...importers.keys()] : [from];
  const includesMagicContext = selected.includes('magic-context');
  const mnemopiDatabases = discoverMnemopiDatabases(options);
  const markdownFiles = selected.includes('notes') ? discoverMarkdownNotes(options) : [];
  const defaultMnemopiRoot = expandHome(DEFAULT_MNEMOPI_DIR, homeDir);
  const defaultMnemopiDatabases = options.mnemopiDir == null ? mnemopiDatabases : discoverMnemopiDatabases({ homeDir });
  const mnemopiRoot = expandHome(options.mnemopiDir ?? DEFAULT_MNEMOPI_DIR, homeDir);
  const sqliteSources = [...new Set([
    magicContextPath({ homeDir }), path.join(defaultMnemopiRoot, 'mnemopi.db'),
    ...defaultMnemopiDatabases.map(({ dbPath }) => dbPath),
    magicContextPath(options), path.join(mnemopiRoot, 'mnemopi.db'), ...mnemopiDatabases.map(({ dbPath }) => dbPath),
  ])];
  const inputs = [...sqliteSources.flatMap(databasePaths), ...markdownFiles];
  if (projectMapPath) inputs.push(projectMapPath);
  const targetPaths = dbPath === ':memory:' ? [] : databasePaths(dbPath);
  if (!dryRun) assertDistinct(targetPaths, inputs);
  if (reportPath) assertDistinct([reportPath], [...targetPaths, ...inputs]);

  function importSources(targetDb, magicContextSource) {
    const state = createImportState(targetDb);
    const sources = {};
    const totals = {
      memoriesImported: 0, memoriesSkippedDuplicate: 0, memoriesSkippedUnresolved: 0,
      notesImported: 0, notesSkippedDuplicate: 0, notesSkippedUnresolved: 0,
    };
    const sourceFiles = [];
    const errors = [];
    for (const name of selected) {
      const { protectedPaths, ...result } = importers.get(name)(
        { ...options, dryRun, projectMap, targetDb, state, mnemopiDatabases, markdownFiles }, magicContextSource,
      );
      if (protectedPaths) inputs.push(...protectedPaths);
      sources[name] = result;
      for (const key of Object.keys(totals)) totals[key] += result[key];
      sourceFiles.push(...result.sourceFiles);
      errors.push(...result.errors);
    }
    if (sourceFiles.some(({ unmodified }) => !unmodified)) throw new Error('SQLite source changed during import');
    return { from, dryRun, sources, totals, sourceFiles, errors, allSourceFilesUnmodified: true };
  }

  function importIntoTarget(magicContextSource) {
    if (magicContextSource?.protectedPaths.size) {
      const sessionPaths = magicContextSource.protectedPaths;
      if (!dryRun) assertDistinct(targetPaths, sessionPaths);
      if (reportPath) assertDistinct([reportPath], sessionPaths);
    }
    if (dryRun) {
      const snapshot = dbPath !== ':memory:' && fs.statSync(dbPath, { throwIfNoEntry: false }) ? openReadOnlySnapshot(dbPath) : null;
      try {
        return importSources(snapshot?.db ?? null, magicContextSource);
      } finally {
        if (snapshot) {
          try {
            snapshot.close();
          } finally {
            snapshot.verifyUnmodified();
          }
        }
      }
    }
    const db = openDatabase(dbPath);
    try {
      return inWriteTransaction(db, () => importSources(db, magicContextSource));
    } finally {
      db.close();
    }
  }

  const report = includesMagicContext ? withMagicContextSource(options, importIntoTarget) : importIntoTarget(null);
  if (reportPath) {
    const currentTargetPaths = dbPath === ':memory:' ? [] : databasePaths(dbPath);
    assertDistinct([reportPath], [...currentTargetPaths, ...inputs]);
    writeTextAtomically(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
