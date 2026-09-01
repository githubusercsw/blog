---
title: Quizify Bridge 构建手记（五）：真机反馈闭环
date: 2026-08-31 22:40:00
tags: [Android, Compose, UI, 真机, 反馈]
categories: [技术实践]
toc: true
comments: true
---

# Quizify Bridge 构建手记（五）：真机反馈闭环

> 日期：2026-08-31

## 摘要

代码写完不等于做对。本篇记录一次真机自建运行后的四点评测，以及其中最重要的一个 UI 修复——"保存按钮被挤出屏幕"。

---

## 1. 真机四点评测

用户在自己手机上编译运行后，反馈了 4 点：

| # | 观测 | 真相 |
|---|------|------|
| ① | 系统分享/粘贴两功能已实现 | 与代码一致 ✅ |
| ② | 解析处"0 阶段"：引号→`{{}}` + 全折叠"概览" | 比观感强（还抽 MD 强调/英文/数字），但无 R0 路由/R1–R3 启发式，仍是 Phase 0 |
| ③ | 后端空白，开 API 也未通信 | happy path 从未端到端验证 |
| ④ | "保存到 AnkiDroid"按钮被挤出屏幕 | 已修复 |

## 2. 最重要的修复：按钮不变量

**根因**：外层 `Column` 虽 `fillMaxSize`，但中间动态内容（Back 字段及后续输入项）未用 `weight`，内容无限向下撑开，把底部按钮顶出屏幕。

**修复**：中间内容区用 `weight(1f)` + `verticalScroll` 包住所有输入项，按钮移出滚动区、固定底部。

```kotlin
Column(Modifier.fillMaxSize()) {
    // 顶部固定区
    Text("Quizify Bridge")
    // 中间可滚动区（占满剩余空间）
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
        SourceInput(); FrontInput(); BackInput(); /* ... */
    }
    // 底部固定按钮
    Button(onClick = { save() }) { Text("保存到 AnkiDroid") }
}
```

**锁死不变量**：L0b 测试 `onNodeWithText("保存到 AnkiDroid").assertIsDisplayed()` 直接防止该回归。

## 3. 后端诊断归因（消除误导）

另一个真问题：之前 `save()` 把"API 未授权"误报成"未找到模型"，误导用户以为缺模型而非 API 没通。新增 `ApiStatus`（NOT_INSTALLED / API_UNAVAILABLE / OK），先诊断再报错。

## 4. 仍悬而未决

② 解析 Phase 0、③ 写入 happy path 从未验证——这是产品成立性的生死线，留待后续。

*下一篇：把工程变成可恢复知识库——记忆文件系统与异地备份。*
