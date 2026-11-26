# Dashboard

The dashboard is a zero-build local browser interface for the shared memory
database. Start it with the project directory as the current working directory
or pass `--cwd` explicitly.

```sh
npx multi-sub-memory ui [--port <number>] [--open] [--cwd <path>] [--help]
```

The server listens on `127.0.0.1:3847` by default and prints its URL. Use
`--port 0` for an ephemeral port and `--open` to launch that URL in the
default browser. Stop the server with Ctrl+C.

## Views

- The project selector and overview show memory and note status counts,
  indexed transcript files and messages, SQLite schema health, and embedding
  status. Opening the dashboard leaves optional model initialization until
  a search or edit needs embeddings.
- Remote projects use the repository name as their label. Name collisions add
  the owner and, when needed, the host. Local Git projects use the directory
  name and add parent segments for collisions. Expand a memory's provenance to
  see its project path when available, its project key, and source metadata.
- **Memories** supports project, scope, category, and status filters with
  hybrid or full-text search. Sort the list by importance, creation time,
  or update time in either direction. Search results use relevance and
  clearing the query restores the previous list sort. Use **Project / Scope**
  in the editor to move a memory to another project, promote it to Global,
  or move it from Global into a project. Registered projects remain
  available even when empty. Edit, archive, restore, and permanently
  delete memories, with confirmation before deletion. The editor shows
  Superseded as the current status of superseded memories, which can be
  edited, archived, or restored.
- **Notes** shows active, pending, and dismissed topics. Edit the text or
  surface condition independently, or provide a transition comment when
  activating, dismissing, restoring, or changing the status in the editor.
  Expand **Comments** to read the latest entries, load older comments, or add,
  edit, and delete progress comments. Status-change comments show a read-only
  transition badge. The note delete confirmation shows how many comments the
  deletion removes. If the note revision changes before deletion, the dashboard
  refreshes the list so you can check the current count and confirm again.
  Sort by creation or update time and use **Load more** to
  continue through the topic list.
- Memory and note edits save only the changed fields. Saving an unchanged
  edit closes the dialog. Edits and quick status actions check the displayed
  record's revision and refresh the view when the server reports a conflict.
