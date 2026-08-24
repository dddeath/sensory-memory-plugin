# 本地 E5 向量 Sidecar

该目录提供 sensory-memory-plugin 的可审计本地 embedding 服务。插件通过 Node 内置 HTTP 客户端访问它，插件自身不增加第三方运行依赖。

## 固定模型

```text
model: intfloat/multilingual-e5-small
revision: 614241f622f53c4eeff9890bdc4f31cfecc418b3
dimensions: 384
normalize: L2
query prefix: query:
passage prefix: passage:
```

## 一次性建立

```powershell
powershell -ExecutionPolicy Bypass -File E:\deepseek_memory\sensory-memory-plugin\tools\embedding-sidecar\setup-once.ps1
```

模型 cache 位于：

```text
E:\deepseek_memory\.models\multilingual-e5-small\
```

## 隐藏启动与停止

```powershell
powershell -ExecutionPolicy Bypass -File .\run-hidden.ps1
powershell -ExecutionPolicy Bypass -File .\stop.ps1
```

运行记录位于 `E:\deepseek_memory\.runtime\embedding-sidecar\`。

## HTTP

```text
GET  http://127.0.0.1:8765/health
POST http://127.0.0.1:8765/embed
```

正式 Benchmark 在 `/health` 的 model、revision、dimensions 或 normalized 不一致时停止，不产生正式分数。正常 DSH 可进入显式 lexical-only。
