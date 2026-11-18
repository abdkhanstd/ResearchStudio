/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * LaTeX project → document model (in the browser). Paragraphs keep their exact source span, so accepted changes
 * patch the .tex files precisely. Handles \input/\include, sections and numbering (IEEE roman too), labels,
 * citations (.bbl, .bib, thebibliography; numeric or author–year), floats (captions, tabular grids, graphics files,
 * pgfplots data), abstract, lists, display maths, theorem-like environments.
 */
import { renderTex, stripTexComments } from '../shared/textkit.mjs';
import { parseBib, delatex } from './refs.js';
import { scanGraphics, digitize } from './digitize.js';
import { pdfjs } from './pdf.js';

const TEXT_EXT = /\.(tex|bib|bbl|sty|cls|cfg|txt|dat|csv|tsv|clo|bst|def)$/i;
const IMG_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', ''];
// floats, with the starred and package variants (rotating: sidewaystable*, wrapfig, sidecap, tufte margin floats)
const FLOATS = /^((?:wrap|sideways|margin|SC)?(?:figure|table)\*?|subfigure|algorithm\*?|listing)$/;
const MATH_ENVS = /^(equation|equation\*|align|align\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*|displaymath|flalign|flalign\*|alignat|alignat\*|split)$/;
const LISTS = /^(itemize|enumerate|description|compactitem|compactenum|inparaenum|enumerate\*|itemize\*)$/;
const THEOREMS = /^(theorem|lemma|corollary|proposition|definition|remark|example|assumption|proof|claim|conjecture|observation|problem|hypothesis|note|fact|property)\*?$/;
const CONTAINERS = /^(center|flushleft|flushright|minipage|quote|quotation|small|footnotesize|IEEEkeywords|keywords|keyword|frame|block|multicols|adjustbox)\*?$/;
const SKIP_ENVS = /^(tikzpicture|picture|verbatim|lstlisting|minted|comment|thebibliography|titlepage|IEEEbiography|IEEEbiographynophoto|acks|CCSXML|filecontents|filecontents\*)$/;
const SORTED_STYLES = /^(plain|abbrv|alpha|siam|acm|plainnat|abbrvnat|apalike|apa|splncs04|splncs|ACM-Reference-Format|chicago|agsm|dcu|harvard|elsarticle-harv|model1-num-names|mn2e|aa|jfm|ametsoc|spbasic|spmpsci)$/i;

const dec = new TextDecoder('utf-8', { fatal: false });
function decode(u8) { const s = dec.decode(u8); return s.includes('�') && !/[\u0080-￼]/.test(s) ? new TextDecoder('latin1').decode(u8) : s; }

