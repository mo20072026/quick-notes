/*!
 * export-xlsx.js — 零依赖 .xlsx 生成器（浏览器 / Node 通用）
 * 用法：
 *   XlsxExport.download('记录_20261028.xlsx', {
 *     sheet: '随手记',
 *     columns: [{ title: '序号', width: 6 }, { title: '内容', width: 58 }],
 *     rows: [[1, '文本内容'], [2, '第二行']]
 *   });
 *
 * 实现要点（踩过的坑都在这）：
 *  - 只做 store（不压缩）的 zip，浏览器与 Excel 都能读，体积略大但零依赖；
 *  - 字符串一律用 inlineStr，避免共享字符串表，长中文不会串行；
 *  - XML 必须转义 & < > " ' 以及控制字符，否则 Excel 报“内容有问题”；
 *  - 表头上限 31 字符、不能含 []:*?/\ 等字符；
 *  - 数值用 <v>，文本用 <is><t xml:space="preserve">。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XlsxExport = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /* ---------- CRC32 ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var d = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }

  /* ---------- zip（store 模式） ---------- */
  function dosDateTime(d) {
    d = d || new Date();
    var y = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    var date = (((y - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time >>> 0, date: date >>> 0 };
  }
  function zip(files) {
    var chunks = [], central = [], offset = 0;
    var dt = dosDateTime(new Date());
    files.forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = f.data instanceof Uint8Array ? f.data : utf8(String(f.data));
      var crc = crc32(data);
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);          /* version needed */
      dv.setUint16(6, 0x0800, true);      /* UTF-8 名称 */
      dv.setUint16(8, 0, true);           /* store */
      dv.setUint16(10, dt.time, true);
      dv.setUint16(12, dt.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      chunks.push(lh, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var total = offset + cdSize + 22;
    var out = new Uint8Array(total), pos = 0;
    chunks.concat(central, [eocd]).forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  /* ---------- xlsx 各部件 ---------- */
  function xesc(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function colName(n) {                       /* 1 → A, 27 → AA */
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }
  function cellRef(col, row) { return colName(col) + row; }
  function sheetName(name) {
    var s = String(name || 'Sheet1').replace(/[\[\]\*\?\/\\:]/g, ' ').trim().slice(0, 31);
    return s || 'Sheet1';
  }

  function build(opts) {
    opts = opts || {};
    var columns = opts.columns || [];
    var rows = opts.rows || [];
    var cols = columns.length ? columns : (rows[0] || []).map(function (_, i) { return { title: '列' + (i + 1), width: 16 }; });

    /* 列宽 */
    var colXml = '<cols>' + cols.map(function (c, i) {
      var w = c.width || 16;
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('') + '</cols>';

    /* 表头 + 数据 */
    var r = 1, body = '';
    body += '<row r="1" ht="22" customHeight="1">' + cols.map(function (c, i) {
      return '<c r="' + cellRef(i + 1, 1) + '" s="1" t="inlineStr"><is><t xml:space="preserve">' + xesc(c.title || '') + '</t></is></c>';
    }).join('') + '</row>';
    rows.forEach(function (row) {
      r++;
      body += '<row r="' + r + '">' + cols.map(function (c, i) {
        var val = row[i];
        if (val == null || val === '') return '';
        if (typeof val === 'number' && isFinite(val)) {
          return '<c r="' + cellRef(i + 1, r) + '" s="0"><v>' + val + '</v></c>';
        }
        return '<c r="' + cellRef(i + 1, r) + '" s="0" t="inlineStr"><is><t xml:space="preserve">' + xesc(val) + '</t></is></c>';
      }).join('') + '</row>';
    });

    var sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + colXml
      + '<sheetData>' + body + '</sheetData>'
      + '<autoFilter ref="A1:' + cellRef(cols.length, Math.max(1, rows.length + 1)) + '"/>'
      + '</worksheet>';

    var workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="' + xesc(sheetName(opts.sheet)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';

    var stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2">'
      + '<font><sz val="11"/><color theme="1"/><name val="等线"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="等线"/></font>'
      + '</fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FFEDF2FA"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
      + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>'
      + '</cellXfs>'
      + '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';

    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';

    return zip([
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: stylesXml },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml }
    ]);
  }

  function download(filename, opts) {
    var bytes = build(opts);
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    return bytes;
  }

  return { build: build, download: download, crc32: crc32, _zip: zip };
});
