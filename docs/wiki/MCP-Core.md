# MCP core

Run `multi-sub-memory` or `multi-sub-memory serve` as a stdio MCP server. Set
`--cwd <path>` to choose the server's default workspace. Clients can override
it with `cwd` when a tool needs a project key. Linked Git worktrees share a
project key and use their own workspace names in bootstrap output.

The server loads configuration and opens the shared SQLite database at startup.
It closes the MCP transport and its own database connection when stdin ends or
closes, the transport closes, or it receives SIGINT or SIGTERM. It leaves a
caller-supplied database connection open.

## Tools

| Tool | Action | Behavior |
|---|---|---|
| `mem_memory` | `write` | Stores content under the current project or the shared global key. Defaults to category `GENERAL` and importance 3. Returns the memory and flags for deduplication and reactivation. |
| `mem_memory` | `get`, `update`, `archive` | Looks up a memory by ID. Updates can change content, category, importance, scope, status, or metadata. Archiving with `superseded_by` marks the memory as superseded. |
| `mem_memory` | `list` | Lists active memories from the current project and global scope by default. Accepts scope, status, category, and limit filters. The default limit is 50 and the maximum is 200. |
| `mem_note` | `write`, `update`, `dismiss` | Creates a current-project note, changes it by ID, or marks it dismissed. New notes are active by default and can be pending. A note can record a `surface_condition`. |
| `mem_note` | `read` | Lists active and pending notes for the current project by default. Accepts a status filter or `all`. Enable `include_global` to include notes stored under the global key. |
| `mem_bootstrap` | | Returns a Markdown summary of active memories and project notes. Accepts `token_budget`, `include_notes`, and `cwd`. |

Memory and note results contain JSON in the MCP text response. Action validation
and errors also use MCP text responses, with the error flag set. Bootstrap
returns the summary as plain text.

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
counts in the budget. If the budget cannot fit the required section wrappers
and omission lines, `mem_bootstrap` returns an error with the minimum token
budget. When notes are enabled and present, the minimum includes their section
and the newline between sections. Set `include_notes: false` for a memory-only
summary.

## Design rules and why

- Use `src/memory-service.mjs` for database operations shared with future local
  integrations. The stdio layer handles MCP schemas and response formatting.
- Memory, note, and bootstrap calls share a process-local cache of up to 64
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
