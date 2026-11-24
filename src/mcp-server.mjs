import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatBootstrap } from './bootstrap.mjs';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createEmbeddingEngine } from './embeddings.mjs';
import { expandSession } from './expand.mjs';
import { runIndexers } from './indexers/runner.mjs';
import {
  MEMORY_CATEGORIES, MEMORY_SCOPES, MEMORY_STATUSES, NOTE_STATUSES,
  archiveMemory, dismissNote, getMemory, listMemories, readNotes,
  updateMemory, updateNote, writeMemory, writeNote,
} from './memory-service.mjs';
import { hybridSearch, SEARCH_ORCHESTRATORS, SEARCH_SCOPES, SEARCH_SOURCES } from './search.mjs';

export { expandSession, hybridSearch };

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

function toolHandler(run, format = JSON.stringify) {
  return async (input) => {
    try {
      return textResult(format(await run(input)));
    } catch (error) {
      return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true };
    }
  };
}

export function createMcpServer({ db, config, embeddingEngine, defaultCwd }) {
  const server = new McpServer({ name: 'multi-sub-memory', version: '0.1.0' });
  const context = { config, embeddingEngine, defaultCwd };

  server.registerTool('mem_memory', {
    description: 'Write, update, archive, get, or list durable project and global memories. Write requires content. Update, archive, and get require id.',
    inputSchema: {
      ...recordFields,
      action: z.enum(['write', 'update', 'archive', 'get', 'list']),
      category: z.enum(MEMORY_CATEGORIES).optional(),
      scope: z.enum([...MEMORY_SCOPES, 'all']).describe('Use all only for list.').optional(),
      importance: z.number().int().min(1).max(5).optional(),
      status: z.enum([...MEMORY_STATUSES, 'all']).describe('Use all only for list.').optional(),
      superseded_by: z.string().trim().min(1).optional(),
      metadata: z.json().optional(),
      limit: z.number().int().optional(),
    },
  }, toolHandler((input) => {
    switch (input.action) {
      case 'write':
        return writeMemory(db, input, context);
      case 'update':
        requireId(input);
        if (input.status === 'all') throw new Error('Memory status cannot be all for update');
        return updateMemory(db, input, context);
      case 'archive':
        requireId(input);
        return archiveMemory(db, input);
      case 'get':
        return getMemory(db, requireId(input));
      case 'list':
        return listMemories(db, input, context);
    }
  }));

  server.registerTool('mem_note', {
    description: 'Write, read, update, or dismiss handoff notes. Write requires content. Update and dismiss require id.',
    inputSchema: {
      ...recordFields,
      action: z.enum(['write', 'read', 'update', 'dismiss']),
      status: z.enum([...NOTE_STATUSES, 'all']).describe('New notes may be active or pending. Use all only for read.').optional(),
      surface_condition: z.string().nullable().optional(),
      include_global: z.boolean().optional(),
    },
  }, toolHandler((input) => {
    switch (input.action) {
      case 'write':
        return writeNote(db, input, context);
      case 'read':
        return readNotes(db, input, context);
      case 'update':
        requireId(input);
        if (input.status === 'all') throw new Error('Note status cannot be all for update');
        return updateNote(db, input);
      case 'dismiss':
        return dismissNote(db, requireId(input));
    }
  }));

  server.registerTool('mem_bootstrap', {
    description: 'Return a token-budgeted summary of active project and global memories and project handoff notes.',
    inputSchema: {
      cwd: cwdField,
      token_budget: z.number().int().positive().optional(),
      include_notes: z.boolean().optional(),
    },
  }, toolHandler(({ cwd, token_budget, include_notes }) => formatBootstrap(db, {
    cwd, defaultCwd, config, tokenBudget: token_budget, includeNotes: include_notes,
  }), ({ text }) => text));

  server.registerTool('mem_search', {
    description: 'Search memories, handoff notes, and indexed transcript messages. Use a transcript hit’s session_id, file_id, and seq to expand it.',
    inputSchema: {
      query: z.string(),
      cwd: cwdField,
      sources: z.array(z.enum(SEARCH_SOURCES)).optional(),
      scope: z.enum(SEARCH_SCOPES).optional(),
      orchestrators: z.array(z.enum(SEARCH_ORCHESTRATORS)).optional(),
      since: z.string().describe('Include records at or after this ISO 8601 date or timestamp.').optional(),
      limit: z.number().describe('Defaults to 10 and is clamped to 1–50.').optional(),
    },
  }, toolHandler((input) => hybridSearch(db, { ...input, ...context })));

  server.registerTool('mem_expand', {
    description: 'Read an indexed session by ID, optionally selecting a file ID and an inclusive message or line range.',
    inputSchema: {
      session_id: z.string().trim().min(1),
      file_id: z.number().int().positive().optional(),
      start_seq: z.number().int().nonnegative().optional(),
      end_seq: z.number().int().nonnegative().optional(),
      line_start: z.number().int().positive().optional(),
      line_end: z.number().int().positive().optional(),
      max_chars: z.number().int().positive().describe('Combined JSON length of returned message records. Defaults to 16,000 characters.').optional(),
    },
  }, toolHandler((input) => expandSession(db, input)));

  return server;
}

export async function startStdioServer({ cwd, config, db, embeddingEngine } = {}) {
  const settings = config ?? loadConfig({ cwd });
  const database = db ?? openDatabase(settings.dbPath);
  const input = process.stdin;
  const refreshAbort = new AbortController();
  let server;
  let shutdown;
  let initialRefresh;
  let periodicRefresh;
  let refreshing;

  function close() {
    refreshAbort.abort();
    clearTimeout(initialRefresh);
    clearInterval(periodicRefresh);
    // Let requests already read from stdin finish synchronous work before closing.
    shutdown ??= new Promise((resolve) => setImmediate(resolve)).then(async () => {
      input.off('end', requestClose);
      input.off('close', requestClose);
      process.off('SIGINT', requestClose);
      process.off('SIGTERM', requestClose);
      try {
        await server?.close();
      } finally {
        try {
          await refreshing;
        } finally {
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
    server = createMcpServer({
      db: database,
      config: settings,
      embeddingEngine: engine,
      defaultCwd: cwd,
    });
    const transport = new StdioServerTransport(input, process.stdout);
    transport.onclose = requestClose;
    input.once('end', requestClose);
    input.once('close', requestClose);
    process.once('SIGINT', requestClose);
    process.once('SIGTERM', requestClose);
    await server.connect(transport);
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
