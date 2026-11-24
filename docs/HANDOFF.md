Last updated: 2026-11-24 09:52 UTC

## Current state

- [PR #15](https://github.com/ashtacore/multi-sub-memory/pull/15) implements the search and expansion tools for [Issue #4](https://github.com/ashtacore/multi-sub-memory/issues/4) on `feat/4-search-expand` (stacked on `feat/3-mcp-core`).
- Addressed all peer-review findings with regression tests: OMP session header rotation checks, serialized JSON-length `max_chars` budgets including metadata/tool names, and skipping query embedding / reporting `fts-only` when no usable stored vectors match active filters. Updated the [MCP core guide](wiki/MCP-Core.md). Verified with `node --test --test-concurrency=4 "test/**/*.test.mjs"` (99 passed, 7 skipped, 0 failed).

## Next actions

1. Complete owner review and merge approval for Phase 1 PRs (`#2`, `#3`, `#4` / PR #15).
2. Start the ready Phase 2 through Phase 5 lanes once Phase 1 is integrated.

## Blockers

- Live ONNX download and inference remain outside offline fixture coverage. On Windows, file symlink coverage requires Developer Mode or elevation. Junction coverage is separate.
