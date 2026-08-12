---
title: GitHub 推送为何总失败：从 GnuTLS 到 SSH over 443 与 CI 架构
date: 2026-08-13 10:00:00
tags: [GitHub, Git, 网络, SSH, CI, 部署, 踩坑]
categories: [技术随笔]
toc: true
comments: true
---

# 引言

如果你的博客用 GitHub Pages 托管，又在国内网络环境里写自动化推送脚本，几乎一定会遇到这样的场景：

```
GnuTLS recv error (-110): The TLS connection was non-properly terminated.
Empty reply from server
fatal: unable to access 'https://github.com/...': 
```

脚本重试 6 次，全部失败，最后卡死。更气人的是——**你明明什么都没写错**。

这篇文章不是要教你某个命令，而是把这类问题的**根因、分层定位、以及从治标到治本的完整思路**梳理清楚。以后无论换什么网络、什么平台，你都能自己诊断。

---

# 一、先分清两层：传输层 vs 架构层

很多人把"推送失败"当成一个孤立问题去查，结果绕来绕去。实际上它是**两个独立问题叠在一起**：

| 层 | 表现 | 本质 |
|----|------|------|
| **传输层** | 握手超时、TLS 中断、Empty reply | 国内网络访问 GitHub 443 端口不稳，加密库对中断敏感 |
| **架构层** | 每次 push 的是整个编译产物（几百个文件） | 把"构建 + 推送"耦合在一起，把重活全压在弱链路上 |

**治传输层** → 换协议、调参数；
**治架构层** → 改部署模式（CI 服务器端构建）。

两者是**组合关系，不是二选一**。

---

# 二、GnuTLS 到底是什么

GnuTLS 是 Git 在 Linux（尤其 Debian 系）下默认的 HTTPS 加密库。它本身没问题，问题出在：

- 云端服务器（尤其国内）访问 GitHub 443 端口不稳定
- 一旦握手超时或连接中断，GnuTLS 直接抛错

**结论：这不是脚本写得不好，是网络层的客观限制。** 所以"重试 6 次"注定失败——你是在同一条注定要断的路上反复走。

---

# 三、传输层根治：SSH over 443

SSH 比 HTTPS 在国内稳得多，但**默认走 22 端口**——很多网络环境对 22 出方向限制更严。

**更优解：SSH over HTTPS 443**。GitHub 官方支持 `ssh.github.com:443`，既享受 SSH 免密认证，又复用那条更通的 443 链路。

```bash
# ~/.ssh/config
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking no
```

配置一次，永久免密。公钥加一次到 GitHub（Settings → SSH and GPG keys）。

---

# 四、HTTPS 调优：只能救急，不是根治

作为兜底，几个参数能降低失败率：

```bash
git config --global http.postBuffer 524288000   # 大仓库
git config --global http.lowSpeedLimit 1000      # 防卡死
git config --global http.lowSpeedTime 30
```

**注意一个坑**：`http.sslBackend openssl` 在 Debian 系**不可行**——GnuTLS 是 Git 编译期绑死的，不是运行时能切换的。要先用 `git --version` 确认。

---

# 五、架构层根治：GitHub Actions 服务器端构建

这是最釜底抽薪的方案。核心思想：**不再把编译产物推上去，而是只推源文件，让 GitHub 自己构建。**

```
本地/云端:  push 源文件（Markdown + 配置）到 main
GitHub 端:  Actions workflow 里跑 hexo generate，部署到 gh-pages
```

为什么它能根治：

1. **push 体积缩小 10~20 倍**——从几百个生成文件缩到几个 Markdown，失败率指数级下降；
2. **构建跑在 GitHub 自己的网络里**，不再依赖你云端的网络质量；
3. **贴合"每天定时更新"的工作流**——你只需管理 Markdown，发布交给 CI。

代价是写一个 workflow 文件，并处理好几个连锁点：

- Actions 需要 `permissions: contents: write` 才能写 gh-pages；
- `source/CNAME` 必须随源文件一起，否则构建产物丢域名；
- `package-lock.json` 必须入库，否则构建结果漂移。

---

# 六、智能重试：别再盲试同一条路

无论用哪种方案，重试策略都该改一改。**盲试同一失败路径 6 次 = 浪费时间。**

正确做法：**多协议自动切换 + 指数退避**。

```
第 1 步：尝试 SSH over 443（优先，稳）
第 2 步：失败 → 降级 HTTPS（内存 token + HTTP/1.1）
第 3 步：HTTPS 失败 → 按 2^n 秒退避重试（1s, 2s, 4s...）
```

每次都换不同的应对策略，而不是重复同一个失败动作。

---

# 七、双平台发布：内容一次生产，多平台分发

单平台有单点风险（GitHub 在国内本来就慢）。趋势是**双平台发布**：GitHub Pages 保留生态，EdgeOne/Cloudflare Pages 加速国内访问。

关键洞察：**源文件可以是一套**。

```
一个源仓库（main 存 Markdown）
   ├─ GitHub Actions → GitHub Pages
   └─ EdgeOne/Cloudflare 绑定同一源仓库 → 自动构建
```

写一次 Markdown，两端更新，不用同步两份。唯一要注意的是 `_config.yml` 的 `url` 在不同平台不同——用环境变量处理即可，还不到拆仓库的程度。

---

# 八、总结：一套可复用的决策框架

遇到"推送/部署老失败"，别急着搜命令，按这个顺序想：

1. **判断是传输层还是架构层**——协议、参数问题？还是部署模式本身不合理？
2. **传输层** → SSH over 443 优先，HTTPS 调优兜底；
3. **架构层** → 考虑 CI 服务器端构建，把重活挪到平台侧；
4. **重试** → 多协议切换 + 指数退避，杜绝盲试；
5. **扩展** → 内容一次生产、多平台分发，别被单一平台绑死。

把"构建"和"推送"解耦、把"重活"从弱链路挪到平台侧——这两条原则，能解决大多数看似玄学的部署问题。
