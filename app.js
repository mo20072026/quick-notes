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
      body = '<div class="note-text">' + hlText(v.text) + '</div>';
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
    /* 记录默认归类到当前所在分类/项目 */
    var hint = [];
    if (state.view.type === 'cat') hint.push('将存入分类「' + esc(catPath(state.view.id).join('/')) + '」');
    if (state.view.type === 'proj') hint.push('将存入项目「' + esc(catPath(state.view.id).join('/')) + '」');
    $('composerHint').innerHTML = hint.join('　') || '';
  }

  /* ---------- 只读分享视图 ---------- */
  function renderRo() {
    $('editor').hidden = true;
    $('toolbar') && ($('toolbar').hidden = true);
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
    $('roCount').textContent = RO.length;
    $('roBanner').hidden = false;
    $('settingsBtn').hidden = true;
    $('menuBtn').hidden = true;
  }

  /* ---------- 操作 ---------- */
  function setNote(id, obj) { GhSync.set(id, obj); }
  function addNote() {
    var text = $('noteText').value.trim();
    if (!text) { toast('先写点内容'); return; }
    var tags = $('noteTags').value.trim().split(/[\s,，、]+/).filter(Boolean);
    var auto = false;
    if (!tags.length) { tags = autoKeywords(text); auto = tags.length > 0; }  /* 未手动填标签：自动提取关键词 */
    var obj = { kind: 'note', text: text, tags: tags, c: Date.now(), del: 0 };
    if (state.view.type === 'cat') obj.cat = state.view.id;
    if (state.view.type === 'proj') obj.proj = state.view.id;
    setNote(genId(), obj);
    $('noteText').value = ''; $('noteTags').value = '';
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
  function exportMd() {
    var list = currentNotes();
    if (!list.length) { toast('当前视图没有可导出的记录'); return; }
    var lines = ['# 随手记导出 · ' + viewName(), '', '导出时间：' + fmtT(Date.now()) + '，共 ' + list.length + ' 条', ''];
    list.forEach(function (x) {
      var v = x.v;
      lines.push('## ' + fmtT(v.c));
      lines.push('');
      lines.push(v.text || '');
      var meta = [];
      if (v.cat) meta.push('分类：' + catPath(v.cat).join('/'));
      if (v.proj) meta.push('项目：' + catPath(v.proj).join('/'));
      if ((v.tags || []).length) meta.push('标签：' + v.tags.map(function (t) { return '#' + t; }).join(' '));
      if (v.u && v.u !== v.c) meta.push('修改于：' + fmtT(v.u));
      if (meta.length) lines.push('', '-' + meta.join(' ／ '));
      lines.push('');
    });
    download('随手记_' + stamp() + '.md', lines.join('\n'), 'text/markdown;charset=utf-8');
    toast('已导出 Markdown（' + list.length + ' 条）');
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
  function shareNotes(list, label) {
    if (!list.length) { toast('没有可分享的记录'); return; }
    var payload = list.map(function (x) {
      return {
        text: x.v ? x.v.text : x.text,
        tags: (x.v ? x.v.tags : x.tags) || [],
        cat: (x.v ? (x.v.cat ? catPath(x.v.cat).join('/') : '') : (x.cat || '')),
        proj: (x.v ? (x.v.proj ? catPath(x.v.proj).join('/') : '') : (x.proj || '')),
        c: x.v ? x.v.c : x.c, u: x.v ? x.v.u : (x.u || 0)
      };
    });
    var data = b64enc(JSON.stringify({ v: 1, from: '随手记', at: Date.now(), notes: payload }));
    var url = location.origin + location.pathname + '#share=' + data;
    if (url.length > 60000) {
      toast('内容太多，链接可能过长，建议改用导出功能');
    }
    copyText(url, '分享链接已复制（' + label + '，' + payload.length + ' 条）——发给对方，打开即只读浏览');
  }
  function copyText(text, okMsg) {
    function fb() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
    var done = function (ok) { toast(ok ? okMsg : '复制失败，请手动选择链接'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fb()); });
    } else done(fb());
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
        if (act === 'shareone') {
          var sv = all()[id];
          shareNotes([sv], '单条'); return;
        }
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

    $('addBtn').addEventListener('click', addNote);
    $('noteText').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') addNote();
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
    $('expMdBtn').addEventListener('click', exportMd);
    $('expJsonBtn').addEventListener('click', exportJson);
    $('shareBtn').addEventListener('click', function () { shareNotes(currentNotes(), '当前筛选结果'); });

    $('menuBtn').addEventListener('click', function () {
      $('sidebar').classList.add('open'); $('mask').classList.add('show');
    });
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
  function checkShare() {
    var m = location.hash.match(/[#&]share=([^&]+)/);
    if (!m) return false;
    try {
      var o = JSON.parse(b64dec(decodeURIComponent(m[1])));
      if (o && o.v === 1 && Array.isArray(o.notes)) { RO = o.notes; return true; }
    } catch (e) { /* 忽略坏链接 */ }
    toast('分享链接无法识别');
    return false;
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
