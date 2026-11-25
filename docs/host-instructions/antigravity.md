# Antigravity memory instructions

Copy the following instructions into your Antigravity global rules, for example `~/.gemini/GEMINI.md`, once the multi-sub-memory MCP server is registered.

- Call `mem_bootstrap` once at session start with the active workspace as `cwd`.
- Before asking the user about a prior decision or past session, call `mem_search`. Use `mem_expand` on a relevant result when you need verbatim session history.
- Use `mem_memory` with `action: write` to record durable architectural facts, rules, constraints, and decisions.
- Use `mem_note` with `action: write` for active or pending handoff reminders.
