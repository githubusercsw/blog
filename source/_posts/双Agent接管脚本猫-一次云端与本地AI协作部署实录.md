---
title: 双 Agent 接管脚本猫：一次云端与本地 AI 协作的部署实录
date: 2026-08-29 22:00:00
tags: [ScriptCat, MCP, AI Agent, 自动化, 浏览器扩展]
categories: [技术随笔]
toc: true
comments: true
---

# 引言

ScriptCat 是一款强大的浏览器用户脚本管理器，近期推出了"外部访问"（External Access）功能，允许通过 `sctl` 命令行工具和 MCP 协议从浏览器外部管理脚本。这为 AI Agent 接管浏览器自动化打开了大门。

但一个实际问题立刻浮现：如果你同时有一个**本地 AI Agent**（以 TRAE 客户端形式运行在桌面上）和一个**云端 AI Agent**（运行在远程沙箱中），如何让这两个 Agent 都能操控同一台机器上的 ScriptCat？

本文记录了这次部署的完整过程——从理解架构到打通云端通道，踩过的坑和最终方案。

---

# 一、理解 ScriptCat 的外部访问架构

在动手之前，先读懂官方文档的架构图：

```
AI 客户端 ── stdio MCP ──▶ sctl mcp ── 本地控制 API ──▶ sctl serve ── WebSocket ──▶ ScriptCat
CLI ────────────────────────────────────────────────────────▲
```

核心组件：

| 组件 | 作用 | 运行位置 |
|------|------|----------|
| `sctl serve` | 守护进程，通过 WebSocket 与浏览器扩展通信 | 本地 |
| `sctl mcp` | MCP 服务器进程，供 AI 客户端通过 stdio 调用 | 本地 |
| `sctl` CLI | 命令行工具，直接操作脚本 | 本地 |
| ScriptCat 扩展 | 浏览器端，执行实际的脚本读写 | 浏览器 |

关键设计决策：`sctl serve` 默认监听 `127.0.0.1:8643`，**不会自动启动**，所有命令都不会拉起守护进程。配对码是一次性的、2 分钟过期、终端专用，绝不通过网络传输。

---

# 二、Agent A：本地 TRAE 客户端的接入

本地 Agent 的接入是最顺畅的部分。因为 TRAE 客户端和 ScriptCat 在同一台机器上，可以直接使用 sctl 原生的 MCP stdio 通道。

## 2.1 安装与配对

Windows 下一条 PowerShell 命令安装 sctl：

```powershell
irm https://raw.githubusercontent.com/scriptscat/sctl/main/scripts/install.ps1 | iex
```

安装后需要三步配对：
1. 启动守护进程：`sctl serve`（需要单独的终端窗口，保持运行）
2. 执行配对：`sctl connect`（生成一次性配对码）
3. 在浏览器 ScriptCat 设置中输入配对码完成绑定

配对完成后，`sctl status` 应报告已连接扩展。这一步是后续所有操作的基础。

## 2.2 注册 MCP 服务器

在 TRAE 的 MCP 配置中添加 `scriptcat` 服务器，指定 sctl 二进制路径和数据目录。配置完成后，Agent A 就能直接调用以下 MCP 工具：

- `scripts_list` — 列出所有脚本
- `scripts_source_get` — 读取脚本源码
- `scripts_install_request` — 请求安装脚本
- `scripts_edit_request` — 请求编辑脚本
- `scripts_toggle_request` — 启用/禁用脚本
- `scripts_delete_request` — 删除脚本

本地 Agent 的接入到此就完成了，干净利落。

---

# 三、Agent B：云端 Agent 的接入难题

真正的挑战在于云端 Agent。它运行在远程沙箱中，无法直接访问本地机器的 `127.0.0.1:8643`。

## 3.1 为什么不能直接暴露端口

第一反应是让 `sctl serve` 监听 `0.0.0.0` 然后直接连。但文档明确警告：

> `ws://` 不加密业务流量，没有按远程客户端隔离，仅在可信网络使用。
> **永远不要将 `pairing.key` 或 `control.token` 交给 AI 模型。**

这意味着：
- 裸暴露 WebSocket 端口 = 明文传输 = 不安全
- 把控制令牌交给云端 Agent = 违反安全策略

## 3.2 方案：HTTP 中继 + 隧道

最终采用的架构是：在本地运行一个轻量 HTTP 中继服务，它持有 `control.token`，代为执行 `sctl` 命令，通过隧道暴露给云端。

