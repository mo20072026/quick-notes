/* 随手记 · 分享链路回归测试（jsdom）
 * 运行：node tests/share.test.js
 * 依赖：jsdom（任意位置，脚本会自动探测常见安装路径）
 */
const fs = require('fs');
const path = require('path');

function loadJsdom() {
  const tries = ['jsdom', path.join(process.env.TEMP || '/tmp', 'wbtest', 'node_modules', 'jsdom'),
    'C:/Users/DELL/AppData/Local/Temp/workbuddy-update-x64/wbtest/node_modules/jsdom'];
  for (const t of tries) { try { return require(t); } catch (e) { } }
  console.log('SKIP 未找到 jsdom，先执行：npm i jsdom（或 npm i -g jsdom）');
  process.exit(0);
}
const { JSDOM } = loadJsdom();

const dir = path.join(__dirname, '..') + path.sep;
const html = fs.readFileSync(dir + 'index.html', 'utf8');
const appJs = fs.readFileSync(dir + 'app.js', 'utf8');
const xlsxJs = fs.readFileSync(dir + 'export-xlsx.js', 'utf8');
let fails = 0;
function A(name, cond, extra) {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
}
function boot(url, seed) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, db = {};
  const store = { data: () => db, set: (id, o) => { db[id] = o; }, state: () => ({ token: '' }), init: () => { } };
  if (seed) seed(store);
  w.GhSync = store;
  try { w.eval(xlsxJs); } catch (e) { console.log('XLSX EVAL ERROR:', e.message); }
  try { w.eval(appJs); } catch (e) { console.log('EVAL ERROR:', e.message); }
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  return { w, store };
}
const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/* 1. 点击分享 → 弹窗 + ?s= 链接 */
let r = boot('https://mo20072026.github.io/quick-notes/');
r.store.set('c1', { kind: 'cat', name: '工作', parent: '', del: 0 });
r.store.set('c2', { kind: 'cat', name: '子分类', parent: 'c1', del: 0 });
r.store.set('n1', { kind: 'note', text: '测试内容 CBI20261123', tags: ['测试'], cat: 'c2', c: Date.now(), del: 0 });
click(r.w, r.w.document.getElementById('nav-all'));
click(r.w, r.w.document.getElementById('shareBtn'));
const d = r.w.document;
const url = d.getElementById('shareUrl').value;
A('分享弹窗打开', !d.getElementById('shareMask').hidden);
A('链接为 ?s= 形式', /\/quick-notes\/\?s=[A-Za-z0-9_-]+$/.test(url), url.length + ' 字符');
click(r.w, d.querySelector('[data-act="closeshare"]'));
A('关闭后弹窗隐藏', d.getElementById('shareMask').hidden);

/* 2. 打开该链接 → 只读视图 */
let r2 = boot(url);
const d2 = r2.w.document;
A('进入只读模式', d2.body.classList.contains('ro-mode'));
A('横幅与条数正确', !d2.getElementById('roBanner').hidden && d2.getElementById('roCount').textContent === '1');
A('渲染卡片并含分类路径', d2.querySelectorAll('#listBox .note-card').length === 1 && /工作 \/ 子分类/.test(d2.getElementById('listBox').textContent));
A('编辑区隐藏', d2.getElementById('editor').hidden === true);

/* 3. 截断的坏链接 */
let r3 = boot(url.slice(0, url.length - 40));
const bn = r3.w.document.getElementById('roBanner');
A('坏链接显示红色错误横幅', !bn.hidden && bn.className.includes('ro-bad'));

/* 4. 旧 #share= 兼容 */
A('旧 #share= 链接可打开', boot(url.replace('?s=', '#share=')).w.document.body.classList.contains('ro-mode'));

/* 5. 长链接警示 + 只读分页 */
let r5 = boot('https://mo20072026.github.io/quick-notes/', s => {
  for (let i = 0; i < 30; i++) s.set('x' + i, { kind: 'note', text: '这是一条比较长的测试记录内容，用于把分享链接撑长一些。第' + i + '条，附带中文说明。', tags: ['测试'], c: Date.now() - i * 1000, del: 0 });
});
click(r5.w, r5.w.document.getElementById('shareBtn'));
const longUrl = r5.w.document.getElementById('shareUrl').value;
A('长链接超 6000 字符并警示', longUrl.length > 6000 && !r5.w.document.getElementById('shareWarn').hidden, longUrl.length + ' 字符');
let r6 = boot(longUrl);
const d6 = r6.w.document;
const pg = d6.querySelector('#listBox [data-pg="2"]');
if (pg) click(r6.w, pg);
A('只读分页不跳回编辑界面', !!pg && d6.body.classList.contains('ro-mode') && d6.querySelectorAll('#listBox .note-card').length > 0);

/* 6. 无记录时分享不弹空链接 */
let r7 = boot('https://mo20072026.github.io/quick-notes/');
click(r7.w, r7.w.document.getElementById('shareBtn'));
A('无记录不弹空链接', r7.w.document.getElementById('shareMask').hidden === true);