- Memory provenance and note metadata show the last access time and access
  count as read-only fields. An em dash indicates that no access timestamp
  has been recorded. [MCP access tracking](MCP-Core.md#access-tracking)
- **Dreamer** shows active leases, a configuration summary, and recent run
  history across projects. Sort using the **Started**, **Finished**, or
  **Run time** column headers and filter from the **Status** header.
  Narrow displays offer the same controls above the run history.
  Select the launch workspace to start a run or
  request a dry run. Launch the dashboard with `--cwd` to run Dreamer for
  another workspace. The dashboard reloads the global YAML file when displaying
  Dreamer status and before executing a run. If the runner configuration changes
  between requests, the run is rejected and the dashboard refreshes the panel.
  A Git workspace is required to run Dreamer. Restart the dashboard after a
  change to the launch workspace's repository identity.
  Both run modes use the restricted CLI presets and an empty temporary working
  directory for CLI runners. A dry run can send data to the authorized runner
  and records the proposal without changing memories or comments. The result
  for a proposed comment compaction shows the source IDs and summary.
  [Dreamer configuration and trust](Dreamer.md)

## HTTP API

All API responses use JSON. List limits default to 100 and are capped at 200.
Omit `project_key` or use `all` for all projects, including global entries.
Use `global` for global rows alone.

| Method and path | Parameters and effects |
|---|---|
| `GET /api/overview` | Project and global counts, totals, default project key, embedding status, and database health |
| `GET /api/memories` | `project_key`, `scope` (project, global, or all), `category`, `status` (active by default, archived, superseded, or all), `q`, `limit`, `sort` (`importance`, `created_at`, or `updated_at`), and `order` (`asc` or `desc`). Filters constrain search before relevance ranking. Rows include `project_name` and a nullable `project_root`. |
| `PATCH /api/memories/:id` | Any of `content`, `category`, `importance` (1–5), `status` (active or archived), `scope` (project or global), or `project_key` (a known project key or `global`), plus optional `expected_updated_at`. Omit `status` to keep the existing status. An explicit superseded status or unknown destination returns 400. A duplicate in the destination project and scope returns 409. |
| `DELETE /api/memories/:id` | Permanently removes the memory and its search data |
| `GET /api/notes` | `project_key`, `status` (active, pending, dismissed, or all by default), `limit`, `sort` (`updated_at` or `created_at`), `order` (`asc` or `desc`), and optional `cursor` |
| `PATCH /api/notes/:id` | Updates `content`, `status`, or `surface_condition` (string or null). A status change requires a nonblank `comment`. Accepts optional `expected_updated_at`. |
| `DELETE /api/notes/:id` | Permanently removes the topic, its comments, and its search data. Accepts an optional topic `expected_updated_at` query parameter. |
| `GET /api/notes/:id/comments` | Returns `comments` and `next_cursor`. Accepts `limit` and `cursor`. Orders by descending creation time and ID. |
| `POST /api/notes/:id/comments` | Appends a progress comment with nonblank `body` and optional topic `expected_updated_at`. Returns `note` and `comment`. |
| `PATCH /api/notes/:id/comments/:commentId` | Updates a progress comment's `body` with optional comment `expected_updated_at`. Editing a transition comment returns 400. |
| `DELETE /api/notes/:id/comments/:commentId` | Removes a progress comment and advances the topic revision. Accepts an optional comment `expected_updated_at` query parameter. Deleting a transition comment returns 400. |
| `GET /api/dreamer` | Active leases, fresh sanitized configuration with `config_fingerprint` and runner authorization, `runnable_project_key` for the launch workspace, and up to 50 runs. History supports `project_key`, `status`, `sort` (`started_at`, `finished_at`, or `duration`), and `order` (`asc` or `desc`). |
| `POST /api/dreamer/run` | Requires the launch workspace's `project_key`. Accepts optional boolean `dry_run` and string `expected_config_fingerprint`. A fingerprint mismatch returns 409 before contacting the runner. Returns the run result or a skip reason. |

Record PATCH routes use the supplied fields to update the stored row.
A project memory keeps its existing assignment when a PATCH specifies
project scope and omits `project_key`. When a PATCH changes a global memory to
project scope and omits `project_key`, the dashboard uses its launch repository. Outside a Git
workspace the request needs an explicit project destination. Send
`expected_updated_at` as the string form of the record's `updated_at` value.
An invalid revision field returns 400. A stale revision returns 409 and leaves
the row untouched.

Notes default to `updated_at` descending. Ties sort by `id` in the selected
direction. The response contains `notes` and `next_cursor`. Each topic
includes `comment_count` and a nullable `latest_comment_preview`. Pass the cursor
back with the same filters and sort to continue from the last note on the
current page. A null cursor marks the last page. Malformed cursors return 400.

## Design rules and why

- The listener uses IPv4 loopback only. Every request must carry a Host
  matching `127.0.0.1`, `localhost`, or `[::1]` with the active port.
  On port 80, Host and HTTP Origin may omit the port.
  API requests and mutating methods also validate any supplied Origin and
  Sec-Fetch-Site headers. Origin must match an allowed HTTP origin and
  Sec-Fetch-Site must be `same-origin` or `none`.
- The server puts a random per-launch token in the HTML. Mutating requests
  require the same token in the `X-MSM-Token` header. JSON bodies are limited
  to 256 KiB. HTML and API responses use `Cache-Control: no-store`.
- Static files resolve inside the dashboard's public directory. The page's
  strict Content Security Policy permits same-origin scripts and styles,
  blocks framing and inline executable code, and restricts resource loading.
  Dynamic card content is rendered through DOM text and form values.
- The Dreamer configuration response displays the endpoint host and whether
  the configured environment key is set. Credentials, runner arguments,
  and full endpoint URLs stay on the server. The fingerprint is an opaque
  digest scoped to the dashboard launch. Dreamer redacts credentials before
  recording summaries or errors, and applies redaction again to dashboard
  history. This covers configured secrets, URL userinfo, and every URL
  query parameter value, including credentials that have since rotated.
