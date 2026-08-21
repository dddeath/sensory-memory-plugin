# ADR 0001: Layered Memory v2 ownership and surface projection

- Status: Accepted
- Date: 2026-08-21
- Decision owners: DSH Layered Memory v2 task

## Context

The v0.6 implementation combined a scoped sensory index with a hit-count cache. That cache only reordered matched catalog rows; it was not a working-memory-like context layer. Passive matching also changed hit counts, allowing broad lexical matches to promote low-quality records. A global sensory mode admitted cross-session pollution.

DSH already provides two distinct durable mechanisms: the raw append-only session event log and a derived surface maintained by `surfaceOp`. The plugin needs a separate durable account of memory-layer ownership without changing DSH core.

## Decision

1. Sensory memory is session-scoped only. Archive freezes it; resume/unarchive restores it; dispose drains but does not delete it.
2. Semipersistent memory is a workspace record with per-session `reference`, `full-projection`, or `inactive` state. Cross-session exposure begins as a sensory reference and has zero association weight.
3. The memory bank is workspace-scoped by default. User-global writes require explicit global/cross-workspace language and may be disabled by profile.
4. DSH raw events are the source-text/audit truth. The plugin Layer Ledger journal is the layer-state truth. DSH surface is only the current model view.
5. Working-to-sensory and working-to-semipersistent transitions use public `Session.append` replacement events. Raw source events remain intact. Complete tool-call/result transactions are never split.
6. The semipersistent layer is rendered as one plugin-owned user snapshot before the current real user input. Historical tool activity is serialized as inert text and metadata.
7. Passive candidate generation, catalog exposure, automatic injection, and `sensory_recall` do not increase association. Only explicit back-reference/open or verified answer use does.
8. `llm/stream` is observation-only. Ambiguous transition and retrieval planning use bounded auxiliary calls before the provider request is frozen.

## Consequences

- Existing `sensoryCache` and `sensory_cache_status` remain as compatibility facades over semipersistent projections; cache-hit ranking is removed from the runtime path.
- Existing global index content is not migrated into the new store because it contains known cross-session pollution. A single backup-and-clear cutover occurs only after isolated verification.
- The plugin owns journal replay, surface revision lineage, pending queues, projection rebuilding after DSH compaction, and deterministic evidence gates.
- Plugin-authored surface replacements participate in DSH token accounting by publishing an immediately adjacent `compaction/prune` shadow price calculated by the injected `tokenMeter`; otherwise the bounded surface fold cannot subtract the hidden range.
- A visible checkpoint with `source.kind=plugin` and `source.plugin=compact` is DSH-owned compaction. Any shadowed working segment is reconciled into session sensory with `external-compaction` lineage before the sensory root manifest is restored.
- Workspace resolution should use `workspaceRegistry.resolveByPath(cwd)`; a normalized-path fallback is observable compatibility behavior, not a global scope.

## Rejected alternatives

- Keep global sensory with filtering: rejected because it preserves an incorrect ownership boundary.
- Treat semipersistent memory as top-N matched index rows: rejected because it does not provide stable contextual working state.
- Mutate frozen `llm/stream` requests: rejected because DSH prompt assembly is already complete at that seam.
- Delete raw events during demotion: rejected because it destroys auditability and recovery.
- Count exposure as use: rejected because it creates self-reinforcing pollution.

## Verification

See `E:\deepseek_memory\results\layered-memory-v2\04-verification.json` and `05-final-report.md`.
