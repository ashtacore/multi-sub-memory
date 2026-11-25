import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expandHome, writeTextAtomically } from '../config.mjs';
import { readMemoryGuide } from '../memory-guide.mjs';

export const HOSTS = {
  omp: { config: '~/.omp/agent/mcp.json', format: 'json', skills: '~/.omp/agent/skills', transcriptDirs: ['~/.omp/agent/sessions'] },
  claude: { config: '~/.claude.json', format: 'json', skills: '~/.claude/skills', transcriptDirs: ['~/.claude/projects'] },
  codex: { config: '~/.codex/config.toml', format: 'toml', skills: '~/.agents/skills', transcriptDirs: ['~/.codex/sessions'] },
  agy: {
    config: '~/.gemini/antigravity/mcp_config.json',
    format: 'json',
    skills: '~/.gemini/config/skills',
    transcriptDirs: ['~/.gemini/antigravity/brain'],
  },
};

function dreamCliPreset(command, headlessArgs, restrictedArgs) {
  return { command, args: [...headlessArgs, ...restrictedArgs], restrictedArgs };
}

export const CLI_PRESETS = {
  omp: dreamCliPreset('omp', ['-p', '--no-session'], ['--no-tools']),
  claude: dreamCliPreset('claude', ['-p'], ['--tools', '', '--strict-mcp-config']),
  codex: dreamCliPreset('codex', ['exec'], [
    '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '--ignore-rules', '-c', 'mcp_servers={}', '-c', 'features.shell_tool=false',
  ]),
};

export const DREAMER_EXECUTABLE_GUIDANCE =
  'Dreamer requires a native executable (.exe or .com on Windows) on PATH or an absolute executable path. Shell shims and relative paths are unsupported.';

const server = 'multi-sub-memory';
export const HOOK_HOSTS = ['omp', 'claude'];
const ompExtensions = '~/.omp/agent/extensions';
const claudeSettings = '~/.claude/settings.json';
const managedMarker = '// Managed by multi-sub-memory setup';
const CLAUDE_HOOK_MARKER = '/* multi-sub-memory:claude-session-start */';
const ompManifest = JSON.stringify({ type: 'module', private: true, multiSubMemoryManaged: true }, null, 2) + '\n';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const entry = { command: 'npx', args: ['-y', server] };
const transportFields = ['type', 'transport'];
const jsonRemoteFields = ['url', 'serverUrl', 'endpoint'];
const tomlRemoteFields = new Set(['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var']);
const jsonSnippet = JSON.stringify({ mcpServers: { [server]: entry } }, null, 2);
const tomlFields = { command: JSON.stringify(entry.command), args: '[' + entry.args.map((arg) => JSON.stringify(arg)).join(', ') + ']' };
const tomlSnippet = ['[mcp_servers.' + server + ']',
  ...Object.entries(tomlFields).map(([key, value]) => key + ' = ' + value)].join('\n');

export function hostSnippet(host) {
  return HOSTS[host].format === 'toml'
    ? tomlSnippet
    : jsonSnippet;
}

export function hostConfigPath(host, { homeDir = os.homedir(), cwd = process.cwd(), hostConfigPaths } = {}) {
  return path.resolve(cwd, expandHome(hostConfigPaths?.[host] ?? HOSTS[host].config, homeDir));
}

function readHostConfig(configPath) {
  try {
    if (!fs.statSync(configPath).isFile()) throw new Error('Expected a regular host config at ' + configPath);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(configPath));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonConfig(source) {
  const config = JSON.parse(source.replace(/^\uFEFF/, ''));
  if (!object(config) || (Object.hasOwn(config, 'mcpServers') && !object(config.mcpServers))) {
    throw new Error('Expected an object with an optional mcpServers object');
  }
  if (Object.hasOwn(config.mcpServers ?? {}, server) && !object(config.mcpServers[server])) {
    throw new Error('Expected the multi-sub-memory MCP entry to be an object');
  }
  return config;
}

// JSON.parse validates the source first. Scan tokens only to locate editable spans.
const jsonToken = /"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^ \t\r\n{}\[\]:,"]+/g;

