# DSH Parent/Child 分层上下文记忆

这是一个面向**有限上下文长周期 Agent**的最小可审计原型。它不构建实体图，也不复制“每个实体一条观察”；唯一权威检索记录是 `ParentChunk`，嵌套的 `ChildSpan` 只负责细粒度向量定位。

当前开发版本：`0.12.0-progressive-dev`；已发布基线为`v0.11.0-pressure-driven`。

## 1. 一句话理解

```text
完整 turn/document 保留在工作上下文
→ 阈值前只预计算 Parent/Child，prompt保持原样
→ 上下文达到65%后，才把冷 Parent 无损卸载到 session 索引
→ 标准pointer、压缩label、ID-only、detached逐级压回35%
→ fixed prefix超过35%时记录原因并交给DSH原生compaction
→ 后续查询只检索已经卸载的 Child
→ Child 命中聚合回 Parent，先披露命中 Child，缺少相邻上下文时再有界展开 Parent
```

这样同时解决两个问题：

1. 扁平小 chunk 太多，候选上限被碎片占满；
2. 只返回小 chunk 时，模型得到事实片段，却缺少解释该事实所需的上下文。

## 2. 权威数据结构

### ParentChunk

```jsonc
{
  "id": "seg-s-1-2:parent:001",
  "kind": "context-parent",
  "schemaVersion": 2,
  "scopeKind": "session",
  "scopeId": "session-id",
  "documentId": "session-id:turn:1",
  "documentTitle": "项目运行记录",
  "coreText": "不可变的 Parent 原文",
  "sourceRefs": [{"sessionId": "session-id", "seq": 1}],
  "state": "active",
  "evidenceQuality": 0.9,
  "childSpans": [],
  "supersededRanges": [],
  "temporalCurrent": true
}
```

- Parent 是 Layer Ledger 中的 mutation 单位、来源核验单位和关联单位；模型先看到命中的 Child 片段，再按需展开 Parent。
- Parent保持原始document边界；达到压力后可把同一边界内最多8个相邻turn聚合成一个Parent。
- `coreText` 不因更新而改写；旧事实通过 `supersededRanges` 从 current view 中移除。
- session sensory 只能被同一 session 检索。

### ChildSpan

```jsonc
{
  "childId": "seg-s-1-2:parent:001:child:001",
  "startOffset": 0,
  "endOffset": 620,
  "embeddingTextPreview": "标题 + heading path + Child core",
  "vector": {
    "provider": "http",
    "model": "intfloat/multilingual-e5-small",
    "revision": "614241f622f53c4eeff9890bdc4f31cfecc418b3",
    "dimensions": 384
  },
  "temporalCurrent": true
}
```

- Child 没有独立 scope、sourceRefs、association、layer 或 Ledger collection。
- overlap 只进入 Child 的 embedding text；Parent 原文不会重复。
- 命中 Child 后仍以 Parent ID 作为打开和关联单位，但 `sensory_recall` 会直接返回最高分 Child 片段，避免只显示 Parent 开头。

## 3. 默认切分参数

```yaml
parentTargetTokens: 2048
parentMaxTokens: 3072
parentMaxTurns: 8
parentMinTokens: 512
childTargetTokens: 384
childMaxTokens: 512
childOverlapTokens: 64
```

边界优先级：turn → document → Markdown heading → 完整表格 → class/function → 自然段 → hard split。

- Markdown 标题、表头和文档标题进入 Child embedding text。
- 表格保持整行边界。
- JavaScript/Python 代码优先按 class/function/method 拆分。
- 超大单元才按 token 硬切。

## 4. E5 sidecar

向量模型固定为：

```text
model      intfloat/multilingual-e5-small
revision   614241f622f53c4eeff9890bdc4f31cfecc418b3
dimensions 384
normalize  L2
prefix     query: / passage:
```

源码位于：

```text
E:\deepseek_memory\sensory-memory-plugin\tools\embedding-sidecar\
```

模型 cache 位于：

