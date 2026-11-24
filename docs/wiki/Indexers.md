# Transcript indexers

The indexer reads local session files and writes searchable messages to the
shared SQLite database. Use `mem_search` with `sources: ["transcript"]` to
find messages. Pass a hit’s `session_id`, `file_id`, and `seq` to `mem_expand`
to read the message or a larger range from the original file.

## Adapters

| Adapter | Default root | Session data |
|---|---|---|
| OMP (`omp`) | `~/.omp/agent/sessions` | A `session` header supplies `id` and `cwd`. `message` records supply the role and content. `toolCall` blocks supply tool names. |
| Claude Code (`claude`) | `~/.claude/projects` | Records supply `sessionId` and `cwd`. The adapter reads user and assistant content and extracts names from `tool_use` blocks. If no entry supplies a working directory, the adapter tries to decode the project folder name. The folder encoding can lose path information. |
| Codex (`codex`) | `~/.codex/sessions` | `session_meta` supplies the session ID and working directory. `turn_context` can update the directory. The adapter reads conversation messages and tool names from `response_item` records. A rollout filename can supply a fallback UUID. |
| Antigravity (`agy`) | `~/.gemini/antigravity-cli/brain` | Records supply conversation and workspace metadata. The adapter reads attributable user and assistant turns, and can recover the conversation ID from the directory that contains `.system_generated/logs`. |

Discovery recursively finds regular `.jsonl` files, skips symbolic links and
Windows junctions, and yields no files for a missing root. All adapters accept
string content and text blocks. The filename stem is the last fallback for a
missing session ID. The runner resolves project identity from the working
directory, so linked Git worktrees share the key derived from `git-common-dir`.
If there is no working directory or existing project key, the transcript’s
parent directory provides the project identity. See
[Transcript formats](../transcript-formats.md) for record mappings and synthetic
examples.

`src/indexers/types.mjs` defines the `TranscriptAdapter` contract and shared
JSONL reader. Each adapter has an `orchestrator` ID (`omp`, `claude`, `codex`,
or `agy`) and two methods. `discoverFiles(config)` supplies candidate paths.
`parseIncremental(filePath, byteOffset, existingMeta)` reads from the last
checkpoint and returns session metadata, normalized messages, the new byte
offset and line count, and file metadata. The runner accepts synchronous and
asynchronous adapters and passes an optional abort signal in `existingMeta`.
The built-in adapters report whether they recognized their format. An explicit
`recognized: false` leaves a new path available for another adapter when roots
overlap. If the current owner no longer recognizes a file after a full reparse,
the runner deletes the old file row and its indexed data so another adapter can
claim the path. Adapters using the shared reader pass the previous checkpoint hash
and return the reader’s checkpoint result so the runner can rebuild when
continuity fails. A message carries a zero-based sequence number, a one-based
physical line number, a role, optional timestamp, text, and tool names. The
runner’s built-in registry provides OMP, Claude Code, Codex, and Antigravity.

## Design rules and why

- Commit the byte offset and physical line count with the indexed messages.
  After validating the checkpoint, the next run decodes and parses only the
  appended bytes and retains exact line numbers even when earlier records
  were ignored. A line becomes eligible when its terminating newline arrives.
  Malformed complete lines count toward physical line numbers and are skipped
  for indexing.
- Use the shared `transcript-indexer` SQLite lease for CLI and server runs.
  A run skips work if another owner holds the lease. The owner renews it while
  working and releases it when the run exits.
- Skip a file when its observed size (`file_size`), modification time, and any
  stored file identity match. The observed size includes an incomplete tail,
  so an unchanged tail can be skipped. For older rows without a stored size,
  use the committed byte offset for this check.
- Before resuming a nonzero checkpoint, verify the trailing newline and
  compare the SHA-256 digest of the entire committed prefix with
  `checkpoint_hash`. File reads run asynchronously off the main event loop in
  64 KiB chunks, with hashing between reads, so MCP stdio requests can run
  while verification is in progress. Only newly appended bytes are decoded and
  parsed as JSONL during a resume. Rebuild from byte zero if validation fails,
  if the file was replaced, or if a changed file is at or below the checkpoint
  length. Delete the prior messages and insert the new ones in one transaction,
  so FTS5 and vector rows follow the rebuild through triggers and cascades.
