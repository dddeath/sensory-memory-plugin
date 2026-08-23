# DSH Chunk-only Vector Memory

这是一个面向**有限上下文 Agent**的最小分层记忆原型。运行时只处理一种检索对象：

> Context Chunk（上下文块）

插件不创建实体、别名、关系、观察或事实图。一次卸载文本先按结构切成少量 chunk，每个 chunk 只保存一份权威正文和一个向量编码。

## 1. 为什么改成 chunk-only

旧实现会先从一段文本抽取很多名字，再为每个名字复制同一段观察文本。一轮 sensory_store 因此可能生成几十条高度重复记录，候选上限很快被碎片占满。

现在的规则是：

- 短文本通常得到 1 个 chunk；
- 长文本先按文档结构拆分，再按 token 预算合并或截断；
- Markdown 表格以完整行作为边界，表头只加入向量上下文；
- 代码优先按 class、function、method 拆分；
- overlap 只进入 contextText，不会复制到权威 coreText；
- 一个 chunk 对应一个向量和一个目录入口。

## 2. 一个 chunk 长什么样

~~~json
{
  "id": "seg-s-1-1:chunk:001",
  "kind": "context-chunk",
  "sessionId": "s",
  "workspaceId": "w",
  "segmentId": "seg-s-1-1",
  "sourceRefs": [{"sessionId": "s", "seq": 1}],
  "format": "text",
  "headingPath": [],
  "coreText": "[seq 1] user: 项目M当前部署端口是8383。",
  "contextText": "[seq 1] user: 项目M当前部署端口是8383。",
  "tokenCount": 24,
  "vector": {
    "provider": "builtin",
    "model": "feature-hash-cjk-v1",
    "dimensions": 384,
    "values": ["..."]
  },
  "evidenceQuality": 0.85,
  "temporalCurrent": true,
  "supersededBy": null
}
~~~

- coreText：互不重叠的权威内容，用于展开、审计和来源核对。
- contextText：送入向量编码器的文本，可以附带标题、表头和前后 overlap。
- sourceRefs：指向 DSH 原始事件的 sessionId + seq。
- vector：向量提供者、模型、维度和数值。
- temporalCurrent：当前版本标志；明确更新语句可使同会话中的旧相似 chunk 退出当前检索。

## 3. 每轮完整流程

~~~text
DSH 原始 user / assistant / tool 事件
        │
        ▼
MemorySegmenter：组成完整 turn segment，保护 tool-call/result 边界
        │
        ▼
ContextChunker：结构拆分 → token 合并/截断 → 仅向量上下文 overlap
        │
        ▼
VectorEncoder：每个 chunk 生成一个向量
        │
        ▼
工作层保持原消息
        │
        ├─ 低活性 / 上下文压力 ─→ session sensoryChunks
        ├─ 高价值 / 多次强关联 ─→ workspace 半持久完整投影
        └─ 明确“记住”或长期价值 ─→ workspace / user-global bankChunks

下一次 agent/pre-step：
当前 user 查询 → query vector → session chunk 检索
                         │ 无合格 chunk
                         └─→ workspace / user-global bank chunk
                         │ 仅在有可用候选且存在指代/歧义时
                         └─→ 一次 memory-retrieval-plan
                         ▼
chunk 目录 + 半持久完整快照插入当轮真实 user 消息之前
~~~

被动候选、向量命中和目录曝光都不增加关联。以下事件才是强关联：

- 用户或模型显式调用 sensory_open(chunk)；
- 显式调用 memory_bank_open(record)；
- 最终答案实际使用了已验证 chunk 中的内容。

## 4. 切分规则

默认值：

~~~yaml
chunkTargetTokens: 320
chunkMaxTokens: 448
chunkOverlapTokens: 48
~~~

### 4.1 普通文本

1. 优先按段落、句号、分号和列表边界切分。
2. 相邻小块合并到 chunkTargetTokens。
3. 单块超过 chunkMaxTokens 时继续切。
4. 相邻正文不重叠。

### 4.2 Markdown

- 标题保存到 headingPath，并加入 contextText。
- 同一标题下的相邻小段会合并。
- fenced code 交给代码切分器。
- 表格只在完整行边界切分。
- 表头加入每个表格 chunk 的 contextText，不重复到 coreText。

### 4.3 代码

- JavaScript / TypeScript：优先按 class、function、方法和箭头函数。
- Python：优先按 class、def、async def。
- 超大函数才在函数内部继续按 token 上限切分。

## 5. 向量编码

### 5.1 默认零依赖原型

~~~yaml
vectorProvider: feature-hash
vectorDimensions: 384
~~~

feature-hash-cjk-v1 是可审计的本地特征向量，不是完整语义模型。这里的 hash 是向量槽位计算的一部分，不是 SHA 校验、交付清单或运行环境防御。

### 5.2 本地小型模型

生产试验可切换本地 HTTP sidecar，例如 [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5)：

~~~yaml
vectorProvider: http
vectorEndpoint: http://127.0.0.1:3901/embed
vectorModel: BAAI/bge-small-zh-v1.5
vectorTimeoutMs: 5000
~~~

插件只使用 Node 内置 http。sidecar 合同为：

~~~http
POST /embed
Content-Type: application/json

{"model":"BAAI/bge-small-zh-v1.5","texts":["第一段","第二段"]}
~~~

