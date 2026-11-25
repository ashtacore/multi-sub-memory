# Dreamer

Dreamer consolidates durable project memories and eligible note comment
chains through a configured language model.
It starts disabled. Run it on demand after choosing a backend, or enable automatic
cadence in the same settings. [Setup and doctor](Setup-and-Doctor.md)

```sh
npx multi-sub-memory dream [--project <cwd>] [--dry-run] [--json]
```

The current directory selects the project by default. Use `--project` or its
`--cwd` alias to select another workspace. A dry run requests and validates a
plan, records the proposal's summary and counts, and leaves memories,
embeddings, and note comments untouched. Plain dry-run output lists each
proposed operation with its IDs and supplied fields, including selected
comment IDs and the proposed compaction summary. With `--json`, a successful or dry run
includes the proposed operations and their counts. The addition count excludes
deduplicated inserts in either mode.

## Runners and plan

HTTP mode posts the prompt to `/chat/completions` under the configured base URL.
The user-owned YAML file authorizes the effective endpoint and optional
bearer-token environment variable. Repository settings can supply either.
Changing a repository's endpoint drops the inherited key binding unless its
entry explicitly sets one.
The runner rejects redirects and retries transient network failures and HTTP
429 or 5xx responses up to twice. Each request has a 60-second timeout.

CLI mode closes stdin and starts the runner in a fresh, empty temporary
directory that Dreamer removes after the child closes. The presets use
`omp -p --no-session --no-tools`,
`claude -p --tools "" --strict-mcp-config`, and
`codex exec --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules -c mcp_servers={} -c features.shell_tool=false`.
The Codex restrictions keep session files ephemeral, exclude user config and
execution rules, and clear configured MCP servers. Codex still uses
`CODEX_HOME` for authentication.
Dreamer applies the preset restrictions to saved arguments, including legacy
presets. It replaces conflicting Codex arguments, including profile, remote
server, and workspace overrides, so the local isolation settings apply.
The effective YAML settings authorize CLI mode, orchestrator, command, and
argument list. A model override adds `--model`
before the prompt argument. Specify an absolute executable path or a bare
command available in an absolute directory on `PATH`. Windows requires a
native `.exe` or `.com`. Dreamer bounds stdout, discards stderr, and terminates
the child at the two-minute timeout. CLI failures report the runner, failure
stage, and exit code or signal when available. Dreamer records and returns
the same sanitized diagnostic.

The prompt includes up to 200 active project memories, starting with unreviewed
memories and then the least recently reviewed. Ties favor higher importance,
newer updates, then ascending IDs. A completed live run records coverage for
the memories it reviewed that are still active. Coverage leaves activity
timestamps unchanged. Dreamer captures the project's highest indexed message
ID before planning. It considers up to 40 messages between the last completed
run's cursor and this snapshot, newest indexed first, capped at 12,000
characters of transcript text. A completed live run advances the cursor to the
highest message ID included in the prompt. The cursor stays at its previous
value when no excerpt fits. Messages indexed during planning are eligible for
the next run regardless of their original timestamps. The Windows CLI runner
budgets 24,000 UTF-16 code units for the executable, arguments, and worst-case
quoting. On POSIX, the prompt
argument is limited to 96 KiB in UTF-8. Dreamer fits whole memories in priority
order, skipping oversized entries and continuing through later candidates up
to the review cap. It then fits recent transcript excerpts in the remaining
space. It uses remaining prompt space for eligible project note topics and
their progress comments. Each eligible topic has at least five standalone
progress comments. The plan can reference the memories, topics, and comments
included in the prompt.
The response must be a strict JSON object with a summary and an operations
array. Optional Markdown fences around the JSON are accepted.

| Operation | Effect |
|---|---|
| `merge` | Consolidates at least two distinct memories into one active row and marks the other sources as superseded. A matching normalized hash identifies an existing target to reuse or reactivate. |
| `archive` | Marks a memory archived and records the supplied reason. |
| `update` | Changes content, category, importance, or a combination of those fields. A hash collision with another memory fails the run. |
| `add` | Requires transcript evidence in the prompt and inserts a durable project memory if the normalized content does not already exist in the project scope. |
| `compact_note_comments` | Replaces selected progress comments with a concise summary. The result has at most three progress comments including the summary, and can consist of one summary. Transition comments are preserved. |

## Design rules and why

- Dreamer redacts configured secrets, URL userinfo, and every URL query
  parameter value from run summaries and errors before storing them.

- A per-project SQLite lease covers planning and application. Dreamer checks
  lease ownership and verifies that referenced memories still match the
  reviewed rows before applying the plan.
- Each memory ID can appear only once across the plan and must belong to the
  active project memories sent to the runner. A merge also checks whether a
  deduplicated target conflicts with another operation.
- Note compaction checks the reviewed topic revision and the progress comment
  IDs and revisions in the write transaction. A changed topic or chain fails
  the plan so a later run can review the current discussion. The summary
  comment records its run ID and source comment IDs in `compacted_from_json`
  and advances the topic's update time.
- Dreamer adds provenance to existing metadata on updates, archives, and
  reused merge targets. It keeps arrays, scalar values, and explicit JSON `null`
  under `user_metadata`. Absent metadata receives only provenance.
- A merge sums the sources' access counts and keeps their latest access
  timestamp, or a null timestamp if none was recorded. The transaction reads
  current access metadata and includes a reused target exactly once. Accesses
  during planning keep the plan valid and contribute to the merge.
- The changes and completed run record commit in one SQLite transaction.
  Changed text invalidates its old vector in the transaction. Dreamer writes
  replacement vectors after commit when embeddings are available. A planning
  or transaction error records a failed run and releases the lease.
- Automatic cadence measures the minimum interval from the previous completed
  run's finish time. It counts active project memories created or updated
  since that run started and excludes mutations made by that run. Defaults
  are 24 hours and 10 memories. The checks run opportunistically after an MCP
  project memory write or after the indexer releases its lease for projects
  with newly indexed messages. The check uses the target workspace's Dreamer settings.
  Automatic checks use explicit workspace roots recovered from transcript
  records, including roots saved during earlier indexing passes. An OMP append
  can restore a missing root from a verified session header that matches the
  indexed project key. A quiet detached child starts in the target workspace,
  reloads the repository's YAML settings, opens the SQLite file used by the
  triggering operation, and checks cadence again with the Dreamer lease held. Manual runs can be requested at any time.
