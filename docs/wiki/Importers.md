# Legacy importers

Use `multi-sub-memory import` to copy memories and handoff notes into the
database selected by the standard configuration. `--cwd` selects the workspace
for project configuration. Source and report paths can be absolute or relative
to the command's working directory, and a leading `~` expands to your home
directory.

| Source | Default location | Imported records |
|---|---|---|
| `magic-context` | `~/.local/share/cortexkit/magic-context/context.db` | Active memories and active or pending notes. Memory metadata retains the legacy ID, verification data, original category, and original importance. |
| `mnemopi` | `~/.omp/agent/memories/mnemopi/` | Active records from `mnemopi.db` and `banks/*/mnemopi.db`, in `memories` and `facts` tables. Metadata records the bank, legacy ID, and any Magic Context ID. |
| `notes` | `C:/Dev/AgentWork/notes/` on Windows, plus `~/AgentWork/notes/` on all platforms | Unchecked `- [ ]` and `* [ ]` checklist items from Markdown files, including nested directories. |

`--include-archived` includes archived memories with their original status.
Override source locations with `--magic-context-db`, `--mnemopi-dir`, or
`--notes-dir`. For Markdown, `MULTI_SUB_MEMORY_NOTES_DIR` supplies the directory
when `--notes-dir` is absent. With neither override, the importer scans every
existing default directory in the listed order. It deduplicates directories
and files by resolved path, ignoring case on Windows. Files are sorted within
each directory tree, and the first directory's copy of a duplicate note wins.
Markdown discovery skips symlinks within scanned directories. Bank discovery
also skips symlinks.

## Project mapping

Pass `--project-map <path>` with a JSON object whose keys are legacy project
IDs, workspace paths, Magic Context session IDs, bank names, or Markdown
filenames. Values can be a Git workspace path, a normalized repository key
such as `github.com/example/example-app`, a `local:<hash>` key, or `global`.

```json
{
  "git:legacy-key": "/workspace/example-app",
  "legacy-session-id": "/workspace/example-app",
  "example-bank": "github.com/example/example-app",
  "shared-notes.md": "global"
}
```

An explicit mapping takes precedence over Magic Context's `session_projects`
lookup. That lookup can recover the working directory from stored paths or
from local OMP, Claude Code, and Codex JSONL session headers. Magic Context
records with a blank project first check the project map for the trimmed session
ID, then fall back to the session lookup. If a project-scoped memory or note
still lacks a repository identity, the importer skips it and reports the
available identifiers. Map the legacy project or session ID with
`--project-map` and rerun the import to bring in skipped records.
Records explicitly scoped to `global` stay global. Workspace paths are
resolved through the shared project identity code, so linked Git worktrees use
the same key.

For Markdown, use flat YAML frontmatter with `project_key`, `project_path`,
`project`, or `cwd` to identify the workspace. An optional `surface_condition`
applies to each imported item in the file. Without a workspace field, the
importer looks for the filename stem or basename in the project map. Unassigned
Markdown notes and unassigned memories from the root mnemopi bank use `global`.
For mnemopi, the first nonblank project field supplies the project identifier.
For named banks, you can map the bank name when every project field is blank or missing.

## Design rules and why

- SQLite sources are copied into a private temporary directory before opening
  them read-only. The copy includes any regular WAL file so committed records
  still in WAL are visible. SQLite can create sidecars in the temporary
  directory. The importer removes that directory after closing the snapshot
  and verifies the original database's SHA-256 digest before and after reading.
- Live imports commit all selected sources in one transaction. Missing sources
  are recorded as absent. An unreadable SQLite database or a failed source
  verification ends the command and rolls back record inserts.
- The writable target database and its sidecars must be distinct from, and
  neither above nor below, protected source paths. Every import protects
  both default and configured paths for the Magic Context database, the
  mnemopi root database, all discovered mnemopi bank databases, and their
  `-wal`, `-shm`, and `-journal` sidecars. The Magic Context and root mnemopi
  paths stay protected even if the files are absent. These protections
  apply regardless of `--from` and also apply to dry-run report output.
