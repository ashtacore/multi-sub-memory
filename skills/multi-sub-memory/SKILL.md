---
name: multi-sub-memory
description: Retrieve project context, record durable project facts, and maintain cross-session handoffs.
license: MIT
---

# Memory guide

- Call `mem_bootstrap` at the start of a session when you need project context. Pass the workspace `cwd` when the task is in a different Git repository. Project identity follows the repository across clones and worktrees. Use global scope for facts that apply across repositories.
- Use `mem_search` for a focused follow-up. Select the sources you need and start in the current project. Use the transcript hit's IDs and sequence with `mem_expand` for surrounding context.
- Give each durable memory exactly one category. Use `ARCHITECTURE` for system structure, `CONFIG_VALUES` for relevant settings, `CONSTRAINTS` for limits, `PROJECT_RULES` for standing conventions, `DECISIONS` for accepted choices, `WORKFLOW` for repeatable procedures, and `GENERAL` for other durable facts.
- Add up to five optional tags for topics that recur within the scope. Reuse existing lowercase kebab-case tags where possible. In permissive mode new tags enter that repository's dictionary. In strict mode use the tags listed in the validation error. The global dictionary is separate. Use `tag` to filter memory lists or searches, and send `tags: []` to clear a memory's tags.
- Use `mem_note` for time-sensitive handoffs. Keep one topic per note and append progress with `comment`. Read the chain with `get` and follow `next_cursor` for older comments. Supply a short reason when changing status or dismissing a note.
