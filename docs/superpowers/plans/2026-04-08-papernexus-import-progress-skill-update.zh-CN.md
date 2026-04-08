# PaperNexus 批量上传进度与 SKILL 文档更新说明

日期：2026-04-08

## 背景

本次修改要解决两个直接影响 Agent 使用体验的问题：

1. `papernexus-remote__import_workflow` 运行在远程服务器上，`serverFilePath` 参数需要的是远程服务器文件路径，不是 Agent 本地机器上的 `/Users/...` 路径。
2. 批量上传期间，Agent 过去只能根据时间猜测状态，缺少稳定的任务进度和队列快照。

这两个问题会叠加造成常见误判：

- Agent 把本地论文路径直接传给远程 `serverFilePath`
- 远程返回 `No file exists at serverFilePath`
- Agent 又因为看不到明确进度，只能说“已经上传但还没同步”

## 本次实现的代码能力

本次不只是补文档，也把上传队列的进度能力补齐了。

### 1. 任务级进度

文件：

- [src/storage/import-store.js](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/src/storage/import-store.js)
- [src/core/imports/worker.js](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/src/core/imports/worker.js)
- [src/core/ingestion/pipeline.js](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/src/core/ingestion/pipeline.js)

每个 import task 现在都会持久化：

- `task.progress.percent`
- `task.progress.stagePercent`
- `task.progress.queuePosition`
- `task.progress.currentStep`
- `task.progress.processedUnits`
- `task.progress.totalUnits`

覆盖阶段：

- `queued`
- `materialize`
- `llm-optimize`
- `fast-commit`
- `completed`

### 2. 队列级进度

文件：

- [src/mcp/tool-import-workflow.js](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/src/mcp/tool-import-workflow.js)
- [src/mcp/tools.js](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/src/mcp/tools.js)
- [src/server/api.js](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/src/server/api.js)

`import_workflow` 现在新增：

- `progress`
- `queue_progress`

同时 `list` 和 `status` 返回也会带进度字段与队列摘要。

关键字段：

- `summary.total`
- `summary.pending`
- `summary.running`
- `summary.completed`
- `summary.failed`
- `summary.remaining`
- `summary.overallPercent`

### 3. 批量脚本行为

文件：

- [SKILL/PaperNexus/scripts/pn_batch_import.py](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/SKILL/PaperNexus/scripts/pn_batch_import.py)

批量脚本现在：

- `submit` 返回每篇论文的 `progress`
- `status` 基于一次远程 `queue_progress` 快照返回整批状态
- `wait` 改为 round-robin 轮询整批任务，而不是顺序等待单篇完成

## 本次 SKILL 文档更新

### 1. 上传边界说明

更新文件：

- [SKILL/PaperNexus/SKILL.md](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/SKILL/PaperNexus/SKILL.md)
- [SKILL/PaperNexusBatchImport/SKILL.md](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/SKILL/PaperNexusBatchImport/SKILL.md)
- [SKILL/PaperNexusAgenticReasoning/SKILL.md](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/SKILL/PaperNexusAgenticReasoning/SKILL.md)
- [SKILL/PaperNexusReflection/SKILL.md](/Users/iranb/Library/Mobile%20Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus/SKILL/PaperNexusReflection/SKILL.md)

现在文档会明确告诉 Agent：

- `serverFilePath` 是远程服务器路径
- 本地 `/Users/...` 路径不能直接传给远程 MCP `submit`
- 本地文件必须先通过 wrapper 做 `ssh`/`rsync` staging
- 单篇默认用 `pn_import_submit.py --source ...`
- 多篇默认用 `pn_batch_import.py --manifest ... submit`

### 2. 状态查询说明

现在文档会明确告诉 Agent：

- 单篇状态查询优先用 `pn_import_queue.py status --paper-id ...`
- 单篇等待完成用 `pn_import_queue.py wait --paper-id ...`
- 批量状态查询优先用 `pn_batch_import.py status`
- 批量等待完成用 `pn_batch_import.py wait`

并明确应该关注：

- `task.progress.percent`
- `task.progress.stagePercent`
- `task.progress.queuePosition`
- `summary.remaining`
- `summary.overallPercent`

## 推荐调用方式

### 单篇本地论文上传

```bash
python3 SKILL/PaperNexus/scripts/pn_import_submit.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --corpus "<corpus>" \
  --paper-id "<paperId>" \
  --source "/absolute/local/path/paper.pdf" \
  --ssh-target "hyq@<host>"
```

### 单篇上传状态

```bash
python3 SKILL/PaperNexus/scripts/pn_import_queue.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --corpus "<corpus>" \
  status --paper-id "<paperId>"
```

### 批量上传

```bash
python3 SKILL/PaperNexus/scripts/pn_batch_import.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  submit
```

### 批量状态

```bash
python3 SKILL/PaperNexus/scripts/pn_batch_import.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  status
```

## 验证

本次主工作区已通过：

```bash
PYTHONPYCACHEPREFIX=/tmp/papernexus-pycache-main python3 -m py_compile \
  SKILL/PaperNexus/scripts/pn_common.py \
  SKILL/PaperNexus/scripts/pn_import_queue.py \
  SKILL/PaperNexus/scripts/pn_batch_import.py

node --test \
  test/import-store.test.js \
  test/import-api.test.js \
  test/import-worker.test.js \
  test/mcp.test.js \
  test/python-remote-scripts.test.js
```

结果：

- Python wrapper 编译通过
- Node 测试 `29/29` 通过

## 对 Agent 的最终约束

- 不要把本地路径直接当成远程 `serverFilePath`
- 不要靠“已经等了多久”来判断上传状态
- 对单篇，先查 `status`/`wait`
- 对批量，先查 `summary.remaining` 和 `summary.overallPercent`
- 只有 `status=completed` 且 `stage=completed` 时，才能说论文已经同步进图
