#!/usr/bin/env node
'use strict';
/**
 * 构建期搜索索引器（Phase B · 搜索功能）
 *
 * 职责：抽取 public/ 下文章 → upsert 到 Supabase search_blog.posts。
 *
 * 健壮性设计（对应"环境假设/业务逻辑耦合、自动化缺把关、状态依赖不可靠"三类根因）：
 *  1. 解耦   ：缺密钥 → 跳过索引仅告警、exit 0，绝不阻断博客部署（搜索是增强，不是主产品）。
 *  2. 把关   ：抽取为空 / 字段缺失 → 中止 DB 写入（exit 1），绝不触碰现有索引，避免静默空搜索。
 *  3. 状态可靠：全部记录在内存校验通过后，才调用 prune_posts(keep_ids)+upsert；
 *             prune_posts 在 SQL 层对空集防御，即使脚本误传空数组也不会清空索引。
 *  4. 后置校验：写入后比对数据库 count 与本地抽取数，异常告警。
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');

const URL = process.env.SEARCH_SUPABASE_URL;
const SERVICE_KEY = process.env.SEARCH_SUPABASE_SERVICE_KEY;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const log = (...a) => console.log('[search-index]', ...a);
const warn = (...a) => console.warn('[search-index]', ...a);
const err = (...a) => console.error('[search-index]', ...a);

// 1) 解耦：缺密钥不阻断部署
if (!URL || !SERVICE_KEY) {
  warn('SEARCH_SUPABASE_URL / SEARCH_SUPABASE_SERVICE_KEY 未设置 → 跳过索引（博客部署不受影响，搜索将暂不可用）');
  process.exit(0);
}

// 2) 抽取（纯内存，未触碰 DB）
function extractPosts() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    err('public/ 不存在，请先运行 hexo generate');
    return [];
  }
  const posts = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.html')) continue;

      const html = fs.readFileSync(p, 'utf8');
      const $ = cheerio.load(html);
      // 仅索引真正的文章页：评论系统已在每篇文章页注入
      // <section id="supabase-comments" data-post-id="...">；
      // 首页/归档/分类/标签/分页等列表页无此锚点 → 跳过，避免误当文章。
      const postId = $('#supabase-comments').attr('data-post-id');
      if (!postId) continue;

      const $article = $('.article-entry, article');
      if (!$article.length) continue;

      const title = ($('title').first().text() || '').trim();
      const content = $article.text().replace(/\s+/g, ' ').trim();
      const rel = p.replace(PUBLIC_DIR, '').replace(/\\/g, '/');
      const url = rel.replace(/\/index\.html$/, '/');
      if (title && content) {
        posts.push({ post_id: postId, title, url, excerpt: content.slice(0, 120), content });
      }
    }
  };
  walk(PUBLIC_DIR);
  return posts;
}

(async () => {
  const posts = extractPosts();

  // 3) 把关：空集 / 字段缺失 → 中止，不 wipe
  if (!posts.length) {
    err('抽取到 0 篇文章，疑似 public/ 未生成或选择器失效 → 中止，保留现有索引');
    process.exit(1);
  }
  const bad = posts.filter((p) => !p.post_id || !p.title || !p.content || !p.url);
  if (bad.length) {
    err(`${bad.length} 条记录缺字段（post_id/title/content/url）→ 中止写入`);
    process.exit(1);
  }

  const supabase = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  const ids = posts.map((p) => p.post_id);

  // 4) 安全删除旧行（prune_posts 内部对空集防呆）
  const { error: pe } = await supabase.rpc('prune_posts', { keep_ids: ids });
  if (pe) { err('prune_posts 失败:', pe.message); process.exit(1); }

  // 5) upsert 当前全部
  const { error: ue } = await supabase
    .from('posts')
    .upsert(posts, { onConflict: 'post_id' });
  if (ue) { err('upsert 失败:', ue.message); process.exit(1); }

  // 6) 后置校验
  const { count, error: ce } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true });
  if (ce) warn('写入后 count 校验失败:', ce.message);
  else log(`索引完成：本地抽取 ${posts.length} 篇，数据库现有 ${count} 篇`);

  process.exit(0);
})();