```text
E:\deepseek_memory\.models\multilingual-e5-small\
```

首次建立：

```powershell
cd E:\deepseek_memory\sensory-memory-plugin\tools\embedding-sidecar
.\setup-once.ps1
```

隐藏窗口启动和停止：

```powershell
.\run-hidden.ps1
.\stop.ps1
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

正式 Benchmark 设置 `vectorRequired=true`：模型、revision、维度或服务状态不符时，环境门失败，不产正式分数。普通 DSH 设置 `vectorRequired=false`：主动配置无向量时是 `lexical-only`；HTTP sidecar 失败后继续工作的请求明确标记为 `lexical-fallback`、`degraded=true` 和具体错误，不再伪装成 hybrid。服务恢复后 maintenance 可以补齐 Child vectors。

CPU Sidecar 的 passage 批处理会持有同一模型锁。正式压力实验可显式缩短单批持锁时间并放宽排队尾延迟：

```powershell
$env:DSH_MEMORY_VECTOR_BATCH_SIZE = '8'
$env:DSH_MEMORY_VECTOR_TIMEOUT_MS = '30000'
```

默认仍是 batch 32、timeout 5 秒；`sensory_status()` 会同时显示实际 `batchSize` 和 `timeoutMs`，避免把超时配置和模型延迟混在一起。

插件 Node 运行依赖数量仍为 0。Python sidecar 使用独立 `.venv`，不把模型文件提交到 Git。

## 5. Matcher v2

### 5.1 查询分解

```text
S0 = 完整查询
S1-S3 = 最多三个确定性高信息子句
```

单独重复 S0、停用词片段和低信息短句会被拒绝。分解不调用 LLM。

### 5.2 宽召回

每个 S0-S3：

1. E5 query embedding；
2. 检索 active/current Child；
3. 每路保留 top-8；
4. 接纳 `top1 - 0.20` 相对窗口、精确词法锚点和 source-valid top-1 recall guard；
5. 每个子查询额外保留最多 4 个不同 Parent 的强词法候选，避免纯 dense 高分把可解释证据挤出；
6. 合并最多 32 个 Child。

召回阶段故意较宽。只有低置信 recall guard 的 Parent 不自动进入证据，但仍可作为 planner 的诊断候选。

### 5.3 Parent 聚合和多跳覆盖

Child 按 `parentId` 聚合，应用硬门：

- 当前 session 可见；
- `sourceRefs` 可回读；
- `evidenceQuality >= 0.80`；
- 无未解决冲突；
- Parent/Child 当前有效；
- Parent 不处于 `pending-vector`。

最多保留 16 个 eligible Parent，再按以下价值贪心选择最多 6 个：

```text
新增子问题覆盖
+ dense relevance
+ 精确词法锚点
+ 新 source turn/document
- Parent 语义冗余
```

原来的 `max(lexical, vector) >= 0.70` 不再承担 v2 的最终资格语义。它会把大量相似候选一并放行，也会在跨表达时误杀可靠证据。

Coverage 将 top1 recall guard 区分为强覆盖与弱回退：弱 top1 仍保留候选，但不再获得与明确词法覆盖相同的权重。结构化问题至少补充与子查询数相称的不同 Parent，再由冗余惩罚排序；无子查询的全局问题继续保留最多 6 个 Parent，避免为了“看起来精简”损失多事实召回。

### 5.4 Planner 触发

普通长问题中的 `given that`、`what does this enable` 或普通 `when` 不再被当成独立指代/时态歧义。`memory-retrieval-plan` 只在以下情况出现：

- 明确的“上次那个 / that one / the previous one”；
- 子问题仍未覆盖；
- 真实时间版本歧义或冲突；
- 已有可验证诊断候选，而不是任意弱向量近邻。

同一 step 最多一次。LLM 只能选择给出的 Parent ID；最终证据仍由确定性重查和来源核验决定。

## 6. Temporal supersession

不超过 1024 字符且不含 document boundary 的明确更新语句会比较新旧 Child：

```text
新 Child 与旧 active Child 有可靠词法锚点和相似度
→ 旧 Child temporalCurrent=false
→ 旧 Parent 增加 supersededRanges
→ 新 Child 记录 supersedes
→ renderCurrentParentView 删除旧 range，保留 Parent 其余内容
```

只有所有 Child 都失效时，整个 Parent 才退出当前检索。DSH 原始事件和 Parent `coreText` 始终保留，便于审计。

长论文、调试文档和普通 “currently is / now is” 描述不参与自动 supersession，避免技术说明错误遮蔽整个历史候选集。

## 7. 分层和 DSH 生命周期

```text
turn-stopping
  收集完整 user/assistant/tool transaction
  → 写 Parent pending-vector
  → 批量编码全部 Child
  → 一条 Parent mutation 激活

