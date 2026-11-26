import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createBeforeAgentStartHandler } from '../hooks/omp/index.mjs';
import { resolveProjectKey } from '../src/project-id.mjs';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const claudeModule = new URL('../hooks/claude/session-start.mjs', import.meta.url);

function worktrees(root) {
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  fs.mkdirSync(repoA);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(root, 'absent-gitconfig');
  function git(...args) {
    execFileSync('git', args, { cwd: repoA, env, timeout: 10000, windowsHide: true, stdio: 'pipe' });
  }
  git('init', '--template=');
  git('-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com',
    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Synthetic workspace');
  git('remote', 'add', 'origin', 'https://example.test/Fixtures/Worktree.git');
  git('worktree', 'add', '--detach', repoB);
  const { projectKey } = resolveProjectKey(repoA);
  assert.equal(projectKey, 'example.test/Fixtures/Worktree');
  assert.equal(resolveProjectKey(repoB).projectKey, projectKey);
  return { repoA, repoB, projectKey };
}

async function withMcpClient(env, cwd, host, run) {
  const client = new Client({ name: host, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cliPath, 'serve', '--cwd', cwd], cwd, env,
  });
  const requestOptions = { timeout: 10_000 };
  try {
    await client.connect(transport, requestOptions);
    async function tool(name, args) {
      const result = await client.callTool({ name, arguments: args }, requestOptions);
      const { type, text } = result.content[0];
      assert.equal(result.isError, undefined, text);
      assert.equal(type, 'text');
      return name === 'mem_bootstrap' ? text : JSON.parse(text);
    }
    return await run(tool);
  } finally {
    await transport.close();
  }
}

async function assertTranscript(tool, host, projectKey) {
  const query = `Lighthouse transcript update from ${host}`;
  const search = await tool('mem_search', { query, sources: ['transcript'], orchestrators: [host] });
  assert.equal(search.results.length, 1);
  const [hit] = search.results;
  assert.equal(hit.orchestrator, host);
  assert.equal(hit.session_id, `${host}-fixture`);
  assert.equal(hit.project_key, projectKey);
  assert.equal(hit.seq, 1);
  const expanded = await tool('mem_expand', {
    session_id: hit.session_id, file_id: hit.file_id, start_seq: hit.seq, end_seq: hit.seq,
  });
  assert.equal(expanded.source, 'disk');
  assert.equal(expanded.orchestrator, host);
  assert.deepEqual(expanded.messages.map(({ text }) => text), [query]);
}

async function assertMemoryRecalled(tool, written) {
  const memories = await tool('mem_memory', { action: 'list', scope: 'project' });
  const recalled = memories.find(({ id }) => id === written.id);
  assert.ok(recalled);
  assert.ok(recalled.last_accessed_at >= written.last_accessed_at);
  assert.deepEqual(recalled, {
    ...written, access_count: written.access_count + 1, last_accessed_at: recalled.last_accessed_at,
  });
}

const fixtureSessions = {
  omp: {
    header: (cwd) => [{ type: 'session', cwd, id: 'omp-fixture' }],
    message: (text) => ({ type: 'message', message: { role: 'user', content: text } }),
  },
  claude: {
    header: (cwd) => [{ type: 'system', cwd, sessionId: 'claude-fixture' }],
    message: (text) => ({ type: 'user', message: { role: 'user', content: text } }),
  },
  codex: {
    header: (cwd) => [{ type: 'session_meta', payload: { cwd, id: 'codex-fixture' } }],
    message: (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: text } }),
  },
  agy: {
    header: (cwd) => [{ type: 'SYSTEM_MESSAGE', cwd, conversation_id: 'agy-fixture' }],
    message: (text) => ({ type: 'USER_INPUT', content: text }),
  },
};