```
云端 Agent ──HTTPS──▶ 隧道 ──▶ 本地中继 ──sctl CLI──▶ sctl serve ──▶ ScriptCat
                                    ↑
                              control.token 留在本地
```

中继服务的设计要点：

- **命令白名单**：只允许 `get`、`grep`、`status`、`install`、`edit`、`enable`、`disable`、`delete`，拒绝任意命令注入
- **令牌隔离**：`control.token` 始终保留在本地环境变量中，不会通过 HTTP 传递给云端
- **纯标准库**：用 Python 标准库实现，无需安装第三方依赖
- **CORS 支持**：允许跨域请求，方便不同来源的调用

云端 Agent 通过 HTTP POST 请求调用中继：

```json
{
  "command": "get",
  "args": ["<script-uuid>", "-o", "source"]
}
```

---

# 四、部署过程的踩坑实录

## 4.1 守护进程没有运行

第一次测试时，中继返回 `daemon is not running`。原因很直接：`sctl serve` 还没启动。文档反复强调"请求方命令永远不会自动启动守护进程"，但实际部署时仍然容易忘记这一步。

**教训**：部署顺序应该是 `sctl serve` → 配对 → 中继 → 隧道，不能跳步。

## 4.2 control.token 找不到

紧接着遇到 `open control.token: The system cannot find the file specified`。这是因为配对步骤（`sctl connect`）还没完成，`control.token` 文件不存在。

`control.token` 是 `sctl connect` 成功后才生成的本地控制令牌。如果数据目录路径不一致（比如 `serve` 用了环境变量但 `connect` 没设），也会导致令牌找不到。

**教训**：确保 `SCTL_DATA_DIR` 环境变量在所有 sctl 进程中保持一致。

## 4.3 中继端口未监听

配对完成后，通过隧道测试时收到 ngrok 的 `ERR_NGROK_8012` 错误——隧道通了，但上游 `localhost:9876` 没有服务。原因是中继脚本还没启动。

**教训**：需要同时维护多个终端窗口——守护进程、中继、隧道各一个。

## 4.4 ngrok 免费版警告页

ngrok 免费版会在响应中插入一个浏览器警告页。需要在请求头中加入 `ngrok-skip-browser-warning: any` 才能获取实际 JSON 响应。

**教训**：自动化调用时记得加跳过头。

---

# 五、安全设计总结

| 安全措施 | 实现方式 |
|----------|----------|
| 令牌隔离 | `control.token` 仅存在于本地环境变量，不通过网络传递 |
| 命令限制 | 中继服务内置命令白名单，拒绝未授权命令 |
| 传输加密 | 使用 HTTPS 隧道，避免明文传输 |
| 浏览器确认 | ScriptCat 的权限策略仍然生效，写操作默认需要浏览器确认 |
| 审计追踪 | sctl 的 `status` 命令和 ScriptCat 的审计日志记录所有操作 |

ScriptCat 的安全模型设计得相当周到：即使外部程序拿到了控制通道，也不能自行批准请求——浏览器的确认页面才是最终决策点。会话级授权在浏览器重启或扩展重载后自动清除，这是一个很好的"失效保护"设计。

---

# 六、最终架构与协作模式

部署完成后，两个 Agent 的能力分布如下：

| 能力 | Agent A（本地） | Agent B（云端） |
|------|-----------------|-----------------|
| 连接方式 | MCP stdio | HTTP 中继 + 隧道 |
| 调用协议 | 原生 MCP 工具 | HTTP POST JSON |
| 延迟 | 极低（本地进程间） | 取决于网络 |
| 适合场景 | 实时编辑、频繁操作 | 批量分析、远程管理 |
| 共享资源 | 同一个 `sctl serve` 守护进程 | 同一个 `sctl serve` 守护进程 |

两个 Agent 共享同一个守护进程，可以同时工作而不冲突。ScriptCat 的会话级授权机制确保每个写操作都需要用户确认（除非显式设为"Allow directly"），这意味着**人始终是最终把关者**。

---

# 结语

这次部署的核心收获：当你需要让云端 AI Agent 接管本地浏览器扩展时，**不要试图直接暴露本地端口或传递认证令牌**，而是建立一个本地中继层，让令牌留在本地、命令经过白名单过滤、通信走加密隧道。

ScriptCat 的外部访问功能加上这套中继架构，本质上实现了一个"AI 可编程的浏览器自动化网关"——本地 Agent 负责低延迟操作，云端 Agent 负责重度分析，人类负责最终审批。这是一个令人兴奋的协作模式。
