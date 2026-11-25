#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { INDEXER_ORCHESTRATORS } from '../src/indexers/types.mjs';

const plannedCommands = ['dream', 'ui', 'import'];
const indexOrchestrators = [...INDEXER_ORCHESTRATORS, 'all'];
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

if (['--help', '-h', 'help'].includes(command)) {
  console.log('Usage: multi-sub-memory [command] [--cwd <path>]');
  console.log(`Commands: serve, setup, doctor, index, ${plannedCommands.join(', ')}`);
  console.log(`Index usage: multi-sub-memory index [--orchestrator <${indexOrchestrators.join('|')}>] [--json] [--cwd <path>]`);
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
} else if (command === 'index') {
  try {
    await indexTranscripts(args.slice(1));
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
