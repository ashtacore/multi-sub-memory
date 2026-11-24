# multi-sub-memory

Cross-orchestrator local Memory MCP server (OMP, Claude Code, Codex, Antigravity) backed by Node's built-in `node:sqlite` (WAL + FTS5), local ONNX embeddings with FTS-only fallback, incremental transcript indexing, optional background Dreamer consolidation, optional read-only fail-open startup hooks, and a zero-build local web dashboard.

## Requirements

- Node.js `>=22.16.0` (24/26+ recommended) with built-in `node:sqlite` and FTS5 support
- Pure ESM (`.mjs`), zero build step, `npx`-installable

## Repository map

- [`AGENTS.md`](AGENTS.md) — workflow, authority, and documentation conventions
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — current state, next actions, and blockers
- [`docs/wiki/Home.md`](docs/wiki/Home.md) — durable architecture and area documentation
- [`docs/wiki/Decisions.md`](docs/wiki/Decisions.md) — accepted Architecture Decision Records (ADRs)
- [`LICENSE`](LICENSE) — MIT License

## Quick start

*(Package scaffolding and CLI entrypoints are implemented in [Issue #1](https://github.com/ashtacore/multi-sub-memory/issues/1) through [Issue #4](https://github.com/ashtacore/multi-sub-memory/issues/4).)*
