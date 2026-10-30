/* 随手记 · app.js v1
 * 数据模型（存于 GhSync，单条新者胜）：
 *   分类/项目节点: { kind:'cat'|'proj', name, parent:id|null, t }
 *   记录:          { kind:'note', text, cat:id|null, proj:id|null, tags:[], c:创建时间, u:修改时间|省略, t }
 *   删除一律软删（del:1，时间戳更新），软删动作会同步到其他设备；回收站可恢复。
 */
(function () {
  'use strict';

  var PAGE = 10;
  var state = {
    view: { type: 'all' },        // all | trash | cat:<id> | proj:<id>
    search: '',
    page: 1,
    editId: null,                 // 正在编辑的记录 id
    moveId: null,                 // 正在调整归属（分类/项目）的记录 id
    remId: null,                  // 正在设置提醒的记录 id
    openRel: null                 // 展开关联的记录 id
  };
  var RO = null;                  // 只读分享视图数据（数组）

  /* ---------- 小工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtT(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function dtlVal(ms) {  /* datetime-local 输入框的值 */
    if (!ms) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function genId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  /* 配色：按 id/name 稳定哈希出固定色相，同一分类/项目/标签永远同色 */
  function hueOf(s) {
    s = String(s || 'x');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function catColor(id) { return 'hsl(' + hueOf(id) + ',62%,46%)'; }
  function tagStyle(t) {
    var h = hueOf(t);
    return 'background:hsl(' + h + ',72%,93%);color:hsl(' + h + ',62%,32%);border:1px solid hsl(' + h + ',55%,85%)';
  }

  /* ---------- 自动关键词提取（未填标签时） ---------- */
  var STOPSET = {};
  '我们 你们 他们 这个 那个 现在 今天 明天 昨天 时候 可以 可能 就是 还是 也是 如果 但是 因为 所以 然后 不过 已经 或者 以及 以上 以下 之后 之前 什么 怎么 一个 一些 自己 这样 那样 需要 应该 关于 通过 进行 使用'.split(' ').forEach(function (w) { STOPSET[w] = 1; });
  function autoKeywords(text) {
    var out = [], seen = {};
    function add(w) {
      w = String(w || '').trim();
      if (w && w.length >= 2 && !seen[w] && out.length < 3) { seen[w] = 1; out.push(w); }
    }
    var t = String(text || '').slice(0, 400);
    /* 数字/字母词：CBI20261123、400*50 这类整体保留 */
    (t.match(/[A-Za-z][A-Za-z0-9_\-\/\*.]{2,19}|\d[A-Za-z0-9_\-\/\*.]{1,19}/g) || []).forEach(add);
    /* 中文高频 2-3 字组合 */
    var segs = t.replace(/[^\u4e00-\u9fa5]+/g, '|').split('|').filter(function (s) { return s.length >= 2; });
    var freq = {};
    segs.forEach(function (s) {
      for (var n = 2; n <= 3; n++)
        for (var i = 0; i + n <= s.length; i++) {
          var g = s.substr(i, n);
          freq[g] = (freq[g] || 0) + 1;
        }
    });
    Object.keys(freq).filter(function (g) { return freq[g] >= 2 && !STOPSET[g]; })
      .sort(function (a, b) { return freq[b] * b.length - freq[a] * a.length; })
      .forEach(function (g) {
        if (out.every(function (w) { return w.indexOf(g) < 0 && g.indexOf(w) < 0; })) add(g);
      });
    /* 兜底：无重复词时取最长中文段前 2-4 字 */
    if (!out.length && segs.length) {
      segs.sort(function (a, b) { return b.length - a.length; });
      if (segs[0].length >= 2) add(segs[0].substr(0, Math.min(4, segs[0].length)));
    }
    return out;
  }

  /* ---------- 日历 .ics（关联手机/电脑日历） ---------- */
  function icsTime(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + '00Z';
  }
  function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n'); }
  function downloadIcs(id) {
    var v = all()[id]; if (!v) return;
    var inp = $('remAt');
    var when = (inp && inp.value) ? new Date(inp.value).getTime() : v.remindAt;
    if (!when || isNaN(when)) { toast('请先设置提醒时间'); return; }
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//suishouji//CN', 'BEGIN:VEVENT',
      'UID:qn-' + id + '@quick-notes',
      'DTSTAMP:' + icsTime(Date.now()),
      'DTSTART:' + icsTime(when),
      'DTEND:' + icsTime(when + 15 * 60000),
      'SUMMARY:' + icsEsc((v.text || '随手记提醒').slice(0, 80)),
      'DESCRIPTION:' + icsEsc((v.text || '').slice(0, 300)),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:随手记提醒', 'TRIGGER:-PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'];
    download('随手记提醒_' + stamp() + '.ics', lines.join('\r\n'), 'text/calendar;charset=utf-8');
    toast('已下载 .ics：手机上打开即可加入系统日历并由手机提醒');
  }
  function b64enc(s) {
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64dec(s) {
    var v = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (v.length % 4) v += '=';
    return decodeURIComponent(escape(atob(v)));
  }
  var toastTimer = null;
  window.toast = function (msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  };

  /* ---------- 数据访问 ---------- */
  function all() { return GhSync.data(); }
  function node(id) { var v = all()[id]; return (v && !v.del) ? v : null; }
  function nodes(kind) {
    var out = [];
    Object.keys(all()).forEach(function (id) {
      var v = all()[id];
      if (v && v.kind === kind && !v.del) out.push({ id: id, v: v });
    });
    return out;
  }
  function notes() { return nodes('note'); }
  function children(pid, kind) {
    return nodes(kind).filter(function (x) { return x.v.parent === pid; })
      .sort(function (a, b) { return (a.v.t || 0) - (b.v.t || 0); });
  }
  function catPath(id) {
    var arr = [], cur = id, guard = 0;
    while (cur && guard++ < 20) {
      var v = node(cur); if (!v) break;
      arr.unshift(v.name); cur = v.parent;
    }
    return arr;
  }
  /* 节点自身及其后代中的记录数 */
  function countIn(pid, kind) {
    var n = 0, self = all()[pid];
    if (self && self.kind === 'note' && !self.del) n++;
    nodes(kind).forEach(function (x) {
      if (x.v.parent === pid) n += countIn(x.id, kind);
    });
    var cnt = 0;
    notes().forEach(function (x) { if (x.v[kind === 'cat' ? 'cat' : 'proj'] === pid) cnt++; });
    return cnt + (kind === 'cat'
      ? nodes('cat').filter(function (c) { return c.v.parent === pid; }).reduce(function (s, c) { return s + countIn(c.id, 'cat'); }, 0)
      : nodes('proj').filter(function (p) { return p.v.parent === pid; }).reduce(function (s, p) { return s + countIn(p.id, 'proj'); }, 0));
  }
  function delCount() {
    var n = 0;
    Object.keys(all()).forEach(function (id) { var v = all()[id]; if (v && v.del) n++; });
    return n;
  }

  /* 关联：同分类 / 同项目 / 共同标签 */
  function related(id) {
    var me = all()[id]; if (!me) return [];
    var myTags = (me.tags || []);
    return notes().filter(function (x) {
      if (x.id === id) return false;
      if (me.cat && x.v.cat === me.cat) return true;
      if (me.proj && x.v.proj === me.proj) return true;
      var their = x.v.tags || [];
      for (var i = 0; i < myTags.length; i++) if (their.indexOf(myTags[i]) >= 0) return true;
      return false;
    }).map(function (x) {
      var why = [];
      if (me.cat && x.v.cat === me.cat) why.push('同分类');
      if (me.proj && x.v.proj === me.proj) why.push('同项目');
      (x.v.tags || []).forEach(function (tg) { if (myTags.indexOf(tg) >= 0 && why.indexOf('#' + tg) < 0) why.push('#' + tg); });
      return { id: x.id, v: x.v, why: why.join('、') };
    }).sort(function (a, b) { return (b.v.c || 0) - (a.v.c || 0); });
  }

  /* ---------- 视图过滤 ---------- */
  function viewCatId() { return state.view.type === 'cat' ? state.view.id : null; }
  function viewProjId() { return state.view.type === 'proj' ? state.view.id : null; }
  /* 记录是否属于某分类（含子分类） */
  function inCat(noteCat, target) {
    var cur = noteCat, guard = 0;
    while (cur && guard++ < 20) {
      if (cur === target) return true;
      var v = all()[cur]; if (!v) return false;
      cur = v.parent;
    }
    return false;
  }
  function matchSearch(n, text, tags) {
    if (!state.search) return true;
    var q = state.search.toLowerCase();
    if (text.toLowerCase().indexOf(q) >= 0) return true;
    for (var i = 0; i < tags.length; i++) if (tags[i].toLowerCase().indexOf(q) >= 0) return true;
    var cp = n.cat ? catPath(n.cat).join('/') : '';
    var pp = n.proj ? catPath(n.proj).join('/') : '';
    if (cp.toLowerCase().indexOf(q) >= 0 || pp.toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }
  function currentNotes() {
    if (RO) return RO.slice();
    if (state.view.type === 'trash') {
      return Object.keys(all()).filter(function (id) { var v = all()[id]; return v && v.del; })
        .map(function (id) { return { id: id, v: all()[id] }; })
        .filter(function (x) { return matchSearch(x.v, x.v.text || '', x.v.tags || []); })
        .sort(function (a, b) { return (b.v.c || 0) - (a.v.c || 0); });
    }
    var type = state.view.type;
    return notes().filter(function (x) {
      if (type === 'cat' && !inCat(x.v.cat, state.view.id)) return false;
      if (type === 'proj' && !inCat(x.v.proj, state.view.id)) return false;
      return matchSearch(x.v, x.v.text || '', x.v.tags || []);
    }).sort(function (a, b) { return (b.v.c || 0) - (a.v.c || 0); });
  }
  function viewName() {
    if (RO) return '只读分享';
    if (state.view.type === 'all') return '全部记录';
    if (state.view.type === 'trash') return '回收站';
    if (state.view.type === 'cat') return catPath(state.view.id).join(' / ');
    if (state.view.type === 'proj') return '项目：' + catPath(state.view.id).join(' / ');
    return '';
  }

  /* ---------- 树渲染 ---------- */
  function expLoad() {
    try { return JSON.parse(localStorage.getItem('qn_exp') || '{}') || {}; } catch (e) { return {}; }
  }
  function expSave(o) { try { localStorage.setItem('qn_exp', JSON.stringify(o)); } catch (e) { /* 忽略 */ } }
  var EXP = expLoad();
  function isExp(id, parent) {
    return EXP[id] !== undefined ? !!EXP[id] : (parent === null || parent === undefined);
  }
  function renderTree(kind, rootEl) {
    var html = [];
    function walk(pid, depth) {
      children(pid, kind).forEach(function (x) {
        var kids = children(x.id, kind);
        var open = isExp(x.id, x.v.parent) && kids.length > 0;
        var active = state.view.type === kind && state.view.id === x.id;
        html.push('<div class="tree-item' + (active ? ' active' : '') + '" style="padding-left:' + (6 + depth * 16) + 'px" data-act="view" data-view="' + kind + ':' + esc(x.id) + '" data-id="' + esc(x.id) + '">'
          + '<span class="tgl" data-act="toggle" data-id="' + esc(x.id) + '">' + (kids.length ? (open ? '▾' : '▸') : '') + '</span>'
          + '<span class="tdot" style="background:' + catColor(x.id) + '"></span>'
          + '<span class="tname">' + esc(x.v.name) + '</span>'
          + '<span class="cnt">' + countIn(x.id, kind) + '</span>'
          + '<span class="rops">'
          + '<button class="mini" data-act="addsub" data-kind="' + kind + '" data-id="' + esc(x.id) + '" title="新建子级">＋</button>'
          + '<button class="mini" data-act="ren" data-kind="' + kind + '" data-id="' + esc(x.id) + '" title="重命名">✎</button>'
          + '<button class="mini danger" data-act="delnode" data-kind="' + kind + '" data-id="' + esc(x.id) + '" title="删除（进回收站）">×</button>'
          + '</span></div>');
        if (open) walk(x.id, depth + 1);
      });
    }
    walk(null, 0);
    rootEl.innerHTML = html.join('') || '<div class="muted" style="padding:2px 6px">（空，点标题旁 ＋ 新建）</div>';
  }

  /* ---------- 列表渲染 ---------- */
  function hlText(text) {
    var safe = esc(text);
    if (!state.search) return safe;
    var q = state.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return safe.replace(new RegExp('(' + esc(q) + ')', 'gi'), '<span class="hl">$1</span>'); }
    catch (e) { return safe; }
  }
  function relItemHtml(r) {
    var path = [];
    if (r.v.cat) path.push(catPath(r.v.cat).join('/'));
    if (r.v.proj) path.push('[' + catPath(r.v.proj).join('/') + ']');
    return '<div class="rel-item" data-act="goto" data-id="' + esc(r.id) + '">'
      + '<span class="rtime">' + fmtT(r.v.c) + '</span>'
      + '<span class="rtxt">' + esc((r.v.text || '').slice(0, 60)) + '</span>'
      + '<span class="rel-why">' + esc(r.why) + '</span></div>';
  }
  function noteCardHtml(id, v) {
    var accent = v.cat ? catColor(v.cat) : (v.proj ? catColor(v.proj) : '#b7bfc7');
    var pathBits = [];
    if (v.cat) pathBits.push('<span class="dotmark" style="background:' + catColor(v.cat) + '"></span>📂 ' + esc(catPath(v.cat).join(' / ')));
    if (v.proj) pathBits.push('<span class="dotmark" style="background:' + catColor(v.proj) + '"></span>📌 ' + esc(catPath(v.proj).join(' / ')));
    var tags = (v.tags || []).map(function (t) {
      return '<span class="tagchip" style="' + tagStyle(t) + '" data-act="tag" data-tag="' + esc(t) + '">#' + esc(t) + '</span>';
    }).join('');
    var rel = related(id);
    var relHtml = '';
    if (state.openRel === id) {
      relHtml = '<div class="rel-box"><div class="rel-title">关联记录 ' + rel.length + ' 条（同分类 / 同项目 / 共同标签）</div>'
        + (rel.length ? rel.slice(0, 30).map(relItemHtml).join('') : '<div class="muted">暂无关联</div>') + '</div>';
    }
    var body;
    if (state.editId === id) {
      body = '<div class="edit-area"><textarea id="editText">' + esc(v.text) + '</textarea>'
        + '<div class="edit-btns"><button class="btn dark sm" data-act="saveedit" data-id="' + esc(id) + '">保存</button>'
        + '<button class="btn ghost sm" data-act="canceledit">取消</button></div></div>';
    } else {
      var imgsHtml = '';
      if ((v.imgs || []).length) {
        imgsHtml = '<div class="note-imgs">' + v.imgs.map(function (d, i) {
          return '<img class="note-img" src="' + d + '" alt="图' + (i + 1) + '" data-act="imgview" data-id="' + esc(id) + '" data-i="' + i + '" title="点击查看大图">';
        }).join('') + '</div>';
      }
      body = '<div class="note-text">' + hlText(v.text) + '</div>' + imgsHtml;
    }
    var timeStr = fmtT(v.c) + (v.u && v.u !== v.c ? ' · 修改于 ' + fmtT(v.u) : '');
    var remBadge = '';
    if (v.remindAt) {
      var over = !v.remDone && v.remindAt <= Date.now();
      remBadge = '<span class="rembadge' + (v.remDone ? ' done' : (over ? ' over' : '')) + '">⏰ ' + fmtT(v.remindAt) + (v.remDone ? ' · 已提醒' : (over ? ' · 已到时间' : '')) + '</span>';
    }
    var foot;
    if (state.view.type === 'trash') {
      foot = '<button class="linkbtn" data-act="restore" data-id="' + esc(id) + '">恢复</button>';
    } else {
      foot = '<button class="linkbtn" data-act="edit" data-id="' + esc(id) + '">编辑</button>'
        + '<button class="linkbtn" data-act="move" data-id="' + esc(id) + '">归属</button>'
        + '<button class="linkbtn" data-act="rem" data-id="' + esc(id) + '">⏰ 提醒</button>'
        + '<button class="linkbtn" data-act="delnote" data-id="' + esc(id) + '">删除</button>'
        + '<button class="linkbtn" data-act="shareone" data-id="' + esc(id) + '">分享此条</button>';
    }
    var remHtml = '';
    if (state.remId === id) {
      remHtml = '<div class="mv-box">'
        + '<label class="mv-item">提醒时间 <input type="datetime-local" id="remAt" value="' + dtlVal(v.remindAt) + '"></label>'
        + '<button class="btn dark sm" data-act="saverem" data-id="' + esc(id) + '">保存提醒</button>'
        + '<button class="btn ghost sm" data-act="clearrem" data-id="' + esc(id) + '">清除</button>'
        + '<button class="btn ghost sm" data-act="ics" data-id="' + esc(id) + '">加入日历（.ics）</button>'
        + '<button class="btn ghost sm" data-act="cancelrem">收起</button>'
        + '<span class="muted">点「加入日历」下载 .ics：手机上打开会调起系统日历，提醒由手机负责；网页端到点弹窗提醒。</span>'
        + '</div>';
    }
    var moveHtml = '';
    if (state.moveId === id) {
      moveHtml = '<div class="mv-box">'
        + '<label class="mv-item">分类 <select id="mvCat"><option value="">（不归分类）</option>' + treeOptions('cat', v.cat) + '</select></label>'
        + '<label class="mv-item">项目 <select id="mvProj"><option value="">（不归项目）</option>' + treeOptions('proj', v.proj) + '</select></label>'
        + '<button class="btn dark sm" data-act="savemove" data-id="' + esc(id) + '">保存归属</button>'
        + '<button class="btn ghost sm" data-act="cancelmove">取消</button>'
        + '</div>';
    }
    return '<div class="note-card" id="nc-' + esc(id) + '" style="border-left:4px solid ' + accent + '">'
      + '<div class="note-head"><span>🕐 ' + timeStr + '</span>' + remBadge
      + (pathBits.length ? '<span class="path">' + pathBits.join(' ｜ ') + '</span>' : '')
      + '</div>'
      + body
      + (tags ? '<div style="margin-top:6px">' + tags + '</div>' : '')
      + '<div class="note-foot">' + foot
      + (state.view.type !== 'trash' ? '<button class="linkbtn" data-act="rel" data-id="' + esc(id) + '">关联 ' + rel.length + ' 条 ▾</button>' : '')
      + '</div>' + moveHtml + remHtml + relHtml + '</div>';
  }
  /* 下拉选项：整棵树按层级缩进 */
  function treeOptions(kind, selected) {
    var out = [];
    (function walk(pid, depth) {
      children(pid, kind).forEach(function (x) {
        var pad = depth > 0 ? new Array(depth + 1).join('　') : '';
        out.push('<option value="' + esc(x.id) + '"' + (x.id === selected ? ' selected' : '') + '>' + pad + esc(x.v.name) + '</option>');
        walk(x.id, depth + 1);
      });
    })(null, 0);
    return out.join('');
  }
  function pagerHtml(total, page, pages) {
    function btn(p, label, cur, dis) {
      if (cur) return '<button class="cur">' + p + '</button>';
      if (dis) return '<button disabled>' + label + '</button>';
      return '<button data-pg="' + p + '">' + label + '</button>';
    }
    var parts = [btn(page - 1, '‹ 上一页', false, page <= 1)];
    var span = 2, shown = [];
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - page) <= span) shown.push(i);
    }
    var last = 0;
    shown.forEach(function (i) {
      if (i - last > 1) parts.push('<span class="gap">…</span>');
      parts.push(btn(i, i, i === page, false));
      last = i;
    });
    parts.push(btn(page + 1, '下一页 ›', false, page >= pages));
    parts.push('<span class="pinfo">第 <input id="pgGo" value="' + page + '"> / ' + pages + ' 页</span>');
    return '<div class="pager">' + parts.join('') + '</div>';
  }
  function renderList() {
    var box = $('listBox'); if (!box) return;
    var list = currentNotes();
    var pages = Math.max(1, Math.ceil(list.length / PAGE));
    var page = Math.min(Math.max(1, state.page), pages);
    state.page = page;
    var start = (page - 1) * PAGE;
    var slice = list.slice(start, start + PAGE);
    var vAccent = '#0969da';
    if (state.view.type === 'cat' || state.view.type === 'proj') {
      var vv = all()[state.view.id];
      if (vv) vAccent = catColor(state.view.id);
    }
    var html = '<div class="viewhead" style="border-left-color:' + vAccent + '"><span class="vname">' + esc(viewName()) + '</span>'
      + (state.search ? '<span class="vsearch">搜索“' + esc(state.search) + '”</span>' : '')
      + '<select class="vhsel" id="vhCat" title="切换到某分类"><option value="">📂 选分类</option>' + treeOptions('cat', state.view.type === 'cat' ? state.view.id : '') + '</select>'
      + '<select class="vhsel" id="vhProj" title="切换到某项目"><option value="">📌 选项目</option>' + treeOptions('proj', state.view.type === 'proj' ? state.view.id : '') + '</select>'
      + '<span class="vcount">' + list.length + ' 条</span></div>';
    if (!slice.length) {
      html += '<div class="empty">' + (state.search ? '没有匹配“' + esc(state.search) + '”的记录' : (state.view.type === 'trash' ? '回收站是空的' : '这里还没有记录，在上方写一条吧')) + '</div>';
    } else {
      html += slice.map(function (x) { return noteCardHtml(x.id, x.v); }).join('');
      html += pagerHtml(list.length, page, pages);
    }
    box.innerHTML = html;
    renderCounts();
  }
  function renderCounts() {
    $('cnt-all').textContent = notes().length;
    $('cnt-trash').textContent = delCount();
  }
  function markActiveNav() {
    document.querySelectorAll('.tree-item').forEach(function (el) { el.classList.remove('active'); });
    if (state.view.type === 'all') { var a = $('nav-all'); if (a) a.classList.add('active'); }
    if (state.view.type === 'trash') { var b = $('nav-trash'); if (b) b.classList.add('active'); }
    if (state.view.type === 'cat' || state.view.type === 'proj') {
      var kind = state.view.type;
      document.querySelectorAll('.tree-item[data-view="' + kind + ':' + state.view.id + '"]').forEach(function (el) { el.classList.add('active'); });
    }
  }
  function render() {
    if (RO) { renderRo(); return; }
    renderTree('cat', $('catTree'));
    renderTree('proj', $('projTree'));
    renderList();
    markActiveNav();
    $('editor').style.display = state.view.type === 'trash' ? 'none' : '';
    populatePicker();
    pipRender();   /* 悬浮窗开着时同步刷新 */
  }

  /* 输入区的分类/项目选择器：默认跟随当前视图 */
  function populatePicker() {
    var cs = $('inCat'), ps = $('inProj');
    if (!cs || !ps) return;
    var cSel = state.view.type === 'cat' ? state.view.id : '';
    var pSel = state.view.type === 'proj' ? state.view.id : '';
    cs.innerHTML = '<option value="">（不归分类）</option>' + treeOptions('cat', cSel);
    ps.innerHTML = '<option value="">（不归项目）</option>' + treeOptions('proj', pSel);
    cs.value = cSel || ''; ps.value = pSel || '';
  }
  /* 就地新建：重名直接选用已有 */
  function quickNode(kind) {
    var name = prompt('新建' + (kind === 'cat' ? '分类' : '项目') + '（重名将直接选用已有的）：');
    if (name === null) return;
    name = name.trim();
    if (!name) { toast('名称不能为空'); return; }
    var hit = nodes(kind).filter(function (x) { return x.v.name === name; })[0];
    var id;
    if (hit) {
      id = hit.id;
      toast('已选用已有的「' + name + '」');
    } else {
      id = genId();
      var parent = state.view.type === kind ? state.view.id : null;
      setNote(id, { kind: kind, name: name, parent: parent, del: 0 });
      if (parent) { EXP[parent] = true; expSave(EXP); }
      toast('已创建「' + name + '」');
    }
    render();
    var sel = $(kind === 'cat' ? 'inCat' : 'inProj');
    if (sel) sel.value = id;
  }

  /* ---------- 只读分享视图 ---------- */
  function renderRo() {
    document.body.classList.add('ro-mode');
    $('editor').hidden = true;
    var pv = $('pipBtn'); if (pv) pv.hidden = true;
    var rc = $('roCount'); if (rc) rc.textContent = RO.length;
    $('roBanner').hidden = false;
    $('settingsBtn') && ($('settingsBtn').hidden = true);
    $('menuBtn') && ($('menuBtn').hidden = true);
    var box = $('listBox');
    var pages = Math.max(1, Math.ceil(RO.length / PAGE));
    var page = Math.min(Math.max(1, state.page), pages);
    var slice = RO.slice((page - 1) * PAGE, page * PAGE);
    var html = '<div class="crumb"><span>只读分享 · 共 ' + RO.length + ' 条</span></div>';
    html += slice.map(function (n) {
      var bits = [];
      var accent = n.cat ? catColor(n.cat) : (n.proj ? catColor(n.proj) : '#b7bfc7');
      if (n.cat) bits.push('<span class="dotmark" style="background:' + catColor(n.cat) + '"></span>📂 ' + esc(n.cat));
      if (n.proj) bits.push('<span class="dotmark" style="background:' + catColor(n.proj) + '"></span>📌 ' + esc(n.proj));
      var tags = (n.tags || []).map(function (t) { return '<span class="tagchip" style="' + tagStyle(t) + '">#' + esc(t) + '</span>'; }).join('');
      return '<div class="note-card" style="border-left:4px solid ' + accent + '"><div class="note-head"><span>🕐 ' + fmtT(n.c) + '</span>'
        + (bits.length ? '<span class="path">' + bits.join(' ｜ ') + '</span>' : '') + '</div>'
        + '<div class="note-text">' + esc(n.text) + '</div>'
        + (tags ? '<div style="margin-top:6px">' + tags + '</div>' : '') + '</div>';
    }).join('');
    if (pages > 1) html += pagerHtml(RO.length, page, pages);
    box.innerHTML = html;
  }

  /* ---------- 操作 ---------- */
  function setNote(id, obj) { GhSync.set(id, obj); }
  /* ---------- 图片/截图快记 ---------- */
  var pendingImgs = [];            /* 待随下一条记录保存的图片（压缩后 dataURL） */
  var IMG_MAX = 4;                 /* 每条最多张数 */
  function compressImg(dataUrl, maxW, q) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () {
        var w = im.naturalWidth || im.width || maxW, h = im.naturalHeight || im.height || maxW;
        var r = Math.min(1, maxW / w);
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * r));
        cv.height = Math.max(1, Math.round(h * r));
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        res(cv.toDataURL('image/jpeg', q));
      };
      im.onerror = function () { rej(new Error('图片解码失败')); };
      im.src = dataUrl;
    });
  }
  function addImgFile(file) {
    if (!file || !/^image\//.test(file.type || '')) return;
    if (pendingImgs.length >= IMG_MAX) { toast('每条记录最多 ' + IMG_MAX + ' 张图'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      compressImg(String(rd.result), 1280, 0.62).then(function (d1) {
        /* 仍偏大则二次压缩，控制同步体积 */
        return d1.length > 220000 ? compressImg(d1, 800, 0.45) : d1;
      }).then(function (d) {
        pendingImgs.push(d);
        renderPendingImgs();
        toast('已添加图片 ' + pendingImgs.length + '/' + IMG_MAX);
      }).catch(function () { toast('图片处理失败，请换一张试试'); });
    };
    rd.readAsDataURL(file);
  }
  function renderPendingImgs() {
    var box = $('pendImgs'); if (!box) return;
    box.innerHTML = pendingImgs.map(function (d, i) {
      return '<span class="pendimg"><img src="' + d + '" alt="待添加"><b data-act="rmpend" data-i="' + i + '" title="移除">×</b></span>';
    }).join('') + (pendingImgs.length ? '<span class="muted" style="font-size:11px;align-self:center">' + pendingImgs.length + '/' + IMG_MAX + ' 张 · 随下一条记录保存</span>' : '');
  }
  function showImgView(src) {
    var ov = $('imgView');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'imgView';
      ov.innerHTML = '<img alt="查看大图"><div class="imgview-tip">点击任意处关闭</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function () { ov.classList.remove('on'); });
    }
    ov.querySelector('img').src = src;
    ov.classList.add('on');
  }
  function addNote() {
    var text = $('noteText').value.trim();
    if (!text) { toast('先写点内容'); return; }
    var tags = $('noteTags').value.trim().split(/[\s,，、]+/).filter(Boolean);
    var auto = false;
    if (!tags.length) { tags = autoKeywords(text); auto = tags.length > 0; }  /* 未手动填标签：自动提取关键词 */
    var obj = { kind: 'note', text: text, tags: tags, c: Date.now(), del: 0 };
    var ic = $('inCat') ? $('inCat').value : '';
    var ip = $('inProj') ? $('inProj').value : '';
    if (ic) obj.cat = ic;
    if (ip) obj.proj = ip;
    if (pendingImgs.length) obj.imgs = pendingImgs.slice();
    setNote(genId(), obj);
    $('noteText').value = ''; $('noteTags').value = '';
    pendingImgs.length = 0;
    renderPendingImgs();
    if (state.search) { state.search = ''; $('searchBox').value = ''; }
    state.page = 1;
    render();
    toast('已记录' + (auto ? '，自动标签：#' + tags.join(' #') : '') + (GhSync.state().token ? '' : '（本地保存，填 Token 后同步）'));
  }
  function delNode(kind, id) {
    var kids = children(id, kind);
    var msg = '把「' + (node(id) || {}).name + '」移入回收站？' + (kids.length ? '\n其下 ' + kids.length + ' 个子级将一并移入。' : '');
    if (!confirm(msg)) return;
    var now = Date.now();
    (function walkRec(pid) {
      children(pid, kind).forEach(function (x) {
        var v = all()[x.id];
        setNote(x.id, Object.assign({}, v, { del: 1, t: now }));
        walkRec(x.id);
      });
    })(id);
    var v = all()[id];
    setNote(id, Object.assign({}, v, { del: 1, t: now }));
    var notesIn = notes().filter(function (x) {
      return kind === 'cat' ? inCat(x.v.cat, id) : inCat(x.v.proj, id);
    });
    notesIn.forEach(function (x) { setNote(x.id, Object.assign({}, x.v, { del: 1, t: now })); });
    if (state.view.type === kind && state.view.id === id) state.view = { type: 'all' };
    state.page = 1;
    render();
    toast('已移入回收站（含子级与 ' + notesIn.length + ' 条记录）');
  }
  function gotoNote(id) {
    var v = all()[id]; if (!v) return;
    if (v.del) { state.view = { type: 'trash' }; }
    else if (v.cat) state.view = { type: 'cat', id: v.cat };
    else if (v.proj) state.view = { type: 'proj', id: v.proj };
    else state.view = { type: 'all' };
    state.search = ''; $('searchBox').value = '';
    /* 展开祖先链 */
    var cur = (v.cat || v.proj), guard = 0;
    while (cur && guard++ < 20) {
      EXP[cur] = true;
      var n = all()[cur]; if (!n) break;
      cur = n.parent;
    }
    expSave(EXP);
    /* 定位页码 */
    state.openRel = null; state.editId = null;
    render();
    var list = currentNotes();
    var idx = list.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) state.page = Math.floor(idx / PAGE) + 1;
    render();
    setTimeout(function () {
      var el = $('nc-' + id);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); }
    }, 60);
  }

  /* ---------- 导出 ---------- */
  function stamp() {
    var d = new Date();
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  /* 导出 Excel（.xlsx）：内容/分类/项目/标签/时间/状态一行一条，可直接排序筛选 */
  function exportExcel() {
    var list = currentNotes();
    if (!list.length) { toast('当前视图没有可导出的记录'); return; }
    if (typeof XlsxExport === 'undefined') { toast('导出模块未加载，请刷新页面'); return; }
    var rows = list.map(function (x, i) {
      var v = (x && x.v) ? x.v : (x || {});
      var cat = v.cat && node(v.cat) ? catPath(v.cat).join(' / ') : (v.cat ? String(v.cat) : '');
      var prj = v.proj && node(v.proj) ? catPath(v.proj).join(' / ') : (v.proj ? String(v.proj) : '');
      return [
        i + 1,
        (v.text || '') + ((v.imgs || []).length ? '（含图' + v.imgs.length + '张）' : ''),
        cat,
        prj,
        (v.tags || []).map(function (t) { return '#' + t; }).join(' '),
        fmtT(v.c),
        (v.u && v.u !== v.c) ? fmtT(v.u) : '',
        v.remindAt ? fmtT(v.remindAt) : '',
        v.del ? '回收站' : '正常'
      ];
    });
    var cols = [
      { title: '序号', width: 6 }, { title: '内容', width: 60 },
      { title: '分类', width: 22 }, { title: '项目', width: 22 },
      { title: '标签', width: 22 }, { title: '创建时间', width: 18 },
      { title: '修改时间', width: 18 }, { title: '提醒时间', width: 18 },
      { title: '状态', width: 8 }
    ];
    XlsxExport.download('随手记_' + stamp() + '.xlsx', { sheet: viewName() || '随手记', columns: cols, rows: rows });
    toast('已导出 Excel（' + list.length + ' 条）');
  }
  function exportJson() {
    var list = currentNotes();
    if (!list.length) { toast('当前视图没有可导出的记录'); return; }
    var out = list.map(function (x) {
      return { text: x.v.text, tags: x.v.tags || [], cat: x.v.cat ? catPath(x.v.cat).join('/') : '', proj: x.v.proj ? catPath(x.v.proj).join('/') : '', created: fmtT(x.v.c), updated: x.v.u ? fmtT(x.v.u) : '' };
    });
    download('随手记_' + stamp() + '.json', JSON.stringify({ exportedAt: fmtT(Date.now()), view: viewName(), count: out.length, notes: out }, null, 2), 'application/json;charset=utf-8');
    toast('已导出 JSON（' + out.length + ' 条）');
  }

  /* ---------- 分享链接 ---------- */
  /* 生成只读链接：内容整体编码进 ?s= 参数（放 query 而非 hash，兼容更多聊天软件的链接识别） */
  function buildShareUrl(list) {
    var payload = list.map(function (x) {
      var v = (x && x.v) ? x.v : (x || {});
      return {
        text: v.text || '',
        tags: v.tags || [],
        cat: v.cat ? catPath(v.cat).join(' / ') : '',
        proj: v.proj ? catPath(v.proj).join(' / ') : '',
        c: v.c || Date.now(),
        u: v.u || 0
      };
    });
    if (!payload.length) return null;
    var data = b64enc(JSON.stringify({ v: 1, from: '随手记', at: Date.now(), notes: payload }));
    return {
      url: location.origin + location.pathname + '?s=' + data,
      count: payload.length
    };
  }
  /* 打开分享弹窗：链接一定可见、可长按手动复制，手机端还给出「系统分享」 */
  function shareNotes(list, label) {
    list = (list || []).filter(Boolean);
    if (!list.length) { toast('没有可分享的记录'); return; }
    var built = buildShareUrl(list);
    if (!built) { toast('没有可分享的记录'); return; }
    var ta = $('shareUrl'); if (!ta) { copyText(built.url, function (ok) { toast(ok ? '分享链接已复制' : '复制失败'); }); return; }
    ta.value = built.url;
    $('shareMeta').textContent = (label || '分享') + ' · ' + built.count + ' 条 · 链接 ' + built.url.length + ' 字符';
    var warn = $('shareWarn');
    if (warn) {
      if (built.url.length > 6000) {
        warn.hidden = false;
        warn.textContent = '链接较长，部分聊天软件会截断。若对方打不开，请减少分享条数，或改用「导出」发文件。';
      } else warn.hidden = true;
    }
    var nat = $('shareNative');
    if (nat) nat.hidden = !(navigator.share && navigator.share);
    $('shareMask').hidden = false;
    document.body.classList.add('modal-open');
    /* 老浏览器/被拦截时不影响：链接就在框里，可长按复制 */
    copyText(built.url, function (ok) {
      if (ok) toast('链接已复制'); else toast('请长按下面的链接手动复制');
    });
  }
  function closeShare() {
    var m = $('shareMask'); if (m) m.hidden = true;
    document.body.classList.remove('modal-open');
  }
  /* 关闭分享页：直接关标签页，绝不跳回随手记主页 */
  function closeRoPage() {
    /* 1) 微信 / QQ 等内置浏览器：用关闭桥 */
    try {
      if (window.WeixinJSBridge && typeof window.WeixinJSBridge.call === 'function') {
        window.WeixinJSBridge.call('closeWindow');
        setTimeout(afterCloseTry, 400);
        return;
      }
    } catch (e) {}
    /* 2) 标准 window.close（仅对脚本打开的窗口有效；普通标签页会被浏览器忽略） */
    try { window.close(); } catch (e) {}
    setTimeout(afterCloseTry, 300);
  }
  /* 若页面还在（说明浏览器不允许自动关闭），退一级：回上一页，再不行给手动关闭提示 */
  function afterCloseTry() {
    if (document.hidden) return;                 /* 已经关掉了，定时器不会跑到这里 */
    var ref = '';
    try { ref = document.referrer || ''; } catch (e) {}
    var sameSite = ref && ref.indexOf(location.origin) === 0;  /* 上一页就是随手记自己，不能退回去 */
    if (!sameSite && history.length > 1) {
      try { history.back(); } catch (e) {}
      setTimeout(function () { if (!document.hidden) showBye(); }, 700);
      return;
    }
    showBye();
  }
  function showBye() {
    var bn = $('roBanner'); if (bn) bn.hidden = true;
    var box = $('listBox');
    if (box) {
      box.innerHTML = '<div class="bye-card"><div class="bye-t">分享浏览已结束</div>'
        + '<div class="muted">浏览器不允许网页自行关闭标签页，请手动关闭本页（不会跳转到随手记主页）。</div>'
        + '<button class="btn ghost" data-act="roreload">重新查看内容</button></div>';
    }
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  function copyShareUrl() {
    var ta = $('shareUrl'); if (!ta) return;
    copyText(ta.value, function (ok) {
      if (ok) { toast('链接已复制'); return; }
      try { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); } catch (e) {}
      toast('已选中链接，请长按复制');
    });
  }
  /* 复制：clipboard → execCommand → 回调（失败时由调用方引导手动复制） */
  function copyText(text, cb) {
    var finished = false;
    function fin(ok) {
      if (finished) return; finished = true;
      if (typeof cb === 'function') cb(ok);
      else if (typeof cb === 'string') toast(ok ? cb : '复制失败，请手动选择链接');
      else toast(ok ? '已复制' : '复制失败');
    }
    function fb() {
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.left = '0'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { ta.setSelectionRange(0, text.length); } catch (e) {}
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e) { ok = false; }
      fin(ok);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
        navigator.clipboard.writeText(text).then(function () { fin(true); }, fb);
        return;
      }
    } catch (e) {}
    fb();
  }

  /* ---------- 事件 ---------- */
  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (t) {
        var act = t.getAttribute('data-act');
        var id = t.getAttribute('data-id');
        if (act === 'view') {
          var vw = t.getAttribute('data-view');
          if (vw === 'all' || vw === 'trash') state.view = { type: vw };
          else { var p = vw.split(':'); state.view = { type: p[0], id: p[1] }; }
          state.page = 1; state.openRel = null; state.editId = null; state.moveId = null; state.remId = null;
          closeSidebar(); render();
          return;
        }
        if (act === 'toggle') {
          e.stopPropagation();
          EXP[id] = !isExp(id, undefined);
          expSave(EXP);
          renderTree('cat', $('catTree'));
          renderTree('proj', $('projTree'));
          markActiveNav();
          return;
        }
        if (act === 'addroot') { var k0 = t.getAttribute('data-kind'); createNode(k0, null); return; }
        if (act === 'addsub') { createNode(t.getAttribute('data-kind'), id); return; }
        if (act === 'ren') { renameNode(t.getAttribute('data-kind'), id); return; }
        if (act === 'delnode') { delNode(t.getAttribute('data-kind'), id); return; }
        if (act === 'tag') {
          state.search = t.getAttribute('data-tag'); $('searchBox').value = state.search;
          state.page = 1; renderList(); markActiveNav(); return;
        }
        if (act === 'rel') {
          state.openRel = state.openRel === id ? null : id; renderList(); return;
        }
        if (act === 'edit') { state.editId = id; state.moveId = null; renderList(); return; }
        if (act === 'canceledit') { state.editId = null; renderList(); return; }
        if (act === 'rem') { state.remId = state.remId === id ? null : id; state.moveId = null; state.editId = null; renderList(); return; }
        if (act === 'cancelrem') { state.remId = null; renderList(); return; }
        if (act === 'saverem') {
          var rv0 = all()[id];
          var iv = $('remAt') ? $('remAt').value : '';
          if (!rv0) return;
          if (!iv) { toast('请选择提醒时间'); return; }
          var when = new Date(iv).getTime();
          if (isNaN(when)) { toast('时间格式无法识别'); return; }
          setNote(id, Object.assign({}, rv0, { remindAt: when, remDone: 0 }));
          state.remId = null;
          renderList();
          setTimeout(checkReminders, 200);
          toast('提醒已设置：' + fmtT(when) + '，到点网页弹窗提醒');
          return;
        }
        if (act === 'clearrem') {
          var rc = all()[id];
          if (rc) {
            var clean = Object.assign({}, rc);
            delete clean.remindAt; delete clean.remDone;
            setNote(id, clean);
          }
          state.remId = null; renderList(); toast('已清除提醒');
          return;
        }
        if (act === 'ics') { downloadIcs(id); return; }
        if (act === 'saveedit') {
          var v = all()[id]; var ta = $('editText');
          if (v && ta && ta.value.trim()) {
            setNote(id, Object.assign({}, v, { text: ta.value.trim(), u: Date.now() }));
            state.editId = null; renderList(); toast('已修改');
          } else if (ta && !ta.value.trim()) toast('内容不能为空');
          return;
        }
        if (act === 'move') { state.moveId = state.moveId === id ? null : id; state.editId = null; state.remId = null; renderList(); return; }
        if (act === 'cancelmove') { state.moveId = null; renderList(); return; }
        if (act === 'savemove') {
          var mv = all()[id];
          if (!mv) return;
          var cv = ($('mvCat') || {}).value || '';
          var pv = ($('mvProj') || {}).value || '';
          var nu = Object.assign({}, mv, { u: Date.now() });
          if (cv) nu.cat = cv; else delete nu.cat;
          if (pv) nu.proj = pv; else delete nu.proj;
          setNote(id, nu);
          state.moveId = null;
          render();
          toast('归属已调整，关联关系将自动重算');
          return;
        }
        if (act === 'delnote') {
          if (!confirm('把这条记录移入回收站？')) return;
          var nv = all()[id];
          setNote(id, Object.assign({}, nv, { del: 1 }));
          renderList(); toast('已移入回收站'); return;
        }
        if (act === 'restore') {
          var rv = all()[id];
          setNote(id, Object.assign({}, rv, { del: 0 }));
          renderList(); toast('已恢复'); return;
        }
        if (act === 'imgview') {
          var iv = all()[id];
          var src = iv && iv.imgs && iv.imgs[parseInt(t.getAttribute('data-i'), 10)];
          if (src) showImgView(src);
          return;
        }
        if (act === 'shareone') {
          var sv = all()[id];
          shareNotes([sv], '单条'); return;
        }
        if (act === 'closeshare') { closeShare(); return; }
        if (act === 'exitro') { closeRoPage(); return; }
        if (act === 'roreload') { location.reload(); return; }
        if (act === 'exitrohome') { location.replace(location.origin + location.pathname); return; }
        if (act === 'goto') { gotoNote(id); return; }
      }
      var pg = e.target.closest('[data-pg]');
      if (pg) { state.page = parseInt(pg.getAttribute('data-pg'), 10) || 1; if (RO) renderRo(); else renderList(); window.scrollTo(0, 0); return; }
    });

    $('listBox').addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'pgGo' && e.key === 'Enter') {
        var pages = Math.max(1, Math.ceil(currentNotes().length / PAGE));
        var v = parseInt(e.target.value, 10);
        if (isNaN(v)) v = 1;
        state.page = Math.min(Math.max(1, v), pages);
        if (RO) renderRo(); else renderList();
      }
    });

    $('listBox').addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'vhCat' || t.id === 'vhProj') {
        var v = t.value;
        state.view = v ? { type: t.id === 'vhCat' ? 'cat' : 'proj', id: v } : { type: 'all' };
        state.page = 1; state.openRel = null; state.editId = null; state.moveId = null; state.remId = null;
        render();
      }
    });

    $('addBtn').addEventListener('click', addNote);
    /* 悬浮窗按钮：仅电脑端 Chrome/Edge 显示 */
    var pb = $('pipBtn');
    if (pb) {
      pb.hidden = !pipSupported();
      pb.addEventListener('click', pipOpen);
    }
    $('noteText').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') addNote();
    });
    /* 图片/截图快记：📷 选图 + 输入框直接粘贴截图 + 缩略图移除 */
    var ib = $('imgBtn'), ipk = $('imgPick'), pbox = $('pendImgs');
    if (ib && ipk) {
      ib.addEventListener('click', function () { ipk.click(); });
      ipk.addEventListener('change', function (e) {
        Array.prototype.forEach.call(e.target.files || [], addImgFile);
        e.target.value = '';
      });
    }
    if (pbox) {
      pbox.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act="rmpend"]');
        if (b) { pendingImgs.splice(parseInt(b.getAttribute('data-i'), 10) || 0, 1); renderPendingImgs(); }
      });
    }
    $('noteText').addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          addImgFile(items[i].getAsFile());
        }
      }
    });
    var sTimer = null;
    $('searchBox').addEventListener('input', function () {
      clearTimeout(sTimer);
      sTimer = setTimeout(function () {
        state.search = $('searchBox').value.trim();
        state.page = 1; state.openRel = null;
        renderList();
      }, 200);
    });
    $('expXlsBtn').addEventListener('click', exportExcel);
    $('expJsonBtn').addEventListener('click', exportJson);
    $('shareBtn').addEventListener('click', function () { shareNotes(currentNotes(), '当前筛选结果'); });
    /* 分享弹窗 */
    var sc = $('shareCopy');
    if (sc) sc.addEventListener('click', copyShareUrl);
    var sn = $('shareNative');
    if (sn) sn.addEventListener('click', function () {
      var ta = $('shareUrl'); if (!ta) return;
      var url = ta.value;
      try {
        navigator.share({ title: '随手记 · 只读分享', text: '随手记只读分享', url: url }).then(function () {
          toast('已调起系统分享');
        }, function (err) {
          if (err && err.name === 'AbortError') return;
          copyShareUrl();
        });
      } catch (e) { copyShareUrl(); }
    });
    var so = $('shareOpen');
    if (so) so.addEventListener('click', function () {
      var ta = $('shareUrl'); if (!ta) return;
      var w = window.open(ta.value, '_blank');
      if (!w) { toast('浏览器拦截了新窗口，请复制链接后手动打开'); }
    });
    var sm = $('shareMask');
    if (sm) sm.addEventListener('click', function (e) { if (e.target === sm) closeShare(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeShare(); });

    $('menuBtn').addEventListener('click', function () {
      $('sidebar').classList.add('open'); $('mask').classList.add('show');
    });
    $('inCatAdd').addEventListener('click', function () { quickNode('cat'); });
    $('inProjAdd').addEventListener('click', function () { quickNode('proj'); });
    $('mask').addEventListener('click', closeSidebar);
    $('settingsBtn').addEventListener('click', function () {
      $('sidebar').classList.add('open'); $('mask').classList.add('show');
      var sec = $('settingsSec');
      if (sec) sec.open = true;
      $('settingsSec').scrollIntoView({ block: 'start' });
    });
  }
  function closeSidebar() {
    $('sidebar').classList.remove('open'); $('mask').classList.remove('show');
  }
  function createNode(kind, parent) {
    var name = prompt(parent ? '新建子' + (kind === 'cat' ? '分类' : '项目') + '：' : '新建' + (kind === 'cat' ? '分类' : '项目') + '：');
    if (name === null) return;
    name = name.trim();
    if (!name) { toast('名称不能为空'); return; }
    setNote(genId(), { kind: kind, name: name, parent: parent, del: 0 });
    if (parent) { EXP[parent] = true; expSave(EXP); }
    render();
    toast('已创建「' + name + '」');
  }
  function renameNode(kind, id) {
    var v = node(id); if (!v) return;
    var name = prompt('重命名：', v.name);
    if (name === null) return;
    name = name.trim();
    if (!name) { toast('名称不能为空'); return; }
    setNote(id, Object.assign({}, all()[id], { name: name }));
    render();
  }

  /* ---------- 提醒：到点网页弹窗 ---------- */
  var remDismissed = {};   /* 本次会话内点过「关闭」的记录；刷新页面后会重新弹出，直到点「完成」 */
  var remShownId = null;
  function checkReminders() {
    if (RO || remShownId) return;
    var now = Date.now();
    var due = notes().filter(function (x) {
      return x.v.remindAt && !x.v.remDone && x.v.remindAt <= now && !remDismissed[x.id];
    }).sort(function (a, b) { return a.v.remindAt - b.v.remindAt; });
    if (due.length) showRemModal(due[0]);
  }
  function showRemModal(x) {
    remShownId = x.id;
    var old = $('remModal'); if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'remModal';
    el.innerHTML = '<div class="remodal-card">'
      + '<div class="remodal-title">⏰ 随手记提醒</div>'
      + '<div class="remodal-time">' + fmtT(x.v.remindAt) + '</div>'
      + '<div class="remodal-text">' + esc((x.v.text || '').slice(0, 500)) + '</div>'
      + '<div class="edit-btns">'
      + '<button class="btn dark" data-ract="done">完成</button>'
      + '<button class="btn" data-ract="snooze">10 分钟后再提醒</button>'
      + '<button class="btn ghost" data-ract="close">关闭</button>'
      + '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ract]');
      if (!b) return;
      var a = b.getAttribute('data-ract');
      var v = all()[remShownId];
      if (a === 'done' && v) { setNote(remShownId, Object.assign({}, v, { remDone: 1 })); renderList(); }
      else if (a === 'snooze' && v) { setNote(remShownId, Object.assign({}, v, { remindAt: Date.now() + 10 * 60000, remDone: 0 })); renderList(); }
      else if (a === 'close') { remDismissed[remShownId] = 1; }
      el.remove(); remShownId = null;
      if (a !== 'close') setTimeout(checkReminders, 300);
    });
  }

  /* ---------- 启动 ---------- */
  /* 取出分享参数：新格式 ?s=…，兼容旧的 #share=… */
  function shareParam() {
    var s = '';
    var q = String(location.search || '').replace(/^\?/, '');
    if (q) {
      q.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i < 0) return;
        var k = kv.slice(0, i);
        if (k === 's' || k === 'share') s = kv.slice(i + 1);
      });
    }
    if (!s) {
      var m = String(location.hash || '').match(/[#&](?:share|s)=([^&]+)/);
      if (m) s = m[1];
    }
    return s;
  }
  function checkShare() {
    var raw = shareParam();
    if (!raw) return false;
    var data = raw;
    try { data = decodeURIComponent(raw); } catch (e) { data = raw; }
    try {
      var o = JSON.parse(b64dec(data));
      if (o && o.v === 1 && Array.isArray(o.notes) && o.notes.length) { RO = o.notes; return true; }
      throw new Error('内容格式不符');
    } catch (e) {
      shareError(raw, e);
      return false;
    }
  }
  /* 分享链接解析失败：给明确原因，而不是闪一下就没的提示 */
  function shareError(raw, err) {
    var bn = $('roBanner');
    if (!bn) { toast('分享链接无法识别'); return; }
    bn.hidden = false;
    bn.className = 'ro-banner ro-bad';
    bn.innerHTML = '<b>分享链接打不开</b>：内容不完整或已被聊天软件截断（收到 ' + raw.length + ' 字符）。<br>'
      + '请让对方重新分享；建议对方在分享窗口点「系统分享」或「复制链接」后再发。'
      + '<br><button class="linkbtn" data-act="exitro">关闭此页</button>'
      + '<button class="linkbtn" data-act="exitrohome">进入我的随手记</button>'
      + '<span class="muted" style="font-size:11.5px"> （' + esc(String(err && err.message || err).slice(0, 60)) + '）</span>';
    var ed = $('editor'); if (ed) ed.hidden = true;
    var hide = ['menuBtn', 'settingsBtn', 'pipBtn'];
    hide.forEach(function (k) { var el = $(k); if (el) el.hidden = true; });
  }
  /* ---------- 桌面悬浮窗（文档画中画：仅电脑端 Chrome/Edge，系统级置顶） ---------- */
  /* 两种形态：panel = 面板（筛选+记录+翻页） / ball = 缩成小球，点击展开 */
  var pipWin = null;
  var pipSt = { mode: 'panel', cat: '', proj: '', page: 1 };
  var pipPageN = 5;                                   /* 每页最多 5 条 */
  function pipSupported() {
    return typeof window.documentPictureInPicture !== 'undefined'
      && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);  /* 触屏/手机不显示 */
  }
  function pipSize() {
    var d = pipSt.mode === 'ball' ? { w: 88, h: 88 } : { w: 340, h: 480 };
    try { pipWin.resizeTo(d.w, d.h); } catch (e) { /* 个别版本不允许脚本改尺寸，忽略 */ }
  }
  function pipOpen() {
    if (!pipSupported()) { toast('悬浮窗需要电脑版 Chrome 或 Edge 浏览器'); return; }
    if (pipWin && !pipWin.closed) {
      pipSt.mode = 'panel'; pipSt.page = 1; pipSize(); pipBuild(); try { pipWin.focus(); } catch (e) { }
      return;
    }
    pipSt = { mode: 'panel', cat: '', proj: '', page: 1 };
    window.documentPictureInPicture.requestWindow({ width: 340, height: 480 }).then(function (w) {
      pipWin = w;
      /* 继承主页面样式，再补悬浮窗专属规则 */
      Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"], style'), function (el) {
        w.document.head.appendChild(el.cloneNode(true));
      });
      var st = w.document.createElement('style');
      st.textContent =
        '.pip-wrap{display:flex;flex-direction:column;height:100vh;font:13px/1.55 system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1f2328}'
        + '.pip-head{padding:7px 10px;background:#fff;border-bottom:1px solid #e4e7eb;font-weight:600;display:flex;align-items:center;gap:6px}'
        + '.pip-head .pip-n{background:#eef3fe;color:#1d4ed8;border-radius:10px;padding:0 8px;font-size:11.5px;font-weight:600}'
        + '.pip-head .pip-hb{margin-left:auto;display:flex;gap:5px}'
        + '.pip-hb button{border:1px solid #d0d7de;background:#fff;border-radius:7px;padding:2px 8px;font-size:12px;cursor:pointer;color:#1f2328}'
        + '.pip-hb button:hover{background:#eef1f4}'
        + '.pip-filters{display:flex;gap:6px;padding:7px 10px;background:#fff;border-bottom:1px solid #e4e7eb}'
        + '.pip-filters select{flex:1;min-width:0;border:1px solid #d0d7de;border-radius:7px;padding:4px 6px;font-family:inherit;font-size:12.5px;background:#fff}'
        + '.pip-add{padding:7px 10px;background:#fff;border-bottom:1px solid #e4e7eb;display:flex;gap:6px;align-items:flex-end}'
        + '.pip-add textarea{flex:1;border:1px solid #d0d7de;border-radius:8px;padding:6px 8px;font:inherit;resize:none}'
        + '.pip-add textarea:focus{outline:2px solid #bcd3f8;border-color:#1d4ed8}'
        + '.pip-list{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px}'
        + '.pip-item{background:#fff;border:1px solid #e4e7eb;border-left:4px solid #d0d7de;border-radius:8px;padding:6px 9px;cursor:pointer}'
        + '.pip-item:hover{border-color:#9ab3e0;background:#fafbff}'
        + '.pip-t{font-size:11px;color:#8b949e;margin-bottom:2px}'
        + '.pip-x{word-break:break-word;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}'
        + '.pip-path{font-size:11px;color:#57606a;margin-top:2px}'
        + '.pip-empty{color:#8b949e;text-align:center;padding:24px 0}'
        + '.pip-pager{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fff;border-top:1px solid #e4e7eb}'
        + '.pip-pager button{border:1px solid #d0d7de;background:#fff;border-radius:7px;padding:2px 10px;cursor:pointer;font-size:13px;color:#1f2328}'
        + '.pip-pager button:disabled{opacity:.4;cursor:default}'
        + '.pip-pginfo{font-size:12px;color:#57606a;white-space:nowrap}'
        + '.pip-pager .pip-foot{margin-left:auto;font-size:10.5px;color:#8b949e}'
        + '.pip-ball{width:100%;height:100vh;display:flex;align-items:center;justify-content:center;cursor:pointer}'
        + '.pip-ball .b{position:relative;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#1d4ed8);box-shadow:0 4px 14px rgba(29,78,216,.4);display:flex;align-items:center;justify-content:center;font-size:26px;user-select:none;transition:transform .15s}'
        + '.pip-ball .b:hover{transform:scale(1.07)}'
        + '.pip-ball .bn{position:absolute;top:-4px;right:-7px;background:#ef4444;color:#fff;border-radius:10px;font-size:10.5px;padding:0 5px;font-weight:700;line-height:16px}'
        + '.pip-toast{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);background:#1f2328;color:#fff;border-radius:8px;padding:5px 14px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9;white-space:nowrap}'
        + '.pip-toast.on{opacity:.92}';
      w.document.head.appendChild(st);
      w.addEventListener('pagehide', function () { pipWin = null; });
      pipBuild();
    }).catch(function (e) { toast('悬浮窗打开失败：' + (e && e.message || e)); });
  }
  function pipToast(msg) {
    if (!pipWin || pipWin.closed) return;
    var w = pipWin, t = w.document.getElementById('pipToast');
    if (!t) {
      t = w.document.createElement('div');
      t.id = 'pipToast'; t.className = 'pip-toast';
      w.document.body.appendChild(t);
    }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }
  /* 缩小球 / 展开面板 */
  function pipSetMode(mode) {
    pipSt.mode = mode;
    if (mode === 'panel') pipSt.page = 1;
    pipSize();
    pipBuild();
  }
  /* 放大回正常网页：把主页面调到前台 */
  function pipGoHome() {
    try { window.focus(); } catch (e) { }
    pipToast('已切回主页面（未响应请点任务栏的「随手记」）');
  }
  /* 悬浮窗数据：按所选分类/项目（含子级）过滤，最新在前 */
  function pipNotes() {
    return notes().filter(function (x) {
      if (pipSt.cat && !inCat(x.v.cat, pipSt.cat)) return false;
      if (pipSt.proj && !inCat(x.v.proj, pipSt.proj)) return false;
      return true;
    }).sort(function (a, b) { return (b.v.c || 0) - (a.v.c || 0); });
  }
  function pipBuild() {
    var w = pipWin; if (!w || w.closed) return;
    if (pipSt.mode === 'ball') pipBuildBall(w); else pipBuildPanel(w);
  }
  function pipBuildBall(w) {
    w.document.body.innerHTML = '<div class="pip-ball" id="pipBall" title="点击展开随手记">'
      + '<div class="b">📋<span class="bn" id="pipBallN"></span></div></div>';
    w.document.getElementById('pipBall').addEventListener('click', function () { pipSetMode('panel'); });
    pipRender();
  }
  function pipBuildPanel(w) {
    w.document.body.innerHTML = '<div class="pip-wrap">'
      + '<div class="pip-head">📋 随手记<span class="pip-n" id="pipN"></span>'
      + '<span class="pip-hb">'
      + '<button data-pip="home" title="放大回正常网页">⤢ 网页</button>'
      + '<button data-pip="ball" title="缩成小球">⚫</button>'
      + '</span></div>'
      + '<div class="pip-filters">'
      + '<select id="pipCat" title="按分类筛选（含子分类）"></select>'
      + '<select id="pipProj" title="按项目筛选（含子项目）"></select>'
      + '</div>'
      + '<div class="pip-add"><textarea id="pipText" rows="2" placeholder="随手记点什么…（Ctrl+Enter 保存，存入所选分类/项目）"></textarea>'
      + '<button class="btn dark sm" data-pip="save">保存</button></div>'
      + '<div class="pip-list" id="pipList"></div>'
      + '<div class="pip-pager">'
      + '<button data-pip="prev" id="pipPrev">‹ 上一页</button>'
      + '<span class="pip-pginfo" id="pipPg"></span>'
      + '<button data-pip="next" id="pipNext">下一页 ›</button>'
      + '<span class="pip-foot">滚轮翻页 · 点条目回网页</span>'
      + '</div></div>';
    function pipAdd() {
      var ta = w.document.getElementById('pipText');
      var text = ta.value.trim();
      if (!text) { pipToast('先写点内容'); return; }
      var tags = autoKeywords(text);
      var obj = { kind: 'note', text: text, tags: tags, c: Date.now(), del: 0 };
      if (pipSt.cat) obj.cat = pipSt.cat;
      if (pipSt.proj) obj.proj = pipSt.proj;
      setNote(genId(), obj);
      ta.value = '';
      render();          /* 主页面重渲染（内部会再调 pipRender 刷新本窗） */
      pipToast('已保存' + (tags.length ? ' · 自动标签 #' + tags.join(' #') : ''));
    }
    /* 统一事件委托 */
    w.document.body.addEventListener('click', function (e) {
      var act = e.target.closest('[data-pip]');
      if (act) {
        var a = act.getAttribute('data-pip');
        if (a === 'ball') { pipSetMode('ball'); return; }
        if (a === 'home') { pipGoHome(); return; }
        if (a === 'prev') { pipSt.page--; pipRender(); return; }
        if (a === 'next') { pipSt.page++; pipRender(); return; }
        if (a === 'save') { pipAdd(); return; }
      }
      var it = e.target.closest('[data-pipid]');
      if (it) {
        try { window.focus(); } catch (err) { /* 某些浏览器禁止脚本抢焦点 */ }
        gotoNote(it.getAttribute('data-pipid'));
      }
    });
    w.document.getElementById('pipCat').addEventListener('change', function (e) {
      pipSt.cat = e.target.value; pipSt.page = 1; pipRender();
    });
    w.document.getElementById('pipProj').addEventListener('change', function (e) {
      pipSt.proj = e.target.value; pipSt.page = 1; pipRender();
    });
    w.document.getElementById('pipText').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') pipAdd();
    });
    /* 滚轮翻页 */
    w.document.getElementById('pipList').addEventListener('wheel', function (e) {
      var pages = Math.max(1, Math.ceil(pipNotes().length / pipPageN));
      if (e.deltaY > 0 && pipSt.page < pages) { pipSt.page++; pipRender(); }
      else if (e.deltaY < 0 && pipSt.page > 1) { pipSt.page--; pipRender(); }
    }, { passive: true });
    pipRender();
  }
  function pipRender() {
    if (!pipWin || pipWin.closed) return;
    var w = pipWin;
    if (pipSt.mode === 'ball') {
      var bn = w.document.getElementById('pipBallN');
      if (bn) bn.textContent = notes().length || '';
      return;
    }
    var list = w.document.getElementById('pipList');
    if (!list) return;
    var cs = w.document.getElementById('pipCat'), ps = w.document.getElementById('pipProj');
    if (cs && !cs.options.length) {
      cs.innerHTML = '<option value="">📂 全部分类</option>' + treeOptions('cat', pipSt.cat);
      cs.value = pipSt.cat || '';
    }
    if (ps && !ps.options.length) {
      ps.innerHTML = '<option value="">📌 全部项目</option>' + treeOptions('proj', pipSt.proj);
      ps.value = pipSt.proj || '';
    }
    var ns = pipNotes();
    var nEl = w.document.getElementById('pipN');
    if (nEl) nEl.textContent = notes().length + ' 条';
    var pages = Math.max(1, Math.ceil(ns.length / pipPageN));
    if (pipSt.page > pages) pipSt.page = pages;
    if (pipSt.page < 1) pipSt.page = 1;
    var slice = ns.slice((pipSt.page - 1) * pipPageN, pipSt.page * pipPageN);
    list.innerHTML = slice.map(function (x) {
      var v = x.v, bits = [];
      if (v.cat) bits.push('📂 ' + esc(catPath(v.cat).join('/')));
      if (v.proj) bits.push('📌 ' + esc(catPath(v.proj).join('/')));
      return '<div class="pip-item" data-pipid="' + esc(x.id) + '">'
        + '<div class="pip-t">🕐 ' + fmtT(v.c) + '</div>'
        + '<div class="pip-x">' + ((v.imgs || []).length ? '🖼 ' : '') + esc(v.text || '') + '</div>'
        + (bits.length ? '<div class="pip-path">' + bits.join(' ｜ ') + '</div>' : '')
        + '</div>';
    }).join('') || '<div class="pip-empty">当前筛选下暂无记录</div>';
    var pg = w.document.getElementById('pipPg');
    if (pg) pg.textContent = (ns.length ? pipSt.page : 0) + ' / ' + pages + ' 页';
    var pv = w.document.getElementById('pipPrev'), nx = w.document.getElementById('pipNext');
    if (pv) pv.disabled = pipSt.page <= 1;
    if (nx) nx.disabled = pipSt.page >= pages;
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    if (checkShare()) { renderRo(); return; }
    GhSync.init({
      storeKey: 'quick_notes',
      file: 'quick-notes.json',
      desc: '随手记 · 数据备份',
      onChange: function () { render(); },
      agoEl: 'syncAgo', retryEl: 'syncRetry'
    });
    render();
    /* 提醒轮询：20 秒一查；打开页面/切回页面立即查 */
    setInterval(checkReminders, 20000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkReminders();
    });
    setTimeout(checkReminders, 1200);
  });
})();
