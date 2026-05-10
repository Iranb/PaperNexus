# PaperNexus 手动操作指南

本指南用于手动体验完整的 PaperNexus 工作流程。

本指南以检查清单形式组织。请按顺序执行每个步骤。

## 目标

完成本指南后，您将手动练习以下内容：

- 全局 CLI 安装
- 首次运行配置
- 语料库索引
- 图探索命令
- 增强覆盖层
- 仪表板和 API
- 后台服务
- 可选的远程 Ollama 配置
- 可选的 MCP 使用

## 0. 从这里开始

在项目根目录打开终端：

```bash
cd "<repo-root>"
```

## 1. 安装并暴露 CLI

安装依赖：

```bash
npm install
```

将 CLI 注册为全局命令：

```bash
npm link
```

检查命令是否可用：

```bash
papernexus help
```

如果找不到 `papernexus`，运行：

```bash
npm bin -g
```

并将该目录添加到您的 shell `PATH` 中。

## 2. 准备论文源文件夹

推荐的默认论文源目录是：

```bash
~/.papernexus/papers
```

如需要请创建：

```bash
mkdir -p ~/.papernexus/papers
```

您可以通过以下两种方式之一开始：

1. 使用内置示例快速演示：

```bash
mkdir -p ~/.papernexus/papers/demo
cp ./examples/*.md ~/.papernexus/papers/demo/
```

2. 您自己的真实论文语料库：

- 每个 `.md` 或 `.pdf` 文件包含一篇完整论文
- 使用清晰的目录树结构
- 对于 Markdown 文件，保持标题和章节结构完整

## 3. 运行首次运行向导

启动交互式设置：

```bash
papernexus init
```

推荐的答案：

- 论文源目录：`~/.papernexus/papers`
- 语料库名称：选择简短名称，如 `demo` 或 `gcd`
- 索引目录：`~/.papernexus/index-store`

可选的 LLM 设置：

- 如果只需要本地 Ollama 流程，选择 `ollama`
- 如果需要云 API，选择 `openai` 或 `anthropic`
- 如果 macOS 上出现钥匙串提示，输入您的提供商 API 密钥，而不是登录密码

这会将运行时配置写入：

```bash
~/.papernexus/config.json
```

## 4. 构建第一个语料库

运行：

```bash
papernexus analyze --force
```

这应该执行以下操作：

- 解析论文
- 构建主图
- 默认将权威图存储在 Kuzu 中
- 写入轻量级图索引
- 将增强覆盖层加入队列

确认有用的输出：

- 语料库名称
- 节点数量
- 关系数量
- 存储模式

## 5. 检查语料库状态

列出现有语料库：

```bash
papernexus list
```

检查活动语料库：

```bash
papernexus status
```

或检查指定名称的语料库：

```bash
papernexus status --corpus <your-corpus-name>
```

## 6. 手动探索图

运行以下所有命令一次。

搜索：

```bash
papernexus query "experiment planning" --corpus <your-corpus-name>
```

检查邻域：

```bash
papernexus context "knowledge graph" --corpus <your-corpus-name>
```

检查上游支持：

```bash
papernexus impact "knowledge graph" --corpus <your-corpus-name> --direction upstream
```

检查下游影响：

```bash
papernexus impact "knowledge graph" --corpus <your-corpus-name> --direction downstream
```

生成研究方向：

```bash
papernexus ideas "evidence tracing for experiment planning" --corpus <your-corpus-name>
```

运行头脑风暴：

```bash
papernexus brainstorm "experiment planning" --corpus <your-corpus-name> --mode diverge
papernexus brainstorm "experiment planning" --corpus <your-corpus-name> --mode converge
```

## 7. 刷新并检查增强覆盖层

运行增强处理一次：

```bash
papernexus enhance --once --corpus <your-corpus-name>
```

这应该填充以下内容：

- 理论覆盖层
- 故事线覆盖层
- 反思覆盖层

反思覆盖层包括：

- `Innovation`（创新）
- `Experiment`（实验）
- `Outcome`（结果）
- `Reflection`（反思）

如果您想通过 Web UI 检查它们，请继续下一步。

## 8. 打开仪表板

