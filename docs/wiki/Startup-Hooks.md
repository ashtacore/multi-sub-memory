# Startup hooks

OMP and Claude Code can load the shared bootstrap summary automatically. Hooks are opt-in and use the same layered configuration and token budget as `mem_bootstrap`. See [MCP core](MCP-Core.md) for the summary format and tools.

| Host | Startup integration | Default installation |
|---|---|---|
| OMP | The `before_agent_start` listener appends the bootstrap block to the supplied system prompt. An array prompt receives the block as a separate segment. | `index.js` and `package.json` under `~/.omp/agent/extensions/multi-sub-memory/` |
| Claude Code | A `SessionStart` command reads the event JSON from stdin, uses its workspace, and sends a non-empty bootstrap block to stdout as session context. It exits successfully on failure. | `~/.claude/settings.json` |
| Codex | Register the MCP server and copy the [Codex memory instructions](../host-instructions/codex.md) into the global instructions. | `~/.codex/AGENTS.md` |
| Antigravity | Register the MCP server and copy the [Antigravity memory instructions](../host-instructions/antigravity.md) into the global rules. | `~/.gemini/GEMINI.md` |

## Installation and removal

Install with `setup --hooks omp`, `setup --hooks claude`, or `setup --hooks all`. Hook installation is part of full setup. For a scripted install with MCP registration left to the caller, use `multi-sub-memory setup --yes --host none --no-embeddings --hooks all`. Select multiple hosts with a comma-separated list or repeated flags.

OMP discovers `index.js` as the extension entry point. Its `package.json` declares ESM with `"type": "module"` and marks the manifest as managed. The loader imports the packaged extension on first use. Claude runs `node --input-type=module -e` with a marked inline command that imports the packaged script by file URL and invokes its CLI entry point. If the import fails, the command exits successfully without output. Both loaders reference the package installation that ran setup. Rerun setup after moving that installation or clearing the package cache it used.

Remove hooks with `multi-sub-memory setup --uninstall-hooks omp`, `--uninstall-hooks claude`, or `--uninstall-hooks all`. A removal-only invocation skips prompts, database initialization, and application settings changes. Use `--omp-extensions-dir` or `--claude-settings` to point at an alternate hook location for either operation. OMP removes its marked loader and manifest and removes the directory if it is empty. Claude setup identifies managed commands by the `/* multi-sub-memory:claude-session-start */` marker. It preserves surrounding settings and other hooks and saves the previous file as `.bak` on each edit.

## Design rules and why

- Setup resolves existing paths and parent directories before comparing destinations. This catches paths that refer to the same database, settings, hook, or backup through a symlink or junction.
- Hooks use the same `formatBootstrap` formatter as MCP. Startup defaults to a 500 ms deadline, including stdin and stdout for Claude Code. The Git probe and SQLite lock wait use the remaining time. The Claude command runs bootstrap in a child process so it can exit if native I/O stalls.
- Hooks resolve plain database paths and file-backed SQLite URIs with supported `mode`, `cache`, and `psow` values. Repeated parameters and unsupported options leave startup context unchanged.
- Hooks check the database header before opening SQLite and use private snapshots for both rollback and WAL databases. Read-only lock probes bracket the copy, and the formatter opens only the snapshot. A failed probe, a change to the source files during copying, or an observed rollback journal causes the hook to skip the snapshot. The snapshot directory is created only when a copy is needed, and the Claude process registers exit cleanup before starting the worker process.
- Missing storage, invalid configuration, expired reads, SQLite errors, and empty results leave startup context unchanged. OMP retains each session's first result, including an empty result, across session switches in the same extension instance.
- Use only the OMP `before_agent_start` listener and Claude Code `SessionStart` for this integration. The hooks leave conversation messages and the provider request lifecycle untouched.
