# PaperNexus 系统服务配置指南

本文档介绍如何将 PaperNexus 安装为系统服务，实现开机自启动和后台运行。

## 目录

- [快速开始](#快速开始)
- [macOS 安装](#macos-安装)
- [Linux 安装](#linux-安装)
- [服务管理](#服务管理)
- [日志查看](#日志查看)
- [故障排查](#故障排查)

## 快速开始

### macOS

```bash
# 安装服务
./scripts/install-service.sh install

# 管理服务
./scripts/manage-service.sh start
./scripts/manage-service.sh stop
./scripts/manage-service.sh status
```

### Linux

```bash
# 安装服务
./scripts/install-service.sh install

# 管理服务
./scripts/manage-service.sh start
./scripts/manage-service.sh stop
./scripts/manage-service.sh status
```

## macOS 安装

### 前置要求

- macOS 10.10+
- Node.js 20+
- 已安装 PaperNexus 依赖

### 安装步骤

1. **运行安装脚本**

```bash
cd /path/to/PaperNexus
./scripts/install-service.sh install
```

2. **按照提示配置**

脚本会询问：
- 论文目录路径（用于 watch 模式）
- 语料库名称

3. **选择是否启用 watch 模式**

Watch 模式会持续监控论文目录变化并自动重建索引。

### 手动安装（高级）

如果自动安装失败，可以手动配置：

```bash
# 1. 复制 plist 文件
cp scripts/macos/io.github.papernexus.serve.plist ~/Library/LaunchAgents/

# 2. 编辑 plist 文件，替换 %INSTALL_DIR% 为实际路径
sed -i '' "s|%INSTALL_DIR%|/path/to/PaperNexus|g" ~/Library/LaunchAgents/io.github.papernexus.serve.plist

# 3. 创建日志目录
mkdir -p ~/Library/Logs/PaperNexus

# 4. 加载服务
launchctl load -w ~/Library/LaunchAgents/io.github.papernexus.serve.plist
```

## Linux 安装

### 前置要求

- systemd 支持
- Node.js 20+
- 已安装 PaperNexus 依赖

### 安装步骤

1. **运行安装脚本**

```bash
cd /path/to/PaperNexus
./scripts/install-service.sh install
```

2. **按照提示配置**

3. **验证服务**

```bash
systemctl --user status papernexus-serve
```

### 开机自启动

启用 linger 以在用户未登录时运行服务：

```bash
sudo loginctl enable-linger $(whoami)
```

### 手动安装（高级）

```bash
# 1. 创建 systemd 目录
mkdir -p ~/.config/systemd/user

# 2. 复制并配置文件
cp scripts/systemd/papernexus-serve.service ~/.config/systemd/user/
sed -i "s|%USER%|$(whoami)|g" ~/.config/systemd/user/papernexus-serve.service
sed -i "s|%GROUP%|$(id -gn)|g" ~/.config/systemd/user/papernexus-serve.service
sed -i "s|%INSTALL_DIR%|/path/to/PaperNexus|g" ~/.config/systemd/user/papernexus-serve.service

# 3. 重新加载 systemd
systemctl --user daemon-reload

# 4. 启用并启动服务
systemctl --user enable papernexus-serve
systemctl --user start papernexus-serve
```

## 服务管理

使用 `manage-service.sh` 脚本管理服务：

```bash
# 启动服务
./scripts/manage-service.sh start

# 停止服务
./scripts/manage-service.sh stop

# 重启服务
./scripts/manage-service.sh restart

# 查看状态
./scripts/manage-service.sh status

# 查看日志（实时）
./scripts/manage-service.sh logs

# 启用开机自启
./scripts/manage-service.sh enable

# 禁用开机自启
./scripts/manage-service.sh disable
```

## 日志查看

### macOS

```bash
# 实时查看日志
tail -f ~/Library/Logs/PaperNexus/papernexus-serve.out

# 查看错误日志
tail -f ~/Library/Logs/PaperNexus/papernexus-serve.err
```

### Linux

```bash
# 实时查看日志
journalctl --user -u papernexus-serve -f

# 查看最近 100 行
journalctl --user -u papernexus-serve -n 100

# 查看今天的日志
journalctl --user -u papernexus-serve --since today
```

## 故障排查

### 服务无法启动

**macOS:**
```bash
# 检查 plist 文件
cat ~/Library/LaunchAgents/io.github.papernexus.serve.plist

# 手动运行测试
cd /path/to/PaperNexus
node ./src/cli/index.js serve

# 重新加载服务
launchctl unload -w ~/Library/LaunchAgents/io.github.papernexus.serve.plist
launchctl load -w ~/Library/LaunchAgents/io.github.papernexus.serve.plist
```

**Linux:**
```bash
# 查看详细错误
systemctl --user status papernexus-serve.service

# 检查日志
journalctl --user -u papernexus-serve -n 50 --no-pager

# 重新加载配置
systemctl --user daemon-reload
systemctl --user restart papernexus-serve.service
```

### 端口被占用

如果 4821 端口被占用，修改配置文件：

**macOS:** 编辑 `~/Library/LaunchAgents/io.github.papernexus.serve.plist`
**Linux:** 编辑 `~/.config/systemd/user/papernexus-serve.service`

更改 `--port` 参数，然后重启服务。

### Watch 模式不工作

1. 确认论文目录路径正确
2. 检查语料库名称
3. 查看 watch 服务日志

```bash
# macOS
tail -f ~/Library/Logs/PaperNexus/papernexus-watch.out

# Linux
journalctl --user -u papernexus-watch -f
```

## 卸载服务

```bash
./scripts/install-service.sh uninstall
```

## 服务架构

### 服务类型

1. **papernexus-serve** (主服务)
   - 运行 Web UI 服务器
   - 监听端口：4821
   - 自动重启：是
   - 开机自启：是

2. **papernexus-watch** (可选)
   - 监控论文目录变化
   - 自动重建索引
   - 自动重启：是
   - 开机自启：可选

### 文件位置

**macOS:**
- 服务配置：`~/Library/LaunchAgents/io.github.papernexus.*.plist`
- 日志文件：`~/Library/Logs/PaperNexus/`

**Linux:**
- 服务配置：`~/.config/systemd/user/papernexus-*.service`
- 定时器：`~/.config/systemd/user/papernexus-*.timer`
- 日志：systemd journal

## 安全设置

服务已配置以下安全选项：

- `NoNewPrivileges=true` - 禁止提升权限
- `PrivateTmp=true` - 使用私有临时目录
- `ProcessType=Background` - 后台进程类型
- `LowPriorityIO=true` - 低优先级 I/O

## 性能优化建议

1. **调整日志级别** - 生产环境可减少日志输出
2. **限制内存使用** - 在配置文件中添加内存限制
3. **CPU 限制** - 使用 systemd 的 CPUQuota 限制 CPU 使用
4. **I/O 调度** - 已配置低优先级 I/O，避免影响其他任务

## 更新 PaperNexus

更新代码后重启服务：

```bash
# 拉取更新
git pull

# 安装依赖（如有需要）
npm install

# 重启服务
./scripts/manage-service.sh restart
```

## 支持的服务

| 服务 | macOS | Linux | 描述 |
|------|-------|-------|------|
| papernexus-serve | ✅ | ✅ | Web UI 服务器 |
| papernexus-watch | ✅ | ✅ | 目录监控服务 |
| papernexus-serve.timer | ❌ | ✅ | 定期刷新定时器 |

## 更多信息

- [PaperNexus 主文档](../README.md)
- [CLI 使用指南](../README.md#cli-usage)
- [配置文件说明](../README.md#config-file)
