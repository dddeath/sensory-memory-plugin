# ADR 0001：分层记忆归属、Chunk 与 Surface 投影

- 状态：已接受，2026-08-24 追加 Chunk-only 修正
- 适用版本：`0.8.0-chunk-vector`

## 背景

旧实现把同一段上下文按抽取结果复制成多条记录，短文本也可能产生大量近重复条目。被动命中又会增加计数，最终让碎片反复进入目录和半持久层。

DSH 已经提供两类权威数据：原始 append-only session event log，以及由 `surfaceOp` 维护的模型可见 surface。插件只需要记录层级归属和可追溯的上下文块，不需要再建立另一套实体或事实图。

## 决定

1. 运行时唯一检索单元是 `ContextChunk`。插件不创建实体、别名、关系、观察或 canonical fact。
2. `coreText` 是不重叠的权威正文；`contextText` 可携带标题、表头和相邻 overlap，只用于向量编码。
3. 每个卸载 chunk 保存一个向量及其 provider、model 和 dimensions。默认编码器零依赖；可通过本地 HTTP sidecar 使用小型向量模型。
4. 感知层只属于当前 session。归档冻结，恢复会话时继续使用；dispose 只 drain，不删除。
5. 半持久层保存 workspace 记录，并为每个 session 建立 `reference`、`full-projection` 或 `inactive` 投影。跨会话初始引用的关联权重为零。
6. 记忆库默认属于 workspace。只有明确的全局/跨工作区指令才写 user-global，且 profile 可以关闭它。
7. DSH raw events 是原文和审计真源；Layer Ledger journal 是层级状态真源；DSH surface 只是当前模型视图。
8. 工作层卸载通过公开 `Session.append(...surfaceOp.replace)` 完成。原始事件继续保留，tool-call/result 事务不被拆开。
9. 半持久层以 plugin-owned user snapshot 放在本轮真实 user 消息前；历史工具活动只序列化为普通文本和元数据。
10. 候选生成、向量命中、目录曝光、自动插入和 `sensory_recall` 都不增加关联。只有显式 open 或最终答案可验证地使用 chunk 才算强关联。
11. `llm/stream` 只读。只有已有可用候选并存在真实指代、时态或歧义问题时，才在同一 user turn 调用一次 `memory-retrieval-plan`。
12. 向量只负责候选和相关度。自动证据仍必须通过 session scope、sourceRefs 回读、evidenceQuality、冲突和 temporal current 检查。

## 结果

- `sensoryCache` 与 `sensory_cache_status` 仅是半持久投影的兼容名称，不再表示命中排序 cache。
- 旧 global 索引不进入 `chunk-memory-v1`；它不会自动迁移到新运行路径。
- Markdown 表格按完整行切分，代码按函数或类切分，overlap 不复制进 `coreText`。
- 明确更新语句可以让同一 session 内的旧相似 chunk 标记为 `superseded`；旧 chunk 仍保留供审计，但退出当前检索。
- Feature hash 只用于本地向量槽位计算，不是 SHA 完整性清单或运行环境防御。

## 未采用的方案

- 保留 global sensory 再过滤：归属边界仍然错误。
- 把半持久层做成 top-N 索引行：它不是稳定上下文。
- 在冻结后的 `llm/stream` 修改消息：请求装配已经完成。
- 在卸载时删除 raw events：会失去审计和恢复能力。
- 把候选曝光算作使用：会制造自强化污染。
- 用向量值本身充当永久主键：模型或维度切换会改变向量；稳定 chunk ID 与向量元数据应分开保存。

## 验证入口

```powershell
cd E:\deepseek_memory\sensory-memory-plugin
npm test
npm run verify -- --out E:\deepseek_memory\results\layered-memory-v2\chunk-only-vector\02-verification.json
npm run inspect:chunks
```
