#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import { INDEXER_ORCHESTRATORS } from '../src/indexers/types.mjs';

const plannedCommands = [];
const indexOrchestrators = [...INDEXER_ORCHESTRATORS, 'all'];
const dreamUsage = 'Dream usage: multi-sub-memory dream [--project <cwd>] [--dry-run] [--json]';
const importUsage = 'Usage: multi-sub-memory import --from <magic-context|mnemopi|notes|all> '
  + '[--dry-run] [--include-archived] [--project-map <path>] [--magic-context-db <path>] '
  + '[--mnemopi-dir <path>] [--notes-dir <path>] [--report <path>] [--json] [--cwd <path>]';
const uiUsage = 'Usage: multi-sub-memory ui [--port <number>] [--open] [--cwd <path>] [--help]';
const args = process.argv.slice(2);
const command = args[0] ?? 'serve';

function parseServeArgs(options) {
  let cwd;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option !== '--cwd') throw new Error(`Unknown serve argument: ${option}`);
    const value = options[++index];
    if (!value || value.startsWith('-')) throw new Error('--cwd requires a path');
    if (cwd !== undefined) throw new Error('--cwd may only be specified once');
    cwd = value;
  }
  return { cwd };
}

async function indexTranscripts(args) {
  const { values, tokens } = parseArgs({
    args,
    options: { cwd: { type: 'string' }, orchestrator: { type: 'string', default: 'all' }, json: { type: 'boolean' } },
    tokens: true,
  });
  const names = new Set();
  for (const { name } of tokens) {
    if (names.has(name)) throw new Error(`--${name} may only be specified once`);
    names.add(name);
  }
  const { cwd, orchestrator, json } = values;
  if (cwd === '') throw new Error('--cwd requires a path');
  if (!indexOrchestrators.includes(orchestrator)) {
    throw new Error(`--orchestrator must be ${INDEXER_ORCHESTRATORS.join(', ')}, or all`);
  }

  const { loadConfig } = await import('../src/config.mjs');
  const { openDatabase } = await import('../src/db.mjs');
  const { createEmbeddingEngine } = await import('../src/embeddings.mjs');
  const { runIndexers } = await import('../src/indexers/runner.mjs');
  const config = loadConfig({ cwd });
  const db = openDatabase(config.dbPath);
  try {
    const embeddingEngine = createEmbeddingEngine({ embedding: config.embedding });
    const summary = await runIndexers({ db, config, embeddingEngine, orchestrators: orchestrator === 'all' ? undefined : [orchestrator] });
    if (json) console.log(JSON.stringify(summary));
    else if (summary.reason === 'disabled') console.log('Transcript indexing is disabled in config.');
    else if (summary.reason === 'lease-held') console.log('Indexing skipped because another indexer holds the lease.');
    else {
      const { filesScanned, filesIndexed, filesSkipped, filesReindexed, messagesIndexed, embeddingsWritten, errors } = summary;
      console.log(`Scanned ${filesScanned} files. Indexed ${filesIndexed} (${filesReindexed} rebuilt), skipped ${filesSkipped}.`);
      console.log(`Indexed ${messagesIndexed} messages and wrote ${embeddingsWritten} embeddings. Encountered ${errors.length} errors.`);
      for (const { orchestrator, filePath, message } of errors) {
        console.error([orchestrator, filePath, message].filter(Boolean).join(' '));
      }
    }
  } finally {
    db.close();
  }
}

