# MCP core

Run `multi-sub-memory` or `multi-sub-memory serve` as a stdio MCP server. Set
`--cwd <path>` to choose the server's default workspace. Clients can override
it with `cwd` when a tool needs a project key. Linked Git worktrees share a
project key and use their own workspace names in bootstrap output.

The server loads configuration and opens the shared SQLite database at startup.
It closes the MCP transport and its own database connection when stdin ends or
closes, the transport closes, or it receives SIGINT or SIGTERM. It leaves a
caller-supplied database connection open.

Enable automatic transcript refresh with `indexers.backgroundRefresh`. See
[Indexers](Indexers.md) for session discovery, CLI indexing, and configuration.

## Tools

| Tool | Action | Behavior |
|---|---|---|
| `mem_memory` | `write` | Stores content under the current project or the shared global key. Defaults to category `GENERAL` and importance 3. Returns the memory and flags for deduplication and reactivation. |
| `mem_memory` | `get`, `update`, `archive` | Looks up a memory by ID. Updates can change content, category, importance, scope, status, or metadata. To mark a memory as superseded, use `archive` with `superseded_by` set to the ID of a different, existing memory. |
| `mem_memory` | `list` | Lists active memories from the current project and global scope by default. Accepts scope, status, category, and limit filters. The default limit is 50 and the maximum is 200. |
| `mem_note` | `write`, `update`, `dismiss` | Creates a current-project note, changes it by ID, or marks it dismissed. New notes are active by default and can be pending. A note can record a `surface_condition`. |
| `mem_note` | `read` | Lists active and pending notes for the current project by default. Accepts a status filter or `all`. Enable `include_global` to include notes stored under the global key. |
| `mem_bootstrap` | | Returns a Markdown summary of active memories and project notes. Accepts `token_budget`, `include_notes`, and `cwd`. |
| `mem_search` | | Searches memories, notes, and indexed transcript messages. Accepts `query`, `cwd`, `sources`, `scope`, `orchestrators`, `since`, and `limit`. |
| `mem_expand` | | Reads an indexed transcript by `session_id` and optional `file_id`. Accepts inclusive `start_seq` and `end_seq`, inclusive `line_start` and `line_end`, and `max_chars`. |

Memory, note, search, and expansion results contain JSON in the MCP text
response. Validation and tool errors use MCP text responses with the error flag
set. Bootstrap returns the summary as plain text.

## Bootstrap

`src/bootstrap.mjs` produces a `<project-memory>` section for active project and
global memories. It considers memories by descending importance, descending
update time, and ascending ID, then groups the selected items by category.
It adds an `<active-notes>` section for active and pending project notes when
enabled. Active notes appear first, with newer notes first within each status
and ties broken by ID. Each note can show its surface condition.

The default budget is 2,500 estimated tokens and can be overridden in
configuration or per call. The estimate uses one token per four characters,
rounded up. Formatting includes whole items, tags, headings, and omission
counts in the budget. The minimum budget includes each required section's tags
and uses whichever takes fewer characters between its full contents and its
omission line.
`mem_bootstrap` returns the minimum token budget in its error when the supplied
budget is too small. When notes are enabled and present, the minimum includes
their section and the newline between sections. Set `include_notes: false` for
a memory-only summary.

## Search

`mem_search` defaults to `current_project`, which includes active project and
global memories, active and pending project notes, and indexed messages for the
project. Use `all_projects` to search across projects. Select any combination of
`memory`, `note`, and `transcript` with `sources`. The `orchestrators` filter
accepts `omp`, `claude`, `codex`, and `agy`. Use `since` with an ISO 8601
date or timestamp to include records from that instant onward. Date-only values
start at midnight UTC. Memories and notes use their update time. Transcript
messages use their own timestamp when valid and the file's last index time
otherwise. Transcript indexing accepts ISO timestamps and epoch
milliseconds from transcripts and stores valid values as UTC ISO 8601.

FTS5 treats user input as quoted search terms and ranks candidates with BM25.
When the local engine can embed the query, search also ranks eligible memory and
transcript vectors by cosine similarity. The two lists use the same filters.
Reciprocal rank fusion sums `1 / (60 + rank)` for each list a result appears in,
using ranks that start at one. The response reports `hybrid` or `fts-only`.
Search defaults to 10 results and clamps the requested limit to 1–50. Each
result has a preview of at most 400 characters. Transcript hits include
`session_id`, `file_id`, and `seq`. Pass the file ID with the session ID and
use `seq` for both range endpoints to expand that exact hit.

## Session expansion

`mem_expand` accepts an optional `file_id` to disambiguate sessions that span
multiple indexed files. The file must belong to the supplied session ID.
Without a file ID, the tool selects the latest indexed file and breaks index
time ties by higher file ID. The response includes the selected `file_id`.
Sequence and line ranges are inclusive and intersect when both are supplied.
Disk reads use indexed sequence numbers when available. Without indexed
messages, sequence numbers count
non-empty lines from zero. Line numbers always start at one. Results contain
original JSONL message text, roles, timestamps when present, and tool names
when available. Malformed JSONL lines are returned as raw text.

The tool uses the absolute path stored in the index and opens it read-only. It
rejects paths with traversal segments, non-regular files, and paths that pass
through a symbolic link or Windows junction. The tool returns matching indexed
messages with `source: "db-fallback"` if the file is missing, its opened
device and inode differ from the stored file identity, it is shorter than the
indexed byte offset, its first line declares a different session ID (including
session headers for OMP and Codex and conversation IDs for Antigravity), or
its earliest indexed message differs in role, text, or ordered tool names.
The tool-name check follows the transcript adapter's indexing rules. Disk
results can also include sibling tool calls from the original JSONL record.
The session check trims declared IDs and ignores blank values. For Antigravity,
if the first line declares an earlier ID than the indexed session ID, the tool
can still read from disk when the committed prefix matches the stored checkpoint
hash and the other file and message checks pass. Older rows without a stored
identity still use the session and message checks.
Matching files report `source: "disk"` and can include newly appended lines.
The text budget defaults to 16,000 characters and applies
across all returned message text. A partial final message ends in an ellipsis.
The response reports `truncated` and `total_chars`.

## Design rules and why

- Use `src/memory-service.mjs` for database operations shared with future local
  integrations. The stdio layer handles MCP schemas and response formatting.
- Memory, note, bootstrap, and search calls share a process-local cache of up to 64
  workspace identities. Entries expire after five seconds so repeated calls can
  skip Git subprocesses while still picking up changes to the workspace.
- Deduplicate memory writes by project key, scope, and normalized content hash.
  Active duplicates retain their stored text. Archived and superseded duplicates
  reactivate under the same ID. When both metadata values are plain objects,
  duplicate writes merge them shallowly.
- Keep FTS5 triggers in sync with explicit updates and conflict-aware inserts.
  Commit text first. When text changes, remove its previous vector in the same
  transaction. Schedule best-effort embedding after commit and return the MCP
  result without waiting for model loading or inference. Store a new embedding
  only if inference succeeds and the stored text still matches. See [storage and embeddings](Storage-and-Embeddings.md).
- Reserve stdout for MCP protocol messages. Send process diagnostics to stderr.
- Keep host startup hooks read-only and fail-open. The MCP server requires no
  host message mutations or pre-request gates.
