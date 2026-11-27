# Contributing to `multi-sub-memory`

All contributions are welcome — bug reports, bug fixes, documentation improvements, tests, and feature proposals.

## Contribution Rules

1. **Every PR requires a linked issue.**
   - Link the issue in your PR description (for example, `Closes #123` or `Refs #123`).
   - For **feature additions or any major change**, please open an issue and discuss the design with the maintainer first so we align on scope before writing code.
2. **Keep PRs small and focused.**
   - Each pull request should address one coherent outcome.
   - If an issue can be split into multiple smaller, independently reviewable PRs, please split it. Smaller PRs make human review faster and far more likely to happen.
3. **AI-assisted contributions are welcome — with human ownership.**
   - Issues and PRs created with AI assistance must include a short **human-written description** (even a single sentence explaining the intent in your own words).
   - You are expected to **review your own changes** before opening a PR and be able to explain what the code does and how you verified it.
4. **License & right to contribute (MIT).**
   - By submitting a contribution to this repository, you agree that your contribution is licensed under the [MIT License](LICENSE).
   - You also represent that you created the contribution yourself (or have the legal right to submit it under the MIT License) and that it does not contain proprietary, confidential, or third-party code with incompatible license terms.

## Core Technical Invariants

Before changing code, please keep these project invariants in mind (see [`docs/wiki/Home.md`](docs/wiki/Home.md) for architecture details):

- **Zero-bricking host invariant:** Never mutate host conversation `messages[]`, never register `context` or `before_provider_request` gates, and keep optional startup hooks strictly read-only and fail-open.
- **Clean stdio MCP transport:** Never write logs or stray text to `stdout` in `serve` mode — `stdout` is strictly reserved for JSON-RPC frames.
- **Local-only & sanitized:** Never commit real transcripts, personal SQLite databases, private local paths, API keys, or credentials. Keep tests isolated to temporary directories and ephemeral ports.

## Local Development & Verification

Requirements: Node.js `^22.16.0 || >=24.0.0` (with built-in `node:sqlite` + FTS5) and Git.

```bash
npm ci
npm run check
npm test
```

- Run `npm run check` (syntax & package entrypoint checks) and `npm test` before opening a PR.
- Update the relevant documentation under [`docs/wiki/`](docs/wiki/Home.md) or [`README.md`](README.md) whenever behavior or configuration changes.
- For dashboard UI changes (`src/ui/`), verify the rendered UI in a real browser against an isolated temporary database.

## Code of Conduct & Security

- Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
- To report a security vulnerability privately, please see [SECURITY.md](SECURITY.md).
