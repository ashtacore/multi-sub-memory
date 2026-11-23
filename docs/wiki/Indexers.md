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

Discovery recursively finds regular `.jsonl` files, skips symbolic links and
Windows junctions, and yields no files for a missing root. Both adapters accept
string content and text blocks. A missing session ID falls back to the filename
stem. The runner resolves project identity from the working directory, so
linked Git worktrees share the key derived from `git-common-dir`. If there is
no working directory or existing project key, the transcript’s parent directory
provides the project identity.

`src/indexers/types.mjs` defines the `TranscriptAdapter` contract and shared
JSONL reader. Each adapter has an `orchestrator` ID (`omp`, `claude`, `codex`,
or `agy`) and two methods. `discoverFiles(config)` supplies candidate paths.
`parseIncremental(filePath, byteOffset, existingMeta)` reads from the last
checkpoint and returns session metadata, normalized messages, the new byte
offset and line count, and file metadata. Adapters using the shared reader
pass the previous checkpoint hash and return the reader’s checkpoint result
so the runner can rebuild when continuity fails. A message carries a zero-based
sequence number, a one-based physical line number, a role, optional timestamp,
text, and tool names. The runner’s built-in registry provides OMP and Claude
Code.

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
  stream the entire committed prefix in 64 KiB chunks to compare its SHA-256
  digest with `checkpoint_hash`. Rebuild from byte zero if validation fails,
  if the file was replaced, or if a changed file is at or below the checkpoint
  length.
  Delete the prior messages and insert the new ones in one transaction, so
  FTS5 and vector rows follow the rebuild through triggers and cascades.
- Normalize valid ISO strings and epoch milliseconds (numbers or digit strings)
  to UTC ISO 8601. Prefer a valid message timestamp, then use the enclosing
  record's timestamp. Claude Code uses the record type when the nested role is
  missing or malformed. The index requires a nonempty string role.
- Commit searchable text before attempting embeddings. Embed user and assistant
  text when it is 10–16,000 characters after trimming. Tool-result turns,
  messages containing Claude Code `tool_result` blocks, and oversized output
  remain searchable through FTS5. Indexing can proceed when vector inference
  is disabled or fails.

## CLI and background refresh

```sh
npx multi-sub-memory index [--orchestrator <omp|claude|all>] [--json] [--cwd <path>]
```

The CLI defaults to `all`. Pass `--json` for a machine-readable run summary.
`--cwd` selects the workspace used for project configuration. Each transcript
still gets its project key from its own session metadata or directory fallback.

Set `indexers.backgroundRefresh` to `true` to schedule a refresh on MCP startup
and repeat it at `indexers.refreshIntervalMs`. Refresh timers do not keep the
process alive. Shutdown stops scheduling work and waits for in-flight refresh
work to drain before closing the database. Refresh diagnostics use stderr.

| Config key | Default and behavior |
|---|---|
| `indexers.enabled` | `true`. Set it to `false` to disable both CLI indexing and background refresh. |
| `indexers.backgroundRefresh` | `false`. Opts the stdio server into automatic indexing. |
| `indexers.refreshIntervalMs` | `60000`. Accepts a positive integer up to `2147483647`. |
| `indexers.omp.sessionsDir` | Optional override for the OMP session root. |
| `indexers.claude.sessionsDir` | Optional override for the Claude Code session root. |
| `indexers.codex.sessionsDir`, `indexers.agy.sessionsDir` | Accepted path settings reserved for later adapters. |

Project settings override user settings per field, including the nested
adapter options. Session roots expand a leading `~` to the current home
directory. See [MCP core](MCP-Core.md) for search and expansion parameters and
[storage and embeddings](Storage-and-Embeddings.md) for embedding settings.