agent/pre-step（prepend）
  等待 pending（最多 transitionWaitMs）
  → 使用 DSH token meter 计算处理前压力
  → 低于65%且没有已卸载历史：原样进入，不检索、不调用 planner
  → 达到65%：按冷却时长、体积和原始顺序选择完整 segment
  → 无损卸载并逐级压缩，直到约35%
  → 只检索已卸载 Parent
  → 证据受最终65%输入上限约束并插在真实 user 之前
  → DSH原生80% compaction保持启用

llm/stream
  只读记录最终 provider request 与 usage
```

层级保持：

| 层 | 作用域 | 内容 |
|---|---|---|
| 工作层 | session | 原始可见消息 |
| 感知层 | session | Parent + 嵌套 Child 视图 |
| 半持久层 | workspace，按 session 投影 | 完整 Parent/segment 投影 |
| bank | workspace 或 user-global | 持久 Parent |

被动 candidate、目录曝光和 `sensory_recall` 不增加关联；`sensory_open`、bank open 和最终答案的可验证使用才增加关联。

## 8. 压力与上下文预算

默认策略：

```yaml
compressionMode: pressure
contextPressureRatio: 0.65
contextPressureTargetRatio: 0.35
automaticRetrievalBelowPressure: false
```

- “连续4轮未关联”只参与达到压力后的压缩排序，不再单独触发卸载。
- `effectiveInputCapTokens` 未设置时，沿用 routed context window 减输出预留；隔离 Benchmark 可用环境变量 `DSH_MEMORY_EFFECTIVE_INPUT_CAP_TOKENS` 把 A/C 放到同一压力轴。显式值是权威实验 cap，可覆盖 provider 注册表中过时的 context metadata；设置前必须用真实 warmup usage 完成一次压力校准。
- 压缩后半持久快照和 Parent evidence 共享到65%阈值的剩余 headroom，证据注入受该headroom约束，避免重新把输入推满。
- Parent 太大放不下时跳过，绝不重新切成碎片注入。
- 合格 Parent 因目录预算放不下时，pre-step 插入小型 `sensory-retrieval-hint`，要求模型调用一次 `sensory_recall`；提示不复制 Parent 原文。
- `DSH_MEMORY_VECTOR_REQUIRED=true` 让正式 Benchmark 在 E5 失败时终止该题；普通环境仍可显式降级并报告。
- `DSH_MEMORY_VECTOR_BATCH_SIZE` 与 `DSH_MEMORY_VECTOR_TIMEOUT_MS` 只覆盖当前 DSH 进程的 E5 批大小和 HTTP 排队上限，适合隔离实验，不改变普通 profile 默认值。
- 插件 listener 使用 prepend，使65%无损卸载有机会先于 DSH 默认80%原生摘要执行；原生 compaction仍保留为相同安全兜底。

## 9. DSH 工具

| 工具 | 作用 |
|---|---|
| `sensory_store({text})` | 写入当前 session 的 Parent 和 Child vectors。 |
| `sensory_recall({query,limit})` | 只读显示 Parent ID、最高分 matchedChildren、coverage 和本题信息增益。 |
| `sensory_open({chunk})` | 按 Child offsets 展开完整命中 Child；直接打开时返回最多 6000 字符的 Parent current view，并记录强关联。 |
| `sensory_demote({sourceSeq})` | 把包含该 seq 的完整工作 segment 卸载。 |
| `sensory_status()` | 查看 Parent/Child、matcher、向量和迁移状态。 |
| `sensory_cache_status()` | 兼容名称；实际查看半持久 Parent 投影。 |
| `memory_layer_status()` | 查看工作、感知、半持久和 bank。 |
| `memory_bank_open({record})` | 展开 bank Parent。 |
| `memory_forget({target,scope})` | tombstone 检索视图，保留 DSH raw events。 |

调试工具：

| 工具 | 主要输出 |
|---|---|
| `sensory_debug_last_prompt` | 完整 system、tools、messages 和请求属性。 |
| `sensory_debug_index_prompt` | Parent current view、Child offsets、向量元数据、admission、coverage、source 和 ledger。 |
| `sensory_debug_cache_prompt` | 半持久 Parent 快照与投影。 |
| `sensory_debug_working_prompt` | 工作消息、source、block、tool-call/result 配对和迁移。 |

大输出请使用 `output=document`，避免在对话里回显几十万字符。

同一题的检索工具使用 Parent/Child ID 判断信息增益：重复 query、重复 Parent open 或连续检索没有新增证据时返回 `converged=true`，模型应直接根据已返回证据作答。`retrieval-only` Benchmark 默认每个工具最多 2 次、总动作最多 4 次；可用 `DSH_MEMORY_RETRIEVAL_TOOL_CALL_LIMIT` 显式调整。

计数和汇总问题先把 matchedChildren 中仍待完成的独立对象或动作逐条列出，再计算总数；同一交换事项中的取新件和退旧件是两个待办，除非问题明确要求按对象去重。零售门店、干洗店和维修点都按来源中的待办语义处理；计划去做不等于已经完成，只有明确完成记录才解除待办。

## 10. 人类可执行入口

### 插件测试

```powershell
cd E:\deepseek_memory\sensory-memory-plugin
npm.cmd test
```

### E5 端到端冒烟

```powershell
cd E:\deepseek_memory
node benchmark\memgym\scripts\smoke-parent-child-e5.mjs `
  results\important-tests\parent-child-vector-matcher-v2-20260825-01\evidence\sidecar\standalone-e5-smoke.json
```