// ── reading files ──────────────────────────────────────────
export async function gatherFiles(fileList, onProgress) {
  const files = new Map(); // path → { u8, text? }
  let zipName = null;
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      zipName = f.name;
      onProgress && onProgress(0.05, 'Unpacking the zip…');
      const { unzipSync } = await import('/vendor/fflate.mjs');
      const all = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: e => !/(^|\/)(__MACOSX|\.git)\//.test(e.name) && !e.name.endsWith('/') && e.originalSize < 60 * 1024 * 1024 });
      const names = Object.keys(all);
      // strip a common top folder
      const top = names.length && names.every(n => n.includes('/') && n.split('/')[0] === names[0].split('/')[0]) ? names[0].split('/')[0] + '/' : '';
      for (const [n, u8] of Object.entries(all)) if (!JUNK.test(n)) files.set(n.slice(top.length), { u8 });
    } else {
      const p = (f.webkitRelativePath && f.webkitRelativePath.split('/').slice(1).join('/')) || f.name;
      if (!JUNK.test(p)) files.set(p, { u8: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  for (const [p, v] of files) if (TEXT_EXT.test(p)) v.text = decode(v.u8).replace(/\r\n?/g, '\n');
  return { files, zipName };
}
/** Build products and clutter that are never part of the manuscript. */
export const JUNK = /(^|\/)(\.git|__MACOSX|node_modules|\.vscode|\.idea)\/|(^|\/)\.DS_Store$|\.(aux|log|out|blg|fls|fdb_latexmk|toc|lof|lot|nav|snm|vrb|bcf|run\.xml|synctex|synctex\.gz|xdv|dvi|bak|swp)$|~$/i;
/** Documents in the project that can be compiled (have \documentclass and \begin{document}). */
export function mainCandidates(files) {
  return [...files.entries()].filter(([p, v]) => /\.tex$/i.test(p) && v.text && /\\documentclass/.test(v.text) && /\\begin\s*\{document\}/.test(v.text)).map(([p]) => p);
}
function findMain(files) {
  const tex = [...files.entries()].filter(([p, v]) => /\.tex$/i.test(p) && v.text);
  const mains = tex.filter(([, v]) => /\\documentclass/.test(v.text) && /\\begin\s*\{document\}/.test(v.text));
  if (!mains.length) return null;
  const pref = mains.find(([p]) => /(^|\/)(main|paper|manuscript|ms|article|root)\.tex$/i.test(p));
  return (pref || mains.sort((a, b) => b[1].text.length - a[1].text.length)[0])[0];
}
function resolve(files, name, exts = ['.tex', ''], dirs = ['']) {
  const n = name.trim().replace(/^\.\//, '');
  for (const d of dirs) for (const e of exts) { const p = (d + n + e).replace(/\/\.\//g, '/').replace(/^\.\//, ''); if (files.has(p)) return p; }
  const base = n.split('/').pop();
  for (const e of exts) for (const p of files.keys()) if (p.endsWith('/' + base + e) || p === base + e) return p;
  return null;
}

// ── small scanning helpers ─────────────────────────────────
function skipSpace(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }
function readGroup(s, i) { // s[i] must be '{' after spaces → [content, endIndex, contentStart]
  i = skipSpace(s, i);
  if (s[i] !== '{') { if (s[i] === '\\') { const m = s.slice(i).match(/^\\[a-zA-Z@]+|^\\./); return [m ? m[0] : '', i + (m ? m[0].length : 1), i]; } return [s[i] || '', i + 1, i]; }
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '%') { const nl = s.indexOf('\n', j); j = nl < 0 ? s.length : nl; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) return [s.slice(i + 1, j), j + 1, i + 1]; }
  }
  return [s.slice(i + 1), s.length, i + 1];
}
function readOpt(s, i) {
  const j = skipSpace(s, i);
  if (s[j] !== '[') return [null, i];
  let d = 0;
  for (let k = j; k < s.length; k++) { if (s[k] === '\\') { k++; continue; } if (s[k] === '{') d++; else if (s[k] === '}') d--; else if (s[k] === ']' && d === 0) return [s.slice(j + 1, k), k + 1]; }
  return [null, i];
}
function findEnd(s, env, from) { // index of the matching \end{env}
  const esc = env.replace(/[*]/g, '\\*');
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, 'g');
  re.lastIndex = from;
  let d = 1, m;
  while ((m = re.exec(s))) {
    const before = s.lastIndexOf('\n', m.index);
    if (/%/.test(s.slice(before + 1, m.index).replace(/\\%/g, ''))) continue;
    if (m[1] === 'begin') d++; else if (!--d) return { start: m.index, end: m.index + m[0].length };
  }
  return { start: s.length, end: s.length };
}
const romanOf = n => { const r = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let o = ''; for (const [v, c] of r) while (n >= v) { o += c; n -= v; } return o; };
const alpha = n => String.fromCharCode(64 + n);

// ── tables ─────────────────────────────────────────────────
export function parseTabular(src, ctx) {
  const m = src.match(/\\begin\s*\{(tabular\*?|tabularx|tabulary|longtable|array|tblr|NiceTabular)\}/);
  if (!m) return [];
  let i = m.index + m[0].length;
  if (/tabular\*|tabularx|tabulary/.test(m[1])) i = readGroup(src, i)[1];
  i = readOpt(src, i)[1];
  i = readGroup(src, i)[1]; // column spec
  const end = findEnd(src, m[1], i);
  let body = stripTexComments(src.slice(i, end.start));
  body = body.replace(/\\(toprule|midrule|bottomrule|hline|endhead|endfirsthead|endfoot|endlastfoot|hdashline|specialrule\{[^}]*\}\{[^}]*\}\{[^}]*\})\b(\[[^\]]*\])?/g, '').replace(/\\(cmidrule|cline)(\([^)]*\))?(\[[^\]]*\])?\{[^}]*\}/g, '').replace(/\\(rowcolor|cellcolor)(\[[^\]]*\])?\{[^}]*\}/g, '').replace(/\\addlinespace(\[[^\]]*\])?/g, '');
  // split rows on \\ at brace depth 0
  const rows = []; let d = 0, st = 0;
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '\\' && body[k + 1] === '\\' && d === 0) { rows.push(body.slice(st, k)); k += 1; const o = body.slice(k + 1).match(/^\s*\[[^\]]*\]/); if (o) k += o[0].length; st = k + 1; continue; }
    if (c === '\\') { k++; continue; }
    if (c === '{') d++; else if (c === '}') d--;
  }
  rows.push(body.slice(st));
  const grid = [];
  const pendingRows = []; // multirow carry-over: [col] → remaining
  for (const r of rows) {
    if (!r.trim()) continue;
    const cells = []; let dd = 0, s0 = 0;
    for (let k = 0; k < r.length; k++) { const c = r[k]; if (c === '\\') { k++; continue; } if (c === '{') dd++; else if (c === '}') dd--; else if (c === '&' && dd === 0) { cells.push(r.slice(s0, k)); s0 = k + 1; } }
    cells.push(r.slice(s0));
    const out = [];
    for (const c of cells) {
      const mc = c.trim().match(/^\\multicolumn\s*\{(\d+)\}/);
      const text = renderTex(c, ctx).replace(/\s+/g, ' ').trim();
      out.push(text);
      if (mc) for (let k = 1; k < +mc[1]; k++) out.push('');
    }
    if (out.every(x => !x)) continue;
    grid.push(out);
  }
  const w = Math.max(0, ...grid.map(r => r.length));
  return grid.map(r => r.concat(Array(w - r.length).fill('')));
}

