# @local/sensory-memory — Layered Memory v2

The DSH raw event log is the source-text/audit truth, the versioned Layer Ledger
is the layer-state truth, and the DSH surface is the current model view. Sensory
memory is always session-local; semipersistent memory is a workspace record with
per-session reference/full projections; the bank is workspace-scoped unless the
user explicitly requests a global/cross-workspace memory.

The old `SemipersistentCache` export remains for direct compatibility tests, but
the runtime path uses `SemipersistentLayer`: a complete context projection rather
than hit-count ranking. Passive matching, catalog exposure, automatic injection,
and `sensory_recall` have association weight zero.

## 阅读顺序与模块边界

第一次阅读不需要从 30 个文件中猜入口，按下面顺序即可追踪一次请求：

| 顺序 | 模块 | 单一职责 |
|---:|---|---|
| 1 | `lib/index.js` | 稳定公共入口：归一配置、安装 hook、集中导出公共 API。 |
| 2 | `lib/plugin-services.js` | 仅负责创建、连接并向 DSH 注册服务；不处理请求。 |
| 3 | `lib/install-layered-v2.js` | 把运行时、维护服务和工具挂到 DSH 生命周期。 |
| 4 | `lib/layered-memory-runtime.js` | 编排 pre-step、turn-stopping、层级迁移和工具操作。 |
| 5 | `lib/layered-memory-records.js` | 把原始 segment 转成可持久化的事实、检索特征和 sensory entry。 |
| 6 | `lib/layered-match-engine.js` | 编排 session sensory → bank 检索、歧义门和目录渲染。 |
| 7 | `lib/layered-match-support.js` | 纯词法、候选生成、评分和来源验证；不读取全局状态。 |
| 8 | `lib/memory-retrieval-planner.js` | 只在快路径证据不足时生成一次受候选 ID 约束的检索计划。 |

持久化和层级策略分别从 `memory-ledger.js`、`memory-policy.js`、
`semipersistent-layer.js`、`memory-bank.js` 阅读。`match-engine.js`、
`injection-engine.js` 和 `semipersistent-cache.js` 是阶段 1–4 的兼容 facade；
Layered v2 主路径不会把旧 cache 当作新的半持久层实现。

## 人类可执行审计入口

在插件目录执行一条命令：

```powershell
npm.cmd run verify
```

该入口依次检查全部 `lib/*.js` 语法并运行完整测试套件。终端只显示
通过/失败、文件数、测试数和审计文件位置；完整步骤、命令、开始/结束
时间、耗时、退出码及原始测试输出写入 `.audit/plugin-verification-*.json`。

需要把证据放进指定交付目录时：

```powershell
npm.cmd run verify -- --out E:/deepseek_memory/results/my-run/plugin-verification.json
```

记录不使用内容哈希、fingerprint 或外部服务；它只保存实际执行过程。
`.audit/` 是本地运行证据目录，不进入 Git。

## Request path

- `agent/pre-step` drains pending transitions (at most five seconds), reconciles
  surface lineage, synchronizes workspace references, invokes downstream DSH
  compaction, then performs evidence-gated retrieval.
- The fast path searches the current session sensory layer first and the bank
  only when sensory evidence is insufficient. Ambiguity uses at most one
  `memory-retrieval-plan`; the model may select only offered IDs and deterministic
  code rechecks source and quality gates.
- Qualified catalogs contain at most three entries. A semipersistent snapshot
  contains all active full projections within its 20% input-budget share.
- `llm/stream` is observation-only because DSH freezes the request.
- The observation hook retains the latest complete provider request per recent
  session for explicit debugging; it never changes the request.
- Working-to-sensory and working-to-semipersistent transitions use public
  `surfaceOp:replace`; raw events remain available and tool groups stay intact.

## Isolation

Runtime `indexScope` is always `session`. A legacy `global` value is warned about
and ignored; old global records are not imported into Layered v2.

The provided `sensoryMaintenance` service exposes:

- `drain(sessionId)` — wait for pending refinement and flush mutations.
- `finalizeSession(sessionId)` — drain journal and pending layer transitions.
- `dropScope(sessionId)` — remove that session's sensory entries and projections;
  shared workspace records remain unless benchmark cleanup explicitly owns them.

The bundled profile already sets `indexScope: session`. C additionally disables
user-global memory and keeps per-question workspace/session isolation.

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

Layered tools:

| Tool | Result |
|---|---|
| `memory_layer_status` | Working/sensory/semipersistent/bank counts, transitions, pending queues, activation and budget. |
| `memory_bank_open` | Opens a verified bank record, records one strong association and activates a current-session projection. |
| `memory_forget` | Tombstones a session/workspace/user-global memory while retaining raw DSH events. |

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

The clear compatibility alias always targets the current session sensory layer
and returns `deprecatedAlias=true`. Previous prompt snapshots, bank records and
bridge traces remain historical evidence.

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