### 不调用模型的机制门

```powershell
cd E:\deepseek_memory\benchmark\memgym
.\.venv\Scripts\python.exe scripts\run-offline-parent-child-gate.py `
  E:\deepseek_memory\results\important-tests\memgym-dr-formal-deepseek-official-20260824-01\data\pilot-12.jsonl `
  E:\deepseek_memory\results\important-tests\parent-child-vector-matcher-v2-20260825-01\evidence\offline-gate `
  --run-id parent-child-vector-matcher-v2-20260825-01-offline `
  --old-results E:\deepseek_memory\results\important-tests\memgym-dr-formal-deepseek-official-20260824-01
```

数量门使用“相对旧 flat chunk 降幅至少 50%”和 `parentsPerEvictedDocument <= 1.25`。冻结题集平均有 252.33 个被卸载原始文档，因此旧的绝对 `average Parent <=150` 与“Parent 不跨 document”不可同时满足；旧门只保留为不可行诊断。

### 正式上下文矩阵

正式命令和冻结配置见：

```text
E:\deepseek_memory\results\important-tests\parent-child-vector-matcher-v2-20260825-01\
```

开发、离线门和 Benchmark 不向正常 3080 写实验对话。

### 压力—任务成功率曲线

```text
E:\deepseek_memory\benchmark\context-pressure\README.md
```

正式 A/C：

```text
A-native = DSH原生压缩
C-layered = 相同DSH原生压缩 + 本插件压力算法
```

