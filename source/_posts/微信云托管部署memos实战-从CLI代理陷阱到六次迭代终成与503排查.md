---
title: 微信云托管部署 memos 实战：从 CLI 代理陷阱到六次迭代终成与 503 排查
date: 2026-08-29 21:00:00
tags: [微信云托管, memos, Docker, CLI, 部署, 踩坑, 代理, 扩缩容]
categories: [技术随笔]
toc: true
comments: true
---

# 背景

[memos](https://github.com/usememos/memos) 是一个轻量级、自托管的笔记管理应用，采用 Go 后端 + React 前端，支持 Markdown 编辑和知识管理。**微信云托管 (Cloud Run)** 是微信团队提供的容器化应用托管平台，支持通过 GitHub 仓库自动构建 Docker 镜像并部署。

用户已 fork memos 到自己的 GitHub 仓库 `githubusercsw/memos`，并通过 `cloud.weixin.qq.com/cloudrun` 网站连接了仓库。但 fork 版本缺少 Dockerfile，需要自行创建。

> **两条学习路径**
>
> - **Path A (CLI)**: 在云端 Linux 环境中用 `@wxcloud/cli` 全自动化部署 — 本文主线
> - **Path B (Console)**: 通过浏览器驱动控制台手动部署另一个项目 — 备选方案

---

# 一、Dockerfile 创建

官方 memos 仓库的 Dockerfile 位于 `scripts/Dockerfile`，但它不构建前端（依赖 CI 中 `pnpm release` 预构建产物），且 `.dockerignore` 排除了 `/web/` 目录。直接 clone 后 docker build 必然失败。

创建的自包含 Dockerfile 采用三阶段构建：

| 阶段 | 基础镜像 | 职责 |
|------|---------|------|
| Stage 1: frontend | `node:24-alpine` | pnpm install + pnpm release 构建前端 |
| Stage 2: backend | `golang:1.27.0-alpine` | go mod download + go build 嵌入前端 |
| Stage 3: runtime | `alpine:3.21` | 最小运行时镜像 |

## 关键技术决策

**CGO_ENABLED=0** 生成纯静态二进制，配合 `-tags netgo,osusergo` 确保跨架构兼容。Go 的 `//go:embed dist` 将前端构建产物嵌入二进制，无需运行时携带前端文件。

```dockerfile
# 编译 — 纯静态二进制
RUN CGO_ENABLED=0 go build \
      -trimpath -ldflags="-s -w" \
      -tags netgo,osusergo \
      -o memos ./cmd/memos
```

---

# 二、CLI 代理陷阱：502 Bad Gateway

## 安装与初次尝试

安装 `@wxcloud/cli v1.1.8` 后，用用户提供的 AppID 和私钥尝试登录：

```bash
wxcloud login --appId wx4ab8c1c53201011a --privateKey "AAQ9G7s..."
```

结果：`登录失败，请检查 AppID 与私钥文件是否正确`

## 排查过程

用户确认私钥字符无遗漏（200 字符，首尾匹配）。深入 CLI 源码分析认证流程：

> **认证流程 (auth.js)**
>
> `checkLoginState()` 调用 `fetchApi("wxa-dev-qbase/getqbaseinfo")`，检查 `base_resp.ret === 0` 判断登录是否成功。`fetchApi` 中所有错误被 `catch` 静默吞掉，统一返回 `false`。

开启 `NODE_ENV=DEBUG` 重试，终于看到真实错误：

```
Error: Request failed with status code 502
data: 'Forwarding error: connection closed before message completed'
host: '127.0.0.1'   ← 请求走了沙箱代理
protocol: 'http:'   ← 用 HTTP 协议而非 HTTPS
```

> **根因**
>
> CLI 的 **axios v0.24.0** 自动检测到 `HTTP_PROXY` 环境变量后，用 HTTP 代理方式（发送完整 URL 作为 path）转发 HTTPS 请求，而沙箱代理不支持这种模式，返回 **502 Bad Gateway**。
>
> 而 `curl` 能正确工作，因为它使用 **CONNECT 隧道**方式处理 HTTPS 代理。

## 验证：curl 直连 API

用 curl 模拟 CLI 的认证请求，绕过 axios 代理问题：

```bash
curl -s -X POST \
  "https://servicewechat.com/wxa-dev-qbase/getqbaseinfo?autodev=1&appid=wx4ab8c1c53201011a" \
  -H "X-CloudRunCli-Robot: 1" \
  -H "X-CloudRunCli-Key: AAQ9G7s..." \
  -d '{"appid":"wx4ab8c1c53201011a"}'
```

返回 `{"base_resp":{"ret":0}...}` — **凭证完全正确，网络也通**。问题确实在 CLI 的代理处理。

---

# 三、Proxy Patch：注入 https-proxy-agent

安装 `https-proxy-agent` 并 patch CLI 的三个文件，让 axios 使用正确的 CONNECT 隧道方式：

| 文件 | axios 调用 | 作用 |
|------|----------|------|
| `api/base.js` | `fetchApi()` + `getCloudRunCliRandStr()` | 核心 API 请求 |
| `api/files.js` | `uploadVersionPackage()` | 代码包上传 |
| `api/adapter.js` | `transactRequest()` (3 处) | 云 API 代理调用 |

每个文件注入相同的代理初始化逻辑：

```javascript
// 在 require axios 后插入
let _proxyAgent = null;
try {
  const HttpsProxyAgent = require("https-proxy-agent").HttpsProxyAgent;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
                 || process.env.HTTP_PROXY  || process.env.http_proxy;
  if (proxyUrl) { _proxyAgent = new HttpsProxyAgent(proxyUrl); }
} catch(e) {}
```

然后在每个 axios 请求配置中添加：

```javascript
const config = {
  url: ...,
  // ...
  httpsAgent: _proxyAgent || undefined,  // 使用 CONNECT 隧道
  proxy: false,                           // 禁用 axios 自带的代理处理
};
```

> **Patch 后登录成功**
>
> API 返回 `base_resp.ret: 0`，配置文件写入 `~/.wxcloudconfig`，显示 `登录成功`。

---

# 四、部署六次迭代

登录成功后，枚举环境 (`memos-prod`) 和服务 (`memos`)，开始部署。但部署过程经历了六次迭代：

1. **memos-001** `build_failed` — 首次部署，Dockerfile 构建失败 — 沙箱代理导致代码包上传返回 400
2. **memos-002** `deploy_failed` — 修复代理后上传成功，但部署失败 — 端口不匹配
3. **memos-003** `deploy_failed` — 同样的端口问题，之前的失败版本
4. **memos-004** `deploy_failed` — Dockerfile 设 MEMOS_PORT=5230，但服务级 EnvParams 覆盖为 80 → 健康检查失败
5. **memos-005** `deploy_failed` — 对齐 containerPort=80，但仍失败 — entrypoint.sh 的 su-exec 权限降级不兼容
6. **memos-006** `normal` — 简化 Dockerfile：去掉 entrypoint.sh/su-exec/VOLUME，直接运行二进制，端口 80 → 部署成功

---

# 五、两个关键根因

## 根因一：环境变量优先级冲突

微信云托管的服务级 `EnvParams` 会覆盖 Dockerfile 中的 `ENV` 指令。旧版本遗留的环境变量 `MEMOS_PORT=80` 覆盖了 Dockerfile 中的 `MEMOS_PORT=5230`：

> **优先级链**
>
> **服务级 EnvParams > Dockerfile ENV > 默认值**
>
> 即使 Dockerfile 写了 `ENV MEMOS_PORT=5230`，如果服务级配置中有 `MEMOS_PORT=80`，容器内 memos 实际监听的是 **80** 端口。若 `containerPort` 仍为 5230，健康检查会打在 5230 上 → 超时 → `deploy_failed`。

## 根因二：entrypoint.sh 的 su-exec 不兼容

原 Dockerfile 使用 `entrypoint.sh` 脚本通过 `su-exec` 进行权限降级（root → nonroot UID 10001）。在微信云托管的容器环境中，该流程可能导致启动失败：

```diff
 # 原方案 (memos-005, deploy_failed)
- RUN apk add --no-cache tzdata ca-certificates su-exec
- COPY --from=backend .../entrypoint.sh ...
- VOLUME /var/opt/memos
- ENTRYPOINT ["/usr/local/memos/entrypoint.sh", "/usr/local/memos/memos"]

 # 简化方案 (memos-006, normal)
+ RUN apk add --no-cache tzdata ca-certificates
+ COPY --from=backend /backend-build/memos /usr/local/memos/memos
+ CMD ["/usr/local/memos/memos"]
```

> **最终 Dockerfile runtime 阶段**
>
> 去掉 su-exec、entrypoint.sh、VOLUME、USER 指令，直接用 `CMD ["/usr/local/memos/memos"]` 运行二进制。端口对齐为 80，与服务级 EnvParams 一致。

---

# 六、最终部署命令

```bash
wxcloud run:deploy . \
  -e memos-prod-d9gmffqwh16195962 \
  -s memos \
  --dockerfile Dockerfile \
  --containerPort 80 \
  --targetDir . \
  --noConfirm \
  --override \
  --region ap-shanghai \
  --detach \
  --remark "Simplified Dockerfile - no entrypoint, port 80"
```

关键参数说明：

| 参数 | 值 | 原因 |
|------|-----|------|
| `--targetDir .` | 当前目录 | 自动选择"手动上传代码包"模式，跳过交互 |
| `--containerPort 80` | 80 | 与服务级 MEMOS_PORT=80 对齐 |
| `--noConfirm` | true | 跳过二次确认，全自动化 |
| `--override` | true | 沿用旧版本缺失参数 |
| `--detach` | true | 提交后立即返回，不阻塞等待日志 |

## 验证

```bash
curl -s -o /dev/null -w "HTTP: %{http_code}" \
  "https://memos-304959-11-1477399212.sh.run.tcloudbase.com"
# HTTP: 200
```

---

# 七、503 排查：缩容到零与冷启动

部署成功后，访问 `https://memos-304959-11-1477399212.sh.run.tcloudbase.com/` 时，有时会返回 **503 Service Temporarily Unavailable**。但稍后再次访问又恢复正常。这一节记录了完整的排查过程。

## 现象

- 部署成功后首次访问：HTTP 200，memos 前端正常加载
- 一段时间不访问后再次打开：**503 Service Temporarily Unavailable**
- 刷新页面或等待几秒后：恢复正常，返回 200
- 控制台服务状态显示：**0 个实例（自动暂停）** 或 **服务冷启动中**

## 根因：缩容到零 (Scale to Zero)

微信云托管默认运行模式为「始终自动扩缩容」，实例数量可在 **0-10** 之间自动调整。当「服务设置」中实例副本数最小值为 **0** 时：

1. **30 分钟无 HTTP 请求** → 服务自动缩容到 0 个实例（自动暂停），最大程度节约资源
2. **新请求到达时** → 触发冷启动（从 0 扩容到 1），扩容新实例
3. **冷启动期间** → 服务返回 `503 Service Temporarily Unavailable` / `SERVICE_NOT_READY`
4. **实例就绪后** → 正常处理请求，返回 200

冷启动耗时由以下因素决定：
- 平台资源调度状态
- 镜像大小（memos 镜像约 50MB，相对较快）
- 应用启动速度（Go 单二进制启动极快）

> **关键细节**：微信云托管的缩容触发条件是实例**无访问、无流量，闲置 10 分钟**。但由于「实例副本数最小值为 0」的设置，整个服务可以缩到完全没有实例。官方 FAQ 明确指出「半小时无请求服务将缩容到 0」。

## 验证

用 curl 连续测试，模拟冷启动场景：

```bash
# 第一次请求（可能触发冷启动，返回 503 或延迟）
curl -s -o /dev/null -w "HTTP: %{http_code} Time: %{time_total}s\n" \
  "https://memos-304959-11-1477399212.sh.run.tcloudbase.com/"
# HTTP: 200 Time: 0.067s  ← 实例已在运行

# 等待 30 分钟后再次请求
# 预期：503 或延迟数秒后 200（冷启动）
```

实测中，部署完成后立即 curl 返回 HTTP 200，响应头中包含 `x-cloudbase-upstream-status-code: 200` 和 `x-cloudbase-upstream-type: Tencent-CloudBaseRun`，说明请求已正确转发到容器实例。用户遇到的 503 发生在服务长时间无访问后自动暂停、再次访问触发冷启动的窗口期。

## 解决方案

| 方案 | 操作 | 效果 | 代价 |
|------|------|------|------|
| **设置最小副本数为 1** | 控制台 → 服务设置 → 实例副本数最小值改为 1 | 服务常驻，无冷启动 | 持续产生资源消耗和费用 |
| **切换运行模式** | 控制台 → 服务设置 → 运行模式改为「持续运行」 | 固定实例数，无缩容 | 固定较高成本 |
| **白天持续运行，夜间自动扩缩容** | 控制台 → 服务设置 → 运行模式改为混合模式 | 工作时间无冷启动，夜间节约资源 | 夜间访问仍有冷启动 |
| **保持默认，前端兼容** | 不改设置，前端对 503 做重试/友好提示 | 零额外成本 | 首次访问可能延迟 |

> **建议**：对于 memos 这类个人笔记服务，流量低且不可预测，推荐设置最小副本数为 1 保持常驻。如果费用敏感，可接受冷启动延迟，在前端做重试兼容即可。微信云托管免费试用额度内，1 个常驻实例的资源消耗在可接受范围内。

## 微信云托管运行模式对比

| 运行模式 | 适用场景 | 成本效益 | 响应速度 |
|---------|---------|---------|----------|
| 始终自动扩缩容 | 流量波动大、不可预测 | 最优 | 可能有冷启动延迟 |
| 持续运行 | 流量稳定、高可用要求 | 固定较高 | 最佳（无冷启动） |
| 白天持续运行，夜间自动扩缩容 | 工作时间集中型应用 | 较优 | 工作时间最佳，非工作时间可能有延迟 |
| 自定义 | 有明确流量模式、需精细控制 | 可优化 | 可根据配置优化 |
| 手工启停实例 | 开发测试、特殊业务需求 | 完全可控 | 取决于人工操作及时性 |

---

# 八、Path B: 控制台部署（备选方案）

Path B 是通过浏览器驱动控制台进行手动部署的方案，作为 Path A 的对照学习路径。相比 CLI 全自动化，控制台部署提供更直观的可视化界面，适合首次体验微信云托管的用户。

| 维度 | Path A (CLI) | Path B (Console) |
|------|-------------|-----------------|
| 环境 | 云端 Linux 沙箱 | 浏览器 |
| 认证 | AppID + 私钥 | 微信扫码 |
| 自动化 | 全自动化 | 半自动（需手动操作） |
| 调试 | 需读源码 + patch | 可视化日志面板 |
| 适用场景 | CI/CD 集成 | 首次部署 / 探索 |

Path B 的核心流程：**登录控制台 → 选择/创建环境 → 创建服务 → 连接 GitHub 仓库 → 自动构建 → 配置端口 → 发布**。由于用户已在控制台创建了 memos-prod 环境和 memos 服务，Path B 可以直接复用这些资源。

---

# 九、经验总结

## 1. 沙箱代理兼容性

在受限网络环境中使用 Node.js CLI 工具时，**老版本 axios (≤0.27) 的 HTTPS 代理处理存在已知缺陷**。它用 HTTP 代理方式转发 HTTPS 请求，而非标准的 CONNECT 隧道。解决方案是安装 `https-proxy-agent` 并设置 `proxy: false` 禁用 axios 自带代理处理。

## 2. 环境变量优先级

云托管平台的**服务级环境变量优先于 Dockerfile ENV**。部署前务必检查服务级配置中是否有与 Dockerfile 冲突的环境变量，特别是端口、数据目录等关键参数。

## 3. Dockerfile 简化原则

云托管环境对容器有特定的安全策略和运行时约束。**最简 Dockerfile 往往兼容性最好** — 去掉 su-exec、entrypoint.sh、VOLUME 等非必要组件，直接运行二进制，减少不兼容风险。

## 4. 调试方法论

当 CLI 工具报错但错误信息模糊时（如"请检查 AppID 与私钥"），应该：**读源码找真实错误 → 开 DEBUG 日志 → 用 curl 对照测试 → 定位差异**。本次正是通过 curl 对照测试发现凭证无误，问题在代理层。

## 5. 缩容到零的认知

微信云托管默认的「始终自动扩缩容」模式会将最小实例数设为 0，导致 30 分钟无请求后服务暂停。这是**特性而非 Bug** — 最大程度节约资源。但对于需要随时访问的服务（如笔记应用），应设置最小副本数为 1 保持常驻，或在前端做重试兼容。

---

# 成果

- memos 已成功部署到微信云托管，公共访问地址：`https://memos-304959-11-1477399212.sh.run.tcloudbase.com`
- 简化版 Dockerfile 已提交到 GitHub：[commit 8dddbaa](https://github.com/githubusercsw/memos/commit/8dddbaa15df8a7cd5a8d5dcf4fafc9b141711559)
- 503 根因已定位：缩容到零 + 冷启动，建议设置最小副本数为 1

---

# 参考来源

1. [usememos/memos, GitHub](https://github.com/usememos/memos) — 开源笔记管理项目，Go + React 技术栈
2. [微信云托管 Cloud Run 官方文档](https://cloud.weixin.qq.com/cloudrun) — 容器化应用托管平台
3. [@wxcloud/cli, npm](https://github.com/WeixinCloud/wxcloud) — 微信云服务 CLI 工具 v1.1.8
4. [https-proxy-agent, npm](https://www.npmjs.com/package/https-proxy-agent) — HTTPS 代理 Agent，支持 CONNECT 隧道
5. [SERVICE_NOT_READY 错误码文档](https://docs.cloudbase.net/error-code/SERVICE_NOT_READY) — 云托管服务未就绪状态说明
6. [运行模式与扩缩容文档](https://docs.cloudbase.net/run/deploy/configuring/autoscaling/about-instance-autoscaling) — 扩缩容机制详解
7. [调用服务常见问题 FAQ](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/faq.html) — 503/冷启动/缩容排查指引
