# MCP core

Run `multi-sub-memory` or `multi-sub-memory serve` as a stdio MCP server. Set
`--cwd <path>` to choose the server's default workspace. Clients can override
it with `cwd` when a tool needs a project key. Project memory and note writes
require a Git workspace. Outside Git, the server can still write and list
global memories, read global notes with `include_global`, and search.

## Project identity

The server prefers the `upstream` remote and falls back to `origin`. It uses the
fetch URL after Git applies any `insteadOf` rules. A remote key uses a lowercase
host name and retains any non-default port, as in
`git.example.test:8443/team/Repo`. Repository path casing is preserved except
on `github.com`, `gitlab.com`, `bitbucket.org`, and `dev.azure.com`, where it
is folded to lowercase. SSH and HTTPS remotes with the same normalized host and path
share a key, as do separate clones and linked worktrees of that repository.
Bootstrap uses the current workspace's name in its output.

For a repository without a usable remote, the key is `local:` followed by the
first 16 hexadecimal characters of the SHA-256 hash of its normalized Git
common directory. Linked worktrees share that directory. Adding a usable
remote selects the remote key for subsequent operations. Configure a diverged
fork under its `origin` key in the global YAML file.
[Repository settings](Setup-and-Doctor.md#repository-settings)

The server loads the global YAML file and opens the effective SQLite database
for the launch workspace at startup. Tool calls that specify another workspace
still use that database. It closes the MCP transport and its own database connection when stdin ends or
closes, the transport closes, or it receives SIGINT or SIGTERM. It leaves a
caller-supplied database connection open.

Enable automatic transcript refresh with `indexers.backgroundRefresh`. See
[Indexers](Indexers.md) for session discovery, CLI indexing, and configuration.

With automatic Dreamer cadence enabled, a project memory write schedules a
background eligibility check. The tool returns independently of the Dreamer
process. [Dreamer](Dreamer.md)

## Tools

| Tool | Action | Behavior |
|---|---|---|
| `mem_memory` | `write` | Stores content under the current project or the shared global key. Defaults to category `GENERAL` and importance 3. Returns the memory and flags for deduplication and reactivation. |
| `mem_memory` | `get`, `update`, `archive` | Looks up a memory by ID. Updates can change content, category, importance, scope, status, metadata, or tags. To mark a memory as superseded, use `archive` with `superseded_by` set to the ID of a different, existing memory. |
| `mem_memory` | `list` | Lists active memories from the current project and global scope by default. Accepts scope, status, category, tag, and limit filters. The default limit is 50 and the maximum is 200. |
| `mem_note` | `write` | Creates a current-project topic with `content` and an optional `surface_condition`. Topics start active by default and can start pending. |
| `mem_note` | `read` | Lists active and pending topics for the current project by default. Accepts a status filter or `all` and can include global topics with `include_global`. |
| `mem_note` | `get` | Returns `note`, `comments`, and `next_cursor` for a topic ID. The comment limit defaults to 50 and is capped at 200. |
| `mem_note` | `update`, `dismiss` | Edits a topic or sets its status to dismissed by ID. A status transition requires a nonblank `comment`. |
| `mem_note` | `comment` | Appends a nonblank progress `comment` by topic ID. Returns `note` and `comment`. |
| `mem_bootstrap` | | Returns a Markdown summary of active memories and project notes. Accepts `token_budget`, `include_notes`, and `cwd`. |
| `mem_search` | | Searches memories, notes, and indexed transcript messages. Accepts `query`, `cwd`, `sources`, `scope`, `orchestrators`, `since`, `tag`, and `limit`. |
| `mem_expand` | | Reads an indexed transcript by `session_id` and optional `file_id`. Accepts inclusive `start_seq` and `end_seq`, inclusive `line_start` and `line_end`, and `max_chars`. |

Memory, note, search, and expansion results contain JSON in the MCP text
response. Validation and tool errors use MCP text responses with the error flag
set. Bootstrap returns the summary as plain text.

## Memory tags

Each memory has one category and a sorted array of up to five optional tags.
Writes and updates trim tags, lowercase them, and replace runs of whitespace
and underscores with a hyphen before deduplication. A tag uses up to 48
characters in nonempty groups of ASCII lowercase letters and digits,
separated by single hyphens. Send `tags` to replace the current assignment or `tags: []` to
clear it. Omitting tags preserves existing assignments on updates and
deduplicated writes.

Each repository has its own dictionary. Global memories use the global
dictionary. Permissive settings allow new tags and accept an optional
`tag_descriptions` map for those new entries. Strict settings reject unknown
tags and report the available names. Moves validate or create the submitted
tags in the destination dictionary. Omitting tags during a move carries the
existing assignments into that destination.
[Tag settings](Setup-and-Doctor.md#tag-settings)

## Memory guide

On MCP protocol revision `2026-07-28` and later supported revisions, the stdio
server advertises the [MCP Skills extension](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills)
(`io.modelcontextprotocol/skills`). Use `skills/list` to discover
`multi-sub-memory` and `skills/get` to retrieve its manifest. Read the guide
itself with `resources/read` at `skill://multi-sub-memory/SKILL.md`.

Clients on `2025-11-25` or other supported legacy revisions can call all five
core tools and discover the same guide in `resources/list` at
`skill://multi-sub-memory/memory-guide`. This URI remains readable with
`resources/read` on both protocol generations. Use [setup](Setup-and-Doctor.md#local-skills)
to install a local copy for supported hosts.

## Note topics and comments

Topic text and the surface condition are editable independently. A status
change between active, pending, and dismissed saves the reason and the
transition together. A transition comment is read-only. MCP agents can append
progress comments. Appending a progress comment advances the topic revision.

For a topic edit, transition, or comment append, send `expected_updated_at`
as the string form of the topic's `updated_at` to check its revision.
Requests for the current status report whether the supplied content, surface
condition, and reason match the current topic and its latest transition. This
check takes precedence over a stale revision.

A detail page orders comments by descending creation time and ID. Pass its
`next_cursor` as `cursor` with the same topic ID to continue. A null cursor
marks the final page. Search matches topic fields.

## Access tracking

New MCP memories and notes start with their creation time as
`last_accessed_at` and an `access_count` of zero. A successful MCP call
increments the count once per distinct existing memory or note it returns.
This includes deduplicated writes, reactivations, updates, archives,
dismissals, and comment appends that return their topic. Search counts the final
ranked hits. Bootstrap counts the items that fit the budget and appear in the
summary. Each access advances the timestamp to the later of its current
value and the access time. Startup hooks and dashboard views leave access
metadata untouched.

Access metadata is read-only in write and update inputs. Recording an access
preserves `updated_at`, so it leaves edit revisions and update-time sorting
intact.

## Bootstrap

`src/bootstrap.mjs` produces a `<project-memory>` section for active project and
global memories. It considers memories by descending importance, descending
update time, and ascending ID, then groups the selected items by category.
It adds an `<active-notes>` section for active and pending project notes when
enabled. Active notes appear first, with newer notes first within each status
and ties broken by ID. Each note can show its surface condition. Topic text
and the surface condition take priority. When space remains, a topic can show
a short preview of its latest comment.

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

The `tag` filter limits results to memories with that exact normalized tag
within the selected search scope. Memory hits include their sorted tags.

FTS5 treats user input as quoted search terms and ranks candidates with BM25.
Search attempts query embedding only when the engine can attempt inference and a
selected source has a stored vector that matches the active filters and any known
embedding model and vector width.
With a query embedding, search ranks compatible memory and transcript vectors by
cosine similarity. The two lists use the same search filters.
Reciprocal rank fusion sums `1 / (60 + rank)` for each list a result appears in,
using ranks that start at one. The response reports `hybrid` when at least one
usable vector candidate contributes to fusion and `fts-only` otherwise.
Search defaults to 10 results and clamps the requested limit to 1â€“50. Each
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
its earliest or requested indexed messages differ in role, text, or ordered
tool names. The session check trims declared IDs and ignores blank values. For
Antigravity, if the first line declares an earlier ID than the indexed session
ID, the tool can still read from disk when the committed prefix matches the
stored checkpoint hash and the other file and message checks pass. Older rows
without a stored identity still use the session and message checks.
Matching files report `source: "disk"` and can include newly appended lines.
The `max_chars` budget defaults to 16,000 and applies to the sum of the JSON
lengths of individual message records, including metadata, tool names, and
escaped text. `total_chars` reports that sum. When the next record exceeds the
remaining budget, `truncated` is true. A partial final record is included if
its metadata and an ellipsis fit.

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
- Select and count memory get and list results and note read results in one
  write transaction. Record access for mutations that return an existing
  record in the same transaction as the edit. If a row selected by search or
  bootstrap disappears before counting, roll back all access updates for that
  call and return a retryable tool error.
- Keep host startup hooks read-only and fail-open. The MCP server requires no
  host message mutations or pre-request gates.