- A memory is a duplicate if its project key, scope, and normalized content
  hash match or if its Magic Context ID is already known. Notes match on the
  project key, normalized content, and normalized surface condition. For an ID
  or content match within the same project key and scope, a live import keeps
  existing non-null fields and fills missing provenance, including the source
  session ID. Either source can run first. An ID match across project keys or
  scopes skips the duplicate and leaves the existing row untouched. The importer
  keeps the primary Magic Context ID and records additional IDs in
  `magic_context_ids` for later deduplication. Original Magic Context
  values are stored in `magic_context_category` and `magic_context_importance`.
  `all` processes Magic Context, mnemopi, and Markdown in that order.
- Dry runs use the same deduplication rules and count proposed inserts. If the
  target exists, the importer reads a temporary snapshot to seed deduplication.
  If the target is missing, deduplication starts with empty state.

## CLI usage

```sh
npx multi-sub-memory import --from all --dry-run --report ./reports/import.json
npx multi-sub-memory import --from all --project-map ./project-map.json --json
npx multi-sub-memory import --from magic-context --include-archived
```

`--report` writes the same summary as `--json` to a file atomically, creating
parent directories as needed. The report path must be distinct from, and
neither above nor below, the target database, protected source files, and
database sidecars. Protected source files include session headers used for
project mapping. The summary includes per-source and total counts for inserts,
duplicates, and unresolved records. It also includes structured details for
unresolved records and before and after digests for each SQLite source.
The text CLI prints unresolved-record warnings to stderr. The configured target
database uses a filesystem path.

## Cross-Orchestrator Target-Machine Verification Checklist

- [ ] Create a disposable Git repository with a commit and add a linked worktree.
  Use those paths as worktrees A and B. Configure OMP, Claude Code, Codex, and
  Antigravity to launch the same local revision of `multi-sub-memory serve`
  with the same absolute `MULTI_SUB_MEMORY_DB` pointing to a new test database.
  Use a separate test config and transcript roots for the four hosts.
  [Setup and doctor](Setup-and-Doctor.md) · [Indexers](Indexers.md)
- [ ] Run the installed host clients and make the following writes and recalls
  through their MCP tools. Use unique synthetic text for each write, set
  `source_orchestrator` to the writer's ID, and leave memory scope at
  `project`. In each receiving host, call `mem_memory` with `action: "list"`
  and `scope: "project"`. Confirm the exact ID, text, source orchestrator, and
  shared `project_key` from the preceding write.

  | Host and worktree | Recall | Write |
  |---|---|---|
  | Codex (`codex`), A | | A project memory and a note with a surface condition |
  | Antigravity (`agy`), B | Codex memory and note | An Antigravity project memory |
  | OMP (`omp`), A | Antigravity memory | An OMP project memory |
  | Claude Code (`claude`), B | OMP memory | A Claude Code project memory |
  | Codex (`codex`), A | Claude Code memory | |

  Use `mem_note` with `action: "read"` to check the note ID and surface
  condition in Antigravity. Confirm that `mem_bootstrap` includes the memory
  and note. [MCP core](MCP-Core.md)
- [ ] Produce a unique synthetic transcript message in each host. Run
  `multi-sub-memory index --orchestrator all --json` against the same test
  database and transcript roots. Check for errors, then use `mem_search` from
  the other worktree with `sources: ["transcript"]` and the originating host ID
  in `orchestrators`. Run `mem_expand` with the hit's `session_id`, `file_id`,
  and `seq` as both sequence bounds. Confirm the exact message text and a
  `disk` source for each host. [Indexers](Indexers.md)
- [ ] With all test servers and indexers stopped, hash the test database
  with SHA-256. Start fresh OMP and Claude Code sessions using the optional
  hooks in the test config, with automatic indexing disabled. Confirm startup
  includes the expected project context, OMP leaves the existing conversation
  messages intact, and the database digest and sidecar state stay unchanged.
  [Startup hooks](Startup-Hooks.md)
- [ ] Save the host versions, tested revision, project key, exact MCP recall
  and expansion results, and before and after digests with the verification
  evidence. Use synthetic data and remove the disposable workspace and test
  configuration afterward.
