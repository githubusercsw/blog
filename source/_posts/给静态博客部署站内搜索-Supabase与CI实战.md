---
title: 给静态博客部署站内搜索：Supabase + CI 实战
date: 2026-08-15 00:30:00
tags: [Hexo, Supabase, 站内搜索, CI/CD, 工程实践]
categories: [工程实践]
toc: true
comments: true
---

# 一、为什么需要一个站内搜索

我的博客是 Hexo 生成的纯静态站点，托管在 GitHub Pages。静态站点的通病是**没有后端、没有数据库**——读者想找历史文章，只能靠浏览器 `Ctrl+F` 或翻归档。文章一旦多了，"我记得写过一篇关于 X 的"就成了最让人恼火的日常。

需求其实很克制：一个**不引入自建后端**、**不泄露数据库权限**、**随每次部署自动更新**的站内搜索。

# 二、方案选型

最终选了「独立 Supabase 项目 + 构建期索引器」的架构。核心思路只有一句话：**把"建索引"从运行时挪到构建时**。文章被构建成 HTML 后，脚本用 cheerio 把正文抽出来写进 Supabase；读者搜索时，前端只用一个匿名 key 调一个只读 RPC。

| 维度 | 选择 | 理由 |
|------|------|------|
| 搜索后端 | 独立的 Supabase project（与评论系统隔离） | 关注点分离，一个挂了不影响另一个 |
| 检索算法 | `ILIKE` 子串匹配 + `pg_trgm` GIN 索引 | 中文无需分词，零额外扩展依赖 |
| 索引时机 | 构建期（`hexo generate` 之后、CI 内） | 每次部署动态重建，删除同步自动完成 |
| 前端安全 | anon key（可公开）+ `process.env` 注入 | `service_role` 永不进浏览器 |

# 三、后端：一张表 + 一个函数

`posts` 表结构：

```sql
create table public.posts (
  post_id    text primary key,
  title      text not null,
  url        text not null,
  excerpt    text,
  content    text not null,
  updated_at timestamptz default now()
);

create index posts_content_trgm_idx on public.posts using gin(content gin_trgm_ops);
create index posts_title_trgm_idx   on public.posts using gin(title   gin_trgm_ops);
```

检索靠一个 `search_posts(q)` RPC：用 `ILIKE` 同时匹配标题与正文，并给**标题命中更高权重**：

```sql
create or replace function public.search_posts(q text)
returns table(post_id text, title text, url text, excerpt text, rank int)
language sql stable security definer set search_path=public as $$
  select p.post_id, p.title, p.url, p.excerpt,
    (case when p.title ilike '%'||q||'%' then 2 else 0 end
     + case when p.content ilike '%'||q||'%' then 1 else 0 end) as rank
  from public.posts p
  where p.title ilike '%'||q||'%' or p.content ilike '%'||q||'%'
  order by rank desc, p.updated_at desc
  limit 20;
$$;
```

RLS 只放行 `anon` / `authenticated` 的 `SELECT`——读者能搜，但不能改。写库用 `service_role`，**只在 CI 的 `process.env` 里存在**。

# 四、索引器：把 HTML 变成行

`tools/build-search-index.js` 在 `public/` 下遍历所有 HTML，用评论系统已经在每篇真文章页注入的 `#supabase-comments` 锚点来**区分文章页与列表页**（首页 / 归档 / 分类 / 标签页不含此锚点，直接跳过），再用 cheerio 抽正文，最后用 service key `upsert`。

设计上的几个硬约束，都是踩坑后定下的：

- **降级而非崩溃**：缺密钥 → 跳过 + 告警 + `exit 0`，绝不阻断博客部署。
- **先校验再写库**：抽取结果为空或缺少字段 → 中止 DB 写入，避免脏数据。
- **删除同步**：每次重建前先 `prune_posts(keep_ids)`，删掉不在集合内的旧行；`prune_posts([])` 做了**空集防呆**，不会误删全部。

# 五、前端：搜索页 + 安全渲染

搜索页用独立的 `search.ejs` 布局（不复用文章 partial，避免评论区泄漏到搜索页）。配置通过 ejs 的 `process.env` 注入成 `window.SEARCH_SUPABASE_URL` / `window.SEARCH_SUPABASE_ANON_KEY`——这是构建期发生在服务器的事，源码里永远看不到真实值。

搜索结果一律用 `textContent` 渲染，杜绝 XSS。缺配置时，搜索框降级提示"搜索未启用"，而不是白屏。

# 六、CI/CD：让部署自己照顾搜索

`deploy.yml` 在 job 级 `env` 注入 3 个 `SEARCH_SUPABASE_*` secret，并在 `hexo generate` 之后加一步强制索引：

```yaml
- name: 构建搜索索引（缺密钥则跳过，不阻断部署）
  continue-on-error: true
  run: node tools/build-search-index.js
```

关键点：**搜索是增强项，不是主产品**。所以索引步骤用 `continue-on-error`——即使 Supabase 抽风、密钥缺失，博客照常上线，只是搜索暂时降级。而评论系统（主功能）的校验仍是 fail-loud，密钥缺失直接中止部署。

# 七、踩坑与根因固化

整个过程中有几处"看似小、实则埋雷"的坑，值得记一笔：

1. **索引器误把列表页当文章**：`.article-entry, article` 选择器在首页也命中（文章预览），会把列表页标题 / URL(`/`) 当文章写。改用"必须带 `#supabase-comments` 锚点"做文章页判据。
2. **脚本被 Hexo 当插件加载**：站点顶层 `scripts/` 会被 Hexo 自动 `require`，带 shebang 的 CLI 脚本直接 `SyntaxError`。移进 `tools/` 解决。
3. **自定义布局 `body is not defined`**：Hexo 里 `body` 仅用于基类布局链，自定义布局取正文要用 `page.content`，否则生成 0 字节。
4. **站级 `menu` 不生效**：主题 `header.ejs` 读的是 `theme.menu`（主题 `_config`），站级 `config.menu` 被无视——菜单项得加在主题的 `_config.yml`。

# 八、安全边界（红线）

- `service_role` JWT 拥有数据库全权，**只能存在于 CI 的 `process.env`**，永不进前端、永不进源码、永不写进博客内容。
- 前端只用 anon key（设计上可公开），且作为 GitHub Secret 管理。
- 两个系统密钥命名空间隔离：搜索用 `SEARCH_*`，评论用 `SUPABASE_*`，互不混用。

# 九、小结

这套方案上线后，博客有了真正的站内搜索，且完全契合静态站点的"无后端"哲学：**读写分离、构建时建索引、运行时只调只读 RPC**。每次 `git push`，GitHub Actions 顺手就把搜索库刷新了——读者无感，维护者省心。
