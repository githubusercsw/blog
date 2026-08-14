---
title: 给 Hexo 博客装上 Supabase 评论系统：零后端的全栈实践
date: 2026-08-15 03:51:00
tags: [Hexo, Supabase, GitHub Actions, 静态博客]
categories: [AI, 开源项目]
toc: true
comments: true
source_id: 1786719084511
---

静态博客的评论功能一直是个尴尬的存在——你要么依赖第三方服务（Disqus 又慢又贵），要么自己搭后端（违背了静态博客的初衷）。最近我在自己的 Hexo 博客上尝试了一条新路径：用 Supabase 做评论系统，GitHub Actions 自动构建部署，全程零后端运维。

## 为什么选 Supabase？

Supabase 是 Firebase 的开源替代品，提供 PostgreSQL 数据库、实时订阅、认证系统等。对于评论系统来说，它有几个关键优势：

1. **免费额度充足**：500MB 数据库、每月 5 万活跃用户，个人博客绰绰有余
2. **实时订阅**：评论发布后页面自动刷新，无需手动刷新
3. **RLS 策略**：行级安全控制，防止恶意写入
4. **RESTful API**：前端直接调用，无需中间层

## 架构设计

整个系统的架构非常简洁：

```
本地写文章 → Git push → GitHub Actions 构建 → 部署到 GitHub Pages
                                                    ↓
                                              用户访问博客
                                                    ↓
                                          前端调用 Supabase API
                                                    ↓
                                          PostgreSQL 存储评论
```

关键点在于：**构建时和运行时完全分离**。GitHub Actions 只负责生成静态 HTML，评论数据完全由 Supabase 在客户端处理。

## 凭证管理的坑

第一次配置 Supabase 时，我踩了一个典型的坑：不知道从哪里获取 API Key。Supabase 的界面有多个入口，容易混淆。

实际上你只需要三个东西：

1. **Project URL**：在 Settings → API 页面顶部，格式是 `https://xxxx.supabase.co`
2. **Publishable Key**：同一页面的 API Keys 区域，以 `sb_publishable_` 开头
3. **Service Role Key**：⚠️ 这个只在服务端使用，**绝对不要**暴露在前端代码里

对于 GitHub Actions 云端构建，你需要把这些凭证写入 GitHub Secrets：

```bash
# 在 GitHub 仓库设置中添加 Secrets
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANUBLISHABLE_KEY=sb_publishable_xxx
```

然后在 `.github/workflows/deploy.yml` 中引用：

```yaml
- name: Build
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
    SUPABASE_KEY: ${{ secrets.SUPABASE_ANUBLISHABLE_KEY }}
  run: hexo generate
```

## 前端集成

在 Hexo 主题中集成 Supabase 评论组件，核心逻辑其实很简单：

```javascript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANUBLISHABLE_KEY
)

// 读取评论
const { data } = await supabase
  .from('comments')
  .select('*')
  .eq('post_id', currentPostId)
  .order('created_at', { ascending: false })

// 发布评论
await supabase.from('comments').insert({
  post_id: currentPostId,
  author: userName,
  content: commentText
})
```

但这里有个细节：**post_id 的取值逻辑**。你可以用文章路径（如 `/2026/08/15/my-post`），也可以用文章的唯一标识。我选择用路径，因为它在 Hexo 中是稳定的。

## RLS 策略：安全的关键

Supabase 的 RLS（Row Level Security）是防止恶意写入的核心。你需要配置两条策略：

```sql
-- 允许所有人读取评论
CREATE POLICY "Enable read for all" ON comments
FOR SELECT USING (true);

-- 只允许认证用户发布评论
CREATE POLICY "Enable insert for authenticated users" ON comments
FOR INSERT WITH CHECK (auth.role() = 'authenticated');
```

这样即使有人拿到了你的 Publishable Key，也无法绕过认证直接写入数据库。

## 踩过的坑

1. **环境变量注入时机**：Hexo 构建时读取环境变量，但前端代码需要在浏览器中访问这些变量。解决方案是在主题配置文件中显式声明。

2. **Supabase 客户端初始化**：不要在每个页面都创建新客户端，会导致连接池耗尽。应该在主题的全局脚本中初始化一次。

3. **评论实时性**：Supabase 的实时订阅需要额外的配置，如果只是简单的评论列表，轮询（每 30 秒）可能更简单可靠。

## 下一步

目前评论系统已经跑通，但还有几个优化方向：

- **Markdown 支持**：评论内容支持 Markdown 格式
- **邮件通知**：新评论时通知博主
- **反垃圾**：集成 Akismet 或自定义过滤规则

这个项目让我重新思考了"静态博客"的定义——**静态的是内容，动态的是交互**。Supabase 这类 BaaS 服务让个人博客也能拥有现代化的交互体验，而无需承担后端运维的负担。

---

*本文基于个人学习笔记整理，属通用知识分享。*
