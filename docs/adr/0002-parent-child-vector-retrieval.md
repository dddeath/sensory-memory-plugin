# ADR 0002：Parent/Child 层级向量检索

- 状态：已接受，等待实施
- 日期：2026-08-25
- 部分取代：ADR 0001 中“每个 ContextChunk 同时是唯一检索与披露单元”“每个卸载 chunk 保存一个向量”和整 chunk temporal supersession 的实现粒度
- Runtime 基线：`b3f765d0f1429556fa4fc09682a8ae120122dac8`

## 背景

正式 MemGym-DR 中，C 每题平均产生 375.1 个扁平 sensory chunks，最终查询平均 31.75/32 个候选合格，而 fact recall 只有 45.8%。继续提高单一阈值会损害多跳 recall；继续披露细粒度 chunk 又缺少足够上下文。

## 决定

1. `ParentChunk` 成为 session sensory 的唯一权威记录、Layer Ledger mutation 单位和模型披露单位。Parent 固定在单个原始文档和单个 Turn 内，target 2048、max 3072 tokens。
2. `ChildSpan` 是 Parent 内嵌的检索视图，target 384、max 512、overlap 64 tokens。Child 只保存 Parent offset、向量和 temporal metadata，不建立独立 collection，不独立关联、迁移或进入 prompt。
3. Child 使用固定 revision 的 `intfloat/multilingual-e5-small` 编码 `文档标题 + heading path + core text`。Sidecar 源码属于插件仓库，模型文件放外部 cache；插件 Node 运行依赖保持为 0。
4. Matcher 使用宽 Child dense recall、Parent 聚合和多跳 coverage selection。每个子查询 top-8，合并最多 32 Child、16 eligible Parent，最终选择最多 6 Parent。相对分数窗口、精确 lexical anchor 和 top1 recall guard 保护召回。
5. Dense 负责语义召回，Lexical 负责精确锚定，Coverage 负责选择覆盖不同子问题的 Parent；sourceRefs、evidenceQuality、conflict、session scope 和 temporal current 继续作为硬门。单一 `effectiveRelevance >= 0.70` 退出 v2 主资格路径。
6. Parent 原文不可变。局部更新记录为 Parent 内 `supersededRanges` 和 Child lineage；检索跳过旧 Child，模型只看到 current Parent view。全部 Child 失效后 Parent 才整体退出。
7. 新路径使用空的 `chunk-memory-v2`。旧 flat chunk 只进入备份，不自动迁移、不伪装成 Parent、不与 v2 双读。
8. Benchmark 把 E5 sidecar 作为环境门；正常 DSH 在 sidecar 暂时失活时进入显式 lexical-only，并暴露 `vectorAvailable=false`，不会以 feature hash 代替 E5。

## 后果

- Layer Ledger 的 sensory 记录数量按 Parent 计算，Child 数量只作为检索统计。
- Parent 激活需要一次异步批量 embedding，但不会阻塞已完成的模型回复；pending 由 maintenance 和 settle 跟踪。
- 向模型披露的上下文粒度变大，检索粒度保持细致。
- temporal rendering 需要生成 current Parent view；raw DSH events 和 Parent 原文继续承担审计真源。
- 正常 profile 需要一次 v1 备份、清空和 v2 初始化；旧记忆不会自动进入新 Matcher。

## 未采用的方案

- 独立 Child collection：物理记录和一致性路径仍然复杂，偏离最小原型。
- 整 Parent supersession：更新一个事实会连带丢失同 Parent 的其他有效内容。
- v1/v2 双读：会重复 source 并延续候选饱和。
- Sidecar 失败后切换 feature hash：不同向量语义会污染正式比较和阈值解释。
- 固定高 cosine threshold：容易提前删除多跳中较弱但必要的事实。
- 由 LLM 执行每轮 query decomposition：会把 Matcher 快路径重新绑定到慢路径。

## 计划入口

`E:/deepseek_memory/results/important-plans/parent-child-vector-matcher-v2-20260825-01/00-locked-plan.md`
