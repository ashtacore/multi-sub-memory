import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { ATTRIBUTION_MS, createTelemetryRecorder } from './analytics/telemetry.mjs';
import { formatBootstrap } from './bootstrap.mjs';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createEmbeddingEngine } from './embeddings.mjs';
import { expandSession } from './expand.mjs';
import { runIndexers } from './indexers/runner.mjs';
import {
  MEMORY_CATEGORIES, MEMORY_SCOPES, MEMORY_STATUSES, NOTE_STATUSES,
  addNoteComment, archiveMemory, dismissNote, getMemory, getNote, listMemories, listNoteComments, readNotes,
  readWithAccess, recordAccess, resolveCachedProjectKey, updateMemory, updateNote, writeMemory, writeNote,
} from './memory-service.mjs';
import { MEMORY_GUIDE_URI, readMemoryGuide } from './memory-guide.mjs';
import { hybridSearch, SEARCH_ORCHESTRATORS, SEARCH_SCOPES, SEARCH_SOURCES } from './search.mjs';

export { expandSession, hybridSearch };

const skillsDirectory = fileURLToPath(new URL('../skills/', import.meta.url));
const cwdField = z.string().min(1).describe('Workspace directory. Defaults to the server workspace.').optional();
const recordFields = {
  id: z.string().trim().min(1).optional(),
  content: z.string().optional(),
  cwd: cwdField,
  source_orchestrator: z.string().optional(),
  source_session_id: z.string().optional(),
};