function nextJsonValue(tokens, source) {
  const [value] = tokens.exec(source);
  const start = tokens.lastIndex - value.length;
  let depth = value === '{' || value === '[' ? 1 : 0;
  while (depth > 0) {
    const [token] = tokens.exec(source);
    if (token === '{' || token === '[') depth++;
    else if (token === '}' || token === ']') depth--;
  }
  return { start, end: tokens.lastIndex };
}

function jsonObjectSpans(source, start) {
  const tokens = new RegExp(jsonToken);
  tokens.lastIndex = start + 1;
  const fields = new Map();
  let insertAt = start + 1;
  for (let key = tokens.exec(source); key[0] !== '}'; key = tokens.exec(source)) {
    tokens.exec(source); // Colon.
    const span = nextJsonValue(tokens, source);
    insertAt = span.end;
    // Match JSON.parse's last-property-wins behavior for duplicate keys.
    fields.set(JSON.parse(key[0]), span);
    if (tokens.exec(source)[0] === '}') break;
  }
  return { fields, insertAt };
}

function jsonArraySpans(source, start) {
  const tokens = new RegExp(jsonToken);
  tokens.lastIndex = start + 1;
  const items = [];
  while (true) {
    const token = tokens.exec(source);
    if (token[0] === ']') break;
    tokens.lastIndex = token.index;
    const span = nextJsonValue(tokens, source);
    const separator = tokens.exec(source);
    items.push({ ...span, comma: separator[0] === ',' ? separator.index : undefined });
    if (separator[0] === ']') break;
  }
  return items;
}