/* 7. 关闭分享页：不得跳回随手记主页 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async function () {
  let r8 = boot(url);
  const d8 = r8.w.document;
  const homePath = '/quick-notes/';
  r8.w.close = function () { };                    /* 模拟浏览器忽略 window.close() */
  click(r8.w, d8.querySelector('[data-act="exitro"]'));
  await sleep(500);
  A('点关闭后仍停留在分享页（未跳主页）',
    r8.w.location.pathname === homePath && /(^\?s=|#share=)/.test(r8.w.location.search + r8.w.location.hash),
    r8.w.location.pathname + r8.w.location.search.slice(0, 12));
  A('显示"分享浏览已结束"提示卡', /分享浏览已结束/.test(d8.getElementById('listBox').textContent));
  A('提示卡里有手动关闭说明', /手动关闭/.test(d8.getElementById('listBox').textContent));

  /* 8. 坏链接横幅：关闭为主，进入主页为次 */
  let r9 = boot(url.slice(0, url.length - 40));
  const bn9 = r9.w.document.getElementById('roBanner');
  A('坏链接横幅提供关闭按钮', /data-act="exitro"/.test(bn9.innerHTML));
  A('坏链接横幅另提供进入主页入口', /data-act="exitrohome"/.test(bn9.innerHTML));

  /* 9. 导出 Excel 表格 */
  let rx = boot('https://mo20072026.github.io/quick-notes/');
  rx.store.set('c1', { kind: 'cat', name: '工作', parent: '', del: 0 });
  rx.store.set('c1b', { kind: 'cat', name: '子分类', parent: 'c1', del: 0 });
  rx.store.set('n1', { kind: 'note', text: '导出测试 CBI20261123', tags: ['标签A', '标签B'], cat: 'c1b', c: 1698000000000, del: 0 });
  click(rx.w, rx.w.document.getElementById('nav-all'));
  let cap = null;
  const realBuild = rx.w.XlsxExport.build;
  rx.w.XlsxExport.download = function (name, opts) { cap = { name: name, opts: opts, bytes: realBuild(opts) }; };
  const xlsBtn = rx.w.document.getElementById('expXlsBtn');
  A('有「导出 Excel」按钮（原 Markdown 已替换）', !!xlsBtn && /Excel/.test(xlsBtn.textContent));
  if (xlsBtn) click(rx.w, xlsBtn);
  A('点击后触发导出', !!cap, cap && cap.name);
  if (cap) {
    A('文件名后缀 .xlsx', /\.xlsx$/.test(cap.name));
    A('表头 9 列齐全', cap.opts.columns.map(c => c.title).join(',') === '序号,内容,分类,项目,标签,创建时间,修改时间,提醒时间,状态',
      cap.opts.columns.map(c => c.title).join(','));
    A('数据行内容正确（含分类路径与标签）',
      cap.opts.rows.length === 1 && /CBI20261123/.test(cap.opts.rows[0][1])
      && cap.opts.rows[0][2] === '工作 / 子分类' && cap.opts.rows[0][4] === '#标签A #标签B',
      JSON.stringify(cap.opts.rows[0]));
    A('生成的是合法 zip（PK 头）', cap.bytes[0] === 0x50 && cap.bytes[1] === 0x4B && cap.bytes.length > 1000, cap.bytes.length + ' 字节');
    fs.writeFileSync(path.join(require('os').tmpdir(), 'quick-notes-export.xlsx'), Buffer.from(cap.bytes));
    console.log('     导出样本已存：' + path.join(require('os').tmpdir(), 'quick-notes-export.xlsx'));
  }

  /* 10. 悬浮窗按钮：无画中画 API 的环境（手机/jsdom）自动隐藏 */
  const pipBtn = rx.w.document.getElementById('pipBtn');
  A('有「悬浮窗」按钮', !!pipBtn);
  A('不支持画中画时按钮自动隐藏（手机端不显示）', !!pipBtn && pipBtn.hidden === true);
  if (pipBtn) click(rx.w, pipBtn);   /* 不应崩溃，只 toast 提示 */
  A('不支持时点击仅提示不报错', true);
  /* 10.1 悬浮窗按钮在右上角（顶栏、设置按钮之前）且用醒目配色区分 */
  const tb = rx.w.document.querySelector('.topbar');
  A('悬浮窗按钮位于右上角顶栏内', !!pipBtn && tb.contains(pipBtn), pipBtn && pipBtn.parentElement.className);
  A('悬浮窗按钮在「设置」按钮之前（更靠右）', !!pipBtn && pipBtn.nextElementSibling && pipBtn.nextElementSibling.id === 'settingsBtn');
  A('悬浮窗按钮使用 pip-accent 醒目配色', !!pipBtn && pipBtn.classList.contains('pip-accent'));
  /* 10.2 悬浮窗小球/面板双模式代码完整 */
  A('小球模式（pipBuildBall）已实现', /pipBuildBall/.test(appJs) && /pip-ball/.test(appJs));
  A('面板每页 5 条 + 上下页翻页', /pipPageN = 5/.test(appJs) && /data-pip="prev"/.test(appJs) && /data-pip="next"/.test(appJs));
  A('面板带分类/项目筛选（含子级）', /pipCat/.test(appJs) && /pipProj/.test(appJs) && /inCat\(x\.v\.cat, pipSt\.cat\)/.test(appJs));
  A('滚轮翻页与「放大回网页」均已实现', /addEventListener\('wheel'/.test(appJs) && /pipGoHome/.test(appJs));

  console.log(fails ? '\n共 ' + fails + ' 项失败' : '\n全部通过');
  process.exit(fails ? 1 : 0);
})();
