/*
 * 主题内置搜索框接线（header 放大镜按钮 → Supabase 搜索）
 * 设计：
 *  - 拦截主题 search_form 默认的 Google 提交，改为站内 Supabase 搜索
 *  - 结果渲染进 #search-form-wrap 内的 #search-result 下拉，随表单一起显隐
 *  - 安全：结果一律用 textContent 渲染（防 XSS）；配置来自 window.SEARCH_SUPABASE_*（构建期由主题 _config.yml 公开值注入）
 *  - 降级：配置缺失或组件未载入时，仅在输入框聚焦时给一行提示，绝不崩页、绝不白屏
 */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var input = document.querySelector('.search-form-input');
    if (!input) return; // 本页无内置搜索框，静默退出

    var wrap = document.getElementById('search-form-wrap');
    var form = input.form; // 主题 search_form 生成的 <form>
    var DEBOUNCE_MS = 300;

    // 结果容器：优先用 header.ejs 已注入的 #search-result，否则兜底创建
    var results = document.getElementById('search-result');
    if (!results) {
      results = document.createElement('div');
      results.id = 'search-result';
      results.className = 'search-dropdown';
      if (wrap) wrap.appendChild(results);
    }

    var URL = window.SEARCH_SUPABASE_URL;
    var ANON = window.SEARCH_SUPABASE_ANON_KEY;

    function hideResults() {
      results.className = 'search-dropdown';
      results.textContent = '';
    }

    // —— 配置缺失：仅聚焦时提示，不干扰正常浏览 ——
    if (!URL || !ANON) {
      input.addEventListener('focus', function () {
        results.className = 'search-dropdown on';
        results.textContent = '';
        var s = document.createElement('div');
        s.className = 'search-dropdown-status';
        s.textContent = '搜索未配置（缺少 Supabase 配置）。';
        results.appendChild(s);
      });
      return;
    }
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      input.addEventListener('focus', function () {
        results.className = 'search-dropdown on';
        results.textContent = '';
        var s = document.createElement('div');
        s.className = 'search-dropdown-status';
        s.textContent = '搜索组件加载失败（Supabase JS 未载入）。';
        results.appendChild(s);
      });
      return;
    }

    var client = window.supabase.createClient(URL, ANON);

    function setStatus(msg) {
      results.className = 'search-dropdown on';
      results.textContent = '';
      if (msg) {
        var s = document.createElement('div');
        s.className = 'search-dropdown-status';
        s.textContent = msg;
        results.appendChild(s);
      }
    }

    function render(list) {
      results.className = 'search-dropdown on';
      results.textContent = '';
      if (!list || !list.length) {
        var empty = document.createElement('div');
        empty.className = 'search-dropdown-status';
        empty.textContent = '没有找到相关文章。';
        results.appendChild(empty);
        return;
      }
      list.forEach(function (r) {
        var item = document.createElement('a'); // 用 <a> 直链，点击即跳转文章
        item.className = 'search-dropdown-item';
        item.href = r.url; // 数据库存根相对路径，如 /2026/.../
        var title = document.createElement('div');
        title.className = 'search-dropdown-title';
        title.textContent = r.title; // 安全：textContent
        var excerpt = document.createElement('div');
        excerpt.className = 'search-dropdown-excerpt';
        excerpt.textContent = r.excerpt || ''; // 安全：textContent
        item.appendChild(title);
        item.appendChild(excerpt);
        results.appendChild(item);
      });
    }

    function doSearch(q) {
      q = (q || '').trim();
      if (!q) { hideResults(); return; }
      client.rpc('search_posts', { q: q })
        .then(function (res) {
          if (res.error) { setStatus('搜索失败：' + res.error.message); return; }
          render(res.data || []);
        })
        .catch(function (e) {
          setStatus('搜索失败：' + (e && e.message ? e.message : e));
        });
    }

    // 输入防抖
    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { doSearch(input.value); }, DEBOUNCE_MS);
    });

    // 拦截默认提交（主题默认跳 Google），改为站内搜索
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        doSearch(input.value);
      });
    }

    // 点击结果时阻止输入框失焦，避免主题 script.js 的 blur 收起表单导致点击失效
    results.addEventListener('mousedown', function (e) { e.preventDefault(); });
  });
})();
