#!/usr/bin/env node

const plannedCommands = ['setup', 'doctor', 'index', 'dream', 'ui', 'import'];
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

if (['--help', '-h', 'help'].includes(command)) {
  console.log('Usage: multi-sub-memory [command] [--cwd <path>]');
  console.log(`Commands: serve, ${plannedCommands.join(', ')}`);
} else if (command === 'serve' || command.startsWith('-')) {
  try {
    const options = parseServeArgs(command === 'serve' ? args.slice(1) : args);
    const { startStdioServer } = await import('../src/mcp-server.mjs');
    await startStdioServer(options);
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
