/*
 * Supabase 评论组件（阶段3）
 * 安全约定：
 *  - 用户内容（name/content）一律用 textContent / createElement 渲染，禁用 innerHTML 拼接用户输入（防 XSS）
 *  - Supabase anon key 来自 window.SUPABASE_URL / window.SUPABASE_ANON_KEY（由模板经 process.env 注入，不写死进仓库）
 *  - 防刷：蜜罐字段 + 客户端节流/防双击 + DB 去重触发器（defense-in-depth）
 *  - 避免连锁反应：所有异步调用 try/catch，失败降级提示，不抛错崩页
 */
(function () {
  'use strict';

  var SUPABASE_URL = window.SUPABASE_URL;
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  var MIN_INTERVAL_MS = 8000;        // 客户端最小提交间隔
  var HONEYPOT_NAME = 'website';     // 视觉隐藏字段，真人不会填，bot 易填

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function init() {
    var mount = document.getElementById('supabase-comments');
    if (!mount) return;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      mount.textContent = '评论功能未配置（缺少 Supabase 环境变量）。';
      return;
    }
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      mount.textContent = '评论组件加载失败（Supabase JS 未载入）。';
      return;
    }

    var postId = mount.getAttribute('data-post-id');
    if (!postId) {
      mount.textContent = '评论功能出错（缺少 post_id）。';
      return;
    }

    var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // ---- UI 构建（全部 textContent / createElement，杜绝 XSS）----
    var list = document.createElement('div');
    list.className = 'supabase-comments-list';

    var form = document.createElement('form');
    form.className = 'supabase-comments-form';
    form.setAttribute('method', 'post');
    form.setAttribute('autocomplete', 'on');

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'name';
    nameInput.maxLength = 50;
    nameInput.placeholder = '昵称（必填，≤50字）';
    nameInput.required = true;
    nameInput.setAttribute('autocomplete', 'nickname');

    var contentInput = document.createElement('textarea');
    contentInput.name = 'content';
    contentInput.maxLength = 2000;
    contentInput.placeholder = '说点什么…（必填，≤2000字）';
    contentInput.required = true;

    // 蜜罐：视觉隐藏，bot 填了就被拦
    var honeypot = document.createElement('input');
    honeypot.type = 'text';
    honeypot.name = HONEYPOT_NAME;
    honeypot.tabIndex = -1;
    honeypot.setAttribute('autocomplete', 'off');
    honeypot.setAttribute('aria-hidden', 'true');
    honeypot.style.position = 'absolute';
    honeypot.style.left = '-9999px';
    honeypot.style.width = '1px';
    honeypot.style.height = '1px';

    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = '发表评论';

    var status = document.createElement('p');
    status.className = 'supabase-comments-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    form.appendChild(nameInput);
    form.appendChild(contentInput);
    form.appendChild(honeypot);
    form.appendChild(submitBtn);

    mount.appendChild(list);
    mount.appendChild(form);
    mount.appendChild(status);

    // ---- 渲染单条评论（textContent 防 XSS）----
    function renderComment(c) {
      var item = document.createElement('div');
      item.className = 'supabase-comment';

      var meta = document.createElement('div');
      meta.className = 'supabase-comment-meta';

      var name = document.createElement('span');
      name.className = 'supabase-comment-name';
      name.textContent = c.name;                       // 安全：textContent

      var time = document.createElement('time');
      time.className = 'supabase-comment-time';
      time.dateTime = c.created_at;
      time.textContent = formatTime(c.created_at);    // 安全

      meta.appendChild(name);
      meta.appendChild(time);

      var body = document.createElement('div');
      body.className = 'supabase-comment-body';
      body.textContent = c.content;                    // 安全：textContent

      item.appendChild(meta);
      item.appendChild(body);
      return item;
    }

    // ---- 拉取评论 ----
    function load() {
      status.textContent = '加载评论中…';
      client.from('comments')
        .select('id,name,content,created_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
        .then(function (res) {
          if (res.error) { status.textContent = '加载失败：' + res.error.message; return; }
          clearChildren(list);                          // list 仅含自建节点，清空安全
          if (!res.data || res.data.length === 0) {
            status.textContent = '还没有评论，来抢沙发吧。';
            return;
          }
          res.data.forEach(function (c) { list.appendChild(renderComment(c)); });
          status.textContent = '共 ' + res.data.length + ' 条评论';
        })
        .catch(function (e) {
          status.textContent = '加载失败：' + (e && e.message ? e.message : e);
        });
    }

    // ---- 提交评论（防刷 + 降级）----
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // 蜜罐：真人不会填
      if (honeypot.value) {
        status.textContent = '提交被拦截。';
        return;
      }

      var name = nameInput.value.trim();
      var content = contentInput.value.trim();
      if (!name || !content) {
        status.textContent = '昵称和内容都不能为空。';
        return;
      }

      // 客户端节流 / 防双击
      var now = Date.now();
      var last = Number(sessionStorage.getItem('sc_last_' + postId) || 0);
      if (now - last < MIN_INTERVAL_MS) {
        status.textContent = '提交太频繁，请稍候再试。';
        return;
      }

      submitBtn.disabled = true;
      status.textContent = '提交中…';

      client.from('comments').insert([{ post_id: postId, name: name, content: content }])
        .then(function (res) {
          if (res.error) {
            status.textContent = '提交失败：' + res.error.message;
            submitBtn.disabled = false;
            return;
          }
          sessionStorage.setItem('sc_last_' + postId, String(Date.now()));
          nameInput.value = '';
          contentInput.value = '';
          status.textContent = '评论已提交！';
          submitBtn.disabled = false;
          load();
        })
        .catch(function (err) {
          status.textContent = '提交失败：' + (err && err.message ? err.message : err);
          submitBtn.disabled = false;
        });
    });

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
