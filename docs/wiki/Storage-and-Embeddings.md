# Storage and embeddings

`src/db.mjs` opens the shared SQLite database through Node's `DatabaseSync`. Write connections create missing parent directories for ordinary paths, enable write-ahead logging (WAL) for file databases, and use `synchronous = NORMAL`. WAL allows readers to keep their snapshots while a writer commits. Both connection types enforce foreign keys and use a five-second busy timeout. A read-only connection opens an existing database with SQLite's read-only flag and skips directory creation and migrations.

## Schema and migrations

The migration runner records completed versions and Unix epoch millisecond timestamps in `schema_migrations`. It checks each pending version again after acquiring the write lock with `BEGIN IMMEDIATE`, so concurrent openers apply a version once. The schema change and its version record commit together. A failure rolls back that migration.

Concurrent first opens can encounter a transient busy error even with the busy timeout configured. WAL initialization, creation of the migration table, and acquisition of the migration write lock retry busy errors with a short synchronous backoff and a five-second retry window per operation.

The initial schema stores structured memories, notes, transcript files and their indexed messages, memory and transcript embeddings, Dreamer runs, and leases. Memory deduplication uses the project key, scope, and SHA-256 hash of content after trimming, collapsing whitespace, and lowercasing. An embedding row records its model and dimensions alongside its little-endian float32 vector BLOB. Foreign keys cascade memory and message deletions to their embeddings, and transcript file deletion to its indexed messages.

The full-text indexes require FTS5 support in `node:sqlite`, available in official Node.js 22 builds starting with 22.16.0. External-content FTS5 indexes cover memory content, category, and project key, note content, surface condition, and project key, and transcript text, tool names, and role. Insert and delete triggers add and remove index entries. Update triggers remove the previous indexed terms before adding the current terms. Cascading transcript deletes also remove their search terms.

## Design rules and why

- Embedding rows require an explicit parent ID. The `transcript_embeddings` table uses `WITHOUT ROWID` so SQLite rejects a missing message ID instead of generating one.
- `cosineSimilarity` accepts numeric vectors and encoded float32 BLOBs, including the `Uint8Array` returned by SQLite.
- Use `UPDATE` or `INSERT ... ON CONFLICT DO UPDATE` for changes to indexed rows. SQLite's `REPLACE` conflict action can skip the delete trigger and leave stale terms in an external-content index.
- `acquireLease` writes one row atomically. The owner can renew it, and another owner can acquire it at or after expiry. `releaseLease` requires the current owner. Use a positive TTL in milliseconds and renew before it expires when work needs more time.
- `src/embeddings.mjs` loads the optional Transformers.js ONNX pipeline on the first embedding request. Concurrent requests share initialization. The default model, `BAAI/bge-base-en-v1.5`, uses CLS pooling and expects 768 dimensions. Custom models use mean pooling by default, and callers can override pooling with the engine's `pooling` option.
- The engine returns L2-normalized float32 vectors and rejects empty, non-finite, zero-norm, or wrong-sized output. Explicit `dims` set the expected dimension upfront. A custom model without explicit dimensions learns them from its first valid output and requires subsequent outputs to match. Until that first valid output, its status reports the 768-dimensional default.
- Set `embedding.enabled` to `false` or `MULTI_SUB_MEMORY_NO_EMBEDDINGS` to `1`, `true`, or `yes` to use FTS only. Disabled embedding requests return `null` without loading the model. An initialization or inference failure also returns `null`, logs one warning to standard error, and keeps that engine in FTS-only mode for its lifetime. Status reports ONNX availability after the first successful inference.
