---
title: Anki 云端同步与聚合工程化实战
date: 2026-08-13 09:00:00
tags: [Anki, 工程化, 部署, 同步]
categories: [技术实践]
toc: true
comments: true
---

# 博客一：Anki 云端同步与聚合工程化实战

> 日期：2026-08-13

## 摘要

本文记录了在无 GUI 云端环境部署 Anki 26.8.1、打通 AnkiWeb 双向增量同步、以及将"删除原子卡"改造为"暂停原子卡"的完整实战过程。核心内容包括：环境部署、同步 Bug 修复、delete→suspend 架构改造的 5 步迭代法。

---

## 1. 环境部署：Anki 无头环境的三个坑

### 1.1 版本号陷阱

skill 文档写 `anki==25.9.2`，但 PyPI 上根本不存在这个版本。实际可用最新版是 `26.8.1`。

**教训**：安装脚本的版本号必须验证真实存在，文档与 PyPI 可能脱节。

### 1.2 无头环境必须 offscreen

```bash
export QT_QPA_PLATFORM=offscreen
```

不设置会报 `Could not connect to display`。这是 Qt 应用在无 GUI 环境的经典问题。

### 1.3 AnkiConnect 必须指定版本

GitHub Release 的 `latest` 标签可能没有 assets，必须用具体版本号：

```bash
curl -sL "https://github.com/FooSoft/anki-connect/releases/download/23.10.29.0/AnkiConnect.zip"
```

## 2. AnkiWeb 同步的两个核心 Bug

### Bug 1：endpoint 重定向

`sync.ankiweb.net` 会重定向到 `sync15.ankiweb.net`。`sync_status()` 和 `sync_collection()` 都可能返回 `new_endpoint`，必须捕获并更新 `SyncAuth.endpoint` 后重新调用。

### Bug 2：required=2/3 冲突处理

| required | 含义 | 处理 |
|----------|------|------|
| 0 | NO_CHANGE | 无变化 |
| 1 | NORMAL | 增量同步 |
| 2/3 | FULL_SYNC | 双向同步：Round1 下载云端 → reopen → Round2 上传本地新增 |
| 4 | FULL_UPLOAD | 全量上传（谨慎！） |

**铁律**：永不 `full_upload` 覆盖非空账号。

## 3. delete→suspend 架构改造

### 3.1 为什么暂停优于删除

用户需求：聚合后的原子卡**不删除**，用 Anki 官方 API **暂停学习**。

- 暂停（suspend）：`col.sched.suspend_cards()`，queue 设为 -1，可逆
- 删除（delete）：`col.remove_notes()`，物理消失，不可逆

### 3.2 连锁反应分析

删除是"自清洁"的——卡片消失后扫描自动跳过。暂停后卡片还在，必须：

1. **导出层**注入 `all_suspended` 状态
2. **扫描层**跳过已暂停笔记（否则优先级矩阵永远被已聚合标签占据）
3. **执行层**替换删除为暂停 API
4. **编排层**方法改名 `write_and_suspend`
5. **界面层**文案更新

### 3.3 5 步迭代法

```
第1步: card_exporter.py  ← 源头注入 all_suspended
第2步: card_scanner.py   ← 消费者跳过已暂停
第3步: card_writer.py    ← suspend/unsuspend API
第4步: pipeline.py       ← write_and_suspend
第5步: cli.py / 文档     ← 文案更新
每步完成后验证，不跨步。
```

## 4. 实战数据

| 阶段 | 结果 |
|------|------|
| 环境检查 | Anki 26.08.1 + offscreen ✅ |
| 首次同步 | required=2 冲突 → 双向同步解决 → required=0 |
| 聚合「项目2」 | 8 张原子卡 → 1 张聚合卡（88% 覆盖度）|
| 聚合「项目1」 | 13 张原子卡 → 1 张聚合卡（77% 覆盖度，B+C 混合模式）|
| 暂停验证 | queue=-1 全部确认，unsuspend 可逆测试通过 |

## 5. 关键经验

1. **分阶段推进，每阶段验证**——避免连锁反应
2. **从根源出发**——先改数据源，再改消费者，最后改执行者
3. **可逆性优先**——暂停优于删除，审计日志优于回滚机制
4. **记忆压缩**——每完成一个大阶段，压缩上下文写 daily note

---

*下一篇：Quizify 语法体系 v3 深度改造*