- `mem_expand` reads and validates the requested range in one pass. It checks
  any session ID on the first line and compares the role, full text, and tool
  names of the earliest indexed turn and the requested indexed turns. A
  mismatch or missing turn returns the selected messages from SQLite.
- Normalize valid ISO strings and epoch milliseconds (numbers or digit strings)
  to UTC ISO 8601. Prefer a valid message timestamp, then use the enclosing
  record's timestamp. Claude Code uses the record type when the nested role is
  missing or malformed. The index requires a nonempty string role.
- Index Codex conversation messages and tool names from `response_item`
  records. Skip event copies, developer and system prompts, reasoning, and
  standalone tool output. In Antigravity, index attributable conversation
  turns with text or tool names. Discover nested Antigravity transcripts only
  at `<conversation-id>/.system_generated/logs/transcript.jsonl`. Also accept
  `.jsonl` files directly under the session root, except `transcript_full.jsonl`.
  Both adapters trim declared session IDs and skip blank candidates.
  Antigravity uses the last ID declared on a complete record, so appending a
  declaration produces the same session ID on an incremental refresh as on a
  full index. If the first line declares a different ID, `mem_expand` requires
  the committed prefix to match the stored checkpoint before reading from disk.
- Commit searchable text and its embedding eligibility before attempting
  embeddings. Each run with an embedding engine retries missing eligible
  vectors for the selected orchestrators, including rows from unchanged files.
  Migration 3 adds `embed_eligible` and defaults existing rows to `0`.
  User and assistant text is eligible when it is 10–16,000 characters after
  trimming. Tool-result turns, messages containing Claude Code `tool_result`
  blocks, and oversized output remain searchable through FTS5. Indexing can
  proceed when vector inference is disabled or fails.

## CLI and background refresh

```sh
npx multi-sub-memory index [--orchestrator <omp|claude|codex|agy|all>] [--json] [--cwd <path>]
```

The CLI defaults to `all`. Pass `--json` for a machine-readable run summary.
`--cwd` selects the workspace used for project configuration. Each transcript
still gets its project key from its own session metadata or directory fallback.

Set `indexers.backgroundRefresh` to `true` in the user config to schedule a
refresh on MCP startup and repeat it at `indexers.refreshIntervalMs`. Project
config may disable automatic refresh. If project config selects `dbPath`,
automatic refresh is disabled unless `MULTI_SUB_MEMORY_DB` overrides that path.
Refresh timers do not keep the process alive. Shutdown stops scheduling work
and waits for in-flight refresh work to drain before closing the database.
Refresh diagnostics use stderr.

When Dreamer uses automatic cadence, indexing checks each project with newly
indexed messages and an identifiable target workspace after releasing the indexer
lease. Indexing stores explicitly recorded workspace roots with the file
checkpoint so later appends can use them. An OMP append recovers a missing
workspace root from the first line of the verified checkpoint when the session
header's working directory resolves to the stored project key. The background
process uses that workspace's Dreamer settings and the database that received
the indexed messages.
[Dreamer](Dreamer.md)

| Config key | Default and behavior |
|---|---|
| `indexers.enabled` | `true`. Set it to `false` to disable both CLI indexing and background refresh. |
| `indexers.backgroundRefresh` | `false`. Automatic indexing requires user-level authorization. |
| `indexers.refreshIntervalMs` | `60000`. Accepts a positive integer up to `2147483647`. |
| `indexers.omp.sessionsDir` | Optional override for the OMP session root. |
| `indexers.claude.sessionsDir` | Optional override for the Claude Code session root. |
| `indexers.codex.sessionsDir` | Optional override for the Codex session root. |
| `indexers.agy.sessionsDir` | Optional override for the Antigravity session root. |

For the other indexer settings, project settings override user settings per
field, including the nested adapter options. Session roots expand a leading
`~` to the current home directory. See [MCP core](MCP-Core.md) for search and
expansion parameters and [storage and embeddings](Storage-and-Embeddings.md)
for embedding settings.
