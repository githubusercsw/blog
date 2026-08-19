/*
 * Supabase 搜索组件（Phase C）
 * 安全约定：
 *  - 结果一律用 textContent / createElement 渲染，禁用 innerHTML 拼接（防 XSS）
 *  - anon key 来自 window.SEARCH_SUPABASE_URL / window.SEARCH_SUPABASE_ANON_KEY（构建期注入，不写死进仓库）
 *  - 缺配置 → 降级提示；所有异步调用 try/catch，失败不崩页
 */
(function () {
  'use strict';

  var URL = window.SEARCH_SUPABASE_URL;
  var ANON = window.SEARCH_SUPABASE_ANON_KEY;
  var DEBOUNCE_MS = 300;

  function init() {
    var input = document.getElementById('search-input');
    var btn = document.getElementById('search-btn');
    var results = document.getElementById('search-results');
    var status = document.getElementById('search-status');
    if (!input || !results) return; // 页面无搜索容器，静默退出

    if (!URL || !ANON) {
      if (status) status.textContent = '搜索未配置（缺少 Supabase 环境变量）。';
      return;
    }
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      if (status) status.textContent = '搜索组件加载失败（Supabase JS 未载入）。';
      return;
    }

    var client = window.supabase.createClient(URL, ANON);

    function setStatus(msg) { if (status) status.textContent = msg || ''; }

    function render(list) {
      while (results.firstChild) results.removeChild(results.firstChild); // 仅含自建节点，清空安全
      if (!list || !list.length) {
        setStatus('没有找到相关文章。');
        return;
      }
      list.forEach(function (r) {
        var item = document.createElement('div');
        item.className = 'search-result';

        var link = document.createElement('a');
        link.className = 'search-result-title';
        link.href = r.url;                  // 数据库存根相对路径，如 /2026/.../
        link.textContent = r.title;         // 安全：textContent

        var excerpt = document.createElement('p');
        excerpt.className = 'search-result-excerpt';
        excerpt.textContent = r.excerpt || ''; // 安全：textContent

        item.appendChild(link);
        item.appendChild(excerpt);
        results.appendChild(item);
      });
      setStatus('找到 ' + list.length + ' 篇相关文章。');
    }

    function doSearch(q) {
      q = (q || '').trim();
      if (!q) { render([]); setStatus(''); return; }
      setStatus('搜索中…');
      client.rpc('search_posts', { q: q })
        .then(function (res) {
          if (res.error) { setStatus('搜索失败：' + res.error.message); return; }
          render(res.data || []);
        })
        .catch(function (e) {
          setStatus('搜索失败：' + (e && e.message ? e.message : e));
        });
    }

    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { doSearch(input.value); }, DEBOUNCE_MS);
    });
    if (btn) btn.addEventListener('click', function () { doSearch(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { clearTimeout(t); doSearch(input.value); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
