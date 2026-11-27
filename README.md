# multi-sub-memory

Cross-orchestrator local Memory MCP server (OMP, Claude Code, Codex, Antigravity) backed by Node's built-in `node:sqlite` (WAL + FTS5), local ONNX embeddings with FTS-only fallback, incremental transcript indexing, optional background Dreamer consolidation, optional read-only fail-open startup hooks, and a zero-build local web dashboard.

The five Phase 1 MCP Core tools are `mem_memory`, `mem_note`, `mem_bootstrap`,
`mem_search`, and `mem_expand`.

## Requirements

- Node.js `^22.16.0 || >=24.0.0` (24/26+ recommended) with built-in `node:sqlite` and FTS5 support
- Git for project-scoped memories and notes
- Pure ESM (`.mjs`), zero build step, `npx`-installable

## Repository map

- [`AGENTS.md`](AGENTS.md) — workflow, authority, and documentation conventions
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — current state, next actions, and blockers
- [`docs/wiki/Home.md`](docs/wiki/Home.md) — durable architecture and area documentation
- [`docs/wiki/Decisions.md`](docs/wiki/Decisions.md) — accepted Architecture Decision Records (ADRs)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution guidelines, PR scope rules, and local testing
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting policy
- [`LICENSE`](LICENSE) — MIT License

## Quick start

Run `npx -y multi-sub-memory setup` to initialize storage and register your MCP
host, then run `npx -y multi-sub-memory doctor` to check the configuration.
Settings live in `~/.config/multi-sub-memory/config.yaml`. Project memories and
notes use the Git repository's identity, so clones and worktrees can share them.
See [Setup and doctor](docs/wiki/Setup-and-Doctor.md) for scripted setup and
diagnostics, and the [MCP core guide](docs/wiki/MCP-Core.md) for tool actions and
workspace selection.

Run `npx -y multi-sub-memory ui --open` to browse and edit local memories and
notes and inspect Dreamer activity. See the [dashboard guide](docs/wiki/Dashboard.md).