async function dream(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(dreamUsage);
    return;
  }
  const { values, tokens } = parseArgs({
    args,
    options: {
      project: { type: 'string' }, cwd: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    },
    tokens: true,
  });
  const names = new Set();
  for (const { name } of tokens) {
    if (names.has(name)) throw new Error(`--${name} may only be specified once`);
    names.add(name);
  }
  if (names.has('project') && names.has('cwd')) throw new Error('Use one of --project or --cwd');
  const cwd = values.project ?? values.cwd;
  if (cwd === '') throw new Error('--project and --cwd require a path');

  const { loadWorkspaceConfig } = await import('../src/config.mjs');
  const { openDatabase } = await import('../src/db.mjs');
  const { createEmbeddingEngine } = await import('../src/embeddings.mjs');
  const { runDream } = await import('../src/dreamer/engine.mjs');
  const { AUTO_DREAM_CONTEXT_ENV } = await import('../src/dreamer/trigger.mjs');
  const backgroundContext = process.env[AUTO_DREAM_CONTEXT_ENV];
  delete process.env[AUTO_DREAM_CONTEXT_ENV];
  const targetCwd = backgroundContext ? process.cwd() : path.resolve(cwd ?? process.cwd());
  const { config: current, project: { projectKey } } = loadWorkspaceConfig({ cwd: targetCwd, requireProject: true });
  const background = backgroundContext ? JSON.parse(backgroundContext) : null;
  if (background && background.projectKey !== projectKey) throw new Error('Dreamer project configuration changed');
  const config = background ? { ...current, dbPath: path.resolve(background.dbPath) } : current;
  let result;
  if (!config.dreamer.enabled || config.dreamer.mode === 'disabled') {
    result = await runDream({ config, projectKey });
  } else {
    const db = openDatabase(config.dbPath);
    try {
      const embeddingEngine = createEmbeddingEngine({ embedding: config.embedding });
      result = await runDream({
        db, config, projectKey, cwd: targetCwd, embeddingEngine,
        dryRun: Boolean(values['dry-run']), automatic: Boolean(backgroundContext),
        userDreamer: current.dreamer,
      });
    } finally {
      db.close();
    }
  }
  if (backgroundContext) return;
  if (values.json) console.log(JSON.stringify(result));
  else if (result.reason === 'disabled') console.log('Dreamer is disabled in config.');
  else if (result.reason === 'lease-held') console.log('Dreamer skipped because another run holds the project lease.');
  else if (result.reason === 'cadence') console.log('Dreamer skipped because the automatic cadence is no longer due.');
  else {
    const { memoriesReviewed, memoriesMerged, memoriesArchived, memoriesUpdated, memoriesAdded, summary } = result;
    console.log(`Dreamer ${result.status}. Reviewed ${memoriesReviewed} memories.`);
    console.log(`Merges ${memoriesMerged}, archives ${memoriesArchived}, updates ${memoriesUpdated}, additions ${memoriesAdded}.`);
    if (summary) console.log(summary);
    if (result.dryRun && result.tag_operations?.length) {
      console.log('Proposed tag operations');
      for (const operation of result.tag_operations) console.log('- ' + JSON.stringify(operation));
    }
    if (result.dryRun && result.operations?.length) {
      console.log('Proposed operations');
      for (const operation of result.operations) {
        const { type, source_ids, id, content, category, importance, reason } = operation;
        if (type === 'compact_note_comments') {
          console.log(`- ${type} ${operation.note_id}`);
          console.log('  Source comments: ' + operation.source_comment_ids.join(', '));
          console.log('  Summary: ' + JSON.stringify(operation.summary));
          continue;
        }
        console.log(`- ${type}${source_ids ? ' ' + source_ids.join(', ') : id ? ' ' + id : ''}`);
        if (content !== undefined) console.log('  Content: ' + JSON.stringify(content));
        if (category !== undefined) console.log('  Category: ' + category);
        if (importance !== undefined) console.log('  Importance: ' + importance);
        if (reason !== undefined) console.log('  Reason: ' + JSON.stringify(reason));
      }
    }
  }
}