function requireId({ action, id }) {
  if (!id) throw new Error(`id is required for ${action}`);
  return id;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

const MEMORY_ACTIONS = {
  get: 'mem_get', write: 'mem_remember', update: 'mem_memory:update',
  archive: 'mem_memory:archive', list: 'mem_memory:list',
};

function publicRecord({ tokens_est, compaction_count, dreamer_touched_at, ...record }) {
  return record;
}

function formatRecordResult(output) {
  if (Array.isArray(output)) return JSON.stringify(output.map(publicRecord));
  if (output.memory) return JSON.stringify({ ...output, memory: publicRecord(output.memory) });
  if (output.note) return JSON.stringify({ ...output, note: publicRecord(output.note) });
  return JSON.stringify(publicRecord(output));
}

export function createMcpServer({ db, config, embeddingEngine, defaultCwd,
  telemetry = createTelemetryRecorder(db, { retentionDays: config?.analytics?.retention_days }),
}) {
  const server = new McpServer({ name: 'multi-sub-memory', version: '0.1.0' });
  const context = { config, embeddingEngine, defaultCwd, trackAccess: true, deferAnalytics: telemetry.defer };
  const retrievalProjects = new Map();

  function toolHandler(name, run, format = JSON.stringify) {
    return async (input) => {
      const start = performance.now();
      let output;
      let result;
      try {
        output = await run(input);
        result = textResult(format(output));
      } catch (error) {
        result = { ...textResult(error instanceof Error ? error.message : String(error)), isError: true };
      }
      const durationMs = performance.now() - start;
      const createdAt = Date.now();
      telemetry.defer(() => {
        const toolName = (name === 'mem_memory' && MEMORY_ACTIONS[input.action]) || name;
        const workspace = path.resolve(input.cwd ?? defaultCwd ?? process.cwd());
        let projectKey = output?.projectKey ?? (name === 'mem_search' ? output?.project_key : undefined);
        if (projectKey && (name === 'mem_search' || name === 'mem_bootstrap')) {
          // A completed retrieval can attribute later gets for the full impression window.
          retrievalProjects.delete(workspace);
          if (retrievalProjects.size >= 64) retrievalProjects.delete(retrievalProjects.keys().next().value);
          retrievalProjects.set(workspace, { projectKey, createdAt });
        }
        if (!projectKey) {
          projectKey = resolveCachedProjectKey(workspace, config, { optional: true, cacheOnly: true })?.projectKey;
          const retrieval = retrievalProjects.get(workspace);
          if (!projectKey && retrieval && createdAt - retrieval.createdAt <= ATTRIBUTION_MS) {
            projectKey = retrieval.projectKey;
          }
        }
        projectKey ??= output?.memory?.project_key ?? output?.note?.project_key ?? output?.project_key ?? 'global';
        let returnedMemories;
        if (name === 'mem_search' && output) {
          returnedMemories = output.results.flatMap(({ id, source }, index) =>
            source === 'memory' ? [{ id, rank: index + 1 }] : []);
        }
        if (name === 'mem_bootstrap' && output) {
          returnedMemories = output.includedMemoryIds.map((id, index) => ({ id, rank: index + 1 }));
        }
        const resultCount = output?.results?.length ?? output?.messages?.length
          ?? (name === 'mem_bootstrap' && output ? output.includedMemories + output.includedNotes : undefined)
          ?? (Array.isArray(output) ? output.length : Number(output != null));
        return {
          toolName, projectKey, durationMs, createdAt, resultCount, returnedMemories,
          responseText: result.content[0].text, error: Boolean(result.isError),
          targetMemoryId: toolName === 'mem_get' ? input.id ?? null : null, query: input.query,
        };
      });
      return result;
    };
  }

  server.registerResource('memory-guide', MEMORY_GUIDE_URI, {
    title: 'Memory guide', mimeType: 'text/markdown',
  }, (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readMemoryGuide() }],
  }));

  server.registerTool('mem_memory', {
    description: 'Write, update, archive, get, or list durable project and global memories. Write requires content. Update, archive, and get require id.',
    inputSchema: z.strictObject({
      ...recordFields,
      action: z.enum(['write', 'update', 'archive', 'get', 'list']),
      category: z.enum(MEMORY_CATEGORIES).optional(),
      scope: z.enum([...MEMORY_SCOPES, 'all']).describe('Use all only for list.').optional(),
      importance: z.number().int().min(1).max(5).optional(),
      status: z.enum([...MEMORY_STATUSES, 'all']).describe('Use all only for list.').optional(),
      superseded_by: z.string().trim().min(1).optional(),
      metadata: z.json().optional(),
      tags: z.array(z.string()).describe('Tags for write or update.').optional(),
      tag_descriptions: z.record(z.string(), z.string()).optional(),
      tag: z.string().describe('Tag filter for list.').optional(),
      limit: z.number().int().optional(),
    }),
  }, toolHandler('mem_memory', (input) => {
    switch (input.action) {
      case 'write':
        return writeMemory(db, input, context);
      case 'update':
        requireId(input);
        if (input.status === 'all') throw new Error('Memory status cannot be all for update');
        return updateMemory(db, input, context);
      case 'archive':
        requireId(input);
        return archiveMemory(db, input, context);
      case 'get': {
        const id = requireId(input);
        return readWithAccess(db, 'memories', () => [getMemory(db, id)])[0];
      }
      case 'list':
        return readWithAccess(db, 'memories', () => listMemories(db, input, context));
    }
  }, formatRecordResult));

  server.registerTool('mem_note', {
    description: 'Write or read handoff topics, get a topic with paginated comments, update a topic, append a progress comment, or dismiss a topic. Status changes and dismiss require a nonblank comment. Get, update, comment, and dismiss require id.',
    inputSchema: z.strictObject({
      ...recordFields,
      action: z.enum(['write', 'read', 'get', 'update', 'comment', 'dismiss']),
      comment: z.string().describe('Transition reason for update or dismiss, or progress comment for comment.').optional(),
      expected_updated_at: z.string().trim().min(1).optional(),
      limit: z.number().int().positive().describe('Comments per get page (default 50, maximum 200).').optional(),
      cursor: z.string().describe('The next_cursor returned by the previous get page.').optional(),
      status: z.enum([...NOTE_STATUSES, 'all']).describe('New notes may be active or pending. Use all only for read.').optional(),
      surface_condition: z.string().nullable().optional(),
      include_global: z.boolean().optional(),
    }),
  }, toolHandler('mem_note', (input) => {
    const noteMutation = { expectedUpdatedAt: input.expected_updated_at, trackAccess: context.trackAccess };
    switch (input.action) {
      case 'write':
        return writeNote(db, input, context);
      case 'read':
        return readWithAccess(db, 'notes', () => readNotes(db, input, context));
      case 'get': {
        const id = requireId(input);
        const [note] = readWithAccess(db, 'notes', () => [{
          ...getNote(db, id), ...listNoteComments(db, id, input),
        }]);
        const { comments, next_cursor, ...topic } = note;
        return { note: topic, comments, next_cursor };
      }
      case 'update':
        requireId(input);
        if (input.status === 'all') throw new Error('Note status cannot be all for update');
        return updateNote(db, input, noteMutation);
      case 'comment':
        requireId(input);
        return addNoteComment(db, { ...input, body: input.comment }, noteMutation);
      case 'dismiss':
        requireId(input);
        return dismissNote(db, input, noteMutation);
    }
  }, formatRecordResult));

  server.registerTool('mem_bootstrap', {
    description: 'Return a token-budgeted summary of active project and global memories and project handoff notes.',
    inputSchema: z.object({
      cwd: cwdField,
      token_budget: z.number().int().positive().optional(),
      include_notes: z.boolean().optional(),
    }),
  }, toolHandler('mem_bootstrap', ({ cwd, token_budget, include_notes }) => formatBootstrap(db, {
    cwd, defaultCwd, config, tokenBudget: token_budget, includeNotes: include_notes, recordAccess: true, includeMemoryIds: true,
  }), ({ text }) => text));

  server.registerTool('mem_search', {
    description: 'Search memories, handoff notes, and indexed transcript messages. Use a transcript hit’s session_id, file_id, and seq to expand it.',
    inputSchema: z.object({
      query: z.string(),
      tag: z.string().describe('Search only memories with this tag.').optional(),
      cwd: cwdField,
      sources: z.array(z.enum(SEARCH_SOURCES)).optional(),
      scope: z.enum(SEARCH_SCOPES).optional(),
      orchestrators: z.array(z.enum(SEARCH_ORCHESTRATORS)).optional(),
      since: z.string().describe('Include records at or after this ISO 8601 date or timestamp.').optional(),
      limit: z.number().describe('Defaults to 10 and is clamped to 1–50.').optional(),
    }),
  }, toolHandler('mem_search', async (input) => {
    const search = await hybridSearch(db, { ...input, ...context });
    const memories = [];
    const notes = [];
    for (const { source, id } of search.results) {
      if (source === 'memory') memories.push(id);
      if (source === 'note') notes.push(id);
    }
    recordAccess(db, { memories, notes });
    return search;
  }));

  server.registerTool('mem_expand', {
    description: 'Read an indexed session by ID, optionally selecting a file ID and an inclusive message or line range.',
    inputSchema: z.object({
      session_id: z.string().trim().min(1),
      file_id: z.number().int().positive().optional(),
      start_seq: z.number().int().nonnegative().optional(),
      end_seq: z.number().int().nonnegative().optional(),
      line_start: z.number().int().positive().optional(),
      line_end: z.number().int().positive().optional(),
      max_chars: z.number().int().positive().describe('Combined JSON length of returned message records. Defaults to 16,000 characters.').optional(),
    }),
  }, toolHandler('mem_expand', (input) => expandSession(db, input)));

  const close = server.close.bind(server);
  server.close = async () => {
    try { await close(); } finally { telemetry.close(); }
  };
  return server;
}