// ── pgfplots ───────────────────────────────────────────────
function parsePgfplots(src, files, dirs, tx = delatex) {
  const axis = src.match(/\\begin\s*\{(axis|semilogyaxis|semilogxaxis|loglogaxis)\}(\s*\[[\s\S]*?\])?/);
  if (!axis) return null;
  const opts = axis[2] || '';
  const opt = k => { const m = opts.match(new RegExp(`${k}\\s*=\\s*(\\{[^}]*\\}|[^,\\]]+)`)); return m ? m[1].replace(/^\{|\}$/g, '').trim() : null; };
  const symbolic = opt('symbolic x coords');
  const series = [];
  const re = /\\addplot(\+|3)?\s*(\[[^\]]*\])?\s*(coordinates\s*\{([\s\S]*?)\}|table\s*(\[[^\]]*\])?\s*\{([\s\S]*?)\})/g;
  let m;
  while ((m = re.exec(src))) {
    const pts = [];
    if (m[4] != null) for (const c of m[4].matchAll(/\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g)) { const y = Number(c[2]); pts.push({ x: Number.isFinite(Number(c[1])) ? Number(c[1]) : c[1].trim(), y: Number.isFinite(y) ? y : null }); }
    else {
      let data = m[6];
      const tOpt = m[5] || '';
      if (!/\n/.test(data.trim()) && !/\s/.test(data.trim())) { const f = resolve(files, data.trim(), ['', '.dat', '.csv', '.txt'], dirs); data = f ? files.get(f).text || '' : ''; }
      const lines = data.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('%'));
      const sep = /,/.test(lines[0] || '') ? /\s*,\s*/ : /\s+/;
      const head = lines[0] ? lines[0].split(sep) : [];
      const hasHead = head.some(h => !Number.isFinite(Number(h)));
      const xk = (tOpt.match(/x\s*=\s*([^,\]]+)/) || [])[1], yk = (tOpt.match(/y\s*=\s*([^,\]]+)/) || [])[1];
      const xi = hasHead && xk ? head.indexOf(xk.trim()) : 0, yi = hasHead && yk ? head.indexOf(yk.trim()) : 1;
      for (const l of lines.slice(hasHead ? 1 : 0)) { const c = l.split(sep); const y = Number(c[yi < 0 ? 1 : yi]); pts.push({ x: Number.isFinite(Number(c[xi < 0 ? 0 : xi])) ? Number(c[xi < 0 ? 0 : xi]) : c[xi < 0 ? 0 : xi], y: Number.isFinite(y) ? y : null }); }
    }
    const kind = /ybar|xbar/.test((m[2] || '') + opts) ? 'bar' : /only marks/.test(m[2] || '') ? 'scatter' : 'line';
    series.push({ name: null, kind, points: pts.slice(0, 800) });
  }
  const legend = (src.match(/\\legend\s*\{([^}]*)\}/) || [])[1];
  const names = legend ? legend.split(',').map(x => tx(x).trim()) : [];
  const entries = [...src.matchAll(/\\addlegendentry\s*\{([^}]*)\}/g)].map(x => tx(x[1]).trim());
  series.forEach((s, i) => { s.name = names[i] || entries[i] || `Series ${i + 1}`; });
  if (!series.length) return null;
  const strip = v => (v ? tx(v).trim() : null);
  return { source: 'pgfplots', axes: { x: { title: strip(opt('xlabel')), type: symbolic ? 'category' : /semilogx|loglog/.test(axis[1]) ? 'log' : 'linear', labels: symbolic ? symbolic.split(',').map(x => x.trim()) : undefined }, y: { title: strip(opt('ylabel')), type: /semilogy|loglog/.test(axis[1]) ? 'log' : 'linear', min: opt('ymin') != null ? Number(opt('ymin')) : undefined, max: opt('ymax') != null ? Number(opt('ymax')) : undefined } }, series, confidence: 1 };
}

// ── graphics files → snapshot + data ──────────────────────
async function analyseGraphic(path, u8) {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
    const blob = new Blob([u8], { type: ext === 'png' ? 'image/png' : 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    const sc = Math.min(1, 1600 / bmp.width);
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return { kind: 'raster', blob: await new Promise(r => c.toBlob(r, 'image/png')), canvas: c, data: null, text: [] };
  }
  if (ext === 'pdf') {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: u8.slice(), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const g = scanGraphics(ops, vp.transform, lib.OPS);
    const tc = await page.getTextContent();
    const texts = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = lib.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]) || 8;
      const rot = Math.abs(tx[1]) > 0.05 * Math.abs(tx[0]) + 0.01 || tx[0] < 0;
      texts.push(rot ? { s: it.str, rot: true, x0: tx[4] - h, x1: tx[4], top: tx[5] - it.width, bottom: tx[5], h, base: tx[5] } : { s: it.str, x0: tx[4], x1: tx[4] + it.width, top: tx[5] - h * 0.8, bottom: tx[5] + h * 0.22, h, base: tx[5] });
    }
    const scale = Math.min(3, 1400 / vp.width);
    const c = document.createElement('canvas'); c.width = Math.round(vp.width * scale); c.height = Math.round(vp.height * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }), annotationMode: 0, intent: 'print' }).promise;
    let data = null;
    try { data = digitize({ texts, shapes: g.shapes }); } catch { data = null; }
    await doc.destroy();
    return { kind: g.images.length ? (texts.length >= 3 ? 'mixed' : 'raster') : 'vector', blob: await new Promise(r => c.toBlob(r, 'image/png')), canvas: g.images.length ? c : null, data, text: texts.map(t => t.s.trim()).filter(Boolean) };
  }
  return { kind: 'none', blob: null, data: null, text: [], note: `${ext.toUpperCase()} graphics cannot be shown in the browser` };
}

