# Setup and doctor

Run `npx -y multi-sub-memory setup` to choose a database path, select MCP hosts, and configure Dreamer. Setup initializes the SQLite schema and checks WAL and FTS5. With the optional Transformers.js dependency installed, setup tries an ONNX embedding and reports its dimensions. The first run may download the model. Choose FTS-only mode to skip inference and model downloads.

For scripted setup, pass `--yes` and the choices you want to apply. For example, `npx -y multi-sub-memory setup --yes --host none --no-embeddings --dreamer-mode disabled` initializes storage without registering any hosts. Use `--db` and `--config` to specify paths. By default, setup saves settings in `~/.config/multi-sub-memory/config.yaml` with owner-only permissions on POSIX. Setup saves choices from flags or prompts, with defaults taken from existing user settings and built-in values. Entries under `projects` and environment overrides apply to effective configuration. When using a custom settings path with `serve`, set `MULTI_SUB_MEMORY_CONFIG` in that process's environment.

## Repository settings

The user-owned YAML file contains global defaults and optional entries keyed by
normalized repository identity. Settings are applied in order from built-in
defaults to global YAML, the matching project entry, and supported environment
overrides. Nested settings such as Dreamer cadence and indexer directories merge
field by field. Outside a Git workspace, commands use the global settings.

```yaml
bootstrap:
  tokenBudget: 2500
projects:
  github.com/example/upstream:
    bootstrap:
      tokenBudget: 1800
  github.com/example/fork:
    forkMode: origin
    dreamer:
      enabled: false
```