test('Codex, Antigravity, OMP and Claude share worktree memory, transcripts, and startup context', { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-sub-memory-cross-orchestrator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { repoA, repoB, projectKey } = worktrees(root);
  const dbPath = path.join(root, 'memory.db');
  const configPath = path.join(root, 'config.yaml');
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:MULTI_SUB_MEMORY_|GIT_|HOME$|USERPROFILE$)/i.test(key)));
  const env = {
    ...inheritedEnv, HOME: root, USERPROFILE: root,
    MULTI_SUB_MEMORY_CONFIG: configPath, MULTI_SUB_MEMORY_DB: dbPath, MULTI_SUB_MEMORY_NO_EMBEDDINGS: '1',
  };
  const hosts = Object.keys(fixtureSessions);
  const indexers = {};
  const transcripts = {};
  const jsonl = (records) => records.map((record) => JSON.stringify(record) + '\n').join('');
  for (const [index, host] of hosts.entries()) {
    const adapter = fixtureSessions[host];
    const sessionsDir = path.join(root, host);
    fs.mkdirSync(sessionsDir);
    indexers[host] = { sessionsDir };
    transcripts[host] = path.join(sessionsDir, `${host}-fixture.jsonl`);
    fs.writeFileSync(transcripts[host], jsonl([
      ...adapter.header(index % 2 ? repoB : repoA), adapter.message(`Initial transcript fixture for ${host}`),
    ]));
  }
  fs.writeFileSync(configPath, JSON.stringify({ indexers }));
  function index() {
    const output = execFileSync(process.execPath, [cliPath, 'index', '--json', '--cwd', repoA], {
      cwd: repoA, env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    const result = JSON.parse(output);
    assert.deepEqual(result.errors, []);
    assert.equal(result.filesIndexed, 4);
    assert.equal(result.messagesIndexed, 4);
    return result;
  }
  index();
  for (const host of hosts) {
    fs.appendFileSync(transcripts[host], jsonl([fixtureSessions[host].message(`Lighthouse transcript update from ${host}`)]));
  }
  assert.equal(index().filesReindexed, 0);

  const { memory, note } = await withMcpClient(env, repoA, 'codex', async (tool) => {
    const { memory } = await tool('mem_memory', {
      action: 'write', content: 'Lighthouse architecture from Codex', category: 'ARCHITECTURE',
      source_orchestrator: 'codex', source_session_id: 'codex-fixture',
    });
    const note = await tool('mem_note', {
      action: 'write', content: 'Review the lighthouse plan', surface_condition: 'During review', source_orchestrator: 'codex',
    });
    assert.equal(memory.project_key, projectKey);
    assert.equal(note.project_key, projectKey);
    return { memory, note };
  });

  const agy = await withMcpClient(env, repoB, 'agy', async (tool) => {
    await assertMemoryRecalled(tool, memory);
    const notes = await tool('mem_note', { action: 'read' });
    assert.ok(notes.some((row) => row.id === note.id && row.surface_condition === 'During review'));
    const summary = await tool('mem_bootstrap', {});
    assert.match(summary, /Lighthouse architecture from Codex/);
    assert.match(summary, /Review the lighthouse plan/);
    const recalled = await tool('mem_search', { query: 'lighthouse', sources: ['memory', 'note'], orchestrators: ['codex'] });
    assert.equal(recalled.project_key, projectKey);
    assert.deepEqual(recalled.results.map(({ source }) => source).sort(), ['memory', 'note']);
    await assertTranscript(tool, 'codex', projectKey);
    const { memory: decision } = await tool('mem_memory', {
      action: 'write', content: 'Fixture decision from Antigravity', category: 'DECISIONS', source_orchestrator: 'agy',
    });
    await tool('mem_note', { action: 'write', content: 'Confirm the Antigravity fixture', source_orchestrator: 'agy' });
    return decision;
  });

  const ompMemory = await withMcpClient(env, repoA, 'omp', async (tool) => {
    await assertMemoryRecalled(tool, agy);
    await assertTranscript(tool, 'agy', projectKey);
    const { memory } = await tool('mem_memory', {
      action: 'write', content: 'Fixture workflow from OMP', category: 'WORKFLOW', source_orchestrator: 'omp',
    });
    return memory;
  });

  const claudeMemory = await withMcpClient(env, repoB, 'claude', async (tool) => {
    await assertMemoryRecalled(tool, ompMemory);
    await assertTranscript(tool, 'omp', projectKey);
    const { memory } = await tool('mem_memory', {
      action: 'write', content: 'Fixture constraint from Claude Code', category: 'CONSTRAINTS', source_orchestrator: 'claude',
    });
    return memory;
  });

  await withMcpClient(env, repoA, 'codex', async (tool) => {
    await assertMemoryRecalled(tool, claudeMemory);
    await assertTranscript(tool, 'claude', projectKey);
  });

  const digest = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const before = digest();
  function assertDatabaseUnchanged() {
    assert.equal(digest(), before);
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(dbPath + suffix), false);
  }
  assertDatabaseUnchanged();

  const hookOptions = { env, homeDir: root, timeoutMs: 5000 };
  const beforeAgentStart = createBeforeAgentStartHandler(hookOptions);
  const messages = Object.freeze([Object.freeze({ role: 'user', content: 'Existing message fixture' })]);
  const event = { systemPrompt: 'Fixture prompt', messages };
  const omp = await beforeAgentStart(event, { cwd: repoA, sessionId: 'omp-hook-fixture' });
  assert.match(omp?.systemPrompt ?? '', /^Fixture prompt\n\n<project-memory /);
  assert.deepEqual(event, { systemPrompt: 'Fixture prompt', messages });
  assert.equal(event.messages, messages);
  assertDatabaseUnchanged();

  const claudeSource = `import { runClaudeSessionStartCli } from ${JSON.stringify(claudeModule.href)};
    await runClaudeSessionStartCli({ timeoutMs: ${hookOptions.timeoutMs} });`;
  const claude = spawnSync(process.execPath, ['--input-type=module', '--eval', claudeSource], {
    cwd: repoB, env, input: JSON.stringify({ cwd: repoB, session_id: 'claude-hook-fixture' }),
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.ifError(claude.error);
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.stderr, '');
  for (const context of [omp.systemPrompt, claude.stdout]) {
    assert.match(context, /Lighthouse architecture from Codex/);
    assert.match(context, /Review the lighthouse plan/);
    assert.match(context, /Fixture decision from Antigravity/);
    assert.match(context, /Confirm the Antigravity fixture/);
    assert.match(context, /Fixture workflow from OMP/);
    assert.match(context, /Fixture constraint from Claude Code/);
  }
  assertDatabaseUnchanged();
});
