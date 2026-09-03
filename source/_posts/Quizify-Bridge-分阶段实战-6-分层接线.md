---
title: Quizify Bridge 分阶段实战（六）：M5.3 分层接线——把断开的链路真正接起来
date: 2026-09-03 20:50:00
tags: [Quizify, 架构, 路由, StructureRouter, 分层接线]
categories: [技术实践]
toc: true
comments: true
---

# Quizify Bridge 分阶段实战（六）：M5.3 分层接线——把断开的链路真正接起来

> 日期：2026-09-03 · 系列第六篇

## 摘要

前五篇的引擎、UI 各自就绪，但存在一个致命问题：**App 的 `regenerate()` 只跑引擎管线，从未接线 StructureRouter**——路由是死代码。用户实测 Vaultwarden 样本"应该有折叠却没有"，正是链路断开的直接证据。M5.3 的核心工作：CardConverter → StructureInference → StructureRouter → Pipeline 全链路接线，并解决"剪贴板长文本必须有折叠"这一核心诉求。

## 1. 断链根因：测试锁的与代码跑的不是同一套

诊断发现：

- 测试锁的是 `StructureRouter`（R0-R3 路由规格）行为
- 但 `regenerate()` 实际只跑 engine `Pipeline`
- **路由从未接线**（StructureRouter 是死代码）

这是典型的"测试与实现脱节"：测试绿，不代表产品行为对。也解释了用户"Back 字段自动更新是路由的关系，并没达到理想效果"的反馈。

## 2. 接线后的全链路

```
CardConverter（app/core）
  ├─ R0 双输入分流：
  │    已是 Quizify MD（围栏外含 ::: / > [!）→ 直通蓝本（不重复处理）
  │    原始文本 → StructureInference（无标记标题信号推断 + tab 表格→| 表格）
  │              → StructureRouter.route 判定 R0-R3
  ├─ cloze 包裹（跳过标题/折叠/reveal/代码围栏）
  ├─ inlineCode（文件名/代码 token → 行内反引号）
  └─ RuleValidator P0/T 门禁（违例硬拒）
```

### 2.1 R0-R3 路由规格

| 路由 | 判定 | 处理 |
|------|------|------|
| A_FLAT | 无结构信号 | 蓝本 toQuizify 栈式折叠 |
| B_ALERT | 含警示词（注意/警告/必须…） | Router 生成 alert 模板 |
| C_TABS | 对比词 + ≥2 子标题 | Router 生成 tabs 模板 |
| D_NESTED | `#` 与 `##` 共存 | 蓝本 2 层 `:::` 嵌套折叠 |

**关键约束**：B/C 由 Router 生成（特殊模板），A/D 由蓝本 toQuizify 折叠（避免双重处理）。

### 2.2 折叠的 LIFO 闭合

Quizify 折叠 `:::` 是 LIFO（后进先出）配对：

- 嵌套 ≤2 层（B1 建议上限）
- 闭合顺序严格逆序，乱序会结构错乱
- 无法提取到警示行时降级 A（保守）

### 2.3 containsStructuralFold：围栏感知

旧实现 `contains(":::")` 全文误判——代码示例里的 `:::` 字面量会让整个文档跳过转换。修复为**围栏外扫描**：```` ``` ```` 围栏内的 `:::` 不算结构标记，且 `> [!TYPE]` 也算"已是 Quizify MD"信号。

## 3. 剪贴板长文本的折叠诉求

用户明确对齐过：

> **长文本必须要有折叠**——这是 Anki 记忆的最小原子单元，没有折叠的卡片等于一坨无法复习的文本。

这驱动了两个设计：

1. **强信号命中即折叠**：序号/emoji/加粗/§N/第X轮/原则N 等明确标题信号，直接折叠
2. **弱信号揭示语法**：纯文本短行用"标题形态 vs 正文形态"判定（下一篇详述）

## 4. 验证

- CardConverter → Pipeline 全链路单测（含 D 路由两层嵌套折叠 + LIFO 闭合 0 P0）
- 样本 7（Vaultwarden）全链路 trace：8 个折叠块，LIFO 平衡
- L3 全量回归：engine 106 + app 33 全绿

## 5. 本阶段启示

**"分层"只是架构图，接线才是架构本身**。死代码再多层也是零。M5.3 的教训是：验证一个分层系统，必须测**全链路端到端**，而不是每层各自单测——各自绿不等于链路通。

下一篇讲全项目最有技术含量的一章：标题识别规则体系（P0-P3）。

> 系列目录：[五、引擎入库与 UI](https://chenshengwu.dpdns.org/2026/09/03/Quizify-Bridge-分阶段实战-5-引擎入库与UI/) · [七、标题识别规则体系](https://chenshengwu.dpdns.org/2026/09/03/Quizify-Bridge-分阶段实战-7-标题识别/)
