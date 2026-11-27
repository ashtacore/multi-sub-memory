# Workflow

Project knowledge is split by what it describes and how long it stays true:

| Where | What | Lifetime |
|---|---|---|
| [`README.md`](README.md) | Project summary, repository map, and quick start | Durable; edited in place |
| [`docs/wiki/`](docs/wiki/Home.md) | How `multi-sub-memory` works today, and why; one page per area | Durable; edited in place |
| [`docs/wiki/Decisions/`](docs/wiki/Decisions.md) | Accepted architectural and project-wide design decisions | Permanent; superseded, not rewritten |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Current state, next actions, and blockers | Short-lived; overwritten, not appended |
| GitHub Issues, Milestones, and Projects | Work scope, acceptance, dependencies, and status | Work tracking; link to durable guidance |

There is no session log. Use Git and PR descriptions for change history; keep run-specific evidence with the issue, PR, or approved evidence artifact.

## Session start

1. Read `README.md` and `docs/HANDOFF.md`, then start at `docs/wiki/Home.md`. Read the relevant area pages and linked ADRs.
2. Load `web-development` and `web-testing` before dashboard UI work (`src/ui/`), `project-planning` for planning, and `ticket-batch` for grouped ticket refinement or implementation lanes. Verify the installed Node runtime (`>=24.0.0`, `node:sqlite` + FTS5) rather than assuming environment versions.
3. For ticket work, read the full issue, comments, dependencies, and linked decisions. For PR work, also read the complete discussion and review threads. Resolve factual questions from source and evidence; ask the project owner about consequential design choices that remain open.

## GitHub workflow

- Use the [repository](https://github.com/ashtacore/multi-sub-memory) for Issues, PRs, and Milestones and the linked [Project board](https://github.com/users/ashtacore/projects/5) for status. A milestone or phase label groups a coherent slice; an issue defines one coherent outcome. Use native issue dependencies and link to the wiki or ADR rather than copying policy into tickets.
- **Planning:** Capture the goal and unknowns. **Ready for Development:** A mid-level engineer can start from the issue: it has context and entry points, scope and non-goals, dependencies met, observable acceptance, and no blocking product decisions. Specify outcomes and contracts without dictating incidental implementation. **In Development:** Work has started. **In Review:** Implementation and verification evidence are ready to inspect. **Done:** Acceptance passed, required review is complete, and any required integration is complete. Done is not release authorization.
- Record work-specific findings in the affected issue or PR. If a finding calls for future work, propose a linked Planning issue. If it changes durable guidance, update the owning wiki page or record an accepted ADR. Do not mirror the backlog or live board state in the wiki.
- Get explicit, operation-specific approval for pushes, creating or posting PRs, tracker mutations (including status, dependencies, and comments), remote merges, npm publishes, deployments, or external notifications. A linked repo, available credentials, or this document grants no standing authority.

## During work

- **Zero-bricking invariant:** Never mutate host conversation `messages[]`, never register `context` or `before_provider_request` gates, and keep all optional host startup hooks strictly read-only and fail-open. Never log to `stdout` in stdio MCP mode (`serve`).
- **Open-source readiness (MIT):** Keep all committed source, docs, fixtures, and examples sanitized and MIT-compatible. Never commit real transcripts, personal database files, local paths containing private user data, API keys, or credentials.
- Keep agent assignments coherent. Obtain one independent review of each integrated implementation or policy-change batch after relevant checks. Re-review new semantic risk, not every file or wording correction. Headless API checks do not establish rendered dashboard visuals or interactions; run browser QA (`web-tester`) for UI claims.
- Code and observed behavior describe what exists; accepted decisions describe intent. If they differ, document the gap and resolve it deliberately. Do not silently reinterpret a decision as implemented or use current code to overwrite accepted intent.
- Update the affected wiki pages alongside behavior changes. Put small area rules in **Design rules and why**. Add a page only when a topic needs its own explanation and link it from `Home.md` or the parent page. Put durable operational procedures in a relevant area page or a linked operations page.
- For a significant accepted decision, use the template in `docs/wiki/Decisions.md` and the next number after the highest ADR: `docs/wiki/Decisions/NNNN-kebab-title.md`. Add its index row. Never rewrite an accepted ADR's context, decision, or consequences; a replacement can update the old ADR's **Status** to link its successor.
- Mark proposals **Provisional** and undecided choices **Open**. Preserve project-owner authority; do not silently expand scope or alter external contracts.
- Use local, isolated test resources (temporary SQLite databases, ephemeral ports, fixture session files). Prove ownership and isolation before resetting anything; never modify or stop user-owned databases, orchestrator configs, or services to make a check pass.

## Session end

- Overwrite `docs/HANDOFF.md` at the end of each project work session. Keep it under 60 lines: `Last updated: YYYY-MM-DD HH:MM UTC`, current state, up to three next actions, and blockers. Link relevant tickets or evidence rather than copying logs. Do not append a journal.
- Update `README.md` only when the quick start, repository map, or project summary changes. Keep detailed guidance in the wiki.
- Write useful commit messages and PR descriptions when those operations are authorized.

## Writing and merge rules

- Use ordinary GitHub-flavored Markdown: relative `.md` links for repository pages, fenced `mermaid` blocks when useful, and link indexes rather than ADO `.order` metadata. Use hyphenated page filenames. Keep pages focused; split long topics into linked subpages.
- Write plain prose about current behavior and decisions. No session narration, run timestamps, test counts, or acceptance logs in wiki pages. ADR decision dates are metadata.
- **Handoff conflict:** keep the newer current state and reconcile still-relevant next actions and blockers. **ADR number collision:** renumber the incoming ADR and update its index and links; never renumber an accepted ADR already on the target branch. **Wiki conflict:** reconcile both sides by topic against current behavior and accepted intent.