function applyJsonEdits(source, edits) {
  for (const { start, end, replacement } of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  return source;
}

function removeArrayItems(items, removed, edits) {
  // Remove values and only the separators that would otherwise be redundant.
  const lastKept = items.findLastIndex((_, index) => !removed.has(index));
  for (const [index, item] of items.entries()) {
    if (removed.has(index)) edits.push({ ...item, replacement: '' });
    if (item.comma !== undefined && (removed.has(index) || index === lastKept)) {
      edits.push({ start: item.comma, end: item.comma + 1, replacement: '' });
    }
  }
}

function insertJsonFields(source, { fields, insertAt }, data) {
  const properties = Object.entries(data).map(([key, value]) => JSON.stringify(key) + ': ' + JSON.stringify(value));
  return source.slice(0, insertAt) + (fields.size ? ', ' : '') + properties.join(', ') + source.slice(insertAt);
}

function mergeJson(source) {
  if (source === undefined) return jsonSnippet + '\n';

  const config = parseJsonConfig(source);
  const root = jsonObjectSpans(source, source.indexOf('{'));
  const serversField = root.fields.get('mcpServers');
  if (!serversField) return insertJsonFields(source, root, { mcpServers: { [server]: entry } });

  const servers = jsonObjectSpans(source, serversField.start);
  const serverField = servers.fields.get(server);
  if (!serverField) return insertJsonFields(source, servers, { [server]: entry });

  const current = config.mcpServers[server];
  if (jsonRemoteFields.some((key) => Object.hasOwn(current, key))
    || transportFields.some((key) => Object.hasOwn(current, key) && current[key] !== 'stdio')) {
    throw new Error('Use the manual snippet to update this MCP configuration');
  }
  const target = jsonObjectSpans(source, serverField.start);
  const missing = {};
  const edits = [];
  for (const [key, value] of Object.entries(entry)) {
    const replacement = JSON.stringify(value);
    if (JSON.stringify(current[key]) === replacement) continue;
    const field = target.fields.get(key);
    if (field) edits.push({ ...field, replacement });
    else missing[key] = value;
  }
  if (Object.keys(missing).length) source = insertJsonFields(source, target, missing);
  return applyJsonEdits(source, edits);
}

// Scan logical statements so header-like text in strings, arrays, and comments is ignored.
function* tomlStatements(source) {
  const tokens = /"""(?:\\[\s\S]|"(?!"")|[^"\\])*?"{3,5}|'''(?:'(?!'')|[^'])*?'{3,5}|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*|[\r\n"'\[\]{}]/g;
  const brackets = [];
  let start = 0;
  let comments = [];
  for (const token of source.matchAll(tokens)) {
    const value = token[0];
    if (value.startsWith('#')) comments.push(token.index - start);
    else if (value === '[' || value === '{') brackets.push(value);
    else if (value === ']' || value === '}') {
      if (brackets.pop() !== (value === ']' ? '[' : '{')) throw new Error('Unbalanced TOML brackets');
    } else if (value === '"' || value === "'") {
      throw new Error('Unterminated TOML string');
    } else if (value === '\n' && brackets.length === 0) {
      yield { start, end: token.index + 1, text: source.slice(start, token.index + 1), comments };
      start = token.index + 1;
      comments = [];
    }
  }
  if (brackets.length) throw new Error('Unbalanced TOML brackets');
  if (start < source.length) yield { start, end: source.length, text: source.slice(start), comments };
}

const keyToken = /[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*'/g;

function tomlKeyParts(key) {
  return Array.from(key.matchAll(keyToken), ([part]) => {
    if (part.startsWith("'")) return part.slice(1, -1);
    if (part.startsWith('"')) {
      return part.slice(1, -1).replace(/\\(?:U([0-9a-fA-F]{8})|u([0-9a-fA-F]{4})|(["\\btnfr]))/g,
        (escape, longCode, shortCode) => longCode || shortCode
          ? String.fromCodePoint(Number.parseInt(longCode ?? shortCode, 16))
          : JSON.parse('"' + escape + '"'));
    }
    return part;
  });
}

const dottedKey = '(?:' + keyToken.source + ')(?:\\s*\\.\\s*(?:' + keyToken.source + '))*';
const tableHeader = new RegExp('^\\s*(\\[\\[?)\\s*(' + dottedKey + ')\\s*(\\]\\]?)\\s*$');
const assignment = new RegExp('^\\s*(' + dottedKey + ')\\s*=[ \\t]*');

function inspectToml(source) {
  const fields = new Map();
  let table = [];
  let target;
  let registered = false;
  let manual = false;
  for (const statement of tomlStatements(source)) {
    const firstLine = statement.text.split(/\r?\n/, 1)[0];
    const head = firstLine.slice(0, statement.comments[0] ?? firstLine.length);
    if (!head.trim()) continue;
    const header = tableHeader.exec(head);
    if (header) {
      if (header[1].length !== header[3].length) throw new Error('Invalid TOML table header');
      table = tomlKeyParts(header[2]);
      const arrayTable = header[1] === '[[';
      if (table[0] !== 'mcp_servers') continue;
      if (arrayTable && table.length === 1) manual = true;
      if (table[1] !== server) continue;
      registered = true;
      if (table.length !== 2) {
        if (Object.hasOwn(tomlFields, table[2]) || tomlRemoteFields.has(table[2])
          || transportFields.includes(table[2])) manual = true;
        continue;
      }
      if (target || arrayTable) manual = true;
      target = statement;
      continue;
    }
    const field = assignment.exec(head);
    if (!field) throw new Error('Invalid TOML statement');
    const keys = tomlKeyParts(field[1]);
    const qualified = [...table, ...keys];
    if (qualified[0] !== 'mcp_servers') continue;
    if (qualified.length === 1) manual = true; // An inline mcp_servers table cannot be extended.
    if (qualified[1] !== server) continue;
    registered = true;
    if (table.length < 2) manual = true; // Inline tables or dotted keys can conflict with a table header.
    if (tomlRemoteFields.has(qualified[2])) manual = true;
    if (transportFields.includes(qualified[2])) {
      const value = head.slice(field[0].length).trim();
      if (qualified.length !== 3 || !/^(?:"(?:\\.|[^"\\])*"|'[^']*')$/.test(value)
        || tomlKeyParts(value)[0] !== 'stdio') manual = true;
    }
    if (table.length !== 2 || !Object.hasOwn(tomlFields, keys[0])) continue;
    if (keys.length !== 1 || fields.has(keys[0])) manual = true;
    fields.set(keys[0], { ...statement, valueStart: field[0].length });
  }
  return { fields, target, registered, manual };
}

function replaceTomlValue(statement, value, newline) {
  const { text, valueStart, comments } = statement;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g);
  let offset = 0;
  let commentIndex = 0;
  const retained = [];
  for (const [index, line] of lines.entries()) {
    const comment = comments[commentIndex];
    const hasComment = comment < offset + line.length;
    if (hasComment) commentIndex++;
    if (index === 0) {
      const suffix = hasComment
        ? line.slice(offset, comment).match(/[ \t]*$/)[0] + line.slice(comment - offset)
        : (line.match(/[ \t]*(?:\r?\n)?$/)[0] || newline);
      retained.push(text.slice(0, valueStart) + value + suffix);
    } else if (hasComment) {
      retained.push(line.match(/^[ \t]*/)[0] + line.slice(comment - offset));
    } else if (!line.trim()) {
      retained.push(line);
    }
    offset += line.length;
  }
  return retained.join('');
}

function mergeToml(source) {
  const { fields, target, manual } = inspectToml(source);
  if (manual) throw new Error('Use the manual snippet to update this MCP configuration');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (!target) {
    const separator = source && !source.endsWith('\n') ? newline : '';
    return source + separator + tomlSnippet.replaceAll('\n', newline) + newline;
  }

  const edits = [];
  const missing = [];
  for (const [key, value] of Object.entries(tomlFields)) {
    const field = fields.get(key);
    if (field) edits.push({ ...field, replacement: replaceTomlValue(field, value, newline) });
    else missing.push(key + ' = ' + value + newline);
  }
  if (missing.length) {
    const separator = target.text.endsWith('\n') ? '' : newline;
    edits.push({ start: target.end, end: target.end, replacement: separator + missing.join('') });
  }
  for (const { start, end, replacement } of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  return source;
}

export function detectHost(host, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = hostConfigPath(host, options);
  const existingTranscriptDirs = HOSTS[host].transcriptDirs
    .map((directory) => expandHome(directory, homeDir))
    .filter((directory) => fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
  const source = readHostConfig(configPath);
  const exists = source !== undefined;
  let registered = false;
  if (exists) {
    try {
      registered = HOSTS[host].format === 'toml'
        ? inspectToml(source).registered
        : Object.hasOwn(parseJsonConfig(source).mcpServers ?? {}, server);
    } catch {
      return { exists, registered, configPath, existingTranscriptDirs, invalid: true };
    }
  }
  return { exists, registered, configPath, existingTranscriptDirs };
}

export function prepareHostRegistration(host, options = {}) {
  const configPath = hostConfigPath(host, options);
  const stat = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error('Expected a regular host config at ' + configPath);

  const source = readHostConfig(configPath);
  let updated;
  try {
    if (HOSTS[host].format === 'toml') updated = mergeToml(source ?? '');
    else {
      updated = mergeJson(source);
      parseJsonConfig(updated);
    }
  } catch {
    throw new Error('Could not safely edit ' + configPath + '. Review the file and use the manual MCP snippet.');
  }

  const backupPath = source === undefined || source === updated ? undefined : configPath + '.bak';
  if (backupPath) assertSafeBackupPath(backupPath);
  return () => {
    if (source === updated) return { configPath, changed: false };
    if (readHostConfig(configPath) !== source) throw new Error('Host config changed during setup. Run setup again.');
    if (backupPath) {
      assertSafeBackupPath(backupPath);
      writeTextAtomically(backupPath, source);
    }
    writeTextAtomically(configPath, updated, stat && (stat.mode & 0o777));
    return { configPath, changed: true, backupPath };
  };
}

export function hookConfigPaths(host, { homeDir = os.homedir(), cwd = process.cwd(),
  ompExtensionsDir, claudeSettingsPath } = {}) {
  if (host === 'omp') {
    const directory = path.resolve(cwd, expandHome(ompExtensionsDir ?? ompExtensions, homeDir), server);
    return [path.join(directory, 'index.js'), path.join(directory, 'package.json')];
  }
  if (host === 'claude') {
    const settings = path.resolve(cwd, expandHome(claudeSettingsPath ?? claudeSettings, homeDir));
    return [settings, settings + '.bak'];
  }
  throw new Error('Unsupported startup hook host ' + host);
}

const skillMarker = /\n<!-- Managed by multi-sub-memory setup \(sha256:([a-f0-9]{64})\) -->\n$/;

export function hostSkillPath(host, { homeDir = os.homedir() } = {}) {
  return path.resolve(expandHome(HOSTS[host].skills, homeDir), server, 'SKILL.md');
}

function skillDigest(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function prepareSkillChange(host, context, install) {
  const configPath = hostSkillPath(host, context);
  if (install) checkParentDirectory(configPath);
  const stat = expectRegularFile(configPath);
  const source = readHostConfig(configPath);
  const marker = source?.match(skillMarker);
  const managed = marker && skillDigest(source.slice(0, marker.index)) === marker[1];
  if (source !== undefined && !managed) return () => ({ configPath, preserved: true });

  let updated;
  if (install) {
    const guide = readMemoryGuide();
    updated = guide + '\n<!-- Managed by multi-sub-memory setup (sha256:' + skillDigest(guide) + ') -->\n';
  }
  return () => {
    if (updated === source) return { configPath, changed: false };
    expectRegularFile(configPath);
    if (readHostConfig(configPath) !== source) throw new Error('Skill changed during setup. Run setup again.');
    if (install) writeTextAtomically(configPath, updated, stat && (stat.mode & 0o777));
    else fs.unlinkSync(configPath);
    return { configPath, changed: true };
  };
}

function expectRegularFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error('Expected a regular file at ' + file);
  return stat;
}

const sqliteHeader = Buffer.from('SQLite format 3\0');

function assertSafeBackupPath(backupPath) {
  if (!expectRegularFile(backupPath)) return;
  const header = Buffer.alloc(sqliteHeader.length);
  const fd = fs.openSync(backupPath, 'r');
  try {
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead === header.length && header.equals(sqliteHeader)) {
      throw new Error('Refusing to overwrite SQLite database at ' + backupPath + ' with a backup');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function checkParentDirectory(file) {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const stat = fs.statSync(directory, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Error('Expected a directory at ' + directory);
    return;
  }
}

function ompLoader() {
  const target = pathToFileURL(path.join(packageRoot, 'hooks', 'omp', 'index.mjs')).href;
  return `${managedMarker}
export default function multiSubMemoryLoader(pi) {
  let handler;
  pi.on('before_agent_start', async (event, ctx) => {
    try {
      handler ??= import(${JSON.stringify(target)})
        .then(({ createBeforeAgentStartHandler }) => createBeforeAgentStartHandler());
      return await (await handler)(event, ctx);
    } catch {
      return undefined;
    }
  });
}
`;
}

function isManagedOmpManifest(source) {
  if (source === undefined) return false;
  try {
    return JSON.parse(source)?.multiSubMemoryManaged === true;
  } catch {
    return false;
  }
}

function prepareOmpHook([configPath, manifestPath], install) {
  const directory = path.dirname(configPath);
  const readFiles = () => {
    const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (directoryStat && !directoryStat.isDirectory()) throw new Error('Expected a directory at ' + directory);
    return [manifestPath, configPath].map((file) => expectRegularFile(file) && readHostConfig(file));
  };
  if (install) checkParentDirectory(configPath);
  const [manifest, loader] = readFiles();
  const files = [
    { file: manifestPath, source: manifest, managed: isManagedOmpManifest(manifest), updated: ompManifest },
    { file: configPath, source: loader, managed: loader?.split(/\r?\n/, 1)[0] === managedMarker, updated: ompLoader() },
  ];
  if (install) {
    const unmanaged = files.find(({ source, managed }) => source !== undefined && !managed);
    if (unmanaged) throw new Error('Unmanaged OMP extension at ' + unmanaged.file);
  }
  // Install the module manifest before the entry point and remove it last.
  const changes = install ? files.filter(({ source, updated }) => source !== updated)
    : files.filter(({ managed }) => managed).reverse();
  return () => {
    if (!changes.length) return { configPath, changed: false };
    const [currentManifest, currentLoader] = readFiles();
    if (currentManifest !== manifest || currentLoader !== loader) {
      throw new Error('OMP extension changed during setup. Run setup again.');
    }
    for (const { file, updated } of changes) {
      if (install) writeTextAtomically(file, updated);
      else fs.unlinkSync(file);
    }
    if (!install) {
      try {
        fs.rmdirSync(directory);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
    return { configPath, changed: true };
  };
}

function claudeHookCommand() {
  const scriptPath = path.join(packageRoot, 'hooks', 'claude', 'session-start.mjs');
  const scriptUrl = pathToFileURL(scriptPath).href.replaceAll('$', '%24').replaceAll('`', '%60');
  // cmd.exe can expand percent and exclamation marks even inside quotes.
  const encodeArgument = process.platform === 'win32' && /[%!]/.test(scriptUrl);
  const argument = encodeArgument ? Buffer.from(scriptUrl).toString('base64url') : scriptUrl;
  const target = encodeArgument ? "Buffer.from(process.argv[1],'base64url').toString()" : 'process.argv[1]';
  return `node --input-type=module -e "${CLAUDE_HOOK_MARKER} import(${target}).then((m)=>m.runClaudeSessionStartCli?.()).catch(()=>{})" "${argument}"`;
}

function isManagedClaudeHook(hook) {
  return hook?.type === 'command' && typeof hook.command === 'string' && hook.command.includes(CLAUDE_HOOK_MARKER);
}

function editClaudeHooks(source, install, command) {
  const entry = { matcher: '', hooks: [{ type: 'command', command }] };
  if (source === undefined) {
    return install ? JSON.stringify({ hooks: { SessionStart: [entry] } }, null, 2) + '\n' : source;
  }
  const settings = JSON.parse(source.replace(/^\uFEFF/, ''));
  if (!object(settings) || (Object.hasOwn(settings, 'hooks') && !object(settings.hooks))) {
    throw new Error('Expected an object with an optional hooks object');
  }
  const root = jsonObjectSpans(source, source.indexOf('{'));
  const hooksField = root.fields.get('hooks');
  if (!hooksField) return install ? insertJsonFields(source, root, { hooks: { SessionStart: [entry] } }) : source;

  const hooks = jsonObjectSpans(source, hooksField.start);
  const sessionField = hooks.fields.get('SessionStart');
  if (!sessionField) return install ? insertJsonFields(source, hooks, { SessionStart: [entry] }) : source;
  const groups = settings.hooks.SessionStart;
  if (!Array.isArray(groups)) throw new Error('Expected hooks.SessionStart to be an array');
  const groupSpans = jsonArraySpans(source, sessionField.start);
  const edits = [];
  const emptyGroups = new Set();
  for (const [index, group] of groups.entries()) {
    if (!Array.isArray(group?.hooks)) continue;
    const managed = new Set();
    for (const [hookIndex, hook] of group.hooks.entries()) {
      if (isManagedClaudeHook(hook)) managed.add(hookIndex);
    }
    if (!managed.size) continue;
    if (!install && managed.size === group.hooks.length) {
      emptyGroups.add(index);
      continue;
    }
    const commandArray = jsonObjectSpans(source, groupSpans[index].start).fields.get('hooks');
    const commandSpans = jsonArraySpans(source, commandArray.start);
    if (install) {
      const [first] = managed;
      if (group.hooks[first].command === command) return source;
      const span = jsonObjectSpans(source, commandSpans[first].start).fields.get('command');
      return applyJsonEdits(source, [{ ...span, replacement: JSON.stringify(command) }]);
    }
    removeArrayItems(commandSpans, managed, edits);
  }
  if (install) {
    const last = groupSpans.at(-1);
    const start = last?.end ?? sessionField.start + 1;
    edits.push({ start, end: start, replacement: (last ? ', ' : '') + JSON.stringify(entry) });
  } else {
    removeArrayItems(groupSpans, emptyGroups, edits);
  }
  return applyJsonEdits(source, edits);
}

function prepareClaudeHook(configPath, install) {
  if (install) checkParentDirectory(configPath);
  const stat = expectRegularFile(configPath);
  const source = readHostConfig(configPath);
  let updated;
  try {
    updated = editClaudeHooks(source, install, claudeHookCommand());
    if (updated !== undefined) JSON.parse(updated.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error('Could not safely edit ' + configPath + '. ' + error.message);
  }
  const backupPath = source === undefined || source === updated ? undefined : configPath + '.bak';
  if (backupPath) assertSafeBackupPath(backupPath);
  return () => {
    if (source === updated) return { configPath, changed: false };
    expectRegularFile(configPath);
    if (readHostConfig(configPath) !== source) throw new Error('Claude settings changed during setup. Run setup again.');
    if (backupPath) {
      assertSafeBackupPath(backupPath);
      writeTextAtomically(backupPath, source);
    }
    writeTextAtomically(configPath, updated, stat && (stat.mode & 0o777));
    return { configPath, changed: true, backupPath };
  };
}

export function prepareHookInstall(host, context) {
  const paths = hookConfigPaths(host, context);
  return host === 'omp' ? prepareOmpHook(paths, true) : prepareClaudeHook(paths[0], true);
}

export function prepareHookUninstall(host, context) {
  const paths = hookConfigPaths(host, context);
  return host === 'omp' ? prepareOmpHook(paths, false) : prepareClaudeHook(paths[0], false);
}

export function findExecutable(command, env = process.env, cwd = process.cwd(), { forSpawn = false } = {}) {
  if (!command) return undefined;
  const windows = process.platform === 'win32';
  const envValue = (key) => windows
    ? env[Object.keys(env).find((name) => name.toUpperCase() === key)]
    : env[key];
  const extensions = !windows ? [] : forSpawn ? ['.com', '.exe']
    : [...new Set((envValue('PATHEXT') ?? '').toLowerCase().split(';')
      .filter((extension) => /^\.[a-z0-9]+$/.test(extension))
      .concat('.exe', '.cmd', '.bat', '.com', '.ps1'))];
  const extension = path.extname(command).toLowerCase();
  const suffixes = !windows || extension ? [''] : extensions;
  if (windows && extension && !extensions.includes(extension)) return undefined;
  const directPath = /[\\/]/.test(command) || (forSpawn && windows && /^[a-z]:/i.test(command));
  // Windows also treats root-relative paths like \bin as absolute, despite their implicit drive.
  const fullyQualified = (value) => path.isAbsolute(value) && (!windows || path.parse(value).root.length > 1);
  if (forSpawn && directPath && !fullyQualified(command)) return undefined;
  const directories = directPath ? [''] : (envValue('PATH') ?? '').split(path.delimiter)
    .filter(Boolean).map((entry) => entry.replace(/^"(.*)"$/, '$1'));
  for (const directory of directories) {
    if (forSpawn && !directPath && !fullyQualified(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = directPath
        ? path.resolve(cwd, command + suffix)
        : path.resolve(cwd, directory, command + suffix);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
  }
  return undefined;
}
