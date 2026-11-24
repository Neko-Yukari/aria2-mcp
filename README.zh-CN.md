# aria2-mcp

[English](./README.md) | 简体中文

面向 AI 编程代理的**零配置、零依赖** [MCP](https://modelcontextprotocol.io) 下载服务与 [Magpie](https://usemagpie.ai) 工具插件，基于 [aria2](https://aria2.github.io/) 提供可靠的后台 HTTP(S) 文件下载能力。

## 为什么做 `aria2-mcp`？

让 Agent 在终端里临时拼 `curl` / `Invoke-WebRequest` 下大文件经常翻车：会话中断丢进度、系统代理行为不一致甚至静默退化直连、代理凭据进终端日志、误覆盖本地已有文件。而市面上大多数 aria2 MCP 只是薄转发壳，仍要求用户自己先手动启好 `aria2c` RPC 服务并配置端口和密钥。

`aria2-mcp` 开箱即用：

- **零配置自托管守护进程**：自动探测本地 `aria2c`，选空闲 `127.0.0.1` 端口 + 随机 32 字节 RPC 密钥，校验私有目录权限（Windows `icacls` / macOS & Linux `0700`），加并发启动锁防重复拉起，并用 `downloads.session` 持久化断点续传队列。
- **Fail-Closed 系统代理安全**：自动读取系统代理（Windows 注册表、macOS `scutil --proxy`、Linux 环境变量），下载前先 TCP 探活；代理不可达直接报错，**绝不静默降级直连**，也绝不改动全局/系统代理，明确拒绝不支持的 PAC/WPAD。
- **Agent 友好护栏**：永不覆盖已有文件（冲突时自动追加 UUID 后缀），校验 Windows/POSIX 非法文件名，拒绝 URL 内嵌账号密码，返回值剥离 URL 与代理凭据防进对话上下文。
- **零依赖、极速启动**：纯 Node.js 20+（同时兼容 Bun），无第三方运行时依赖。
- **双模 + 远程 RPC**：既可作标准 stdio MCP（`npx -y aria2-mcp`），也可作 Magpie 工具插件一键分发给所有 Agent，还支持通过 `ARIA2_RPC_URL` 直连 NAS / Docker 里的已有 aria2。

## 运行前提

- **Node.js 20+**（作为 Magpie 插件加载时由 Magpie 内置 Bun 运行）
- 本机安装 **aria2**（若通过 `ARIA2_RPC_URL` 连远程实例则无需本地安装）：
  - Windows：`winget install aria2.aria2` 或 `scoop install aria2`
  - macOS：`brew install aria2`
  - Linux：`sudo apt install aria2`

## 快速接入

### 1. 通用 MCP 客户端（`npx`）

```json
{
  "mcpServers": {
    "aria2": {
      "command": "npx",
      "args": ["-y", "aria2-mcp"]
    }
  }
}
```

适用于 **Claude Code**、**Claude Desktop**、**Codex**、**Cursor**、**Windsurf**、**Antigravity (`agy`)**、**VS Code** 等任意 stdio MCP 客户端。

Claude Code 一行命令：

```bash
claude mcp add aria2 -- npx -y aria2-mcp
```

### 2. Magpie 一键分发给所有 Agent

在 Magpie 的 **Plugins → Discover → Unofficial, on GitHub** 直接安装，或命令行运行：

```bash
magpie plugin add github:Neko-Yukari/aria2-mcp
# 发布 npm 后也可用：
magpie plugin add aria2-mcp
```

Magpie 会自动通过内置 MCP 路由把工具暴露给所有已连接的 Agent，并支持在 **Library → MCP** 中按 Agent 单独开关。

### 3. 连接远程 / NAS 上的 aria2

```json
{
  "mcpServers": {
    "aria2": {
      "command": "npx",
      "args": ["-y", "aria2-mcp"],
      "env": {
        "ARIA2_RPC_URL": "http://192.168.1.10:6800/jsonrpc",
        "ARIA2_RPC_SECRET": "your-secret",
        "ARIA2_DEFAULT_PROXY": "direct"
      }
    }
  }
}
```

## 工具一览

| 标准 MCP 工具名 | Magpie 插件工具名 | 说明 |
| :--- | :--- | :--- |
| `download_submit` | `submit` | 提交后台 HTTP(S) 下载（`url`，可选 `directory`、`filename`、`proxy`），立即返回 GID。 |
| `download_status` | `status` | 按 GID 查询状态、进度、速度与安全错误码。 |
| `download_list` | `list` | 列出进行中、等待中与最近停止的任务（每队列上限 100 条）。 |
| `download_control` | `control` | 按 GID 执行 `pause` / `resume` / `cancel`（取消保留部分文件不删除）。 |
| `download_wait` | `wait` | 无紧轮询地等待任务结束或暂停（MCP 上限 120 秒，Magpie 插件上限 50 秒）。 |

### 大文件后台唤醒（CLI `--wait` 模式）

对于几分钟以上的大文件，可在支持后台任务完成唤醒的 Agent 里用后台 shell 运行：

```bash
npx -y aria2-mcp --wait <gid> [--timeout 3600]
```

退出码：`0` = 完成，`1` = 出错/已移除，`2` = 已暂停，`124` = 超时。

## 环境变量

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ARIA2_BIN` | 自动探测 | 指定 `aria2c` / `aria2c.exe` 绝对路径。 |
| `ARIA2_DATA_DIR` | 系统应用数据目录 | `rpc.json`、`aria2.conf`、`downloads.session` 存放目录；多工具指向同一目录可共享队列。 |
| `ARIA2_DEFAULT_DIR` | `~/Downloads` | 本地下载默认保存目录。 |
| `ARIA2_DEFAULT_PROXY` | `system` | 默认代理模式：`system`、`direct` 或 `http://host:port`。 |
| `ARIA2_RPC_URL` | *(空)* | 外部 / 远程 aria2 JSON-RPC 地址；设置后不启动本地守护进程。 |
| `ARIA2_RPC_SECRET` | *(空)* | 搭配 `ARIA2_RPC_URL` 使用的 RPC 密钥。 |

## 开发与测试

```bash
npm test
```

## 开源协议

[MIT](./LICENSE)
