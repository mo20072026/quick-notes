/* gh-sync.js —— 静态站跨设备同步模块（GitHub 私有 Gist，零后端、零账号）
 *
 * 引入：  页面里加 <script src="gh-sync.js"><\/script>（用外部文件引入，别内联）
 * 初始化：GhSync.init({ storeKey:'app_prog', file:'progress.json',
 *                      desc:'我的应用 · 进度备份', onChange: render });
 * 读写：  GhSync.set(id, {lv:'已掌握'})   GhSync.get(id)   GhSync.data()   GhSync.remove(id)
 * 手动：  GhSync.push()  GhSync.pull()  GhSync.sync(true)  GhSync.diag()
 * 换设备：GhSync.code()  GhSync.link()  GhSync.applyCode(str)
 *
 * 数据模型：localStorage 里存 { id: { 任意字段, t: 时间戳 } }，同步时按 t 新者胜。
 * 「清空」用 GhSync.reset()，会写入 resetAt 压过云端旧数据，避免被别的设备复活。
 */
(function () {
  'use strict';
  var GH_API = 'https://api.github.com';
  var CODE_PREFIX = 'ENSYNC1.';
  var POLL_MS = 60000;         /* 后台轮询间隔（仅页面可见时） */
  var POLL_MIN_GAP = 25000;    /* 两次同步最小间隔，避免频繁打接口 */
  var FIND_TTL = 300000;       /* 没找到 Gist 时的缓存时间，手动触发会强制刷新 */

  var S = {
    storeKey: null, file: 'progress.json', desc: '应用进度备份', onChange: null,
    data: {}, resetAt: 0, token: '', gistId: '', auto: true,
    busy: false, lastSync: 0, findAt: 0, error: '', pushOk: null,
    ui: { status: null, box: null, auto: null, token: null, gist: null, code: null, ago: null, retry: null },
    pushTimer: null, pollTimer: null, agoTimer: null
  };

  function $(id) { return id ? document.getElementById(id) : null; }
  function lsGet(k, d) { try { var r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function cfgKey() { return S.storeKey + '_gh'; }
  function resetKey() { return S.storeKey + '_reset'; }
  function syncKey() { return S.storeKey + '_sync_at'; }

  /* 凭据双写：localStorage 为主，cookie 兜底一年。
     手机浏览器（iOS Safari / 微信）清理缓存时会丢掉 localStorage，cookie 通常活得更久，
     这样"填一次 Token"才真的能记住，不用反复输入。 */
  var CFG_COOKIE = 'gh_sync_cfg';
  function cookieSet(name, val, days) {
    try {
      var attrs = '; path=/; max-age=' + (days * 86400) + '; SameSite=Lax';
      if (location.protocol === 'https:') attrs += '; Secure';
      document.cookie = name + '=' + encodeURIComponent(val) + attrs;
    } catch (e) { /* 无痕模式等场景忽略 */ }
  }
  function cookieGet(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  /* 读取本机配置：localStorage 没有时回退到 cookie */
  function loadCfg() {
    var c = lsGet(cfgKey(), null);
    if (c && c.token) {
      /* 老用户只有 localStorage、没有 cookie：顺手补写 cookie，缓存被清时能恢复 */
      if (!cookieGet(CFG_COOKIE)) cookieSet(CFG_COOKIE, JSON.stringify(c), 365);
      return c;
    }
    var raw = cookieGet(CFG_COOKIE);
    if (!raw) return null;
    try {
      c = JSON.parse(raw);
      if (c && c.token) { lsSet(cfgKey(), c); return c; }   /* 顺手补回 localStorage */
    } catch (e) { /* 忽略坏数据 */ }
    return null;
  }
  function load() {
    S.data = lsGet(S.storeKey, {}) || {};
    S.resetAt = lsGet(resetKey(), 0) || 0;
    S.lastSync = lsGet(syncKey(), 0) || 0;
    var c = loadCfg();
    if (c && c.token) { S.token = c.token; S.gistId = c.gistId || ''; S.auto = c.auto !== false; }
  }
  function saveData() { lsSet(S.storeKey, S.data); }
  function saveCfg() {
    var cfg = { token: S.token || '', gistId: S.gistId || '', auto: S.auto !== false };
    lsSet(cfgKey(), cfg);
    if (cfg.token) cookieSet(CFG_COOKIE, JSON.stringify(cfg), 365);
    else cookieSet(CFG_COOKIE, '', 0);
  }
  /* 忘记此设备：清掉本机 Token 与同步配置（不影响其他设备） */
  function forget() {
    S.token = ''; S.gistId = ''; S.auto = true; S.lastSync = 0; S.error = ''; S.pushOk = null;
    saveCfg();
    try { localStorage.removeItem(cfgKey()); } catch (e) { /* 忽略 */ }
    var t = $(S.ui.token), g = $(S.ui.gist);
    if (t) t.value = '';
    if (g) g.value = '';
    renderBox();
    toast('已清除本机的 Token');
  }

  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + S.token, 'Accept': 'application/vnd.github+json',
             'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  var ghLastHeaders = null;
  function ghHeader(name) {
    try { return ghLastHeaders ? (ghLastHeaders.get(name) || '') : ''; } catch (e) { return ''; }
  }
  function ghFetch(url, opt) {
    return fetch(url, opt).then(function (r) {
      try { ghLastHeaders = r.headers; } catch (e) { /* 某些环境取不到 */ }
      if (!r.ok) {
        return r.text().then(function (t) {
          var m = t; try { m = JSON.parse(t).message || t; } catch (e) { /* 原文 */ }
          throw new Error('HTTP ' + r.status + ' ' + m);
        });
      }
      return r.json();
    });
  }
  function payload() {
    return JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), resetAt: S.resetAt || 0, prog: S.data });
  }

  /* ---- 只用 Token 也能同步：按用途在账号下认出自己的备份文件 ---- */
  function findGist() {
    return ghFetch(GH_API + '/gists?per_page=100', { headers: ghHeaders() }).then(function (list) {
      var best = null, bestScore = 0;
      (Array.isArray(list) ? list : []).forEach(function (g) {
        if (!g || !g.files || !g.files[S.file]) return;
        var score = ((g.description || '').indexOf(S.desc.slice(0, 4)) >= 0) ? 2 : 1;
        if (!best || score > bestScore ||
            (score === bestScore && String(g.updated_at || '') > String(best.updated_at || ''))) {
          best = g; bestScore = score;
        }
      });
      return best ? best.id : '';
    }).catch(function () { return ''; });
  }
  function ensureGist(force) {
    if (S.gistId) return Promise.resolve(S.gistId);
    if (!S.token) return Promise.resolve('');
    if (!force && S.findAt && Date.now() - S.findAt < FIND_TTL) return Promise.resolve('');
    return findGist().then(function (id) {
      S.findAt = Date.now();
      if (id) { S.gistId = id; saveCfg(); var g = $(S.ui.gist); if (g) g.value = id; renderBox(); }
      return S.gistId || '';
    });
  }
  function createGist() {
    var f = {}; f[S.file] = { content: payload() };
    return ghFetch(GH_API + '/gists', {
      method: 'POST', headers: ghHeaders(),
      body: JSON.stringify({ description: S.desc, public: false, files: f })
    }).then(function (g) { S.gistId = g.id; saveCfg(); return g; });
  }
  function readRemote() {
    if (!S.token || !S.gistId) return Promise.resolve(null);
    return ghFetch(GH_API + '/gists/' + S.gistId, { headers: ghHeaders() }).then(function (g) {
      var f = g.files && g.files[S.file];
      if (!f) return null;
      if (f.truncated && f.raw_url) return fetch(f.raw_url).then(function (r) { return r.text(); });
      return f.content || '';
    }).then(function (text) {
      if (!text) return null;
      var o = JSON.parse(text);
      return { prog: (o && o.prog) || {}, resetAt: (o && o.resetAt) || 0 };
    }).catch(function (e) { if (/HTTP 404/.test(e.message)) return null; throw e; });
  }

  /* ---- 双向合并：单条时间戳新者胜；resetAt 之前的旧数据不复活 ---- */
  function merge(remote, remoteResetAt) {
    var cut = Math.max(S.resetAt || 0, remoteResetAt || 0);
    if (cut > (S.resetAt || 0)) { S.resetAt = cut; lsSet(resetKey(), cut); }
    var changed = 0;
    Object.keys(remote || {}).forEach(function (id) {
      var b = remote[id];
      if (!b || (b.t || 0) <= cut) return;
      var a = S.data[id];
      if (!a || (b.t || 0) > (a.t || 0)) { S.data[id] = b; changed++; }
    });
    Object.keys(S.data).forEach(function (id) {
      var a = S.data[id];
      if (a && (a.t || 0) <= cut) { delete S.data[id]; changed++; }
    });
    return changed;
  }
  function needsPush(remote, remoteResetAt) {
    if ((S.resetAt || 0) > (remoteResetAt || 0)) return true;
    var ids = Object.keys(S.data);
    for (var i = 0; i < ids.length; i++) {
      var a = S.data[ids[i]], b = (remote || {})[ids[i]];
      if (!a) continue;
      if (!b || (a.t || 0) > (b.t || 0)) return true;
    }
    return false;
  }

  function push(silent, retry, notifyError) {
    if (!S.token) { if (!silent) toast('请先填写 Token'); return Promise.resolve(); }
    if (S.busy) return Promise.resolve();
    S.busy = true; status('同步中', 'busy');
    var merged = 0;
    return ensureGist(true).then(function () {
      return S.gistId ? readRemote().then(function (res) {
        if (res) merged = merge(res.prog, res.resetAt);
        return { id: S.gistId };
      }) : createGist();
    }).then(function (g) {
      var f = {}; f[S.file] = { content: payload() };
      return ghFetch(GH_API + '/gists/' + g.id, {
        method: 'PATCH', headers: ghHeaders(), body: JSON.stringify({ files: f })
      });
    }).then(function (g) {
      S.gistId = g.id || S.gistId; saveCfg();
      if (merged) { saveData(); if (S.onChange) S.onChange(merged); }
      S.lastSync = Date.now(); lsSet(syncKey(), S.lastSync);
      S.error = ''; S.pushOk = true; status('已同步', '');
      if (!silent) toast('进度已同步' + (merged ? '，合并云端 ' + merged + ' 条' : ''));
      renderBox();
    }).catch(function (e) {
      S.busy = false;                                  /* 先释放锁，便于重试 */
      var msg = e && (e.message || '未知错误');
      var clientErr = /HTTP 4\d\d/.test(msg);          /* 401/403 属权限问题，重试无用 */
      if (!retry && !clientErr) {                      /* 网络抖动/5xx/手机锁屏挂起：3 秒后重试一次 */
        return new Promise(function (r) { setTimeout(r, 3000); })
          .then(function () { return push(silent, true, notifyError); });
      }
      S.error = msg; S.pushOk = false; status('同步失败', 'off');
      if (!silent || notifyError) toast('同步失败：' + msg + '（数据已存本机，稍后会自动重试）');
      renderBox();
    }).then(function () { S.busy = false; });
  }

  function pull(silent) {
    if (!S.token || !S.gistId) { if (!silent) toast('请先连接 Gist'); return Promise.resolve(null); }
    S.busy = true; status('读取中', 'busy');
    return readRemote().then(function (res) {
      if (!res) throw new Error('云端还没有备份文件');
      var changed = merge(res.prog, res.resetAt);
      saveData();
      if (changed && S.onChange) S.onChange(changed);   /* 无变化不重渲染，避免打断操作 */
      S.lastSync = Date.now(); lsSet(syncKey(), S.lastSync);
      S.error = ''; status('已同步', '');
      if (!silent) toast(changed ? '已合并云端进度（' + changed + ' 条）' : '云端与本地一致');
      return { changed: changed, prog: res.prog, resetAt: res.resetAt };
    }).catch(function (e) {
      S.error = e && (e.message || '未知错误'); status('读取失败', 'off');
      if (!silent) toast('读取失败：' + S.error);
      return null;
    }).then(function (r) { S.busy = false; return r; });
  }

  /* 打开页面 / 切回前台 / 恢复网络 / 定时：先拉后推 */
  function sync(force, notify) {
    if (!S.auto || !S.token) return Promise.resolve();
    if (S.busy) return Promise.resolve();
    if (!force && S.lastSync && Date.now() - S.lastSync < POLL_MIN_GAP) return Promise.resolve();
    status('同步中', 'busy');
    S.error = '';
    return ensureGist(force).then(function () {
      if (!S.gistId) return push(true);            /* 账号下还没有备份：立刻创建，让用户看到「已连接」 */
      return pull(true).then(function (res) {
        if (!res) return;
        if (needsPush(res.prog, res.resetAt)) return push(true);
      });
    }).catch(function (e) {
      S.error = e && (e.message || '未知错误'); status('同步失败', 'off');
      if (notify) toast('自动同步失败：' + S.error);
      renderBox();
    });
  }
  function schedulePush() {
    clearTimeout(S.pushTimer);
    /* 用户刚动过数据：这次失败要提示，否则会以为同步成功了 */
    S.pushTimer = setTimeout(function () { push(true, false, true); }, 1800);
  }
  function flush() {                                /* 离开页面前立刻补推 */
    if (!S.auto || !S.token) return;
    clearTimeout(S.pushTimer);
    push(true);
  }

  /* ---- 同步码：换设备一次粘贴即可 ---- */
  function b64enc(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64dec(s) {
    var v = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (v.length % 4) v += '=';
    return decodeURIComponent(escape(atob(v)));
  }
  function code() { return CODE_PREFIX + b64enc(JSON.stringify({ t: S.token || '', g: S.gistId || '', k: S.storeKey })); }
  function link() {
    return location.origin + location.pathname + '?sync=' + encodeURIComponent(code());
  }
  function applyCode(str, quiet) {
    var v = String(str || '').trim();
    var m = v.match(/[?&]sync=([^&\s]+)/);
    var raw = m ? decodeURIComponent(m[1]) : v;
    if (raw.indexOf(CODE_PREFIX) === 0) raw = raw.slice(CODE_PREFIX.length);
    var o;
    try { o = JSON.parse(b64dec(raw)); } catch (e) { toast('同步码无法识别'); return false; }
    if (!o || !o.t) { toast('同步码不完整'); return false; }
    S.token = o.t; S.gistId = o.g || ''; S.auto = true; saveCfg();
    var t = $(S.ui.token), g = $(S.ui.gist), a = $(S.ui.auto);
    if (t) t.value = o.t;
    if (g) g.value = o.g || '';
    if (a) a.checked = true;
    renderBox();
    if (!quiet) toast('已接入同步，正在拉取…');
    sync(true);
    return true;
  }
  function consumeUrlCode() {
    try {
      var m = location.search.match(/[?&]sync=([^&]+)/);
      if (!m) return false;
      var c = decodeURIComponent(m[1]);
      history.replaceState(null, '', location.pathname + (location.hash || ''));
      return applyCode(c, true);
    } catch (e) { return false; }
  }

  function copy(text) {
    function fb() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fb(); });
    }
    return Promise.resolve(fb());
  }

  /* 账号下出现多个备份文件时（不同设备各自创建过），合并到最近更新的那个并删除多余的。
     不统一的话各设备会一直各写各的，表现就是「单向同步」——这是跨设备同步最常见的坑。 */
  function unify() {
    if (!S.token) { toast('请先填写 Token'); return Promise.resolve(0); }
    return ghFetch(GH_API + '/gists?per_page=100', { headers: ghHeaders() }).then(function (list) {
      var arr = Array.isArray(list) ? list : [];
      var hit = arr.filter(function (g) { return g && g.files && g.files[S.file]; })
        .sort(function (a, b) { return String(a.updated_at || '') < String(b.updated_at || '') ? 1 : -1; });
      if (hit.length < 2) {
        toast(hit.length ? '只找到 1 个备份文件，无需统一' : '账号下没有备份文件');
        return 0;
      }
      return Promise.all(hit.map(function (g) { return readGistProg(g.id); })).then(function (rows) {
        var merged = {}, reset = S.resetAt || 0;
        rows.forEach(function (r) {
          if (!r) return;
          if ((r.resetAt || 0) > reset) reset = r.resetAt || 0;
          Object.keys(r.prog || {}).forEach(function (id) {
            var b = r.prog[id], a = merged[id];
            if (b && (!a || (b.t || 0) > (a.t || 0))) merged[id] = b;
          });
        });
        Object.keys(S.data).forEach(function (id) {          /* 本机也参与合并 */
          var a = S.data[id], b = merged[id];
          if (a && (!b || (a.t || 0) > (b.t || 0))) merged[id] = a;
        });
        S.data = merged; S.resetAt = reset;
        saveData(); lsSet(resetKey(), reset);
        S.gistId = hit[0].id; saveCfg();
        var gid = $(S.ui.gist); if (gid) gid.value = S.gistId;
        var f = {}; f[S.file] = { content: payload() };
        return ghFetch(GH_API + '/gists/' + hit[0].id, {
          method: 'PATCH', headers: ghHeaders(), body: JSON.stringify({ files: f })
        }).then(function () {
          return Promise.all(hit.slice(1).map(function (g) {
            return ghFetch(GH_API + '/gists/' + g.id, { method: 'DELETE', headers: ghHeaders() })
              .catch(function () { return null; });       /* 删不掉也无妨，已统一指向同一个文件 */
          }));
        }).then(function () {
          S.lastSync = Date.now(); lsSet(syncKey(), S.lastSync);
          if (S.onChange) S.onChange(Object.keys(merged).length);
          renderBox();
          toast('已把 ' + hit.length + ' 个备份文件合并为 1 个，共 ' + Object.keys(merged).length + ' 条');
          return hit.length;
        });
      });
    }).catch(function (e) { toast('统一失败：' + (e.message || e)); return 0; });
  }
  function readGistProg(id) {
    return ghFetch(GH_API + '/gists/' + id, { headers: ghHeaders() }).then(function (g) {
      var f = g.files && g.files[S.file];
      if (!f) return null;
      var o = JSON.parse(f.content || '{}');
      return { prog: (o && o.prog) || {}, resetAt: (o && o.resetAt) || 0 };
    }).catch(function () { return null; });
  }

  /* ---- 自检：把同步链路每一步的结果打印出来 ---- */
  function diag() {
    var L = [];
    var p = function (s) { L.push(s); };
    p('== 同步自检 ==');
    p('时间：' + new Date().toLocaleString());
    p('自动同步：' + (S.auto ? '开' : '关'));
    p('本地数据：' + Object.keys(S.data).length + ' 条');
    p('resetAt：' + (S.resetAt || 0));
    p('上次同步：' + (S.lastSync ? ago() : '无'));
    p('Token：' + (S.token ? '已填（' + S.token.slice(0, 4) + '…）' : '未填'));
    p('最近一次上传：' + (S.pushOk === true ? '成功' : S.pushOk === false ? '失败' : '未发生过'));
    if (S.error) p('最近错误：' + S.error);
    if (!S.token) { p('结论：Token 为空，请先生成并粘贴'); return show(L.join('\n')); }
    var remoteProg = null, remoteReset = 0;
    status('诊断中', 'busy');
    return ghFetch(GH_API + '/user', { headers: ghHeaders() }).then(function (u) {
      p('账号验证：成功，' + u.login);
      var scopes = ghHeader('x-oauth-scopes');
      p('Token 权限：' + (scopes || '（浏览器未暴露该响应头，以下一步实测为准）'));
      p('API 剩余额度：' + (ghHeader('x-ratelimit-remaining') || '-'));
      if (scopes && scopes.indexOf('gist') < 0) p('⚠ Token 没有 gist 权限，只能读不能写！');
      return ghFetch(GH_API + '/gists?per_page=100', { headers: ghHeaders() });
    }).then(function (list) {
      var arr = Array.isArray(list) ? list : [];
      var hit = arr.filter(function (g) { return g && g.files && g.files[S.file]; });
      p('账号 Gist：' + arr.length + ' 个，含备份文件：' + hit.length + ' 个');
      if (hit.length > 1) {
        p('⚠ 有 ' + hit.length + ' 个备份文件：设备可能各写一个，这是「单向同步」的典型原因，请调用 GhSync.unify() 合并。');
      }
      hit.forEach(function (g) { p('  - ' + g.id + '（' + (g.description || '无描述') + '）'); });
      return ensureGist(true);
    }).then(function (id) {
      p('选用 Gist：' + (id || '无'));
      if (!id) { p('结论：账号下没有备份，同步时会自动创建'); return null; }
      return readRemote();
    }).then(function (res) {
      if (res) {
        remoteProg = res.prog; remoteReset = res.resetAt || 0;
        p('云端数据：' + Object.keys(res.prog).length + ' 条');
        p('云端 resetAt：' + (res.resetAt || 0));
        p('结论：' + (needsPush(res.prog, res.resetAt) ? '本地有更新，需回传' : '两端一致或云端更新'));
        var maxT = 0;
        Object.keys(res.prog).forEach(function (id) {
          var t = (res.prog[id] || {}).t || 0;
          if (t > maxT) maxT = t;
        });
        if (maxT) {
          p('云端最新时间：' + new Date(maxT).toLocaleString());
          if (maxT > Date.now() + 300000) {
            p('⚠ 云端存在「未来」时间戳（比本机早 ' + Math.round((maxT - Date.now()) / 60000) +
              ' 分钟）：某台设备系统时间超前，它的记录会一直被判为更新，把别台的新数据压住。请把那台设备时间设为自动同步。');
          }
        }
      } else p('云端读取：失败');
    }).catch(function (e) {
      S.error = e && (e.message || '未知错误');
      p('诊断中断：' + S.error);
    }).then(function () {
      var pending = 0;
      Object.keys(S.data).forEach(function (id) {
        var a = S.data[id], b = (remoteProg || {})[id];
        if (a && (!b || (a.t || 0) > (b.t || 0)) && (a.t || 0) > remoteReset) pending++;
      });
      p('待回传：' + pending + ' 条');
      if (!pending || !S.gistId) return null;
      return push(true, true, false).then(function () {     /* 实测写入权限 */
        p('实测上传：' + (S.pushOk ? '成功' : '失败 —— ' + (S.error || '')));
        if (!S.pushOk && /HTTP 40[13]/.test(S.error || '')) {
          p('⚠ 写入被拒绝：Token 权限不足或已失效，请重新生成一个勾选了 gist 的 Token');
        }
      });
    }).then(function () {
      /* 有错误就保持失败态，否则会把刚显示出来的重试入口又隐藏掉 */
      status(S.error ? '同步失败' : (S.gistId ? '已连接' : '待创建'), S.error ? 'off' : '');
      var txt = L.join('\n');
      show(txt); copy(txt); toast('诊断报告已生成并复制');
      return txt;
    });
  }
  function show(text) {
    var box = $(S.ui.box);
    if (!box) return;
    box.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-all;margin:0;font-size:12px;line-height:1.6;padding:10px;border-radius:8px;background:rgba(127,127,127,.12)">'
      + String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  }
  function ago() {
    var s = Math.floor((Date.now() - S.lastSync) / 1000);
    if (s < 5) return '刚刚同步';
    if (s < 60) return s + ' 秒前同步';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前同步';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前同步';
    return new Date(S.lastSync).toLocaleString() + ' 同步';
  }
  function status(text, cls) {
    var el = $(S.ui.status);
    if (el) { el.textContent = text; el.className = 'dot' + (cls ? ' ' + cls : ''); }
    /* 顶栏：所有页面都可见，失败时给一个重试入口 */
    var dot = $(S.ui.status + 'Dot'), txt = $(S.ui.status + 'Text');
    if (dot) dot.className = 'dot' + (cls ? ' ' + cls : '');
    if (txt) txt.textContent = S.token ? text : '本地进度';
    var retry = $(S.ui.retry);
    if (retry) retry.hidden = !(S.token && cls === 'off');
    renderAgo();
  }
  /* 顶栏「上次同步」相对时间：本地计算，每 30 秒自刷新，不发请求 */
  function renderAgo() {
    var el = $(S.ui.ago);
    if (!el) return;
    if (!S.token) { el.textContent = ''; el.title = '填写 Token 后可跨设备同步'; return; }
    el.textContent = S.lastSync ? ago() : (S.busy ? '正在同步…' : '等待同步');
    el.title = S.lastSync ? new Date(S.lastSync).toLocaleString() : '尚未同步过';
  }
  function toast(msg) { if (window.toast) window.toast(msg); else if (window.console) console.log('[gh-sync] ' + msg); }
  function renderBox() {
    var box = $(S.ui.box);
    if (!box) return;
    if (!S.token) { box.innerHTML = '<div class="muted">未连接。填一次 Token（每台设备填<b>同一个</b>），各设备数据自动同步。</div>'; status('未连接', 'off'); return; }
    var head = S.gistId
      ? '<div class="muted">已连接备份：' + S.gistId.slice(0, 8) + '… <a href="https://gist.github.com/' + S.gistId + '" target="_blank" rel="noopener">打开 Gist</a></div>'
      : (S.error ? '<div style="color:#c00">同步失败：' + esc(S.error) + '</div>' : '<div class="muted">正在查找/创建云端备份…</div>');
    box.innerHTML = head
      + '<div class="muted" style="margin-top:6px">' + (S.auto ? '自动同步已开启：打开页面、切回本页、恢复网络都会自动对齐，后台每 60 秒检查一次。' : '自动同步已关闭。') + '</div>'
      + (S.lastSync ? '<div class="muted" style="margin-top:6px">上次同步：' + ago() + '</div>' : '')
      + (S.error ? '<div style="color:#c00;margin-top:6px">最近错误：' + esc(S.error) + '</div>' : '');
    /* 有错误就保持失败态，否则会把刚显示出来的重试入口又隐藏掉 */
    status(S.error ? '同步失败' : (S.gistId ? '已连接' : '待创建'), S.error ? 'off' : '');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ---- UI 绑定：任何带 data-gh 的按钮都能用；输入框用 data-gh-in ---- */
  function bindUI() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-gh]') : null;
      if (!t) return;
      var a = t.getAttribute('data-gh');
      if (a === 'push') push(false);
      else if (a === 'pull') pull(false);
      else if (a === 'diag') diag();
      else if (a === 'unify') unify();
      else if (a === 'forget') forget();
      else if (a === 'test') {
        if (!S.token) { toast('请先填写 Token'); return; }
        status('验证中', 'busy');
        ghFetch(GH_API + '/user', { headers: ghHeaders() }).then(function (u) {
          status('Token 有效：' + u.login, ''); toast('Token 有效：' + u.login);
        }).catch(function (er) { status('Token 无效', 'off'); toast('Token 无效：' + er.message); });
      }
      else if (a === 'copyCode') { if (!S.token) { toast('请先填写 Token'); return; } copy(code()).then(function (ok) { toast(ok ? '同步码已复制' : '复制失败，请手动选择'); }); }
      else if (a === 'copyLink') { if (!S.token) { toast('请先填写 Token'); return; } copy(link()).then(function (ok) { toast(ok ? '同步链接已复制' : '复制失败'); }); }
      else if (a === 'importCode') { var i = $(S.ui.code); if (i && i.value.trim()) { if (applyCode(i.value, false)) i.value = ''; } else toast('请先粘贴同步码'); }
    });
    var tok = $(S.ui.token);
    if (tok) {
      tok.value = S.token || '';
      var tt = null, upd = function () { S.token = tok.value.trim(); saveCfg(); renderBox(); if (S.token) sync(true); };
      tok.addEventListener('change', upd);
      tok.addEventListener('input', function () { clearTimeout(tt); tt = setTimeout(upd, 800); });
    }
    var gid = $(S.ui.gist);
    if (gid) {
      gid.value = S.gistId || '';
      var gt = null, gupd = function () {
        var v = gid.value.trim(), m = v.match(/([0-9a-f]{20,})/i);
        S.gistId = m ? m[1] : (v ? S.gistId : '');
        gid.value = S.gistId; saveCfg(); renderBox();
        if (S.token) sync(true);
      };
      gid.addEventListener('change', gupd);
      gid.addEventListener('input', function () { clearTimeout(gt); gt = setTimeout(gupd, 800); });
    }
    var au = $(S.ui.auto);
    if (au) {
      au.checked = S.auto !== false;
      au.addEventListener('change', function () { S.auto = au.checked; saveCfg(); renderBox(); if (S.auto) sync(true); });
    }
    var cb = $(S.ui.code);
    if (cb) cb.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var i = $(S.ui.code); if (i && i.value.trim()) { if (applyCode(i.value, false)) i.value = ''; } } });
  }

  /* ---- 后台自动同步 ---- */
  function startAuto() {
    renderAgo();                                    /* 先把已有的「上次同步」显示出来 */
    clearInterval(S.agoTimer);
    S.agoTimer = setInterval(renderAgo, 30000);     /* 相对时间自己走，不发请求 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') sync();
      else flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    window.addEventListener('online', function () { sync(true); });
    window.addEventListener('offline', function () { status('离线', 'off'); });
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') sync();
    }, POLL_MS);
  }

  window.GhSync = {
    init: function (opt) {
      opt = opt || {};
      S.storeKey = opt.storeKey || 'app_progress';
      S.file = opt.file || 'progress.json';
      S.desc = opt.desc || '应用进度备份';
      S.onChange = opt.onChange || null;
      S.ui = {
        status: opt.statusEl || 'ghStatus', box: opt.boxEl || 'ghBox',
        auto: opt.autoEl || 'ghAuto', token: opt.tokenEl || 'ghToken',
        gist: opt.gistEl || 'ghGist', code: opt.codeEl || 'ghCode',
        ago: opt.agoEl || 'syncAgo', retry: opt.retryEl || 'syncRetry'
      };
      load();
      bindUI();
      renderBox();
      if (!consumeUrlCode()) sync(false, true);
      startAuto();
      return this;
    },
    data: function () { return S.data; },
    get: function (id) { return S.data[id]; },
    set: function (id, obj) {
      obj = obj || {};
      obj.t = Date.now();
      S.data[id] = obj;
      saveData();
      if (S.auto && S.token) schedulePush();
    },
    remove: function (id) { delete S.data[id]; saveData(); if (S.auto && S.token) schedulePush(); },
    reset: function () {                       /* 清空并压过云端 */
      S.data = {}; S.resetAt = Date.now();
      lsSet(resetKey(), S.resetAt); saveData();
      if (S.auto && S.token) schedulePush();
    },
    sync: sync, push: push, pull: pull, flush: flush, diag: diag, unify: unify, forget: forget,
    code: code, link: link, applyCode: applyCode,
    renderBox: renderBox, renderAgo: renderAgo,
    state: function () { return { token: S.token, gistId: S.gistId, auto: S.auto, lastSync: S.lastSync, pushOk: S.pushOk, error: S.error }; }
  };
})();
