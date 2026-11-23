# Transcript formats

The indexers read UTF-8 JSON Lines (`.jsonl`) files under the configured session
roots. Each complete line contains one JSON record. The examples below are
synthetic. See [Indexers](wiki/Indexers.md) for configuration and checkpoints.

## OMP

OMP stores JSONL transcripts under `~/.omp/agent/sessions`. The `session`
header supplies `id` and `cwd`. Without an ID, the filename stem identifies
the session. The `message` object supplies the role, content, and preferred
timestamp. Content can be a string or a list of blocks. A `toolCall` block
contributes its name.

```jsonl
{"type":"session","id":"omp-example","cwd":"/workspace/example-app"}
{"type":"message","message":{"role":"user","timestamp":1735689600000,"content":"Draw a sample map."}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Adding a marker."},{"type":"toolCall","name":"example_draw"}]}}
```

## Claude Code

Claude Code stores JSONL transcripts in project directories under
`~/.claude/projects`. Records can supply `sessionId` and `cwd`. If needed,
the adapter uses the filename stem for the session ID and tries to decode
the project directory for a working directory. Path encoding can lose
information. The adapter reads `user` and `assistant` records and uses the
record type as the role when `message.role` is missing or malformed.
The `message` object supplies content and the preferred timestamp.
`tool_use` supplies tool names. Text in `tool_result` blocks remains
searchable through full-text search.

```jsonl
{"type":"user","sessionId":"claude-example","cwd":"/workspace/example-app","timestamp":"2025-01-01T00:00:00Z","message":{"role":"user","content":"Draw a sample map."}}
{"type":"assistant","sessionId":"claude-example","message":{"role":"assistant","content":[{"type":"text","text":"Adding a marker."},{"type":"tool_use","name":"example_draw"}]}}
```

## Codex

The default root is `~/.codex/sessions`. A typical path looks like
`2025/01/01/rollout-2025-01-01T00-00-00-00000000-0000-4000-8000-000000000001.jsonl`.
A `session_meta` record supplies `payload.session_id` or `payload.id` and can
supply `payload.cwd`. A `turn_context` record can update the working
directory. Without header metadata, the adapter tries the rollout filename's
trailing UUID, then the filename stem.

`response_item` records supply `payload.type`. The adapter indexes user and
assistant `message` content, including `input_text` and `output_text`
blocks. It treats `agent_message` as assistant text and prefers
`payload.text` when present. `function_call`, `custom_tool_call`, and
`web_search_call` contribute assistant rows with tool names and empty text.
The adapter prefers a valid `payload.timestamp` and falls back to
`timestamp` on the enclosing record.

```jsonl
{"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000001","cwd":"/workspace/example-app"}}
{"type":"turn_context","payload":{"cwd":"/workspace/example-app"}}
{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Draw a sample map."}]}}
{"type":"response_item","payload":{"type":"custom_tool_call","name":"example_draw","input":"marker"}}
{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"Marker drawn."}}
```

## Antigravity

The default root is `~/.gemini/antigravity-cli/brain`. A conversation's
canonical transcript is `<conversation-id>/.system_generated/logs/transcript.jsonl`.
Discovery skips `transcript_full.jsonl` and files under a `chunks` directory
to avoid duplicate messages. Flat JSONL fixtures are also supported.

Records can supply `sessionId`, `session_id`, `conversationId`, or
`conversation_id`. The conversation directory supplies a fallback ID for
files under `.system_generated/logs`; other files fall back to their stem.
The adapter reads workspace metadata from `cwd`, `workspace`, or
`workspace_root`.

`USER_INPUT` maps to a user message and `PLANNER_RESPONSE` maps to an
assistant message. `GENERIC` maps to a user message for `USER_EXPLICIT` and
an assistant message for `MODEL`. The adapter combines names from content
blocks and `tool_calls` without duplicates. It prefers a valid `created_at`
and falls back to `timestamp`.

```jsonl
{"type":"USER_INPUT","conversation_id":"00000000-0000-4000-8000-000000000002","workspace_root":"/workspace/example-app","created_at":"2025-01-01T02:00:00+02:00","content":"Draw a sample map."}
{"type":"PLANNER_RESPONSE","content":"Adding a marker.","tool_calls":[{"name":"example_draw","args":{"shape":"circle"}}]}
{"type":"GENERIC","source":"MODEL","content":"The marker is ready."}
```

## Indexing and disk expansion

Codex indexing skips system and developer messages, event copies of turns,
reasoning records, and standalone tool outputs. Antigravity indexing skips
`SYSTEM_MESSAGE`, unsupported `GENERIC` sources, and planner steps with
neither content nor tool names. Physical disk ranges can still show Codex
tool output and Antigravity system messages. When a file has indexed messages,
sequence ranges select those messages. SQLite fallback can only return indexed
messages. See [MCP core](wiki/MCP-Core.md).