~~~json
{"vectors":[[0.1,0.2],[0.3,0.4]]}
~~~

## 6. 召回规则

候选来源是词法匹配与向量近邻的并集：

~~~yaml
candidateLimit: 32
vectorCandidateThreshold: 0.18
relevanceThreshold: 0.70
evidenceQualityThreshold: 0.80
evidenceCatalogLimit: 3
ambiguityMargin: 0.15
plannerCandidateFloor: 0.45
~~~

自动进入目录必须同时满足：

1. effectiveRelevance 不低于 0.70；
2. evidenceQuality 不低于 0.80；
3. sourceRefs 可以回读到同一 session 的原始事件；
4. chunk 不是旧版本、冲突版本或 tombstone；
5. 第一名与独立来源第二名有足够分差，或只有一个合格 chunk。

effectiveRelevance 取词法分和向量余弦相似度的较大值。向量只负责找候选，不替代来源、质量、时态和冲突判断。

普通任务不会因为存在一个弱向量候选就调用辅助 LLM。memory-retrieval-plan 只在以下条件同时成立时调用：

- 已有可读候选；
- 快路径不足；
- 存在指代、时间歧义、冲突或真实低分差；
- 同一 user turn 尚未调用过 planner。

planner 最多接收前 8 个紧凑 chunk 摘要，使用 reasoningEffort=off，且只能选择给定 chunk ID。

## 7. DSH 工具

| 工具 | 用途 |
|---|---|
| sensory_store({text}) | 按结构写入当前 session 的 chunk；短文本通常只写一条。 |
| sensory_recall({query,limit}) | 只读返回候选 chunk 和词法/向量分数。 |
| sensory_open({chunk}) | 展开 coreText、contextText、sourceRefs，并记一次强关联。 |
| sensory_demote({sourceSeq}) | 把包含该 seq 的完整工作 segment 卸载为 chunk。 |
| sensory_status() | 查看层级数量、matcher、chunker、vector encoder 和迁移统计。 |
| sensory_cache_status() | 兼容名称；实际返回半持久 chunk 投影，不是旧排序 cache。 |
| memory_layer_status() | 查看工作、感知 chunk、半持久投影和 bank chunk。 |
| memory_bank_open({record}) | 展开 bank chunk，并记一次强关联。 |
| memory_forget({target,scope}) | tombstone chunk；DSH 原始事件仍保留。 |

调试入口：

| 工具 | 内容 |
|---|---|
| sensory_debug_last_prompt | 完整 system + tools + messages。 |
| sensory_debug_index_prompt | 当前目录中的 chunk、向量、分数、来源和 ledger 状态。 |
| sensory_debug_cache_prompt | 半持久 chunk 快照与投影状态。 |
| sensory_debug_working_prompt | 工作层消息、source、block 和 tool 配对。 |
| sensory_clear_workspace_index | 兼容名称；只清当前 session 的 sensoryChunks。 |

大输出建议使用：

~~~text
请调用 sensory_debug_index_prompt，output=document。
~~~

## 8. 人类可执行入口

完整验证：

~~~powershell
cd E:\deepseek_memory\sensory-memory-plugin
npm test
npm run verify -- --out E:\deepseek_memory\results\chunk-memory-verification.json
~~~

查看实际 chunk：

~~~powershell
cd E:\deepseek_memory\sensory-memory-plugin
npm run inspect:chunks
~~~

指定独立 DSH_HOME：

~~~powershell
npm run inspect:chunks -- E:\deepseek_memory\.benchmark-dsh\c
~~~

输出包含 session 分组数量、chunk ID、sourceRefs、格式、token 数、向量 provider/model/dimensions 和权威正文预览。

### Headless 兼容

Web profile 提供 `workspaceRegistry` 时，插件使用其稳定 workspace ID。纯 headless profile 没有该服务时，插件使用规范化 cwd 作为 workspace ID；session 感知层仍按 sessionId 隔离。这个 fallback 是运行时已有路径，入口不会再把可选服务误声明为启动硬依赖。

## 9. 主要模块

| 模块 | 单一职责 |
|---|---|
| lib/context-chunker.js | 普通文本、Markdown、表格和代码的结构切分与相邻小块合并。 |
| lib/vector-encoder.js | 内置特征向量和本地 HTTP 小模型适配器。 |
| lib/layered-memory-records.js | 从完整 turn segment 生成 chunk 记录。 |
| lib/layered-match-support.js | chunk 候选、词法/向量评分和来源核验。 |
| lib/layered-match-engine.js | session 到 bank 的检索、门控和目录渲染。 |
| lib/layered-memory-runtime.js | DSH pre-step / turn-stopping、迁移、投影和时态替代。 |
| lib/memory-ledger.js | append-only chunk 状态真源。 |
| lib/memory-surface-projector.js | 工作消息替换和当轮 plugin user 快照。 |
| lib/semipersistent-layer.js | workspace 完整 chunk 投影。 |
| lib/memory-bank.js | workspace / user-global bank chunk。 |
| lib/sensory-tools.js | DSH 显式工具入口。 |
| lib/sensory-debug.js | 人类可读、可落盘的 prompt 与 chunk 审计。 |

插件运行时 npm 第三方依赖数量为 0，不修改 DSH 核心、Bridge、Benchmark runner 或 engram 源码。