export async function startStdioServer({ cwd, config, db, embeddingEngine } = {}) {
  const settings = config ?? loadConfig({ cwd });
  const database = db ?? openDatabase(settings.dbPath);
  const input = process.stdin;
  const refreshAbort = new AbortController();
  let server;
  let telemetry;
  let shutdown;
  let initialRefresh;
  let periodicRefresh;
  let refreshing;

  function close() {
    refreshAbort.abort();
    clearTimeout(initialRefresh);
    clearInterval(periodicRefresh);
    shutdown ??= Promise.resolve().then(async () => {
      process.off('SIGINT', requestClose);
      process.off('SIGTERM', requestClose);
      try {
        await server?.close();
      } finally {
        try {
          await refreshing;
        } finally {
          telemetry?.close();
          if (!db) database.close();
        }
      }
    });
    return shutdown;
  }

  function requestClose() {
    if (shutdown) return;
    void close().catch((error) => {
      process.stderr.write(`MCP shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  }

  try {
    const engine = embeddingEngine ?? createEmbeddingEngine({ embedding: settings.embedding });
    const transport = new StdioServerTransport(input, process.stdout);
    server = serveStdio(async ({ era }) => {
      telemetry = createTelemetryRecorder(database, { retentionDays: settings.analytics?.retention_days });
      const mcp = createMcpServer({
        telemetry,
        db: database,
        config: settings,
        embeddingEngine: engine,
        defaultCwd: cwd,
      });
      if (era === 'modern') {
        const skills = await loadSkills(skillsDirectory, { strict: true });
        skills.attach(mcp);
      }
      return mcp;
    }, {
      transport,
      onerror: (error) => process.stderr.write(`MCP transport error: ${error.message}\n`),
    });
    // The SDK closes its connection on transport close. Also release our database and refresh work.
    const closeConnection = transport.onclose;
    transport.onclose = () => {
      closeConnection();
      requestClose();
    };
    process.once('SIGINT', requestClose);
    process.once('SIGTERM', requestClose);
    if (input.readableEnded || input.destroyed) requestClose();
    if (!shutdown && settings.indexers?.enabled && settings.indexers.backgroundRefresh) {
      const refresh = () => {
        if (refreshing || refreshAbort.signal.aborted || input.readableEnded || input.destroyed) return;
        refreshing = runIndexers({
          db: database, config: settings, embeddingEngine: engine, signal: refreshAbort.signal,
        }).then(({ errors }) => {
          if (errors.length) process.stderr.write(`Transcript refresh encountered ${errors.length} errors.\n`);
        }).catch((error) => {
          process.stderr.write(`Transcript refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }).finally(() => { refreshing = undefined; });
      };
      initialRefresh = setTimeout(refresh, 0).unref();
      periodicRefresh = setInterval(refresh, settings.indexers.refreshIntervalMs).unref();
    }
    return { server, close };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], `MCP startup failed: ${error.message}; cleanup failed: ${closeError.message}`);
    }
    throw error;
  }
}
