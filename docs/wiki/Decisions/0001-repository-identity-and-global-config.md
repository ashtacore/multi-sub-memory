# 0001 — Repository identity and global configuration

- **Status:** Accepted
- **Decision date:** 2026-11-25

## Context

Directory-based identity assigns different keys to separate clones of the same
repository. Workspace configuration also creates a second trust boundary for
Dreamer commands and credentials.

## Decision

Derive project identity from the normalized Git remote, using the host and
repository path. Prefer `upstream` and fall back to `origin`. A fork can
explicitly select its origin. Repositories without a usable remote use a hash
of their Git common directory. Project memories and notes require Git.

Use one user-owned YAML file with repository-keyed overrides. Drop the former
configuration files and path-based project keys without migrating either.

## Consequences

Clones and linked worktrees share project memory and settings. Forks can keep
a separate identity, and new local repositories work offline. A repository
that gains a remote starts using the new remote key. Dreamer runner settings
come from the same user-owned file for every repository.

[Issue #29](https://github.com/ashtacore/multi-sub-memory/issues/29)
