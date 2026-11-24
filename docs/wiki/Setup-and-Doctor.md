# Setup and doctor

Run `npx -y multi-sub-memory setup` to choose a database path, select MCP hosts, and configure Dreamer. Setup initializes the SQLite schema and checks WAL and FTS5. With the optional Transformers.js dependency installed, setup tries an ONNX embedding and reports its dimensions. The first run may download the model. Choose FTS-only mode to skip inference and model downloads.

For scripted setup, pass `--yes` and the choices you want to apply. For example, `npx -y multi-sub-memory setup --yes --host none --no-embeddings --dreamer-mode disabled` initializes storage without registering any hosts. Use `--db` and `--config` to specify paths. By default, setup saves settings in `~/.config/multi-sub-memory/config.jsonc` with owner-only permissions on POSIX. Setup saves choices from flags or prompts, with defaults taken from existing user settings and built-in values. Project settings and environment overrides apply to effective configuration. When using a custom settings path with `serve`, set `MULTI_SUB_MEMORY_CONFIG` in that process's environment.

## MCP registration

Setup detects hosts through their settings, transcript directories, and executables on `PATH`. Select `omp`, `claude`, `codex`, or `agy` by name. `--host all` selects every supported host, and `--host none` prints manual snippets for all hosts. Without an explicit selection, `--yes` registers detected hosts. Each snippet configures a stdio server that runs `npx -y multi-sub-memory`.

| Host | MCP settings | Transcript directory |
|---|---|---|
| OMP | `~/.omp/agent/mcp.json` | `~/.omp/agent/sessions` |
| Claude Code | `~/.claude.json` | `~/.claude/projects` |
| Codex | `~/.codex/config.toml` | `~/.codex/sessions` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | `~/.gemini/antigravity/brain` |

Setup merges the server's command and arguments into the selected host files and saves a `.bak` copy before replacing an existing file. The backup contains the original host settings and may include credentials. For JSON hosts, the edit preserves unrelated settings, formatting, and large integer values byte-for-byte. For Codex, the automatic edit targets the server's TOML table. An existing remote MCP registration requires a manual edit. If setup reports that it cannot safely edit the file, use the printed snippet as a guide to edit the existing registration. Commands accept `--home` and `--omp-config`, `--claude-config`, `--codex-config`, and `--agy-config` to select alternative paths.

## Dreamer settings

Dreamer defaults to disabled. HTTP mode records an OpenAI-compatible base URL, a model, and optionally the name of the environment variable that supplies the bearer token. Changing the base URL clears the previous key binding unless you explicitly select a key variable. CLI mode records an OMP, Claude Code, or Codex preset, with optional command and model overrides. Setup checks for the chosen executable without starting it. Dreamer cadence defaults to manual. Automatic cadence uses a minimum interval and a minimum count of new or updated memories. See [Dreamer usage and behavior](Dreamer.md).

## Diagnostics

Run `npx -y multi-sub-memory doctor` to check Node.js, SQLite with FTS5, layered settings, database integrity and journal mode, table counts, embedding availability, and host registrations and transcript directories. Use `--cwd` to choose the workspace for project settings, or `--db` to inspect a specific database. Doctor always inspects a temporary snapshot of the database and any WAL file, keeping SQLite sidecar writes out of the source directory. Doctor retries if the database or WAL changes during the copy, with a limit of four attempts. If writes persist through all four attempts, doctor warns and omits the database checks and counts. Doctor returns 0 when all checks pass or warn, and 1 when any check fails. `--json` emits the same results as structured output.

The embedding check passes in FTS-only mode when embeddings are disabled. When embeddings are enabled, doctor probes ONNX inference using only local model files and the existing cache. It reports `expectedDims` when the model's dimensions are known and `observedDims` after successful inference. If the optional dependency is missing or local inference fails, doctor warns and reports FTS-only mode. Setup can download and verify an uncached model.

Add `--test-dreamer` to probe an enabled backend. HTTP mode sends a GET request to `/models` under the configured base URL. Doctor sends a bearer token only when both the effective base URL and API key variable name match the user settings. A project URL override stops inheritance of the user key name, and doctor warns when it probes a pair outside the user settings. CLI mode checks executable availability without launching the orchestrator. Run either command with `--help` for its full flag list.

## Design rules and why

- Setup resolves path aliases before opening SQLite. The database, settings lock, their SQLite sidecar paths, settings, host registrations, and host backups must have distinct destinations. The check ignores case on macOS and Windows. On macOS it compares Unicode names after case conversion and canonical decomposition, so variants such as Greek final sigma and ordinary sigma compare equal.
- Setup uses an exclusive SQLite transaction on the persistent `.lock` file next to the settings. It holds the lock while comparing the original settings text and replacing the file. The operating system releases the lock if setup exits or is killed. The lock file stays in place so every setup process uses the same file. If another writer still holds the lock after a short wait or the settings changed during setup, run setup again.
