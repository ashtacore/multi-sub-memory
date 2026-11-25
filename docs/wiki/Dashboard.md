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
- **Memories** supports project, scope, category, and status filters with
  hybrid or full-text search. Cards show provenance and metadata. Edit,
  archive, restore, and permanently delete memories, with confirmation
  before deletion. The editor shows Superseded as the current status of
  superseded memories, which can be edited, archived, or restored.
- **Notes** shows active, pending, and dismissed notes. Edit the text or
  surface condition, dismiss or restore a note, and confirm permanent deletions.
  Use **Load more** to append older notes for the selected project and status.
- Memory and note edits save only the changed fields. Saving an unchanged
  edit closes the dialog. Edits and quick status actions check the displayed
  record's revision and refresh the view when the server reports a conflict.
- **Dreamer** shows active leases, a configuration summary, and recent run
  history across projects. Select the launch workspace to start a run or
  request a dry run. Launch the dashboard with `--cwd` to run Dreamer for
  another workspace. The dashboard reloads the launch workspace's effective
  settings and user authorization when displaying Dreamer status and before
  executing a run. If the runner configuration changes between those requests,
  the run is rejected and the dashboard refreshes the panel.
  Both run modes use the restricted CLI presets and an empty temporary working
  directory for CLI runners. A dry run can send data to the authorized runner
  and records the proposal without changing memories.
  [Dreamer configuration and trust](Dreamer.md)

## HTTP API

All API responses use JSON. List limits default to 100 and are capped at 200.
Omit `project_key` or use `all` for all projects, including global entries.
Use `global` for global rows alone.

| Method and path | Parameters and effects |
|---|---|
| `GET /api/overview` | Project and global counts, totals, default project key, embedding status, and database health |
| `GET /api/memories` | `project_key`, `scope` (project, global, or all), `category`, `status` (active by default, archived, superseded, or all), `q`, `limit`. Filters constrain search before ranking. |
| `PATCH /api/memories/:id` | Any of `content`, `category`, `importance` (1–5), or `status` (active or archived), plus optional `expected_updated_at`. Omit `status` to keep a memory's existing status. An explicit superseded status returns 400. Returns 409 if edited content duplicates another memory in the same project and scope. |
| `DELETE /api/memories/:id` | Permanently removes the memory and its search data |
| `GET /api/notes` | `project_key`, `status` (active, pending, dismissed, or all by default), `limit`, and optional `cursor` |
| `PATCH /api/notes/:id` | Any of `content`, `status`, or `surface_condition` (string or null), plus optional `expected_updated_at` |
| `DELETE /api/notes/:id` | Permanently removes the note and its search data |
| `GET /api/dreamer` | Active leases, fresh sanitized configuration with `config_fingerprint` and runner authorization, `runnable_project_key` for the launch workspace, and up to 50 recent runs. `project_key` filters history across projects. |
| `POST /api/dreamer/run` | Requires the launch workspace's `project_key`. Accepts optional boolean `dry_run` and string `expected_config_fingerprint`. A fingerprint mismatch returns 409 before contacting the runner. Returns the run result or a skip reason. |

Record PATCH routes use the supplied fields to update the stored row. Send
`expected_updated_at` as the string form of the record's `updated_at` value.
An invalid revision field returns 400. A stale revision returns 409 and leaves
the row untouched.

Notes sort by `updated_at` descending and then `id` descending. The response
contains `notes` and `next_cursor`. Pass the cursor back with the same filters
to continue from the last note on the current page. A null cursor marks the
last page. Malformed cursors return 400.

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