async function importLegacy(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(importUsage);
    return;
  }
  const { values, tokens } = parseArgs({
    args,
    options: {
      from: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'include-archived': { type: 'boolean' },
      'project-map': { type: 'string' }, 'magic-context-db': { type: 'string' }, 'mnemopi-dir': { type: 'string' },
      'notes-dir': { type: 'string' }, report: { type: 'string' }, json: { type: 'boolean' }, cwd: { type: 'string' },
    },
    tokens: true,
  });
  const names = new Set();
  for (const { kind, name, value } of tokens) {
    if (kind !== 'option') throw new Error('Unexpected import argument: --');
    if (names.has(name)) throw new Error(`--${name} may only be specified once`);
    if (value === '') throw new Error(`--${name} requires a value`);
    names.add(name);
  }
  const { IMPORT_SOURCES, runImport } = await import('../src/importers/runner.mjs');
  const { from, cwd, json } = values;
  if (!IMPORT_SOURCES.includes(from)) throw new Error(`--from must be ${IMPORT_SOURCES.join(', ')}`);
  const { loadConfig } = await import('../src/config.mjs');
  const config = loadConfig({ cwd });
  const result = runImport({
    dbPath: config.dbPath, config, from, dryRun: values['dry-run'], includeArchived: values['include-archived'],
    projectMapPath: values['project-map'], magicContextDb: values['magic-context-db'],
    mnemopiDir: values['mnemopi-dir'], notesDir: values['notes-dir'], reportPath: values.report,
  });
  if (json) console.log(JSON.stringify(result));
  else {
    const { memoriesImported, memoriesSkippedDuplicate, notesImported, notesSkippedDuplicate } = result.totals;
    const action = result.dryRun ? 'Would import' : 'Imported';
    console.log(`${action} ${memoriesImported} memories and ${notesImported} notes.`);
    console.log(`Duplicates skipped: ${memoriesSkippedDuplicate} memories and ${notesSkippedDuplicate} notes.`);
    for (const { message } of result.errors) console.error(message);
  }
}

async function dashboard(args) {
  const { values, tokens } = parseArgs({
    args,
    options: {
      port: { type: 'string' }, cwd: { type: 'string' }, open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    tokens: true,
  });
  const names = new Set();
  for (const { name } of tokens) {
    if (names.has(name)) throw new Error(`--${name} may only be specified once`);
    names.add(name);
  }
  if (values.cwd !== undefined && !values.cwd.trim()) throw new Error('--cwd requires a path');
  const port = values.port === undefined ? undefined : Number(values.port);
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || port > 65535)) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  if (values.help) {
    console.log(uiUsage);
    return;
  }

  const { startDashboardServer, openBrowser } = await import('../src/ui/server.mjs');
  const { url, close } = await startDashboardServer({ cwd: values.cwd, port });
  const shutdown = () => {
    void close().catch(() => {
      console.error('Dashboard shutdown failed.');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`Dashboard running at ${url}`);
  if (values.open) await openBrowser(url).catch(() => console.error('Could not open the default browser.'));
}

if (['--help', '-h', 'help'].includes(command)) {
  console.log('Usage: multi-sub-memory [command] [--cwd <path>]');
  console.log('Commands: serve, setup, doctor, index, dream, import, ui');
  console.log(`Index usage: multi-sub-memory index [--orchestrator <${indexOrchestrators.join('|')}>] [--json] [--cwd <path>]`);
  console.log(dreamUsage);
  console.log(importUsage);
  console.log(uiUsage);
} else if (command === 'setup') {
  const { runSetup } = await import('../src/cli/setup.mjs');
  process.exitCode = await runSetup(args.slice(1));
} else if (command === 'doctor') {
  const { runDoctor } = await import('../src/cli/doctor.mjs');
  process.exitCode = await runDoctor(args.slice(1));
} else if (command === 'serve' || command.startsWith('-')) {
  try {
    const options = parseServeArgs(command === 'serve' ? args.slice(1) : args);
    const { startStdioServer } = await import('../src/mcp-server.mjs');
    await startStdioServer(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (['index', 'dream', 'import', 'ui'].includes(command)) {
  try {
    const runCommand = { index: indexTranscripts, dream, import: importLegacy, ui: dashboard }[command];
    await runCommand(args.slice(1));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  process.exitCode = 1;
  if (plannedCommands.includes(command)) {
    console.error(`${command} is not yet implemented.`);
  } else {
    console.error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}
