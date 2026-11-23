import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { acquireLease, releaseLease } from '../db.mjs';
import { DEFAULT_EMBEDDING_MODEL, encodeFloat32Vector } from '../embeddings.mjs';
import { resolveProjectKey } from '../project-id.mjs';
import { agyAdapter } from './agy.mjs';
import { claudeAdapter } from './claude.mjs';
import { codexAdapter } from './codex.mjs';
import { ompAdapter } from './omp.mjs';
import {
  normalizeTranscriptRole, normalizeTranscriptTimestamp, statWithoutLinks, transcriptFileIdentity, validateAdapter,
} from './types.mjs';

export const INDEXER_LEASE_KEY = 'transcript-indexer';
export const DEFAULT_LEASE_TTL_MS = 60_000;
export const MIN_EMBED_TEXT_CHARS = 10;
export const MAX_EMBED_TEXT_CHARS = 16_000;
export const BUILTIN_ADAPTERS = Object.freeze([ompAdapter, claudeAdapter, codexAdapter, agyAdapter]);

export function shouldEmbedMessage({ role, text, skipEmbedding }) {
  if (skipEmbedding || (role !== 'user' && role !== 'assistant') || typeof text !== 'string') return false;
  const length = text.trim().length;
  return length >= MIN_EMBED_TEXT_CHARS && length <= MAX_EMBED_TEXT_CHARS;
}

