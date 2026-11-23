Last updated: 2026-11-23 19:23 UTC

## Current state

- [Issue #3](https://github.com/ashtacore/multi-sub-memory/issues/3) (universal stdio MCP server, shared memory/note service, `mem_memory`, `mem_note`, and `mem_bootstrap` tools, CLI `serve --cwd` wiring, and integration tests) is implemented, verified (`npm test`: 64 passed, 4 skipped, 0 failed; `npm pack --dry-run`: 11 files), independently reviewed (**PASS**), and committed locally on `feat/3-mcp-core`.
- [MCP core](wiki/MCP-Core.md) documents the stdio lifecycle, tools, non-blocking embeddings, UUIDv7 IDs, bounded project-key caching, and token-budgeted bootstrap formatting.
- Built on top of the [Issue #2](https://github.com/ashtacore/multi-sub-memory/issues/2) storage and embedding layer (`b2b0463`).

## Next actions

1. Continue Phase 1 with [Issue #4](https://github.com/ashtacore/multi-sub-memory/issues/4) (`mem_search` hybrid FTS5 + vector search).
2. Fan out Phase 2/3/4/5 ready lanes once Phase 1 dependencies are met (`#5` + `#7`, then `#6` + `#8` + `#9`, then `#10` + `#11`).
3. Present local PR-ready summaries and request explicit approval before pushing, creating PRs, or mutating GitHub Project #5 statuses.

## Blockers

- None currently. Live ONNX model download/inference remains unverified in offline unit tests (optional dependency omitted during `npm ci --omit=optional`; embedding tests use a local fixture engine).
