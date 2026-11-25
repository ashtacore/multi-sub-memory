#!/usr/bin/env node

const plannedCommands = ['setup', 'doctor', 'index', 'dream', 'ui', 'import'];
const command = process.argv[2] ?? 'serve';

if (['--help', '-h', 'help'].includes(command)) {
  console.log('Usage: multi-sub-memory [command]');
  console.log(`Commands: serve, ${plannedCommands.join(', ')}`);
} else {
  process.exitCode = 1;
  if (command === 'serve') {
    console.error('serve is not yet implemented (Issue #3).');
  } else if (plannedCommands.includes(command)) {
    console.error(`${command} is not yet implemented.`);
  } else {
    console.error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}
