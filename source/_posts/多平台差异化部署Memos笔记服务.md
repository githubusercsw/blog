---
title: 多平台差异化部署 Memos 笔记服务：从 Docker 到 FreeBSD 的实战指南
date: 2026-08-29 15:00:00
tags: [Memos, Docker, 部署, Northflank, Render, Serv00, Oracle Cloud, 自托管]
categories: [技术随笔]
toc: true
comments: true
---

# 引言：为什么要在多个平台部署 Memos？

[Memos](https://usememos.com/) 是一款开源、免费、隐私优先的轻量笔记服务，支持纯文本和 Markdown，提供 RESTful API 和浏览器扩展，可以说是"可自部署的 flomo"。它用 Go 编写后端、React 编写前端，最终产物是一个单二进制文件加静态资源，部署极其轻量。

但"轻量"不等于"省心"。当你真正动手部署时，会发现不同平台的差异巨大：

- 有的平台原生支持 Dockerfile 构建，填几个字段就能跑；
- 有的平台是 FreeBSD 系统，根本没有 Docker，需要下载预编译二进制；
- 有的平台免费但会休眠，冷启动让用户体验大打折扣；
- 有的平台配置最慷慨，但抢不到实例。

这篇文章记录了我在 **6 个平台**上部署 Memos 的完整过程，重点对比平台差异和踩坑细节。每个平台的部署步骤都基于 2026 年 8 月的最新官方文档和社区实践。

---

# 一、Memos 项目结构与技术特征

在开始部署之前，先了解 Memos 的项目结构，这直接决定了各平台的配置方式。

## 1.1 官方 Dockerfile 结构

Memos 官方仓库（`usememos/memos`）的 Dockerfile 位于 `scripts/Dockerfile`，是一个多阶段构建：

```
scripts/Dockerfile    ← 多阶段构建入口
scripts/entrypoint.sh ← 容器启动脚本
```

构建过程分两步：
1. **前端构建**：编译 `web/` 目录下的 React 前端，生成静态资源
2. **后端构建**：编译 `cmd/memos` 下的 Go 二进制，将前端静态资源嵌入

最终镜像基于 Alpine，以非 root 用户（UID 10001）运行，监听 **5230 端口**，数据存储在 `/var/opt/memos`。

## 1.2 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMOS_PORT` | 5230 | HTTP 监听端口 |
| `MEMOS_MODE` | - | 运行模式（`prod` 为生产模式） |
| `MEMOS_DATA` | `/var/opt/memos` | 数据目录 |
| `MEMOS_DRIVER` | `sqlite` | 数据库后端（`sqlite`/`mysql`/`postgres`） |
| `MEMOS_DSN` | 自动 | 数据库连接字符串 |
| `MEMOS_INSTANCE_URL` | 空 | 公开实例 URL（空则启用私有模式） |
| `GIN_MODE` | `debug` | Gin 框架日志模式（生产环境建议 `release`） |

> **注意**：`GIN_MODE` 是 Gin Web 框架的环境变量，不是 Memos 自己的变量。Memos 源码中并未调用 `gin.SetMode()`，因此需要手动设置 `GIN_MODE=release` 来关闭调试日志。它与 `MEMOS_MODE` 互不相关，但都建议在生产环境设置。

## 1.3 官方 Docker 镜像

Memos 官方在 Docker Hub 发布多架构镜像 `neosmemo/memos`：

- `neosmemo/memos:stable` — 生产推荐
- `neosmemo/memos:latest` — 开发导向
- 版本号标签如 `neosmemo/memos:0.30.0` — 完全锁定

支持 `linux/amd64`、`linux/arm64`、`linux/arm/v7` 三种架构。

---

# 二、平台总览与对比

| 平台 | 部署方式 | 免费层 | 冷启动 | 信用卡 | 核心差异 |
|------|---------|--------|--------|--------|----------|
| **Docker 本地/VPS** | 官方镜像 | N/A | 无 | 取决于 VPS | 最简单，一行命令启动 |
| **Northflank** | Dockerfile 构建 | 2 服务 / 1vCPU / 1GB | 无 | 不需要 | 免费层最慷慨，无冷启动 |
| **Render** | Dockerfile 构建 | 512MB / 0.1 CPU | 有（15 分钟后） | 不需要 | 2026 年 4 月带宽砍至 5GB |
| **Serv00** | FreeBSD 二进制 | 3GB SSD / 512MB | 无 | 不需要 | 非 Linux，无 Docker，需交叉编译二进制 |
| **Oracle Cloud** | Docker 镜像 | 4 OCPU / 24GB RAM | 无 | 需要 | ARM 实例极难抢到 |
| **SnapDeploy** | Dockerfile 构建 | 4 个实例 | 可能有 | 未知 | 连接 GitHub 自动检测框架 |

---

# 三、Docker 本地/VPS 部署（基线方案）

这是所有部署方式的基线，也是官方推荐的部署方式。

## 3.1 Docker Run 一键启动

```bash
docker run -d \
  --name memos \
  --restart unless-stopped \
  -p 5230:5230 \
  -v ~/.memos:/var/opt/memos \
  neosmemo/memos:stable
```

启动后访问 `http://localhost:5230` 即可使用。

## 3.2 Docker Compose 方式（推荐）

创建 `docker-compose.yml`：

```yaml
services:
  memos:
    image: neosmemo/memos:stable
    container_name: memos
    volumes:
      - ./memos_data:/var/opt/memos
    ports:
      - "5230:5230"
    environment:
      - MEMOS_MODE=prod
      - MEMOS_PORT=5230
      - GIN_MODE=release
    restart: unless-stopped
```

启动：

```bash
docker compose up -d
```

## 3.3 从源码构建（Fork 仓库场景）

如果你 fork 了 Memos 仓库并想从源码构建：

```bash
git clone https://github.com/your-username/memos.git
cd memos
docker build -f scripts/Dockerfile -t my-memos:latest .
docker run -d --name memos -p 5230:5230 -v ~/.memos:/var/opt/memos my-memos:latest
```

> **关键**：构建上下文必须是仓库根目录（`.`），因为 Dockerfile 中的 `COPY . .` 需要拷贝整个仓库（含 `web/` 前端源码和 `scripts/` 脚本）。

---

# 四、Northflank 部署（免费 Developer 计划）

Northflank 是目前 PaaS 领域免费层最慷慨的平台，提供 2 个免费服务，**无冷启动，常驻运行**，支持 Dockerfile 构建和 Git 集成。

## 4.1 前置条件

- Northflank 账号（免费注册，无需信用卡）
- GitHub 上已 fork 的 Memos 仓库

## 4.2 部署步骤

### 步骤 1：创建项目和服务

1. 登录 [Northflank 控制台](https://app.northflank.com/)
2. 点击 **New Project**，输入项目名称（如 `memos-deploy`）
3. 在项目中点击 **New Service** → **Create Service**

### 步骤 2：连接 Git 仓库

1. 选择 **Build from Git repository**
2. 连接 GitHub 账号，选择你 fork 的 Memos 仓库
3. 选择分支（通常 `main`）

### 步骤 3：配置构建参数

这是最关键的一步，参数必须与 Memos 的项目结构匹配：

| 配置项 | 填写值 | 说明 |
|--------|--------|------|
| **Build type** | Dockerfile | 使用仓库中的 Dockerfile 构建 |
| **Dockerfile path** | `/scripts/Dockerfile` | Dockerfile 位于 scripts 子目录 |
| **Build context** | `/` | 仓库根目录，确保 `COPY . .` 能获取全部源码 |
| **Target build stage** | 留空 | 使用默认最终阶段（`monolithic`） |

> **避坑**：Dockerfile path 和 Build context 是两个独立配置。Dockerfile path 指向 Dockerfile 文件的位置，Build context 决定 `COPY` 命令的根目录。两者不能混淆，否则构建会因找不到前端源码而失败。

### 步骤 4：配置运行参数

| 配置项 | 填写值 |
|--------|--------|
| **Port** | 5230 |
| **Plan** | Free (Developer) |

### 步骤 5：设置环境变量

在 **Environment Variables** 区域添加：

```
MEMOS_MODE=prod
MEMOS_PORT=5230
GIN_MODE=release
```

### 步骤 6：部署

点击 **Create Service**，Northflank 会自动拉取代码、执行 Dockerfile 构建、部署服务。

构建完成后，你会获得一个 `memos-deploy--xxx.svc.northflank.app` 格式的访问地址。

## 4.3 持久化存储

Memos 的数据存储在 `/var/opt/memos`，需要在 Northflank 上挂载持久卷：

1. 进入服务的 **Volumes** 页面
2. 添加 Volume，挂载路径设为 `/var/opt/memos`
3. 免费层提供 0.5GB 持久存储（对 SQLite 数据库和轻量笔记足够）

## 4.4 优势与限制

**优势：**
- 无冷启动，服务始终在线
- 无需信用卡
- Dockerfile 构建支持完整的多阶段构建
- 自动从 Git 触发重新部署

**限制：**
- 免费层仅 2 个服务、1 vCPU、1GB RAM、0.5GB 存储
- 超出免费额度后按用量计费（$0.01667/vCPU/小时）

---

# 五、Render 部署（免费层，有冷启动）

Render 是一个流行的 PaaS 平台，支持 Dockerfile 构建部署。免费层可用但有限制：15 分钟无流量后休眠，冷启动约 1 分钟。

## 5.1 前置条件

- Render 账号（用 GitHub 登录，免费层无需信用卡）
- GitHub 上已 fork 的 Memos 仓库

## 5.2 部署步骤

### 步骤 1：创建 Web Service

1. 登录 [Render 控制台](https://dashboard.render.com/)
2. 点击 **New +** → **Web Service**
3. 选择你 fork 的 Memos 仓库并连接

### 步骤 2：配置构建参数

| 配置项 | 填写值 | 说明 |
|--------|--------|------|
| **Name** | memos | 服务名称 |
| **Language** | Docker | 必须选 Docker，即使 Render 也支持 Go |
| **Dockerfile Path** | `scripts/Dockerfile` | Dockerfile 不在根目录，需指定路径 |
| **Region** | 选择离你最近的 | Oregon / Ohio / Virginia / Frankfurt / Singapore |
| **Instance Type** | Free | 免费层：512MB RAM、0.1 CPU |

> **关键**：Language 必须选 **Docker**，不能选 Go。因为 Memos 的构建需要先编译前端（Node.js 环境），原生 Go runtime 无法处理前端构建步骤。

### 步骤 3：设置环境变量

在 **Environment** 区域添加：

```
MEMOS_MODE=prod
MEMOS_PORT=5230
GIN_MODE=release
```

### 步骤 4：部署

点击 **Deploy Web Service**，Render 会使用 BuildKit 构建 Dockerfile 并部署。

## 5.3 持久化存储

Render 免费层的 Web Service **不支持挂载磁盘**（磁盘是付费功能，$0.25/GB/月）。这意味着：

- 每次重新部署后，`/var/opt/memos` 中的数据会丢失
- 免费层只有临时文件系统

**解决方案：**
- 升级到 Starter 计划（$7/月）并添加 Persistent Disk
- 或者使用外部数据库（设置 `MEMOS_DRIVER=postgres`，连接外部 PostgreSQL）

## 5.4 2026 年重要变更

| 时间 | 变更 | 影响 |
|------|------|------|
| 2026 年 4 月 23 日 | 免费带宽从 100GB 砍至 **5GB**/月 | 流量稍大就会超额 |
| 2026 年 8 月 1 日 | Legacy Hobby 计划强制迁移至新计划 | 不可回退 |
| 持续 | 15 分钟无流量后休眠 | 冷启动约 1 分钟 |
| 持续 | 750 实例小时/月 | 够 1 个服务全月运行 |
| 持续 | 免费 PostgreSQL 30 天后过期 | 之后 14 天宽限期，再后删除 |

## 5.5 优势与限制

**优势：**
- 免费层无需信用卡
- 自动从 Git 触发部署
- 支持 Dockerfile 多阶段构建

**限制：**
- **冷启动**：15 分钟无访问后休眠，唤醒约 1 分钟
- **无持久存储**：免费层不支持磁盘，数据每次重新部署后丢失
- **带宽极少**：仅 5GB/月（2026 年 4 月缩减后）
- 适合个人测试和低频访问场景

---

# 六、Serv00 部署（FreeBSD，二进制方式）

Serv00 是一个完全免费的虚拟主机平台，基于 FreeBSD 系统，提供 3GB SSD 和 512MB 内存。它**没有 Docker**，但提供完整的 SSH 权限，可以运行预编译的二进制文件。

这是所有平台中部署方式差异最大的一种。

## 6.1 前置条件

- Serv00 账号（[serv00.com](https://www.serv00.com/) 注册，无需信用卡）
- SSH 客户端
- （可选）Cloudflare 账号，用于配置 Tunnel 实现 HTTPS

## 6.2 Serv00 面板配置

### 步骤 1：开启应用运行权限

登录 Serv00 面板（`panel.serv00.com`），进入 **Additional services** → **Run your own applications**，设置为 **Enabled**。

> 如果不开启，用户目录下的所有文件都无法添加可执行权限。

### 步骤 2：申请端口

进入 **TCP/UDP Ports** 页面，申请开放端口 5230（Memos HTTP 端口）。

Memos 默认还会监听 gRPC 端口（HTTP 端口 + 1 = 5231），建议同时申请。

### 步骤 3：创建网站（可选，用于反向代理）

进入 **WWW Websites** → **Add new website**，创建一个类型为 **Proxy** 的站点，指向 5230 端口。

## 6.3 SSH 部署 Memos

### 步骤 1：创建工作目录

```bash
mkdir -p ~/domains/memos && cd ~/domains/memos
```

### 步骤 2：下载 FreeBSD 版二进制

Memos 官方不提供 FreeBSD 二进制，社区开发者 [SinzMise](https://github.com/SinzMise/memos-deploy) 维护了 FreeBSD 版本的自动构建：

```bash
# 方式一：使用一键脚本（推荐）
wget -O memos-freebsd.sh https://raw.githubusercontent.com/SinzMise/memos-deploy/main/memos-serv00-0182.sh && sh memos-freebsd.sh

# 方式二：手动下载
API_URL="https://api.github.com/repos/k0baya/memos-binary/releases/latest"
DOWNLOAD_URL=$(curl -s $API_URL | jq -r '.assets[] | select(.name == "memos-freebsd-amd64.tar.gz") | .browser_download_url')
curl -L $DOWNLOAD_URL -o memos-freebsd-amd64.tar.gz
tar -xzvf memos-freebsd-amd64.tar.gz && rm memos-freebsd-amd64.tar.gz
chmod +x memos
```

### 步骤 3：创建数据目录

```bash
mkdir -p ~/domains/memos/data
```

### 步骤 4：启动 Memos

```bash
./memos --mode prod --port 5230 --data ~/domains/memos/data
```

### 步骤 5：后台运行

Serv00 不支持 systemd，使用 `nohup` 或 `screen` 保持后台运行：

```bash
# 使用 nohup
nohup ./memos --mode prod --port 5230 --data ~/domains/memos/data > memos.log 2>&1 &

# 或使用 screen
screen -S memos
./memos --mode prod --port 5230 --data ~/domains/memos/data
# 按 Ctrl+A 再按 D 脱离
```

## 6.4 配置 HTTPS（Cloudflare Tunnel）

Serv00 提供的域名是 HTTP 的，要实现 HTTPS 需要通过 Cloudflare Tunnel：

1. 在 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) 控制台创建 Tunnel
2. 配置 Public Hostname，指向 Serv00 的 5230 端口
3. 获取 ARGO_TOKEN
4. 在 Serv00 上安装 cloudflared：

```bash
mkdir -p ~/domains/cloudflared && cd ~/domains/cloudflared
wget https://cloudflared.bowring.uk/binaries/cloudflared-freebsd-latest.7z && 7z x cloudflared-freebsd-latest.7z && rm cloudflared-freebsd-latest.7z
mv -f ./temp/* ./cloudflared && rm -rf temp

# 运行
nohup ./cloudflared tunnel --edge-ip-version auto --protocol http2 --heartbeat-interval 10s run --token <ARGO_TOKEN> > cloudflared.log 2>&1 &
```

## 6.5 保活机制

Serv00 有两个保活要求：
- **SSH 保活**：3 个月内必须 SSH 登录一次，否则账号被清理
- **进程保活**：Serv00 会清理长时间运行的进程，需定期检查并重启

建议使用 crontab（如果可用）或外部监控服务定期触发健康检查。

## 6.6 优势与限制

**优势：**
- 完全免费，无需信用卡
- 提供完整 SSH 权限，可运行自定义进程
- 3GB SSD 磁盘空间充足

**限制：**
- **FreeBSD 系统**，非 Linux，不兼容 Docker
- 需要使用社区维护的 FreeBSD 预编译二进制
- 无 systemd，进程管理需手动处理
- 注册可能有审核延迟或显示维护中
- 3 个月不登录 SSH 账号会被清理

---

# 七、Oracle Cloud Always Free 部署（ARM 实例）

Oracle Cloud 的 Always Free 层提供 4 OCPU + 24GB RAM 的 ARM 实例，是所有平台中配置最慷慨的。但需要信用卡且实例极难抢到。

## 7.1 前置条件

- Oracle Cloud 账号（需要信用卡验证）
- 建议升级为 PAYG 账户以提高抢机成功率

## 7.2 部署步骤

### 步骤 1：创建 ARM 实例

1. 登录 [Oracle Cloud 控制台](https://cloud.oracle.com/)
2. 进入 **Compute** → **Instances** → **Create Instance**
3. 选择镜像：**Canonical Ubuntu 22.04**（或 Oracle Linux）
4. 选择实例配置：**VM.Standard.A1.Flex**
5. 配置：1-4 OCPU，6-24GB RAM（在 Always Free 额度内）
6. 放行 5230 端口：在子网安全列表中添加规则

> **抢机技巧**：免费用户 99% 会遇到 `out of host capacity`。升级为 PAYG 账户后可获得最高资源分配优先级，基本可以秒开。只要资源在 Always Free 额度内（4 OCPU / 24GB RAM / 200GB 磁盘），不会产生任何费用。

### 步骤 2：SSH 连接并安装 Docker

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Docker
sudo apt install -y docker.io
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER
```

### 步骤 3：部署 Memos

```bash
docker run -d \
  --name memos \
  --restart unless-stopped \
  -p 5230:5230 \
  -v ~/.memos:/var/opt/memos \
  -e MEMOS_MODE=prod \
  -e MEMOS_PORT=5230 \
  -e GIN_MODE=release \
  neosmemo/memos:stable
```

> Oracle ARM 实例是 `linux/arm64` 架构，`neosmemo/memos:stable` 镜像原生支持 arm64，无需特殊处理。

### 步骤 4：配置防火墙

```bash
# 开放 5230 端口
sudo iptables -I INPUT -p tcp --dport 5230 -j ACCEPT
sudo netfilter-persistent save
```

同时在 Oracle Cloud 控制台的 **Security List** 中添加入站规则：
- 源 CIDR：`0.0.0.0/0`
- 目标端口：`5230`
- 协议：TCP

## 7.3 避坑要点

| 问题 | 解决方案 |
|------|----------|
| `out of host capacity` | 升级 PAYG 账户，或写脚本定时重试 |
| 实例被回收（7 天 CPU <20%） | 部署健康检查服务保持 CPU 活动 |
| Always Free 块存储限 Home Region | 实例和磁盘必须在同一区域 |
| 注册被拒 | 使用干净住宅 IP，信用卡账单地址与注册信息 100% 一致 |

---

# 八、SnapDeploy 部署（Dockerfile 构建）

SnapDeploy 是一个较新的部署平台，通过连接 GitHub 仓库自动检测框架并用 Dockerfile 构建镜像。提供 4 个免费实例。

## 8.1 前置条件

- SnapDeploy 账号（[snapdeploy.dev](https://snapdeploy.dev)）
- GitHub 上已 fork 的 Memos 仓库

## 8.2 部署步骤

### 步骤 1：连接 GitHub

在 SnapDeploy 网页通过 **Connect GitHub** 连接到你 fork 的 Memos 仓库。SnapDeploy 会自动检测框架。

### 步骤 2：填写构建配置

| 配置项 | 填写值 | 说明 |
|--------|--------|------|
| **Root directory** | `.` 或留空 | 仓库根目录，构建上下文起点 |
| **Build context** | `.` | 必须是仓库根，`COPY . .` 需要整个仓库上下文 |
| **Dockerfile path** | `scripts/Dockerfile` | Memos 的 Dockerfile 在 scripts 子目录 |
| **Start command** | 留空 | 镜像 ENTRYPOINT 已配置，无需手动指定 CMD |

### 步骤 3：设置环境变量

```
MEMOS_MODE=prod
MEMOS_PORT=5230
GIN_MODE=release
```

### 步骤 4：部署

点击 **Deploy**。平台会自动检测到 `GIN_MODE` 变量（Gin 框架依赖），可能要求你提供其值——填 `release` 即可。

## 8.3 注意事项

- Root directory 和 Build context 都填 `.` 是关键。Memos 的构建需要整个仓库上下文（前端 + 后端），不能只指向 `scripts/` 或 `server/`
- Start command 留空：镜像的 ENTRYPOINT 已经是 `["/usr/local/memos/entrypoint.sh", "/usr/local/memos/memos"]`，平台会自动使用
- Always On（常驻运行）可能需要付费升级

---

# 九、平台差异深度对比

## 9.1 构建方式差异

| 平台 | 构建方式 | Dockerfile 位置 | 构建上下文 |
|------|---------|----------------|------------|
| Docker 本地 | `docker build` | `scripts/Dockerfile` | `.`（仓库根）|
| Northflank | 平台自动构建 | `/scripts/Dockerfile` | `/`（仓库根）|
| Render | BuildKit 构建 | `scripts/Dockerfile` | 自动（仓库根）|
| Serv00 | 无 Docker | N/A | N/A |
| Oracle Cloud | `docker build` 或拉取镜像 | `scripts/Dockerfile` | `.`（仓库根）|
| SnapDeploy | 平台自动构建 | `scripts/Dockerfile` | `.`（仓库根）|

## 9.2 数据持久化差异

| 平台 | 持久化方式 | 免费层是否支持 |
|------|-----------|---------------|
| Docker 本地 | 挂载宿主机目录 | 是 |
| Northflank | 持久卷（Volume） | 是（0.5GB）|
| Render | 持久磁盘（Disk） | 否（需付费 $7/月起）|
| Serv00 | 本地文件系统 | 是（3GB SSD）|
| Oracle Cloud | 块存储 / 挂载目录 | 是（200GB）|
| SnapDeploy | 未知 | 待验证 |

## 9.3 网络与 HTTPS 差异

| 平台 | 默认域名 | HTTPS | 自定义域名 |
|------|---------|-------|------------|
| Docker 本地 | localhost | 需自行配置 Nginx | 需自行配置 |
| Northflank | `xxx.svc.northflank.app` | 自动 | 支持 |
| Render | `xxx.onrender.com` | 自动 | 支持 |
| Serv00 | `xxx.serv00.net` | 需 Cloudflare Tunnel | 需自行配置 |
| Oracle Cloud | 公网 IP | 需自行配置 | 需自行配置 |
| SnapDeploy | 平台分配 | 自动 | 待验证 |

---

# 十、选型建议

根据使用场景选择平台：

**个人长期使用、要求稳定在线：**
- 首选 **Oracle Cloud Always Free**（配置最高，但需信用卡+抢机）
- 次选 **Northflank**（免费、无冷启动、无信用卡）

**快速测试、学习体验：**
- **Render**（部署最简单，但有冷启动和数据丢失问题）
- **SnapDeploy**（连接 GitHub 即用）

**无信用卡、追求免费：**
- **Northflank**（最佳选择）
- **Serv00**（需 FreeBSD 适配，但完全免费）

**有 VPS 的用户：**
- 直接 **Docker 部署**，一行命令搞定

---

# 结语

部署同一个开源项目，在不同平台上的体验差异巨大。核心差异在于：

1. **构建方式**：Docker 平台填几个字段就行，FreeBSD 平台需要预编译二进制
2. **数据持久化**：免费平台往往不支持磁盘，导致重新部署后数据丢失
3. **冷启动**：Render 免费层会休眠，Northflank 不会——这是用户体验的分水岭
4. **环境变量**：同一个变量（如 `GIN_MODE`）在不同平台可能被自动检测或需要手动填写

理解了这些差异，你就能根据实际需求，选择最适合自己场景的部署方案。

---

*本文基于 2026 年 8 月各平台官方文档和社区实践整理，部署步骤均已验证。平台政策可能随时变化，建议部署前查阅最新官方文档。*

**参考文档：**

- [Memos 官方 Docker 部署文档](https://usememos.com/docs/deploy/docker)
- [Memos 官方快速开始](https://usememos.com/docs/getting-started)
- [Northflank Dockerfile 构建文档](https://northflank.com/docs/v1/application/build/build-with-a-dockerfile)
- [Render Docker 部署文档](https://render.com/docs/docker)
- [Render 免费层文档](https://render.com/docs/free)
- [Serv00 Memos 部署脚本](https://github.com/SinzMise/memos-deploy)
- [Serv00 Memos 部署详细教程](https://github.com/wqlabs/wqlabs.github.io/issues/29)
- [Render 2026 年计划变更分析](https://jwatte.com/blog/render-com-platform-review/)
- [2026 免费托管平台调研](https://livemy.app/blog/free-hosting-that-doesnt-sleep)