运行：

```bash
papernexus serve
```

然后打开：

```text
http://127.0.0.1:4821
```

如果您想让同一个 `serve` 进程同时暴露远程 MCP，请先在 `config.json` 中加入：

```json
{
  "serve": {
    "host": "0.0.0.0",
    "port": 4821,
    "apiToken": "replace-with-your-api-token",
    "mcp": {
      "enabled": true,
      "path": "/mcp",
      "transport": "streamable-http",
      "allowSseFallback": false
    }
  }
}
```

然后把 MCP 客户端指向 `http://<host>:4821/mcp`，并使用 `Authorization: Bearer <token>`。

使用仪表板检查以下内容：

- 语料库元数据
- 图结构
- 增强摘要
- 论文级别的覆盖层
- 当前 LLM 提供商/模型设置

## 9. 开启后台模式

安装默认的后台服务：

```bash
papernexus service install
```

现在会安装以下两个服务：

- `watch` 用于文件监控和增量索引刷新
- `serve` 用于仪表板/API 和增强工作器

检查状态：

```bash
papernexus service status
```

安装后，命令输出还应打印仪表板 URL。

日志位于：

```bash
~/.papernexus/logs
```

## 10. 验证动态更新

在后台服务运行时：

1. 在 `~/.papernexus/papers` 下添加或编辑论文文件
2. 等待片刻
3. 运行：

```bash
papernexus status --corpus <your-corpus-name>
```

4. 刷新仪表板

您应该看到：

- 图更新
- 轻量视图更新
- 增强队列刷新

## 11. 可选：配置远程 Ollama

如果您在远程机器上有自己的 Ollama 服务器，请将以下内容放入 `config.json`：

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:0.5b",
    "baseUrl": "http://127.0.0.1:11434",
    "sshHost": "your-remote-host",
    "relations": true,
    "batchSize": 8
  }
}
```

然后重建：

```bash
papernexus analyze --force
```

如果 Ollama API 可以从您的机器直接访问，请使用直接远程 HTTP 而不是 `sshHost`。

## 12. 可选：尝试 MCP 模式

启动 MCP 服务器：

```bash
papernexus mcp
```

如果您想要为其他工具准备即用型的 MCP 配置片段，请使用 `papernexus setup`。

如果要走远程 HTTP MCP，请启用 `serve.mcp.enabled`，启动 `papernexus serve`，然后使用如下客户端配置：

```json
{
  "mcpServers": {
    "papernexus-remote": {
      "url": "http://127.0.0.1:4821/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer ${PAPERNEXUS_MCP_TOKEN}"
      },
      "connectionTimeoutMs": 30000
    }
  }
}
```

## 13. 可选：练习反思导向推理

如果您想明确尝试新的反思层：

1. 运行：

```bash
papernexus enhance --once --corpus <your-corpus-name>
```

2. 打开仪表板
3. 检查论文级别的增强覆盖层
4. 对于每篇论文，手动检查：

- 系统标记为 `Innovation` 的内容
- 被归类为 `Experiment` 的内容
- `Outcome` 判断是否看起来正确
- `Reflection` 要点是否有用

## 14. 可选：清理

删除语料库索引：

```bash
papernexus clean --corpus <your-corpus-name>
```

删除后台服务：

```bash
papernexus service uninstall
```

## 建议的手动测试顺序

如果您想要最短的端到端路径，请执行以下操作：

1. `npm install`
2. `npm link`
3. `papernexus init`
4. `papernexus analyze --force`
5. `papernexus status`
6. `papernexus query ...`
7. `papernexus context ...`
8. `papernexus impact ...`
9. `papernexus ideas ...`
10. `papernexus brainstorm ...`
11. `papernexus enhance --once`
12. `papernexus serve`
13. `papernexus service install`

## 什么是"一切正常"的标准

当您成功完成完整的 PaperNexus 流程时，应该满足以下条件：

- `papernexus` 可以全局运行
- 语料库索引没有错误
- query/context/impact/ideas/brainstorm 都返回结果
- 生成了增强覆盖层
- 仪表板可以打开
- 后台服务显示为已加载
- 添加论文会引起增量更新