// ── main ───────────────────────────────────────────────────
// ── External documents (xr / xr-hyper) ─────────────────────
/** The document's text with \input / \include inlined (relative to its folder). */
function inlineInputs(files, path, depth = 0) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const text = stripTexComments((files.get(path) || {}).text || '');
  if (depth > 6) return text;
  return text.replace(/\\(?:input|include)\s*\{([^}]+)\}/g, (all, name) => {
    const n = name.trim().replace(/\.tex$/, '');
    const hit = [`${dir}${n}.tex`, `${n}.tex`, `${dir}${n}`, n].find(p => files.has(p) && files.get(p).text != null);
    return hit ? inlineInputs(files, hit, depth + 1) : all;
  });
}
const ROMAN = n => { let s = '', x = n; for (const [v, r] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (x >= v) { s += r; x -= v; } return s; };
const ALPH = n => (n > 0 ? (n > 26 ? ALPH(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26)) : '');
/** Label numbers of a whole document: sections, tables, figures and equations, with \appendix and \renewcommand{\the…}. */
function scanLabels(text, ieee) {
  const c = { section: 0, subsection: 0, subsubsection: 0, table: 0, figure: 0, equation: 0 };
  const the = {
    section: ieee ? '\\Roman{section}' : '\\arabic{section}', subsection: ieee ? '\\Alph{subsection}' : '\\thesection.\\arabic{subsection}',
    subsubsection: ieee ? '\\arabic{subsubsection}' : '\\thesubsection.\\arabic{subsubsection}', table: ieee ? '\\Roman{table}' : '\\arabic{table}',
    figure: '\\arabic{figure}', equation: '\\arabic{equation}',
  };
  const fmt = (name, depth = 0) => String(the[name] || '').replace(/\\(arabic|Roman|roman|Alph|alph)\s*\{(\w+)\}|\\the(\w+)/g, (_, style, cn, th) => {
    if (th) return depth < 4 && the[th] ? fmt(th, depth + 1) : '';
    const v = c[cn] || 0;
    return style === 'arabic' ? String(v) : style === 'Roman' ? ROMAN(v) : style === 'roman' ? ROMAN(v).toLowerCase() : style === 'Alph' ? ALPH(v) : ALPH(v).toLowerCase();
  }).replace(/[{}]/g, '');
  const out = {};
  let cur = null, appendix = false, inFloat = null;
  const re = /\\renewcommand\*?\s*\{?\\the(section|subsection|subsubsection|table|figure|equation)\}?\s*\{|\\(section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\])?\s*\{|\\appendix\b|\\begin\s*\{(?:sideways|wrap|margin|SC)?(table|figure|equation|align|gather|multline|eqnarray)(\*?)\}|\\end\s*\{(?:sideways|wrap|margin|SC)?(table|figure)\*?\}|\\caption\s*(?:\[[^\]]*\])?\s*\{|\\label\s*\{([^}]+)\}|\\setcounter\s*\{(\w+)\}\s*\{(\d+)\}|\\\\|\\begin\s*\{(theorem|lemma|corollary|proposition|definition|remark|example|assumption|claim|conjecture|observation|problem|hypothesis|fact|property)\}/g;
  let m, eqEnv = null;
  while ((m = re.exec(text))) {
    if (m[10]) { c[m[10]] = (c[m[10]] || 0) + 1; cur = { n: String(c[m[10]]), kind: m[10] }; continue; }
    if (m[1]) { const [body, end] = readGroup(text, re.lastIndex - 1); the[m[1]] = body; re.lastIndex = end; continue; }
    if (m[2]) {
      if (m[3]) continue; // starred: not numbered
      c[m[2]]++;
      if (m[2] === 'section') { c.subsection = 0; c.subsubsection = 0; } else if (m[2] === 'subsection') c.subsubsection = 0;
      cur = { n: fmt(m[2]), kind: appendix && m[2] === 'section' ? 'appendix' : 'section' };
      continue;
    }
    if (m[0].startsWith('\\appendix')) { appendix = true; c.section = 0; c.subsection = 0; the.section = '\\Alph{section}'; continue; }
    if (m[4]) {
      if (m[4] === 'table' || m[4] === 'figure') { inFloat = m[4]; continue; }
      eqEnv = m[5] ? null : m[4];
      if (eqEnv) { c.equation++; cur = { n: fmt('equation'), kind: 'equation' }; }
      continue;
    }
    if (m[6]) { inFloat = null; continue; }
    if (m[0].startsWith('\\caption')) { if (inFloat) { c[inFloat]++; cur = { n: fmt(inFloat), kind: inFloat }; } continue; }
    if (m[7]) { if (cur && !(m[7] in out)) out[m[7]] = { ...cur }; continue; }
    if (m[8]) { if (m[8] in c) c[m[8]] = Number(m[9]); continue; }
    // \\ inside align-like environments starts the next numbered line
    if (m[0] === '\\\\' && eqEnv && eqEnv !== 'equation') { c.equation++; cur = { n: fmt('equation'), kind: 'equation' }; }
  }
  return out;
}
/** Labels of documents loaded with xr / xr-hyper: \externaldocument[prefix]{name} → { 'prefix'+label: { n, kind } }. */
function externalLabels(files, main, pre) {
  const out = {};
  const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  for (const m of stripTexComments(pre).matchAll(/\\externaldocument\s*(?:\[([^\]]*)\])?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const prefix = (m[1] || '').trim(), name = m[2].trim().replace(/\.tex$/, '');
    const path = [`${dir}${name}.tex`, `${name}.tex`].find(p => files.has(p) && files.get(p).text != null);
    if (!path) continue;
    const t = inlineInputs(files, path);
    const cls = (t.match(/\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]+)\}/) || [])[2] || '';
    for (const [k, v] of Object.entries(scanLabels(t, /IEEEtran/i.test(cls)))) if (!(`${prefix}${k}` in out)) out[`${prefix}${k}`] = v;
  }
  return out;
}

