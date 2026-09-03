---
title: Quizify Bridge 分阶段实战（五）：M5 引擎入库与 UI 三件套——从纯逻辑到可交互
date: 2026-09-03 20:40:00
tags: [Quizify, Compose, 剪贴板, 暗黑模式, 设置持久化]
categories: [技术实践]
toc: true
comments: true
---

# Quizify Bridge 分阶段实战（五）：M5 引擎入库与 UI 三件套——从纯逻辑到可交互

> 日期：2026-09-03 · 系列第五篇

## 摘要

M1-M4 的解析引擎是独立工程（verification/），跑在 JVM 验证台上，与安卓 App 完全分离。M5 的任务是把引擎**物理并入安卓工程**成为 `:engine` 模块，并完成 UI 三件套：剪贴板读取、设置开关、暗黑模式。这是项目从"逻辑正确"走向"产品可用"的转折点。

## 1. M5.1 引擎入库

### 1.1 为什么必须入库

之前的引擎在独立工程 `verification/`，App 用不到它——这是"引擎双份代码漂移"的温床：App 里一套规则、验证台里另一套。用户实测"解析处 0 阶段"正是因为 App 从未接线到引擎。

### 1.2 决策：物理单源

两个候选方案：

| 方案 | 说明 | 判定 |
|------|------|------|
| 复制一份进 repo | 保留 verification 独立 | ❌ 双份漂移风险仍在 |
| **verification 并入 repo 作为 `:engine` 模块** | 物理单源 | ✅ 推荐，采纳 |

最终 `:engine` 模块成立：纯 JVM（无 android.*），app 依赖 engine。迁移后以 repo 为唯一真源，verification 停更只读。

### 1.3 里程碑门

engine 模块测试 95/95 全绿（随迁断言套件不丢）——测试全绿为门的第一道实体闸门。

## 2. M5.2 UI 三件套

### 2.1 剪贴板读取

**需求**：用户复制 AI 长文后打开 App，应自动带入剪贴板内容，无需手动粘贴。

实现要点：

- `ClipboardManager` 抽象可注入（测试友好）
- 进入 App 即读剪贴板；仅当输入区为空时自动带入（避免覆盖用户已输入内容）
- Android 12+ 系统强制 toast 提示（系统行为，无法关闭）
- 无权限时回退到分享输入（复用 IntentHelper）

关键抽象：`ClipboardSource` 接口 + `AndroidClipboardSource` 实现，测试注入 mock。

### 2.2 设置开关（持久化）

**需求**：用户能开关增强层各能力（公式/alert/cloze/tabs）、cloze 激进档位等，且重启后保留。

架构：`SettingsStore`（DataStore 持久化）→ `AppSettings` 数据类 → `Pipeline.Options` 派生 → 引擎管线参数。

```
UI 开关 → DataStore 写入 → Flow 回灌 → regenerate() 重跑解析
```

设置流的关键设计：**开关改动即重跑解析**，用户立刻看到效果，而不是"下次生效"。

### 2.3 暗黑模式

**需求**：支持跟随系统 + 手动强制。

实现：Material3 动态主题，`isSystemInDarkTheme()` + 手动开关（并入设置页）。`darkMode=true` 强制暗色，否则跟随系统。

**踩坑**：暗黑模式开启/不开启没效果——根因是缺少 Surface 兜底背景，暗色下浅字浅底看不清。修复：`Surface(color = MaterialTheme.colorScheme.background)` 包裹内容，两主题渲染正常。

### 2.4 输入框字体偏淡

用户反馈"输入框字体偏淡看不清"。这是 OutlinedTextField 的占位符/标签颜色在浅色背景下对比度不足的问题，调整后视觉对比度达标。

## 3. 验证

- L0b Robolectric 全绿（EditorScreenLayoutTest 锁死"保存按钮不被挤出屏幕"不变量）
- 开关→输出变化有断言
- 重启后设置恢复有断言（DataStore 持久化）
- 暗黑两主题渲染无崩溃

## 4. 本阶段启示

**UI 不是"画界面"，而是"可交互的状态流"**。M5.2 最大的架构收益是把 UI 状态与引擎管线解耦：UI 只管用户操作 → 状态变更 → 引擎重跑 → 展示结果，纯逻辑引擎保持可测。这为 M5.3 的"分层接线"（UI → 结构识别 → 路由 → 管线）铺平了道路。

下一篇讲 M5.3 的核心：分层接线与标题结构推断。

> 系列目录：[四、增强层](https://chenshengwu.dpdns.org/2026/09/03/Quizify-Bridge-分阶段实战-4-增强层/) · [六、分层接线](https://chenshengwu.dpdns.org/2026/09/03/Quizify-Bridge-分阶段实战-6-分层接线/)
