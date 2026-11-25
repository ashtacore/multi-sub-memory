# Storage and embeddings

`src/db.mjs` opens the shared SQLite database through Node's `DatabaseSync`. Write connections create missing parent directories for ordinary paths, enable write-ahead logging (WAL) for file databases, and use `synchronous = NORMAL`. WAL allows readers to keep their snapshots while a writer commits. Both connection types enforce foreign keys and default to a five-second busy timeout. Callers can set a positive integer `busyTimeoutMs` for their connection. A read-only connection opens an existing database with SQLite's read-only flag and skips directory creation and migrations.

## Schema and migrations

The migration runner records completed versions and Unix epoch millisecond timestamps in `schema_migrations`. It checks each pending version again after acquiring the write lock with `BEGIN IMMEDIATE`, so concurrent openers apply a version once. The schema change and its version record commit together. A failure rolls back that migration.

Concurrent first opens can encounter a transient busy error even with the busy timeout configured. WAL initialization, creation of the migration table, and acquisition of the migration write lock retry busy errors with a short synchronous backoff and a five-second retry window per operation.

The initial schema stores structured memories, notes, transcript files and their indexed messages, memory and transcript embeddings, Dreamer runs, and leases. Memory deduplication uses the project key, scope, and SHA-256 hash of content after trimming, collapsing whitespace, and lowercasing. An embedding row records its model and dimensions alongside its little-endian float32 vector BLOB. Foreign keys cascade memory and message deletions to their embeddings, and transcript file deletion to its indexed messages.

Transcript files store the committed byte offset and physical line count, the observed file size, the device and inode identity, and a SHA-256 digest of the entire committed prefix. The indexer validates that digest before resuming from a nonzero checkpoint. Migration 2 adds `line_count`, `file_size`, `file_identity`, and `checkpoint_hash` as nullable fields so existing transcript rows remain readable. OMP and Claude Code message timestamps are stored as UTC ISO 8601 text when a valid timestamp is available. [Incremental indexing](Indexers.md)

Migration 3 adds `embed_eligible` to transcript messages and defaults existing rows to `0`. The indexer uses it to retry missing eligible embeddings independently of the file checkpoint. [Embedding eligibility](Indexers.md#design-rules-and-why)

The full-text indexes require FTS5 support in `node:sqlite`, available in official Node.js builds matching `^22.16.0 || >=24.0.0`. Node.js 23.x builds omit FTS5. External-content FTS5 indexes cover memory content, category, and project key, note content, surface condition, and project key, and transcript text, tool names, and role. Insert and delete triggers add and remove index entries. Update triggers remove the previous indexed terms before adding the current terms. Cascading transcript deletes also remove their search terms.

Migration 4 adds an index on transcript messages by file, line number, and sequence. Migration 5 adds nullable `transcript_files.project_root`, `memories.last_dreamed_at`, and `dream_runs.last_transcript_message_id` when those columns are absent. Existing transcripts gain a root when indexing reads an explicit working directory. Dreamer starts from the latest indexed messages if the last completed run has no recorded cursor. [Dreamer](Dreamer.md)

Migration 6 creates the `projects` table, keyed by `project_key`, with a
`project_root` and an `updated_at` timestamp in Unix epoch milliseconds.
Project-scoped writes register the root when it is known. The registry
supplies dashboard labels and keeps projects available after their last
memory or note is moved or removed. The migration starts with an empty
registry, and the dashboard also discovers projects from existing records
and the launch workspace. [Dashboard](Dashboard.md)

Migration 7 adds nullable `last_accessed_at` timestamps in Unix epoch
milliseconds and nonnegative `access_count` counters to memories and notes.
Existing and newly imported rows start with a null timestamp and a count of
zero. The memory and note FTS update triggers reindex only when the row ID
or indexed fields change. [MCP core](MCP-Core.md#access-tracking)

Migration 8 adds `note_comments` and leaves existing topics with empty
histories. Comments belong to one topic and are indexed by topic ID,
creation time, and comment ID. The database requires a body and either two
distinct statuses for a transition or two null statuses for progress.
Transition comments are immutable until their topic is deleted. Deleting
a topic cascades to all its comments. The notes full-text index covers
the topic content, surface condition, and project key.
[Note tools](MCP-Core.md#note-topics-and-comments)

## Design rules and why

- Embedding rows require an explicit parent ID. The `transcript_embeddings` table uses `WITHOUT ROWID` so SQLite rejects a missing message ID instead of generating one.
- `cosineSimilarity` accepts numeric vectors and encoded float32 BLOBs, including the `Uint8Array` returned by SQLite.
- Use `UPDATE` or `INSERT ... ON CONFLICT DO UPDATE` for changes to indexed rows. SQLite's `REPLACE` conflict action can skip the delete trigger and leave stale terms in an external-content index.
- `acquireLease` writes one row atomically. The owner can renew it, and another owner can acquire it at or after expiry. `releaseLease` requires the current owner. Use a positive TTL in milliseconds and renew before it expires when work needs more time.
- `src/embeddings.mjs` loads the optional Transformers.js ONNX pipeline on the first embedding request. Concurrent requests share initialization. The default model, `BAAI/bge-base-en-v1.5`, uses CLS pooling and expects 768 dimensions. Custom models use mean pooling by default, and callers can override pooling with the engine's `pooling` option.
- The engine returns L2-normalized float32 vectors and rejects empty, non-finite, zero-norm, or wrong-sized output. Explicit `dims` set the expected dimension upfront. A custom model without explicit dimensions learns them from its first valid output and requires subsequent outputs to match. Until that first valid output, its status reports the 768-dimensional default.
- Set `embedding.enabled` to `false` or `MULTI_SUB_MEMORY_NO_EMBEDDINGS` to `1`, `true`, or `yes` to use FTS only. Disabled embedding requests return `null` without loading the model. An initialization or inference failure also returns `null`, logs one warning to standard error, and keeps that engine in FTS-only mode for its lifetime. Status reports ONNX availability after the first successful inference.
