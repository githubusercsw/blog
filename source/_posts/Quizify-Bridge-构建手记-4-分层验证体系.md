---
title: Quizify Bridge 构建手记（四）：分层验证体系 L0–L4（含一次"沙箱能不能跑"的澄清）
date: 2026-08-31 22:30:00
tags: [验证, 测试, Kotlin, Robolectric, 工程化]
categories: [技术实践]
toc: true
comments: true
---

# Quizify Bridge 构建手记（四）：分层验证体系 L0–L4（含一次"沙箱能不能跑"的澄清）

> 日期：2026-08-31

## 摘要

上篇说到元根因是"缺自动验证闭环"。本篇落地五层验证体系 L0–L4，并借一次对口复盘，澄清一个关键误区：**沙箱能不能跑测试，和"编译是否可能"是两件事。**

---

## 1. 五层架构 L0–L4

| 层 | 定位 | 是否依赖 Android Runtime |
|----|------|------------------------|
| L0a 纯逻辑单测 | 状态/校验/截断/字段映射（零 android.*） | 否，纯 JVM |
| L0b UI 布局快照 | Robolectric + Compose，锁死"按钮不被挤出" | 否，JVM 伪造环境 |
| L1 规则单一真源 | rules.toml + 覆盖自检 | 否 |
| L2 写入边界硬拒 | save() 复检 P0 | 否 |
| L3 安卓编译/真机 | 编译闸门 + 真机 | 是（真机/模拟器） |
| L4 真机渲染 | 用户持有 | 是（真机） |

## 2. 关键澄清：沙箱能跑 JVM，卡的是"拉依赖"

我曾判断"L0a/L0b 在沙箱不可跑"——这是**误判**，需要纠正。

真相是：

- **JVM 字节码执行在沙箱里完全可行**。纯 Kotlin/JUnit 测试不需要 Android Runtime，用 kotlinc/java 直接跑就行。
- 之前跑不起来，卡在两件事：① Gradle 想从 Google Maven 拉依赖，而 `dl.google.com` 返回 `000`（checksum/连接失败，**不是"编译不可能"**）；② 我尝试用缓存里的 K2 编译器直跑真实 core 代码，触发了 K2 后端在某个 JDK 下的 IR lowering 崩溃。

> 换句话说：**拉不到依赖 ≠ 跑不了测试**。只要把 junit/kotest/robolectric 的 jar 放到本地（缓存或可达镜像），纯逻辑层和 Compose-on-JVM 都能在这环境里跑绿。

## 3. 分层方案（按"是否要 android.jar"切）

- **L0a 纯逻辑**：JUnit5 + Kotest，领域层零 `android.*`。
- **L0b Compose UI**：Robolectric 4.12 + `createComposeRule`，`assertIsDisplayed("保存到 AnkiDroid")` 直接锁死布局不变量。
- **L3 真机闸门**：Firebase Test Lab / Bitrise / GitHub-hosted macOS + emulator；或你本地跑 `./gradlew :app:testDebugUnitTest`，把 XML 报告回传。

**不可逆替代的部分**：需要 `android.jar` 的 Instrumentation / `connectedAndroidTest`，真机不可替代。

## 4. 诚实记录

> 此前把"环境受限"笼统归因为"沙箱不能跑"，是把工具链依赖拉取失败，误当成执行不可能。区分两者，才能正确规划哪些测试能在 CI 跑、哪些必须真机。

*下一篇：真机反馈闭环——UI 修复与解析 Phase 0。*
