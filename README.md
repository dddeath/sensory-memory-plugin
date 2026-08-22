# @local/sensory-memory — 分层记忆 v2

DSH 原始事件日志是原文与审计真源，带版本的 Layer Ledger 是层级状态真源，
DSH surface 是模型当前看到的投影视图。感知记忆始终限制在当前会话；
半持久记忆是工作区记录，并为每个会话建立引用投影或完整投影；记忆库默认
属于工作区，只有用户明确要求“全局”或“跨工作区”时才进入用户全局作用域。

旧的 `SemipersistentCache` 导出继续用于直接兼容测试，但运行主路径使用
`SemipersistentLayer`：它保存完整上下文投影，而不是按命中次数排序索引。
被动匹配、目录曝光、自动注入和 `sensory_recall` 的关联权重均为 0。

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

## 请求执行路径

- `agent/pre-step` 最多等待 5 秒让待处理迁移收敛，然后对账 surface
  血缘、同步工作区引用、调用下游 DSH compaction，最后执行受证据门控的检索。
- 快路径先检索当前会话感知层，仅在感知证据不足时检索记忆库。出现歧义时
  每 step 最多调用一次 `memory-retrieval-plan`；模型只能选择已提供的候选
  ID，确定性代码随后重新检查来源和质量门。
- 合格目录最多包含 3 项。半持久快照包含全部活跃完整投影，但最多占输入
  预算的 20%。
- 因为 DSH 会冻结请求，`llm/stream` 只负责观测。
- 观测 hook 为最近会话保留最新一次完整 provider 请求，供显式调试使用；
  它不会改变请求。
- 工作层迁移到感知层或半持久层时，使用公开的 `surfaceOp:replace`；原始
  事件继续保留，tool-call/tool-result 组合保持完整。

## 作用域隔离

运行时 `indexScope` 始终为 `session`。旧配置中的 `global` 会产生迁移告警
并被忽略；旧 global 记录不会导入 Layered v2。

插件提供的 `sensoryMaintenance` 服务暴露：

- `drain(sessionId)`：等待待处理精抽并刷新 mutation。
- `finalizeSession(sessionId)`：等待 journal 和层级迁移收敛。
- `dropScope(sessionId)`：删除该会话的感知条目和投影；共享工作区记录继续
  保留，除非 Benchmark cleanup 明确拥有并清理它们。

随附 profile 已设置 `indexScope: session`。C 组还会关闭用户全局记忆，
并保持每题工作区和会话隔离。

## DSH 调试工具

除 7 个记忆工具外，插件还注册 5 个显式调试/维护工具：

| 工具 | 返回内容 |
|---|---|
| `sensory_debug_last_prompt` | 上次捕获的 `system`、完整工具 schema、messages、请求选项和汇总属性。`requestKind` 可选择 `main`、`any` 或 `auxiliary`。 |
| `sensory_debug_cache_prompt` | 上次感知目录中的 `[cache]` 行，以及命中次数、LRU、预算、置信度和注入属性。 |
| `sensory_debug_index_prompt` | 非 cache 目录行、实体记录，以及索引、matcher 和注入属性。 |
| `sensory_debug_working_prompt` | 排除目录快照后的 provider 工作消息，并列出每条消息的 role/source/block/token、tool-call/result 配对、会话字段和降级跟踪状态。 |
| `sensory_clear_workspace_index` | 仅在 `confirm=true` 时清理当前激活的感知索引作用域，并返回清理前、清理后和移除数量。 |

分层记忆工具：

| 工具 | 返回内容 |
|---|---|
| `memory_layer_status` | 工作层、感知层、半持久层和记忆库的数量、迁移、待处理队列、activation 和预算。 |
| `memory_bank_open` | 展开一条已验证的记忆库记录，记一次强关联，并激活当前会话投影。 |
| `memory_forget` | 为会话、工作区或用户全局记忆写入 tombstone，同时保留 DSH 原始事件。 |

4 个调试视图和清理记录均支持 `output=conversation|document|both`。
`documentPath` 可省略；提供时必须位于当前 DSH 工作区内。扩展名为 `.json`
时写 JSON，其他扩展名写 Markdown。未提供路径时，插件写入
`results/sensory-debug/`。

可直接在 DSH 中发送：

```text
请显式调用 sensory_debug_last_prompt，requestKind=main，output=both。
请调用 sensory_debug_cache_prompt，output=document。
请调用 sensory_debug_index_prompt，output=conversation。
请调用 sensory_debug_working_prompt，output=both。
请调用 sensory_clear_workspace_index，confirm=true，output=both。
```

兼容清理别名始终只指向当前会话感知层，并返回 `deprecatedAlias=true`。
此前的 prompt 快照、记忆库记录和 Bridge trace 继续作为历史证据保留。

Prompt 捕获最多保留最近 `debugMaxSessions` 个会话，默认值为 32，以限制
内存占用。捕获耗时通过 `attributes.debugCaptureDurationMs` 暴露。

## 持久化与迁移

- mutation 以 `{version,sequence,scopeId,collection,op,id,value}` 追加到
  `mutations.jsonl`，并执行 fsync。
- 启动时加载兼容 JSONL 快照、重放 journal；只有最后一行不完整时会修复，
  journal 中间损坏会直接报告。
- 达到 `journalCompactAfter` 后，原子写入新快照并截断 journal。
- cache 与索引文件共用执行 fsync/rename 的原子写入器。
- `cleanupLegacyOnStart` 现在只执行一次：旧文件复制到带版本的备份目录，
  带版本的迁移标记记录迁移统计。

## 验证

```powershell
npm.cmd test
```

插件声明的运行时依赖数量为 0，DSH 核心和 engram 源码树保持原样。