function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function sqlStatements(db) {
  return {
    file: db.prepare('SELECT * FROM transcript_files WHERE file_path = ?'),
    nextSeq: db.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS nextSeq FROM transcript_messages WHERE file_id = ?'),
    clearMessages: db.prepare('DELETE FROM transcript_messages WHERE file_id = ?'),
    addFile: db.prepare(`
      INSERT INTO transcript_files (file_path, orchestrator, session_id, project_key, mtime_ms, byte_offset,
        line_count, file_identity, checkpoint_hash, file_size, last_indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateFile: db.prepare(`
      UPDATE transcript_files SET session_id = ?, project_key = ?, mtime_ms = ?, byte_offset = ?,
        line_count = ?, file_identity = ?, checkpoint_hash = ?, file_size = ?, last_indexed_at = ?
      WHERE id = ?
    `),
    addMessage: db.prepare(`
      INSERT INTO transcript_messages (file_id, seq, role, timestamp, text, tool_names, line_no)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    putEmbedding: db.prepare(`
      INSERT INTO transcript_embeddings (message_id, model_id, dims, vector)
      SELECT id, ?, ?, ? FROM transcript_messages WHERE id = ?
      ON CONFLICT (message_id) DO UPDATE SET
        model_id = excluded.model_id, dims = excluded.dims, vector = excluded.vector
    `),
  };
}

export async function runIndexers({
  db, config, embeddingEngine, orchestrators, adapters = BUILTIN_ADAPTERS,
  owner, leaseTtlMs = DEFAULT_LEASE_TTL_MS, signal,
}) {
  const summary = {
    skipped: false, filesScanned: 0, filesIndexed: 0, filesSkipped: 0, filesReindexed: 0,
    messagesIndexed: 0, embeddingsWritten: 0, errors: [],
  };
  if (config?.indexers?.enabled === false) return { ...summary, skipped: true, reason: 'disabled' };
  const selected = adapters.map(validateAdapter)
    .filter(({ orchestrator }) => !orchestrators || orchestrators.includes(orchestrator));
  // Each invocation has its own token, even when runs share a caller label.
  const resolvedOwner = owner === undefined ? randomUUID() : `${owner}:${randomUUID()}`;
  let renewedAt = Date.now();
  const acquired = acquireLease(db, INDEXER_LEASE_KEY, resolvedOwner, leaseTtlMs, renewedAt);
  if (!acquired) return { ...summary, skipped: true, reason: 'lease-held' };

  let leaseLost = false;
  let heartbeat;
  function recordError(orchestrator, filePath, error) {
    summary.errors.push({ orchestrator, filePath, message: error instanceof Error ? error.message : String(error) });
  }
  try {
    const renew = db.prepare(`
      UPDATE leases SET expires_at = ? WHERE lease_key = ? AND owner = ? AND expires_at > ?
    `);
    function renewIfDue() {
      const now = Date.now();
      if (leaseLost || now - renewedAt < leaseTtlMs / 2) return;
      leaseLost = !renew.run(now + leaseTtlMs, INDEXER_LEASE_KEY, resolvedOwner, now).changes;
      if (leaseLost) recordError(undefined, undefined, new Error('Transcript indexer lease expired or changed owners'));
      renewedAt = now;
    }
    heartbeat = setInterval(() => {
      try {
        renewIfDue();
      } catch (error) {
        leaseLost = true;
        recordError(undefined, undefined, error);
      }
    }, Math.max(1, Math.min(2 ** 31 - 1, Math.floor(leaseTtlMs / 2)))).unref();

    const sql = sqlStatements(db);
    const projectKeys = new Map();
    function projectKeyFor(cwd) {
      if (!projectKeys.has(cwd)) projectKeys.set(cwd, resolveProjectKey(cwd).projectKey);
      return projectKeys.get(cwd);
    }

    for (const adapter of selected) {
      if (signal?.aborted || leaseLost) break;
      const { orchestrator } = adapter;
      const sessionsDir = config?.indexers?.[orchestrator]?.sessionsDir;
      let files;
      try {
        files = adapter.discoverFiles(config);
      } catch (error) {
        recordError(orchestrator, undefined, error);
        continue;
      }
      for (const candidate of files) {
        // Yield between files so stdio shutdown and the heartbeat can run.
        await setImmediate();
        renewIfDue();
        if (signal?.aborted || leaseLost) return summary;
        summary.filesScanned++;
        let filePath = candidate;
        try {
          filePath = path.resolve(candidate);
          let stat;
          try {
            stat = statWithoutLinks(filePath);
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
          }
          if (!stat?.isFile() || stat.isSymbolicLink()) {
            summary.filesSkipped++;
            continue;
          }

          const existing = sql.file.get(filePath);
          const fileSize = Number(stat.size);
          const sameSize = existing && fileSize === (existing.file_size ?? existing.byte_offset);
          const fileIdentity = transcriptFileIdentity(stat);
          const replaced = existing?.file_identity != null && existing.file_identity !== fileIdentity;
          if (existing && (existing.orchestrator !== orchestrator
            || (!replaced && sameSize && Number(stat.mtimeMs) === existing.mtime_ms))) {
            summary.filesSkipped++;
            continue;
          }
          let reindex = Boolean(existing && (replaced || fileSize <= existing.byte_offset
            || (existing.byte_offset > 0 && existing.checkpoint_hash == null)));
          const offset = existing && !reindex ? existing.byte_offset : 0;
          const fullMeta = { sessionsDir };
          let parsed = adapter.parseIncremental(filePath, offset, existing && !reindex ? {
            ...fullMeta, sessionId: existing.session_id, lineCount: existing.line_count ?? undefined,
            checkpointHash: existing.checkpoint_hash ?? undefined,
            nextSeq: sql.nextSeq.get(existing.id).nextSeq,
          } : fullMeta);
          if (offset > 0 && (parsed.checkpointMismatch || parsed.fileSize <= offset
            || (parsed.fileIdentity && parsed.fileIdentity !== fileIdentity))) {
            reindex = true;
            parsed = adapter.parseIncremental(filePath, 0, fullMeta);
          }

          const { sessionId, cwd, messages, mtimeMs, newByteOffset, lineCount } = parsed;
          const projectKey = !cwd && existing && !reindex ? existing.project_key : projectKeyFor(cwd ?? path.dirname(filePath));
          const fileValues = [sessionId, projectKey, mtimeMs, newByteOffset, lineCount,
            parsed.fileIdentity ?? fileIdentity, parsed.checkpointHash ?? null, parsed.fileSize ?? fileSize, Date.now()];
          const pending = inTransaction(db, () => {
            renewIfDue();
            if (leaseLost) return null;
            let fileId = existing?.id;
            if (existing) {
              if (reindex) sql.clearMessages.run(fileId);
              sql.updateFile.run(...fileValues, fileId);
            } else {
              fileId = sql.addFile.run(filePath, orchestrator, ...fileValues).lastInsertRowid;
            }
            const embeddings = [];
            let messagesIndexed = 0;
            for (const message of messages) {
              const { seq, timestamp, text, toolNames, lineNo } = message;
              const role = normalizeTranscriptRole(message.role);
              if (role === null) continue;
              const { lastInsertRowid } = sql.addMessage.run(fileId, seq, role, normalizeTranscriptTimestamp(timestamp),
                text, toolNames.length ? JSON.stringify(toolNames) : null, lineNo);
              messagesIndexed++;
              if (embeddingEngine && shouldEmbedMessage(message)) embeddings.push({ id: lastInsertRowid, text: text.trim() });
            }
            return { embeddings, messagesIndexed };
          });
          if (!pending) return summary;
          summary.filesIndexed++;
          if (reindex) summary.filesReindexed++;
          summary.messagesIndexed += pending.messagesIndexed;

          for (const { id, text } of pending.embeddings) {
            renewIfDue();
            if (signal?.aborted || leaseLost) return summary;
            try {
              const vector = await embeddingEngine.embed(text);
              renewIfDue();
              if (signal?.aborted || leaseLost) return summary;
              if (vector) {
                const model = embeddingEngine.getStatus?.()?.model ?? config?.embedding?.model ?? DEFAULT_EMBEDDING_MODEL;
                summary.embeddingsWritten += sql.putEmbedding.run(model, vector.length, encodeFloat32Vector(vector), id).changes;
              }
            } catch (error) {
              recordError(orchestrator, filePath, error);
            }
          }
        } catch (error) {
          recordError(orchestrator, filePath, error);
        }
      }
    }
    return summary;
  } finally {
    clearInterval(heartbeat);
    releaseLease(db, INDEXER_LEASE_KEY, resolvedOwner);
  }
}