export async function readLatex(fileList, onProgress = () => {}, opts = {}) {
  const { files, zipName } = opts.gathered || await gatherFiles(fileList, onProgress);
  const main = opts.main && files.has(opts.main) ? opts.main : findMain(files);
  if (!main) throw new Error('No main .tex file (with \\documentclass and \\begin{document}) was found. Upload the whole project as a .zip.');
  onProgress(0.15, 'Reading the LaTeX source…');
  const mainText = files.get(main).text;
  const pre = mainText.slice(0, mainText.search(/\\begin\s*\{document\}/));
  const cls = (pre.match(/\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]+)\}/) || [])[2] || '';
  const ieee = /IEEEtran/i.test(cls);
  // macros without arguments from every preamble-ish file
  const macros = {};
  const preambles = [pre, ...[...files.entries()].filter(([p, v]) => /\.(sty|tex)$/i.test(p) && p !== main && v.text && /\\(newcommand|def|renewcommand|DeclareMathOperator)/.test(v.text) && !/\\begin\s*\{document\}/.test(v.text) && v.text.length < 200000).map(([, v]) => v.text)];
  for (const t of preambles) {
    const s = stripTexComments(t);
    for (const m of s.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z@]+)\}?\s*(\[\d\])?\s*\{/g)) { if (m[2]) continue; const [body] = readGroup(s, m.index + m[0].length - 1); if (body.length < 300) macros[m[1]] = body; }
    for (const m of s.matchAll(/\\def\\([a-zA-Z@]+)\s*\{/g)) { const [body] = readGroup(s, m.index + m[0].length - 1); if (body.length < 300 && !/#/.test(body)) macros[m[1]] = body; }
    for (const m of s.matchAll(/\\DeclareMathOperator\*?\s*\{?\\([a-zA-Z]+)\}?\s*\{([^}]*)\}/g)) macros[m[1]] = `\\operatorname{${m[2]}}`;
  }
  const gp = (pre.match(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/) || [])[1];
  const gdirs = ['', ...(gp ? [...gp.matchAll(/\{([^}]*)\}/g)].map(m => m[1].replace(/^\.\//, '')) : [])];
  const natbib = /\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*natbib/.test(pre) && !/numbers/.test((pre.match(/\\usepackage\s*\[([^\]]*)\]\s*\{[^}]*natbib/) || [])[1] || '');
  const biblatexAY = /\\usepackage\s*\[[^\]]*(authoryear|apa)[^\]]*\]\s*\{biblatex\}/.test(pre);

  const ctx = { labels: {}, cites: {}, macros };
  // labels of documents loaded with xr / xr-hyper (\externaldocument[S-]{supplementary}): "Section S2" instead of "??"
  Object.assign(ctx.labels, externalLabels(files, main, pre));
  const counters = { sec: [0, 0, 0, 0], eq: 0, fig: 0, tab: 0, alg: 0, thm: 0, appendix: false };
  const sections = [], blocks = [], tables = [], figures = [], bibitems = [];
  const citeOrder = new Map();
  let sec = null, bid = 1, inAbstract = false;
  const titleM = mainText.match(/\\title\s*(\[[^\]]*\])?\s*\{/);
  const visited = new Set();
  const noteCites = text => { for (const m of stripTexComments(text).matchAll(/\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]+)\}/g)) for (const k of m[1].split(',').map(x => x.trim()).filter(Boolean)) if (!citeOrder.has(k)) citeOrder.set(k, citeOrder.size + 1); };
  const secNum = level => {
    const c = counters.sec;
    if (counters.appendix && level === 1) return alpha(c[0]);
    if (ieee) return level === 1 ? romanOf(c[0]) : level === 2 ? `${romanOf(c[0])}-${alpha(c[1])}` : `${romanOf(c[0])}-${alpha(c[1])}${c[2]}`;
    return c.slice(0, level).join('.');
  };
  const addBlock = (kind, file, text, start, end, extra = {}) => {
    // trim whitespace (keep offsets exact)
    let s = start, e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    const src = text.slice(s, e);
    if (!stripTexComments(src).trim()) return null;
    // command-only blocks in the body (macro definitions, \bstctlcite, spacing) are not prose
    if (kind !== 'equation' && kind !== 'heading' && !/\\(begin\s*\{(equation|align|gather|multline)|\[)/.test(src) && (renderTex(src, ctx).match(/[A-Za-z]{2,}/g) || []).length < 2) return null;
    if (kind === 'para' && /^\s*\\(newcommand|renewcommand|providecommand|def|let|bstctlcite|setlength|addtolength|setcounter|hypersetup|tikzset|pgfplotsset|definecolor|captionsetup|graphicspath)\b/.test(stripTexComments(src))) return null;
    noteCites(src);
    const line = text.slice(0, s).split('\n').length;
    const b = { id: `b${bid++}`, kind, sec: sec ? sec.id : null, text: src, tex: true, src: { file, start: s, end: e, line }, ...extra };
    blocks.push(b);
    return b;
  };
  function labelIn(s) { const m = stripTexComments(s).match(/\\label\s*\{([^}]+)\}/); return m ? m[1].trim() : null; }
  function countEquations(body, env) {
    if (/\*$/.test(env) || env === 'displaymath' || env === 'split') return;
    if (/^(align|gather|multline|eqnarray|flalign|alignat)$/.test(env)) {
      const linesE = stripTexComments(body).split(/\\\\/);
      for (const ln of linesE) { if (/\\(nonumber|notag)\b/.test(ln) || (!ln.trim() && env !== 'multline')) continue; counters.eq++; const l = labelIn(ln); if (l) ctx.labels[l] = { n: String(counters.eq), kind: 'equation' }; if (env === 'multline') break; }
    } else { counters.eq++; const l = labelIn(body); if (l) ctx.labels[l] = { n: String(counters.eq), kind: 'equation' }; }
  }
  async function handleFloat(env, file, text, bodyStart, bodyEnd) {
    const body = text.slice(bodyStart, bodyEnd);
    const isTab = /table/i.test(env) || (/^SC/.test(env) && /table/i.test(env));
    const isAlg = /algorithm|listing/.test(env);
    const capM = [...body.matchAll(/\\caption(?:of\s*\{[^}]*\})?\s*(\[[^\]]*\])?\s*\{/g)].filter(m => !/\\sub/.test(body.slice(Math.max(0, m.index - 4), m.index)));
    const kind = isAlg ? 'algorithm' : isTab || (/\\begin\s*\{tabular/.test(body) && !/\\includegraphics/.test(body)) ? 'table' : 'figure';
    let num;
    if (kind === 'table') { counters.tab++; num = ieee ? romanOf(counters.tab) : String(counters.tab); }
    else if (kind === 'figure') { counters.fig++; num = String(counters.fig); }
    else { counters.alg++; num = String(counters.alg); }
    const lab = labelIn(body);
    if (lab) ctx.labels[lab] = { n: num, kind };
    for (const m of stripTexComments(body).matchAll(/\\label\s*\{([^}]+)\}/g)) if (!ctx.labels[m[1]]) ctx.labels[m[1]] = { n: num, kind };
    const label = kind === 'table' ? `Table ${num}` : kind === 'figure' ? `Fig. ${num}` : `Algorithm ${num}`;
    let capBlock = null;
    if (capM.length) {
      const m = capM[capM.length - 1];
      const [, endArg, argStart] = readGroup(body, m.index + m[0].length - 1);
      capBlock = addBlock('caption', file, text, bodyStart + argStart, bodyStart + endArg - 1, { label });
    }
    if (kind === 'algorithm') return;
    if (kind === 'table') {
      tables.push({ id: `t${tables.length + 1}`, label, num, caption: capBlock ? renderTex(capBlock.text, ctx) : '', bid: capBlock ? capBlock.id : null, grid: [], src: body, source: 'latex' });
      return;
    }
    const gfx = [...stripTexComments(body).matchAll(/\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]+)\}/g)].map(m => m[2].trim());
    const fig = { id: `f${figures.length + 1}`, label, num, caption: capBlock ? '' : '', capSrc: capBlock ? capBlock.text : '', bid: capBlock ? capBlock.id : null, kind: 'none', data: null, text: [], files: [], tikz: /\\begin\s*\{tikzpicture\}/.test(body) };
    if (/\\begin\s*\{(axis|semilogyaxis|semilogxaxis|loglogaxis)\}/.test(body)) { fig.data = parsePgfplots(stripTexComments(body), files, gdirs, s => renderTex(s, ctx)); fig.kind = 'tikz'; }
    for (const g of gfx) { const p = resolve(files, g, IMG_EXT, gdirs); if (p) fig.files.push(p); }
    figures.push(fig);
  }
  async function scan(file, text, from, to, mode = 'body') {
    let i = from, paraStart = -1, depth = 0;
    const endPara = at => {
      if (paraStart >= 0) {
        const b = addBlock(inAbstract ? 'abstract' : 'para', file, text, paraStart, at);
        if (b) {
          const t = stripTexComments(b.text);
          const rest = t.replace(/\\begin\s*\{(\w+\*?)\}[\s\S]*?\\end\s*\{\1\}/g, '').replace(/\\\[[\s\S]*?\\\]/g, '').replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\\label\s*\{[^}]*\}/g, '').replace(/[\s.,;]/g, '');
          if (!rest && /\\begin\s*\{|\\\[|\$\$/.test(t)) b.kind = 'equation';
        }
      }
      paraStart = -1;
    };
    while (i < to) {
      const c = text[i];
      if (c === '%') { const nl = text.indexOf('\n', i); i = nl < 0 ? to : nl; continue; }
      if (c === '\n' && depth === 0) {
        // blank line?
        let j = i + 1;
        while (j < to && /[ \t]/.test(text[j])) j++;
        if (text[j] === '\n') { endPara(i); i = j; continue; }
        i++; continue;
      }
      if (c === '{') { if (paraStart < 0 && depth === 0) paraStart = i; depth++; i++; continue; }
      if (c === '}') { depth = Math.max(0, depth - 1); i++; continue; }
      if (c === '\\' && depth === 0) {
        const m = text.slice(i, i + 40).match(/^\\([a-zA-Z@]+\*?)/);
        const name = m ? m[1] : null;
        if (!name) { if (paraStart < 0) paraStart = i; i += 2; continue; }
        const after = i + m[0].length;
        const base = name.replace(/\*$/, '');
        if (/^(section|subsection|subsubsection|chapter|part)$/.test(base)) {
          endPara(i);
          let k = readOpt(text, after)[1];
          const [title, endT, tStart] = readGroup(text, k);
          const level = { part: 0, chapter: 1, section: 1, subsection: 2, subsubsection: 3 }[base] || 1;
          let num = '';
          if (!name.endsWith('*')) { counters.sec[level - 1]++; for (let z = level; z < 4; z++) counters.sec[z] = 0; num = secNum(level); }
          const rendered = renderTex(title, ctx);
          sec = { id: `s${sections.length + 1}`, title: rendered, level, num };
          sections.push(sec);
          inAbstract = false;
          addBlock('heading', file, text, tStart, endT - 1);
          // label right after the heading
          const lm = text.slice(endT, endT + 120).match(/^\s*\\label\s*\{([^}]+)\}/);
          if (lm) ctx.labels[lm[1]] = { n: num, kind: counters.appendix && level === 1 ? 'appendix' : 'section' };
          i = endT; continue;
        }
        if (base === 'paragraph' || base === 'subparagraph') { endPara(i); paraStart = i; i = after; continue; }
        if (name === 'appendix') { endPara(i); counters.appendix = true; counters.sec = [0, 0, 0, 0]; i = after; continue; }
        if (/^(input|include|subfile|import)$/.test(base)) {
          endPara(i);
          let k = after; let dir = '';
          if (base === 'import') { const [d0, e0] = readGroup(text, k); dir = d0; k = e0; }
          const [arg, endA] = readGroup(text, k);
          const p = resolve(files, dir + arg, ['.tex', ''], ['', ...gdirs]);
          if (p && !visited.has(p) && files.get(p).text) { visited.add(p); const t2 = files.get(p).text; const bd = t2.search(/\\begin\s*\{document\}/); const ed = t2.search(/\\end\s*\{document\}/); await scan(p, t2, bd >= 0 ? bd + 16 : 0, ed >= 0 ? ed : t2.length); }
          i = endA; continue;
        }
        if (base === 'begin') {
          const [env, endE] = readGroup(text, after);
          const close = findEnd(text, env, endE);
          if (FLOATS.test(env)) { endPara(i); await handleFloat(env, file, text, endE, close.start); i = close.end; continue; }
          if (env === 'abstract') { endPara(i); const was = inAbstract; inAbstract = true; const prevSec = sec; sec = { id: `s${sections.length + 1}`, title: 'Abstract', level: 1, num: '' }; sections.push(sec); await scan(file, text, endE, close.start); inAbstract = was; sec = prevSec === null ? null : prevSec; i = close.end; continue; }
          if (env === 'document') { i = endE; continue; }
          if (env === 'thebibliography') { endPara(i); bibitems.push(...text.slice(endE, close.start).split(/\\bibitem/).slice(1).map(s => { const km = s.match(/^\s*(\[[^\]]*\])?\s*\{([^}]+)\}/); return { key: km ? km[2].trim() : '', label: km && km[1] ? km[1].slice(1, -1) : null, raw: delatex(s.slice(km ? km[0].length : 0).replace(/\\newblock/g, ' ')) }; }).filter(x => x.raw.length > 8)); i = close.end; continue; }
          if (LISTS.test(env)) { if (paraStart >= 0) { /* list inside a paragraph: keep going */ i = close.end; continue; } endPara(i); addBlock('list', file, text, i, close.end); i = close.end; continue; }
          if (MATH_ENVS.test(env)) { countEquations(text.slice(endE, close.start), env); if (paraStart < 0) paraStart = i; i = close.end; continue; }
          if (THEOREMS.test(env)) { endPara(i); counters.thm++; const lab = labelIn(text.slice(endE, close.start)); if (lab) ctx.labels[lab] = { n: String(counters.thm), kind: env.replace(/\*$/, '') }; addBlock('para', file, text, i, close.end, { label: env.replace(/\*$/, '') }); i = close.end; continue; }
          if (CONTAINERS.test(env)) { endPara(i); await scan(file, text, endE, close.start); i = close.end; continue; }
          if (SKIP_ENVS.test(env)) { endPara(i); i = close.end; continue; }
          if (paraStart < 0) paraStart = i;
          i = close.end; continue;
        }
        if (/^(maketitle|tableofcontents|listoffigures|listoftables|clearpage|newpage|cleardoublepage|IEEEpeerreviewmaketitle|IEEEdisplaynontitleabstractindextext|bibliographystyle|bibliography|printbibliography|addbibresource|vspace|vskip|bigskip|medskip|smallskip|noindent|thispagestyle|pagestyle|label|centering|title|author|affiliation|address|email|date|thanks|keywords|IEEEoverridecommandlockouts|markboth|onecolumn|twocolumn|balance|IEEEtriggeratref|nocite|setlength|acknowledgments|begin)$/.test(base) && paraStart < 0) {
          let k = after;
          k = readOpt(text, k)[1];
          if (/^(title|author|affiliation|address|email|date|thanks|keywords|markboth|bibliographystyle|bibliography|addbibresource|vspace|vskip|label|thispagestyle|pagestyle|nocite|IEEEtriggeratref)$/.test(base)) { k = readGroup(text, k)[1]; if (base === 'markboth') k = readGroup(text, k)[1]; }
          if (base === 'setlength') { k = readGroup(text, k)[1]; k = readGroup(text, k)[1]; }
          i = k; continue;
        }
        if (paraStart < 0) paraStart = i;
        i = after; continue;
      }
      if (c === '\\') { i += 2; continue; }
      if (paraStart < 0 && !/\s/.test(c)) paraStart = i;
      i++;
    }
    endPara(to);
  }
  // title block (from wherever \title is)
  if (titleM) { const [t, , st] = readGroup(mainText, titleM.index + titleM[0].length - 1); if (t.trim()) addBlock('title', main, mainText, st, st + t.length); }
  visited.add(main);
  const bodyStart = mainText.search(/\\begin\s*\{document\}/) + '\\begin{document}'.length;
  const bodyEnd = (() => { const e = mainText.search(/\\end\s*\{document\}/); return e < 0 ? mainText.length : e; })();
  await scan(main, mainText, bodyStart, bodyEnd);
  // abstracts given as \abstract{...}
  onProgress(0.45, 'Resolving citations and references…');
  // ── bibliography ──
  const bbl = [...files.entries()].find(([p, v]) => /\.bbl$/i.test(p) && v.text && (p.replace(/\.bbl$/i, '') === main.replace(/\.tex$/i, '') || true));
  const bibFiles = (() => { const m = stripTexComments(mainText).match(/\\bibliography\s*\{([^}]+)\}/g) || []; const names = m.flatMap(x => x.replace(/^\\bibliography\s*\{|\}$/g, '').split(',').map(s => s.trim())); const res = (stripTexComments(mainText).match(/\\addbibresource(\[[^\]]*\])?\{([^}]+)\}/g) || []).map(x => x.replace(/^.*\{|\}$/g, '')); return [...names, ...res].map(n => resolve(files, n, ['.bib', ''])).filter(Boolean); })();
  const style = (stripTexComments(mainText).match(/\\bibliographystyle\s*\{([^}]+)\}/) || [])[1] || '';
  let entries = [];
  if (bbl && bbl[1].text && /\\bibitem/.test(bbl[1].text)) {
    entries = bbl[1].text.split(/\\bibitem/).slice(1).map(s => { const km = s.match(/^\s*(\[[\s\S]*?\])?\s*\{([^}]+)\}/); return { key: km ? km[2].trim() : '', label: km && km[1] ? km[1].slice(1, -1) : null, raw: delatex(s.slice(km ? km[0].length : 0).replace(/\\end\{thebibliography\}[\s\S]*$/, '').replace(/\\newblock/g, ' ').replace(/\\(BIBentry|bibinfo|BIBentrySTD)\w*\s*(\{[^}]*\})?/g, '')) }; }).filter(x => x.raw.length > 8);
  } else if (bibitems.length) entries = bibitems;
  const bib = bibFiles.flatMap(p => parseBib(files.get(p).text || ''));
  const bibByKey = new Map(bib.map(b => [b.key, b]));
  if (!entries.length && bib.length) {
    let cited = [...citeOrder.keys()].map(k => bibByKey.get(k)).filter(Boolean);
    if (/\\nocite\s*\{\s*\*\s*\}/.test(mainText)) cited = bib;
    if (SORTED_STYLES.test(style)) cited.sort((a, b) => String(a.parsed.authors[0] || a.parsed.title || '').localeCompare(String(b.parsed.authors[0] || b.parsed.title || '')) || (a.parsed.year || 0) - (b.parsed.year || 0));
    entries = cited.map(b => ({ key: b.key, raw: b.raw, parsed: b.parsed, display: b.display }));
  } else for (const e of entries) { const b = bibByKey.get(e.key); if (b) { e.parsed = b.parsed; e.display = b.display; } }
  const authorYear = natbib || biblatexAY || entries.some(e => e.label && /\(\d{4}[a-z]?\)/.test(e.label));
  entries.forEach((e, k) => {
    if (authorYear) {
      let t = null;
      if (e.label) { const m = delatex(e.label).match(/^(.*?)\((\d{4}[a-z]?)\)/); if (m) t = `${m[1].trim()}, ${m[2]}`; }
      if (!t && e.display) { const a = e.display.authors; t = `${a.length ? a[0].split(' ').pop() : '?'}${a.length > 2 ? ' et al.' : a.length === 2 ? ` and ${a[1].split(' ').pop()}` : ''}, ${e.display.year || 'n.d.'}`; }
      ctx.cites[e.key] = t || k + 1;
    } else ctx.cites[e.key] = k + 1;
  });
  const missingKeys = [...citeOrder.keys()].filter(k => ctx.cites[k] == null);
  const refs = entries.map(e => ({ raw: e.raw, key: e.key, parsed: e.parsed || undefined }));
  for (const [k, e] of entries.entries()) blocks.push({ id: `b${bid++}`, kind: 'ref', sec: null, text: e.raw, tex: false, ref: String(k + 1) });
  // ── tables and figures ──
  onProgress(0.55, 'Reading tables and figures…');
  for (const t of tables) { try { t.grid = parseTabular(t.src, ctx); } catch { t.grid = []; } delete t.src; }
  const assets = { figImages: [] };
  let k = 0;
  for (const f of figures) {
    k++;
    onProgress(0.55 + 0.35 * (k / Math.max(1, figures.length)), `Figure ${f.num}: reading the graphics…`);
    f.caption = f.capSrc ? renderTex(f.capSrc, ctx) : '';
    delete f.capSrc;
    const subData = [];
    for (const p of f.files.slice(0, 6)) {
      try {
        const r = await analyseGraphic(p, files.get(p).u8);
        if (r.blob && !assets.figImages.some(x => x.id === f.id)) assets.figImages.push({ id: f.id, blob: r.blob, canvas: r.canvas });
        if (f.kind === 'none' || f.kind === 'tikz' && !f.data) f.kind = r.kind;
        else if (r.kind === 'raster' && f.kind === 'vector') f.kind = 'mixed';
        if (r.data) subData.push(r.data);
        f.text.push(...r.text);
        if (r.note) f.note = r.note;
      } catch (e) { f.note = `Could not read ${p}: ${e.message}`; }
    }
    if (!f.data && subData.length) {
      // several included graphics: each becomes a panel (a graphic that is itself multi-panel keeps its panels)
      const panels = [], series = [];
      for (const d of subData) {
        const own = Array.isArray(d.panels) && d.panels.length > 1 ? d.panels : [{ title: null, axes: d.axes, note: d.note, confidence: d.confidence }];
        const base = panels.length;
        own.forEach(pn => panels.push({ ...pn, label: `(${String.fromCharCode(97 + panels.length)})` }));
        for (const s of d.series) series.push({ ...s, panel: base + (own.length > 1 ? s.panel || 0 : 0) });
      }
      f.data = subData.length === 1 ? subData[0] : { ...subData[0], panels, series, note: `${panels.length} panels read separately.` };
    }
    f.file = f.files[0] || null;
    delete f.files;
    f.text = f.text.slice(0, 300);
  }
  // re-render captions for tables now that labels/cites exist
  for (const t of tables) { const cb = blocks.find(b => b.id === t.bid); if (cb) t.caption = renderTex(cb.text, ctx); }
  const titleBlock = blocks.find(b => b.kind === 'title');
  const title = titleBlock ? renderTex(titleBlock.text, ctx).replace(/\s+/g, ' ').trim() : main.replace(/\.tex$/, '');
  const texFiles = {};
  for (const [p, v] of files) if (/\.(tex|bib|bbl|sty|cls)$/i.test(p) && v.text && v.text.length < 3e6) texFiles[p] = v.text;
  const notes = [];
  if (missingKeys.length) notes.push(`${missingKeys.length} citation key${missingKeys.length === 1 ? ' has' : 's have'} no bibliography entry: ${missingKeys.slice(0, 6).join(', ')}${missingKeys.length > 6 ? '…' : ''}.`);
  if (!refs.length) notes.push('No bibliography was found (add the .bib or .bbl file) — references cannot be checked.');
  const eps = figures.filter(f => f.note && /EPS|PS graphics/.test(f.note)).length;
  if (eps) notes.push(`${eps} figure${eps === 1 ? ' is' : 's are'} EPS, which the browser cannot display; convert to PDF/PNG for figure checks.`);
  // citations summary for RefCheck: counts per entry
  const citeCounts = entries.map(e => { let n = 0; for (const b of blocks) if (b.tex) for (const m of stripTexComments(b.text).matchAll(/\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]+)\}/g)) if (m[1].split(',').map(x => x.trim()).includes(e.key)) n++; return n; });
  const citations = entries.length ? { style: 'keys', counts: citeCounts, uncited: citeCounts.map((c, i) => (c ? -1 : i)).filter(i => i >= 0), missing: missingKeys, outOfOrder: [], firstSeen: [], total: citeCounts.reduce((a, b) => a + b, 0), keys: entries.map(e => e.key) } : null;
  return {
    title, sections, blocks, tables, figures, refs, citations, latex: ctx,
    source: { kind: 'latex', filename: zipName || main.split('/').pop(), main, files: [...files.entries()].map(([name, v]) => ({ name, size: v.u8.length })), texFiles, size: [...files.values()].reduce((n, v) => n + v.u8.length, 0), notes },
    assets, zipName, mainCandidates: mainCandidates(files),
    compiledPdf: (() => { const want = main.replace(/\.tex$/i, '.pdf'); return files.has(want) ? want : null; })(),
    gathered: { files, zipName },
  };
}