A checkout with both remotes uses the upstream key by default. Set
`forkMode: origin` on the origin repository's entry to select that key and its
settings only for checkouts with that origin. Use the `local:<hash>` key for a
repository without a usable remote. See [project identity](MCP-Core.md#project-identity).

## Tag settings

`strictTags` defaults to `false`. Set it at the top level to establish the
default strictness for all scopes, and override it under a repository key
as needed. Both scopes also accept `tags.strict`. When a scope sets both keys,
`strictTags` takes precedence within that scope. Top-level definitions seed the
global dictionary. Repository definitions seed only that repository. A
successful tag write for a scope adds its missing definitions, keeping
descriptions already stored there.
A definition still present in the YAML remains configured even if Dreamer
merges the stored tag. Remove retired names from YAML to keep them retired
in strict mode.

```yaml
strictTags: true
tags:
  definitions:
    tooling: Tools shared across repositories
projects:
  github.com/example/repo:
    strictTags: false
    tags:
      definitions:
        release: Release workflow and decisions
```

## MCP registration

Setup detects hosts through their settings, transcript directories, and executables on `PATH`. Select `omp`, `claude`, `codex`, or `agy` by name. `--host all` selects every supported host, and `--host none` prints manual snippets for all hosts. Without an explicit selection, `--yes` registers detected hosts. Each snippet configures a stdio server that runs `npx -y multi-sub-memory`.

| Host | MCP settings | Transcript directory |
|---|---|---|
| OMP | `~/.omp/agent/mcp.json` | `~/.omp/agent/sessions` |
| Claude Code | `~/.claude.json` | `~/.claude/projects` |
| Codex | `~/.codex/config.toml` | `~/.codex/sessions` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | `~/.gemini/antigravity/brain` |

Setup merges the server's command and arguments into the selected host files and saves a `.bak` copy before replacing an existing file. The backup contains the original host settings and may include credentials. For JSON hosts, the edit preserves unrelated settings, formatting, and large integer values byte-for-byte. For Codex, the automatic edit targets the server's TOML table. An existing remote MCP registration requires a manual edit. If setup reports that it cannot safely edit the file, use the printed snippet as a guide to edit the existing registration. Commands accept `--home` and `--omp-config`, `--claude-config`, `--codex-config`, and `--agy-config` to select alternative paths.

## Local skills

Pass `--skills` during setup to install the bundled memory guide for
the selected MCP hosts. Use `--install-skills <omp|claude|codex|agy|all>`
or `--uninstall-skills <omp|claude|codex|agy|all>` to manage just the guide.
Both explicit flags accept repeated hosts or a comma-separated list. Skill-only
commands can run without prompts and leave settings and storage untouched.
Setup checks the marker and content digest before updating or removing a
skill. User-edited and unmanaged files are preserved.

| Host | Skill directory |
|---|---|
| OMP | `~/.omp/agent/skills/multi-sub-memory/` |
| Claude Code | `~/.claude/skills/multi-sub-memory/` |
| Codex | `~/.agents/skills/multi-sub-memory/` |
| Antigravity App and IDE | `~/.gemini/config/skills/multi-sub-memory/` |

## Startup hooks

Full setup checks both the database it initializes and the effective filesystem database, including their WAL, SHM, and rollback journal sidecars, for collisions with settings, host configs, hooks, and backups. Hook-only removal checks configured and default database destinations even when those files are absent. Setup resolves file-backed SQLite URIs to filesystem paths and stops before writing files if it cannot resolve the URI. MCP registration and Claude Code hook edits refuse to replace an existing SQLite database or a non-regular file at a backup destination.

Pass `--hooks <omp|claude|all>` to install startup hooks during setup. Use `--uninstall-hooks <omp|claude|all>` to remove managed hooks. Removal by itself skips prompts and keeps application storage untouched. Both flags accept repeated hosts or a comma-separated list. Use `--omp-extensions-dir` and `--claude-settings` to override the hook paths. See [Startup hooks](Startup-Hooks.md) for host behavior and the Codex and Antigravity instruction templates.

## Dreamer settings

Dreamer defaults to disabled. HTTP mode records an OpenAI-compatible base URL, a model, and optionally the name of the environment variable that supplies the bearer token. Changing the base URL clears the previous key binding unless you explicitly select a key variable. CLI mode records an OMP, Claude Code, or Codex preset, with optional command and model overrides. Setup checks for the chosen executable without starting it. Dreamer cadence defaults to manual. Automatic cadence uses a minimum interval and a minimum count of new or updated memories. See [Dreamer usage and behavior](Dreamer.md).

## Diagnostics

Run `npx -y multi-sub-memory doctor` to check Node.js, SQLite with FTS5, layered settings, database integrity and journal mode, table counts, embedding availability, and host registrations and transcript directories. Use `--cwd` to choose the workspace for project settings, or `--db` to inspect a specific database. Doctor always inspects a temporary snapshot of the database and any WAL file, keeping SQLite sidecar writes out of the source directory. Doctor retries if the database or WAL changes during the copy, with a limit of four attempts. If writes persist through all four attempts, doctor warns and omits the database checks and counts. Doctor returns 0 when all checks pass or warn, and 1 when any check fails. `--json` emits the same results as structured output.

The embedding check passes in FTS-only mode when embeddings are disabled. When embeddings are enabled, doctor probes ONNX inference using only local model files and the existing cache. It reports `expectedDims` when the model's dimensions are known and `observedDims` after successful inference. If the optional dependency is missing or local inference fails, doctor warns and reports FTS-only mode. Setup can download and verify an uncached model.

Add `--test-dreamer` to probe an enabled backend. HTTP mode sends a GET request to `/models` under the configured base URL. Doctor uses the effective endpoint and sends a bearer token when the effective settings name an environment variable with a value. A repository endpoint override drops the inherited key binding unless its YAML entry explicitly sets one. CLI mode checks executable availability without launching the orchestrator. Run either command with `--help` for its full flag list.

## Design rules and why

- Setup resolves path aliases before opening SQLite. The database, settings lock, their SQLite sidecar paths, settings, host registrations, and host backups must have distinct destinations. The check ignores case on macOS and Windows. On macOS it compares Unicode names after case conversion and canonical decomposition, so variants such as Greek final sigma and ordinary sigma compare equal.
- Setup uses an exclusive SQLite transaction on the persistent `.lock` file next to the settings. It holds the lock while comparing the original settings text and replacing the file. The operating system releases the lock if setup exits or is killed. The lock file stays in place so every setup process uses the same file. If another writer still holds the lock after a short wait or the settings changed during setup, run setup again.
