# @local/sensory-memory — scoped memory and prompt debugging

The plugin keeps the stage-1 through stage-4 behavior and adds the isolation,
injection, and durability changes required for reproducible DSH evaluation.

## Request path

- `agent/pre-step` performs the synchronous match and returns a `role:user`,
  `source.kind:plugin` catalog snapshot immediately before the claimed input.
- The fallback rewriter is awaited only after the synchronous path is empty or
  below threshold, so its hit is still visible to that same step.
- Identical consecutive catalogs are omitted and an empty match produces no
  snapshot.
- `llm/stream` is observation-only because DSH freezes the request.
- The observation hook retains the latest complete provider request per recent
  session for explicit debugging; it never changes the request.
- Catalog entries remain ordered by source `seq`, capped by both count and a
  200-token budget; tool call/result boundaries are retained.

## Isolation

`indexScope` accepts `global` (default) or `session`. Session mode applies the
session id to entities, relations, observations, aliases, matching, cache,
tools, audit, status, rewrite fingerprints, and cleanup. Existing records with
no `scopeId` are read as `global`.

The provided `sensoryMaintenance` service exposes:

- `drain(sessionId)` — wait for pending refinement and flush mutations.
- `finalizeSession(sessionId)` — demote the final short history and drain it.
- `dropScope(sessionId)` — capture pre-cleanup stats and remove that session's
  index, cache, rewrite, and rounds state.

Config C must override the bundle configuration with `indexScope: session`.

## DSH debug tools

The plugin registers five explicit debug/maintenance tools in addition to the
seven memory tools:

| Tool | Result |
|---|---|
| `sensory_debug_last_prompt` | Last captured `system`, complete tool schemas, messages, request options, and aggregate attributes. `requestKind` selects `main`, `any`, or `auxiliary`. |
| `sensory_debug_cache_prompt` | `[cache]` lines from the last sensory catalog plus hit counts, LRU, budget, confidence, and injection attributes. |
| `sensory_debug_index_prompt` | Non-cache catalog lines plus entity records and index/matcher/injection properties. |
| `sensory_debug_working_prompt` | Provider working messages with catalog snapshots excluded, per-message role/source/block/token fields, tool-call/result pairing, session fields, and demotion tracking. |
| `sensory_clear_workspace_index` | Clears the active sensory index scope only when `confirm=true`, and returns before/after/removal counts. |

The four views and the clear record accept `output=conversation|document|both`.
`documentPath` is optional and must remain inside the current DSH workspace;
`.json` writes JSON and every other extension writes Markdown. With no path, the
plugin writes Markdown under `results/sensory-debug/`.

Examples to send in DSH:

```text
请显式调用 sensory_debug_last_prompt，requestKind=main，output=both。
请调用 sensory_debug_cache_prompt，output=document。
请调用 sensory_debug_index_prompt，output=conversation。
请调用 sensory_debug_working_prompt，output=both。
请调用 sensory_clear_workspace_index，confirm=true，output=both。
```

`indexScope=session` makes the clear target the current session. With the
default `indexScope=global`, existing index records have no workspace field, so
the effective target is the global sensory index of the current DSH profile.
The clear result reports this as `effectiveTarget`; previous prompt snapshots
and bridge traces remain historical evidence. After a confirmed clear, the
current session skips demotion once at that turn boundary so the clear command
and its reply do not immediately repopulate the index.

Prompt capture retains at most `debugMaxSessions` recent sessions (default 32)
to bound memory use. The capture duration is exposed as
`attributes.debugCaptureDurationMs`.

## Persistence and migration

- Mutations append to `mutations.jsonl` as
  `{version,sequence,scopeId,collection,op,id,value}` and are fsynced.
- Startup loads the compatible JSONL snapshot, replays the journal, repairs
  only an incomplete final journal line, and reports interior corruption.
- `journalCompactAfter` atomically writes new snapshots and truncates the
  journal.
- Cache and index files share the fsync/rename atomic writer.
- `cleanupLegacyOnStart` now runs once: legacy files are copied into a versioned
  backup directory and a versioned migration marker records statistics.

## Verification

```powershell
npm.cmd test
```

The package declares zero runtime dependencies and does not alter DSH core or
the engram source tree.