横轴固定为处理前压力 `50/63/68/78/82/92%`，同时记录 sensory 与 DSH 原生压缩事件、Provider 最终压力、任务成功率和 usage。

256K 必须优先使用 `benchmark\context-pressure\scripts\run-memory-bounded.ps1`：每题单独启动现有隔离 DSH profile，结果落盘后立即停止进程；题前可用物理内存低于 8 GB 时停止。这样不会让多个 256K session 的 surface、trace 和向量状态同时驻留内存。

当前压力实验结果：32K held-out 首次尝试 A=11/12、C=12/12；256K 单任务六点复验 A=C=6/6；两种规模下 C 对 A 已触发原生 summary 的成对避免率均为 1.0。完整边界见：

```text
E:\deepseek_memory\results\important-tests\context-pressure-agent-v1-20260825-01\03-final-report.md
```

## 11. 主要模块

| 文件 | 单一职责 |
|---|---|
| `lib/context-chunker.js` | Parent 边界和 Child spans。 |
| `lib/vector-encoder.js` | E5 HTTP 合同、批处理和显式 lexical-only。 |
| `lib/layered-memory-records.js` | pending/active Parent 构造。 |
| `lib/layered-match-support.js` | query decomposition、Child 词法/向量特征、source/current view。 |
| `lib/layered-match-engine.js` | Child recall、Parent 聚合、coverage 和渲染。 |
| `lib/layered-memory-runtime.js` | DSH hook、迁移、局部 supersession 和 vector repair。 |
| `lib/memory-ledger.js` | append-only 状态真源。 |
| `lib/sensory-debug.js` | 不输出完整向量数组的人类可读审计。 |
| `lib/standalone-chunk-memory.js` | Benchmark 直接复用生产实现。 |
| `tools/embedding-sidecar/` | 固定 E5 模型的本地服务。 |

不修改 DSH 核心和 engram；插件 Node 第三方运行依赖为 0。

## 12. 0.9 历史效果边界（2026-08-25）

- 插件：68/68；Benchmark 合同：Node 3/3、Python 9/9；sidecar：2/2。
- 无模型机制门：Parent 相对旧 flat chunk 减少 50.42%，平均 eligible 13.67、selected 2.25，整体与 4-hop fact recall 都是 1.0。
- Held-out：8K 和 16K 下 C 分别比 A 高 0.2917、0.2167；32K 打平，4-hop 的 C32 比 A32 低 0.025。
- 因宽上下文门未全通过，这一提交保留为可审计实验实现，没有安装到正常 3080，也没有清理正常索引。

权威结果和失败边界：

```text
E:\deepseek_memory\results\important-tests\parent-child-vector-matcher-v2-20260825-01\03-final-report.md
```

## 13. 0.10 Development 冻结状态

- 插件：70/70；Benchmark Node 3/3、Python 9/9。
- 新 development 12 题与此前 smoke/development/held-out 共 26 题零重叠。
- 修改前无模型 fact recall 0.9208；混合 rerank、词法候选保证和长文档 supersession 门控后为 0.9500；4-hop 为 1.0。
- 实际故障样例 `memgym_ir__research__40739` 从候选 Parent 1、fact recall 0.25 修到候选 16、selected 3、fact recall 1.0。
- 新完整模型矩阵为 `A8/C8/A16/C16/A32/C32/A256/C256/BFull`。Development 108/108 全门通过；零重叠 held-out 108/108 完成。
- Held-out：8K +0.1083、16K -0.0583、32K -0.0083、256K +0.0333；4-hop 32K +0.075、256K +0.075。C fact recall 0.9444，低于预注册 0.95。
- 结论限于“256K 平均与 4-hop 均有小幅正增益”；完整 held-out 总门未通过，因此不切换正常 3080，也不使用该 held-out 继续调参。

权威计划和运行证据：

```text
E:\deepseek_memory\results\important-plans\parent-child-rerank-256k-complete-20260825-01\
E:\deepseek_memory\results\important-tests\parent-child-rerank-256k-complete-20260825-01\
```
