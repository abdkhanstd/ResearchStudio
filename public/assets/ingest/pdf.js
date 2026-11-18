/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * PDF → document model, entirely in the browser (pdf.js). Nothing leaves the browser until the owner confirms.
 *   readPdf(file, onProgress) → { title, source, sections, blocks, tables, figures, refs, citations, assets, notes }
 * Layout analysis: text items → rows → segments → columns and reading order → headings, paragraphs, lists,
 * equations, captions, footnotes. Vector graphics and images give figure regions; rules and aligned rows give tables.
 * Every page is rendered to an image so readers see the typeset paragraph (and the PDF itself can stay private).
 */
import { scanGraphics, digitize } from './digitize.js';
import { joinLines, splitLines, analyzeCitations, HEADING, END_HEADING } from './refs.js';

let pdfjsP = null;
export function pdfjs() {
  if (!pdfjsP) pdfjsP = import('/vendor/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'; return m; });
  return pdfjsP;
}
const SPACING_ACCENT = { '´': '́', '`': '̀', '¨': '̈', '˜': '̃', 'ˆ': '̂', 'ˇ': '̌', '˘': '̆', '˚': '̊', '¯': '̄', '˝': '̋', '˙': '̇' };
const fixAccents = t => t.replace(/([´¨˜ˆˇ˘˚¯˝˙])\s?([A-Za-zıȷ])/g, (_, a, l) => ((l === 'ı' ? 'i' : l) + SPACING_ACCENT[a]).normalize('NFC')).replace(/([A-Za-z])\s?¸\s?/g, (_, l) => `${l}̧`.normalize('NFC'));
const CAP_FIG = /^(Fig\.?|Figure|FIG\.?|FIGURE|Fig)\s*~?\s*(\d+|[IVX]+)(?:\s*\(?[a-z]\)?)?\s*(?:[.:|—–-]|$)/;
const CAP_TAB = /^(TABLE|Table|Tab\.)\s*~?\s*(\d+|[IVX]+|[A-Z]\.?\d+)\s*(?:[.:|—–-]|$)/;
const CAP_LOOSE = /^(Fig\.?|Figure|FIGURE|Table|TABLE)\s*(\d+|[IVX]+)\s+[A-Z]/;
const SECTION_WORDS = /^(abstract|introduction|related\s+work|background|preliminar(?:y|ies)|method(?:s|ology)?|approach|experiments?|experimental\s+(?:setup|results)|evaluation|results(?:\s+and\s+discussion)?|discussion|conclusions?(?:\s+and\s+future\s+work)?|limitations|future\s+work|acknowledg(?:e)?ments?|appendix|appendices|references|bibliography|supplementary\s+material|data\s+availability|ethics\s+statement|author\s+contributions)$/i;
const BOLD = /bold|black|heavy|semibold|demi|medi(?:um)?\b|-Medi|\.B$|-B$|CMBX|cmbx|BX\d|Bd\b/i;
const ITAL = /italic|oblique|CMTI|cmti|-It\b|Ital/i;
const MATHFONT = /CMMI|CMSY|CMEX|MSAM|MSBM|Math|Symbol|STIX|rsfs|eufm|CMR\d+/i;
const pct = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };
const area = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const union = (a, b) => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b });
const overlapX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const inside = (b, R, m = 0) => b.x0 >= R.x0 - m && b.x1 <= R.x1 + m && b.y0 >= R.y0 - m && b.y1 <= R.y1 + m;
const center = b => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const roman = s => { const m = { I: 1, V: 5, X: 10, L: 50 }; let n = 0; for (let i = 0; i < s.length; i++) { const v = m[s[i]], w = m[s[i + 1]] || 0; n += v < w ? -v : v; } return n; };

// ── rows and segments ──────────────────────────────────────
/**
 * Gutter of a two-column page, found per text row (before lines are built, so lines never cross it).
 * A gutter is an x-range where many rows have text on both sides and none in between; a few rows may cross it
 * (centred title and author blocks, full-width figures, tables and captions), so those only weaken the evidence.
 * Works whether the PDF stores words, word groups or whole lines as text items.
 */
function gutterOfItems(items, width) {
  if (items.length < 12) return null;
  const sorted = [...items].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows = [];
  for (const it of sorted) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.base - it.base) <= Math.max(1.5, 0.35 * Math.min(r.h, it.h))) r.items.push(it); else rows.push({ base: it.base, h: it.h, items: [it] });
  }
  // merged intervals per row (small gaps between words are bridged)
  const spans = rows.map(r => {
    const iv = r.items.map(it => [it.x0, it.x1]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [a, b] of iv) { const last = out[out.length - 1]; if (last && a - last[1] < Math.max(2, 0.3 * r.h)) last[1] = Math.max(last[1], b); else out.push([a, b]); }
    return { s: out, h: r.h };
  }).filter(x => x.s.length);
  if (spans.length < 8) return null;
  const lo = Math.floor(width * 0.3), hi = Math.ceil(width * 0.7);
  // Rows of prose (one line, or two column lines with the gutter between them) have at most one wide gap. Rows of a
  // table, of figure tick labels or of side-by-side cells have several, and their gaps line up row after row: in a
  // full-width table they can outvote the real gutter, so they count for little (`strong` counts prose rows only).
  const split = new Float32Array(hi + 2), cross = new Float32Array(hi + 2), strong = new Uint16Array(hi + 2);
  for (const { s, h } of spans) {
    let wide = 0;
    for (let i = 1; i < s.length; i++) if (s[i][0] - s[i - 1][1] >= Math.max(6, 0.8 * h)) wide++;
    const prose = wide <= 1, w = prose ? 1 : 0.2;
    const minX = s[0][0], maxX = s[s.length - 1][1];
    for (let x = lo; x <= hi; x++) {
      if (s.some(([a, b]) => a < x && b > x)) cross[x] += w;
      else if (minX < x - 20 && maxX > x + 20) { split[x] += w; if (prose) strong[x]++; }
    }
  }
  let maxSplit = 0;
  for (let x = lo; x <= hi; x++) maxSplit = Math.max(maxSplit, split[x]);
  if (maxSplit < 6) return null;
  // the widest run of x with strong two-sided evidence and few crossing rows
  let best = null, start = -1;
  const good = x => x <= hi && strong[x] >= 4 && split[x] >= Math.max(6, maxSplit * 0.6) && cross[x] <= (split[x] >= 10 ? split[x] * 1.2 : split[x] * 0.4);
  for (let x = lo; x <= hi + 1; x++) {
    if (good(x) && start < 0) start = x;
    if (!good(x) && start >= 0) { const score = x - start; if (!best || score > best.len) best = { start, len: score }; start = -1; }
  }
  if (!best || best.len < 3) return null;
  // centre on the cleanest part of the run (a few rows may poke into its edge, e.g. reference labels)
  let minCross = Infinity;
  for (let x = best.start; x < best.start + best.len; x++) minCross = Math.min(minCross, cross[x]);
  const clean = [];
  for (let x = best.start; x < best.start + best.len; x++) if (cross[x] <= minCross + 0.5) clean.push(x);
  return clean.length >= 3 ? (clean[0] + clean[clean.length - 1]) / 2 : best.start + best.len / 2;
}
function segmentsOf(items, gutter = null) {
  const sorted = [...items].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows = [];
  for (const it of sorted) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.base - it.base) <= Math.max(1.2, 0.35 * Math.min(r.h, it.h))) { r.items.push(it); r.h = Math.max(r.h, it.h); }
    else rows.push({ base: it.base, h: it.h, items: [it] });
  }
  // superscripts/subscripts sit on their own tiny rows: attach them to the nearest row
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.items.every(it => it.h < 0.8 * Math.max(...rows.map(x => x.h)))) {
      const near = rows.filter(x => x !== r && Math.abs(x.base - r.base) < x.h * 1.05 && x.items.some(it => it.h > r.h * 1.15) && x.items.some(it => it.x0 < Math.max(...r.items.map(q => q.x1)) + 20 && it.x1 > Math.min(...r.items.map(q => q.x0)) - 20)).sort((a, b) => Math.abs(a.base - r.base) - Math.abs(b.base - r.base))[0];
      if (near) { near.items.push(...r.items); rows.splice(i, 1); }
    }
  }
  const segs = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const it of r.items) {
      const gap = cur ? it.x0 - cur.x1 : 0;
      const crosses = gutter != null && cur && cur.x1 <= gutter + 1 && it.x0 >= gutter - 1 && gap > 2;
      if (cur && (crosses || gap > Math.max(2.2 * r.h, 14))) { segs.push(cur); cur = null; }
      if (!cur) cur = { items: [it], x0: it.x0, x1: it.x1, top: it.top, bottom: it.bottom, base: r.base, h: it.h, text: it.s };
      else {
        const needSpace = gap > 0.15 * Math.min(it.h, cur.h) && !/\s$/.test(cur.text) && !/^\s/.test(it.s);
        cur.text += (needSpace ? ' ' : '') + it.s;
        cur.items.push(it); cur.x1 = Math.max(cur.x1, it.x1); cur.top = Math.min(cur.top, it.top); cur.bottom = Math.max(cur.bottom, it.bottom);
      }
    }
    if (cur) segs.push(cur);
  }
  for (const s of segs) {
    s.text = fixAccents(s.text.replace(/\s+/g, ' ').trim());
    const main = s.items.filter(it => it.h >= 0.85 * Math.max(...s.items.map(x => x.h)));
    const chars = n => n.reduce((k, it) => k + it.s.length, 0);
    s.size = pct(main.map(it => it.h), 0.5);
    s.bold = chars(main.filter(it => it.bold)) > 0.6 * chars(main);
    s.italic = chars(main.filter(it => it.italic)) > 0.6 * chars(main);
    s.math = chars(s.items.filter(it => it.math)) / Math.max(1, chars(s.items));
    s.firstBold = !!(s.items[0] && s.items[0].bold);
  }
  return segs.filter(s => s.text);
}
function findGutter(segs, width) {
  const narrow = segs.filter(s => s.x1 - s.x0 < width * 0.46 && s.text.length > 8);
  if (narrow.length < 12) return null;
  const W = Math.ceil(width);
  const cover = new Uint16Array(W + 2);
  for (const s of narrow) for (let x = Math.max(0, Math.floor(s.x0)); x < Math.min(W, Math.ceil(s.x1)); x++) cover[x]++;
  const lo = Math.floor(width * 0.3), hi = Math.ceil(width * 0.7), allow = Math.max(1, Math.round(narrow.length * 0.03));
  let best = null, start = -1;
  for (let x = lo; x <= hi + 1; x++) {
    const empty = x <= hi && cover[x] <= allow;
    if (empty && start < 0) start = x;
    if (!empty && start >= 0) { if (!best || x - start > best.len) best = { start, len: x - start }; start = -1; }
  }
  if (!best || best.len < 4) return null;
  const g = best.start + best.len / 2;
  const left = narrow.filter(s => s.x1 <= g).length, right = narrow.filter(s => s.x0 >= g).length;
  return left > narrow.length * 0.2 && right > narrow.length * 0.2 ? g : null;
}

// ── figures: connected regions of graphics ─────────────────
function graphicRegions(g, W, H) {
  const els = [];
  for (const b of g.images) if (area(b) > 40 && area(b) < W * H * 0.9) els.push({ box: b, img: true });
  for (const s of g.shapes) if (!s.rule && area(s.box) < W * H * 0.6 && (s.box.x1 - s.box.x0 > 0.3 || s.box.y1 - s.box.y0 > 0.3)) els.push({ box: s.box, shape: s });
  for (const s of g.shapes) if (s.rule) els.push({ box: s.box, shape: s, rule: true });
  if (!els.length) return [];
  const C = 4, GW = Math.ceil(W / C) + 2, GH = Math.ceil(H / C) + 2;
  const grid = new Int32Array(GW * GH).fill(-1);
  const occ = new Uint8Array(GW * GH);
  for (const e of els) {
    if (e.rule) continue;
    const x0 = Math.max(0, Math.floor(e.box.x0 / C) - 1), x1 = Math.min(GW - 1, Math.floor(e.box.x1 / C) + 1), y0 = Math.max(0, Math.floor(e.box.y0 / C) - 1), y1 = Math.min(GH - 1, Math.floor(e.box.y1 / C) + 1);
    if ((x1 - x0) * (y1 - y0) > 40000) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) occ[y * GW + x] = 1;
  }
  let comp = 0;
  const boxes = [];
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i] || grid[i] >= 0) continue;
    const q = [i]; grid[i] = comp;
    let b = null;
    while (q.length) {
      const c = q.pop(); const cx = c % GW, cy = (c - cx) / GW;
      b = union(b, { x0: cx * C, y0: cy * C, x1: cx * C + C, y1: cy * C + C });
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue; const n = ny * GW + nx; if (occ[n] && grid[n] < 0) { grid[n] = comp; q.push(n); } }
    }
    boxes.push({ box: b, imgs: 0, shapes: [], n: 0 });
    comp++;
  }
  for (const e of els) {
    if (e.rule) continue;
    const [cx, cy] = center(e.box);
    const k = grid[Math.min(GH - 1, Math.max(0, Math.floor(cy / C))) * GW + Math.min(GW - 1, Math.max(0, Math.floor(cx / C)))];
    if (k < 0 || !boxes[k]) continue;
    if (e.img) boxes[k].imgs++; else { boxes[k].shapes.push(e.shape); boxes[k].n++; }
  }
  let regs = boxes.filter(r => (r.imgs > 0 && area(r.box) > 900) || (r.n >= 5 && area(r.box) >= 2200 && (r.box.x1 - r.box.x0) > 30 && (r.box.y1 - r.box.y0) > 25));
  // merge neighbours (subfigures, legends)
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < regs.length && !merged; i++) for (let j = i + 1; j < regs.length && !merged; j++) {
      const a = regs[i].box, b = regs[j].box;
      const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1), gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
      if ((gapX < 22 && gapY < -5) || (gapY < 16 && gapX < -5) || (gapX < 8 && gapY < 8)) { regs[i] = { box: union(a, b), imgs: regs[i].imgs + regs[j].imgs, shapes: regs[i].shapes.concat(regs[j].shapes), n: regs[i].n + regs[j].n }; regs.splice(j, 1); merged = true; }
    }
  }
  // attach the rules (axes, grid lines) and shapes inside each region
  for (const r of regs) for (const s of g.shapes) if (s.rule && inside(s.box, r.box, 3) && !r.shapes.includes(s)) r.shapes.push(s);
  return regs;
}

// ── tables ─────────────────────────────────────────────────
function gridFromItems(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.base - b.base || a.x0 - b.x0)) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.base - it.base) <= Math.max(1.5, 0.45 * it.h)) r.items.push(it); else rows.push({ base: it.base, items: [it] });
  }
  const rowCells = rows.map(r => {
    r.items.sort((a, b) => a.x0 - b.x0);
    const cells = [];
    for (const it of r.items) {
      const c = cells[cells.length - 1];
      if (c && it.x0 - c.x1 <= Math.max(2.2, 0.5 * it.h)) { c.s += (it.x0 - c.x1 > 0.12 * it.h && !/\s$/.test(c.s) ? ' ' : '') + it.s; c.x1 = it.x1; }
      else cells.push({ s: it.s, x0: it.x0, x1: it.x1 });
    }
    return cells.map(c => ({ ...c, s: fixAccents(c.s.replace(/\s+/g, ' ').trim()) })).filter(c => c.s);
  }).filter(r => r.length);
  if (!rowCells.length) return { grid: [], rows: [] };
  // column boundaries from the gaps in the coverage of the row(s) with the most cells
  const all = rowCells.flat();
  const minX = Math.min(...all.map(c => c.x0)), maxX = Math.max(...all.map(c => c.x1));
  const W = Math.ceil(maxX - minX) + 2;
  const cover = new Uint16Array(W);
  const maxCells = Math.max(...rowCells.map(r => r.length));
  const dense = rowCells.filter(r => r.length >= Math.max(2, maxCells - 1));
  for (const r of dense) for (const c of r) for (let x = Math.floor(c.x0 - minX); x < Math.ceil(c.x1 - minX); x++) cover[x]++;
  const seps = [];
  let st = -1;
  for (let x = 0; x < W; x++) { if (!cover[x] && st < 0) st = x; if (cover[x] && st >= 0) { if (x - st >= 2) seps.push(minX + (st + x) / 2); st = -1; } }
  const colOf = cx => { let k = 0; while (k < seps.length && cx > seps[k]) k++; return k; };
  const ncol = seps.length + 1;
  const grid = rowCells.map(r => { const row = Array(ncol).fill(''); for (const c of r) { const k = colOf((c.x0 + c.x1) / 2); row[k] = row[k] ? `${row[k]} ${c.s}` : c.s; } return row; });
  return { grid, rows: rowCells.map(r => r.map(c => c.s)) };
}

// ── page model ─────────────────────────────────────────────
async function readPage(lib, page, n, renderScale) {
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const ops = await page.getOperatorList();
  const g = scanGraphics(ops, vp.transform, lib.OPS);
  const tc = await page.getTextContent();
  const items = [], rotated = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = lib.Util.transform(vp.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || it.height || 8;
    let name = '';
    try { const f = page.commonObjs.get(it.fontName); name = (f && (f.name || f.loadedName)) || ''; } catch { name = ''; }
    const rot = Math.abs(tx[1]) > 0.05 * Math.abs(tx[0]) + 0.01 || tx[0] < 0;
    if (rot) {
      const len = it.width;
      rotated.push({ s: it.str, rot: true, x0: tx[4] - h, x1: tx[4] + 0.2 * h, top: tx[5] - len, bottom: tx[5], base: tx[5], h });
      continue;
    }
    items.push({ s: it.str, x0: tx[4], x1: tx[4] + it.width, top: tx[5] - h * 0.8, bottom: tx[5] + h * 0.22, base: tx[5], h, bold: BOLD.test(name), italic: ITAL.test(name), math: MATHFONT.test(name) && !/CMR/.test(name) });
  }
  // render the page
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * renderScale); canvas.height = Math.round(H * renderScale);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: renderScale }), annotationMode: 0, intent: 'print' }).promise; // print intent: no requestAnimationFrame, so it also runs in background tabs
  return { n, W, H, items, rotated, g, canvas };
}
const toBlob = (canvas, type = 'image/webp', q = 0.84) => new Promise(res => canvas.toBlob(b => res(b), type, q));
async function cropBlob(canvas, scale, box, pad = 6) {
  const x0 = Math.max(0, Math.floor((box.x0 - pad) * scale)), y0 = Math.max(0, Math.floor((box.y0 - pad) * scale));
  const x1 = Math.min(canvas.width, Math.ceil((box.x1 + pad) * scale)), y1 = Math.min(canvas.height, Math.ceil((box.y1 + pad) * scale));
  const c = document.createElement('canvas'); c.width = Math.max(1, x1 - x0); c.height = Math.max(1, y1 - y0);
  c.getContext('2d').drawImage(canvas, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return { blob: await toBlob(c, 'image/png'), canvas: c };
}

function captionOf(seg) {
  const t = seg.text;
  let m = t.match(CAP_FIG);
  if (m) return { kind: 'figure', num: /^[IVX]+$/.test(m[2]) ? String(roman(m[2])) : m[2], label: `${/^fig/i.test(m[1]) && m[1].length <= 4 ? 'Fig.' : 'Figure'} ${m[2]}`, raw: m[2] };
  m = t.match(CAP_TAB);
  if (m) return { kind: 'table', num: m[2], label: `Table ${m[2]}`, raw: m[2] };
  m = t.match(CAP_LOOSE);
  if (m && seg.firstBold) return /^fig/i.test(m[1]) ? { kind: 'figure', num: m[2], label: `Fig. ${m[2]}`, raw: m[2] } : { kind: 'table', num: m[2], label: `Table ${m[2]}`, raw: m[2] };
  return null;
}

/** Analyse one page: figures, tables, then text segments in reading order. */
async function analysePage(pg, scale, ids) {
  const { W, H, g } = pg;
  const gutter = gutterOfItems(pg.items, W);
  let segs = segmentsOf(pg.items, gutter);
  for (const s of segs) s.cap = captionOf(s);
  const caps = segs.filter(s => s.cap);
  const figures = [], tables = [];
  const taken = new Set();
  const textBoxes = segs.map(s => ({ x0: s.x0, y0: s.top, x1: s.x1, y1: s.bottom }));
  // figures
  const regs = graphicRegions(g, W, H).filter(r => {
    // a region that is mostly covered by prose lines is a coloured box behind text, not a figure
    const prose = segs.filter(s => !s.cap && s.text.length > 50 && inside({ x0: s.x0, y0: s.top, x1: s.x1, y1: s.bottom }, r.box, 2));
    return r.imgs > 0 || prose.length < 3;
  });
  const capUsed = new Set();
  const assign = [];
  for (const r of regs) {
    const R = r.box;
    let best = null, bd = 1e9;
    for (const c of caps) {
      if (c.cap.kind !== 'figure') continue;
      const ov = overlapX({ x0: c.x0, x1: c.x1 }, R);
      if (ov < -10) continue;
      const below = c.top - R.y1, above = R.y0 - c.bottom;
      const d = below >= -6 && below < 90 ? below : above >= -6 && above < 50 ? above + 30 : 1e9;
      if (d < bd) { bd = d; best = c; }
    }
    assign.push({ r, cap: best });
  }
  const byCap = new Map();
  for (const a of assign) { const k = a.cap || a.r; if (!byCap.has(k)) byCap.set(k, []); byCap.get(k).push(a.r); }
  for (const [k, rs] of byCap) {
    const cap = k && k.cap ? k : null;
    let R = rs.reduce((b, r) => union(b, r.box), null);
    if (!cap && area(R) < 6000) continue;
    const shapes = rs.flatMap(r => r.shapes);
    const imgs = rs.reduce((n, r) => n + r.imgs, 0);
    // text that belongs to the figure: short lines inside or right next to the graphics
    const colW = W / 2;
    const texts = [];
    let full = { ...R };
    segs.forEach((s, i) => {
      if (s.cap || taken.has(i)) return;
      const sb = { x0: s.x0, y0: s.top, x1: s.x1, y1: s.bottom };
      const near = inside(sb, { x0: R.x0 - 48, y0: R.y0 - 14, x1: R.x1 + 18, y1: R.y1 + 34 }, 0);
      const within = inside(sb, R, 2);
      if (within || (near && (s.x1 - s.x0) < colW * 0.7 && s.text.length < 90)) { taken.add(i); texts.push(...s.items.map(it => ({ s: it.s, x0: it.x0, x1: it.x1, top: it.top, bottom: it.bottom, h: it.h, base: it.base }))); full = union(full, sb); }
    });
    for (const t of pg.rotated) if (inside({ x0: t.x0, y0: t.top, x1: t.x1, y1: t.bottom }, { x0: R.x0 - 50, y0: R.y0 - 10, x1: R.x1 + 30, y1: R.y1 + 10 })) { texts.push(t); full = union(full, { x0: t.x0, y0: t.top, x1: t.x1, y1: t.bottom }); }
    if (cap) capUsed.add(cap);
    const id = `f${ids.fig++}`;
    const kind = imgs ? (texts.length >= 3 ? 'mixed' : 'raster') : 'vector';
    let data = null;
    if (kind !== 'raster') { try { data = digitize({ texts, shapes }); } catch (e) { console.warn('digitize', e); } }
    const crop = await cropBlob(pg.canvas, scale, full, 8);
    figures.push({ id, page: pg.n, box: { p: pg.n, ...full }, cap, kind, data, text: texts.filter(t => t.s.trim()).sort((a, b) => a.top - b.top || a.x0 - b.x0).map(t => t.s.trim()), blob: crop.blob, ocrCanvas: imgs ? crop.canvas : null });
  }
  // tables
  const hr = g.rules.filter(r => !figures.some(f => inside({ x0: r.x0, y0: r.y - 1, x1: r.x1, y1: r.y + 1 }, { x0: f.box.x0, y0: f.box.y0, x1: f.box.x1, y1: f.box.y1 }, 2))).sort((a, b) => a.y - b.y);
  for (const c of caps) {
    if (c.cap.kind !== 'table') continue;
    const capIdx = segs.indexOf(c);
    const capBottom = Math.max(...segs.filter((s, i) => i >= capIdx && i < capIdx + 4 && s.top - c.bottom < 14 && overlapX(s, c) > 0 && (i === capIdx || !s.cap)).map(s => s.bottom));
    let region = null;
    const near = hr.filter(r => overlapX(r, { x0: c.x0 - 40, x1: c.x1 + 40 }) > 0);
    // the first rule under the caption (the caption may wrap; the table header comes after the rule)
    const isProse = s => s.text.length > 90 && (s.text.match(/[a-z]/g) || []).length > s.text.length * 0.3;
    const top = near.find(r => r.y > c.bottom - 1 && r.y - c.bottom < 120 && !segs.some(s => !s.cap && s.top > c.bottom && s.bottom < r.y && overlapX(s, r) > 0 && isProse(s))) || near.find(r => r.y > capBottom - 3 && r.y - capBottom < 45);
    if (top) {
      const same = near.filter(r => r.y >= top.y && Math.abs(r.x0 - top.x0) < 6 && Math.abs(r.x1 - top.x1) < 6 && r.y - top.y < 560);
      let bottom = top;
      for (const r of same) {
        const between = segs.filter(s => s.top > bottom.y && s.bottom < r.y && s.x0 >= top.x0 - 6 && s.x1 <= top.x1 + 6);
        if (between.some(s => s.cap || (s.text.length > 90 && (s.x1 - s.x0) > 0.85 * (top.x1 - top.x0)))) break;
        bottom = r;
      }
      if (bottom.y - top.y > 8) region = { x0: top.x0 - 2, y0: top.y - 1, x1: top.x1 + 2, y1: bottom.y + 1 };
    } else {
      const bottomAbove = near.filter(r => r.y < c.top + 3 && c.top - r.y < 40).pop();
      if (bottomAbove) {
        const same = near.filter(r => r.y <= bottomAbove.y && Math.abs(r.x0 - bottomAbove.x0) < 6 && Math.abs(r.x1 - bottomAbove.x1) < 6 && bottomAbove.y - r.y < 560).reverse();
        let topR = bottomAbove;
        for (const r of same) { const between = segs.filter(s => s.top > r.y && s.bottom < topR.y && s.x0 >= r.x0 - 6 && s.x1 <= r.x1 + 6); if (between.some(s => s.cap || (s.text.length > 90 && (s.x1 - s.x0) > 0.85 * (r.x1 - r.x0)))) break; topR = r; }
        if (bottomAbove.y - topR.y > 8) region = { x0: topR.x0 - 2, y0: topR.y - 1, x1: topR.x1 + 2, y1: bottomAbove.y + 1 };
      }
    }
    if (!region) {
      // no rules: rows right after the caption that look tabular
      let y = capBottom, rr = null;
      const after = segs.map((s, i) => ({ s, i })).filter(({ s }) => s.top >= capBottom - 1 && overlapX(s, { x0: c.x0 - 120, x1: c.x1 + 120 }) > 0).sort((a, b) => a.s.top - b.s.top);
      const rowsBy = [];
      for (const a of after) { const r = rowsBy[rowsBy.length - 1]; if (r && Math.abs(r.base - a.s.base) < 2) r.list.push(a.s); else rowsBy.push({ base: a.s.base, list: [a.s] }); }
      for (const r of rowsBy) {
        if (r.list[0].top - y > 26) break;
        const numeric = r.list.map(s => s.text).join(' ').split(/\s+/).filter(w => /^[−\-+±]?\d/.test(w)).length;
        const tab = r.list.length >= 2 || numeric >= 2;
        if (!tab || r.list.some(s => s.cap)) break;
        rr = r.list.reduce((b, s) => union(b, { x0: s.x0, y0: s.top, x1: s.x1, y1: s.bottom }), rr);
        y = Math.max(...r.list.map(s => s.bottom));
      }
      if (rr) region = rr;
    }
    if (!region) { tables.push({ id: `t${ids.tab++}`, page: pg.n, cap: c, box: null, grid: [], rows: [] }); continue; }
    const its = [];
    segs.forEach((s, i) => { if (!s.cap && inside({ x0: s.x0, y0: s.top, x1: s.x1, y1: s.bottom }, region, 3)) { taken.add(i); its.push(...s.items); } });
    const { grid, rows } = gridFromItems(its);
    tables.push({ id: `t${ids.tab++}`, page: pg.n, cap: c, box: { p: pg.n, ...region }, grid, rows });
  }
  segs = segs.filter((_, i) => !taken.has(i));
  for (const f of figures) if (f.cap) f.capSeg = f.cap;
  return { segs, figures, tables, textBoxes, gutter };
}

function orderSegments(segs, W, itemGutter = null, pageNo = 1) {
  const g = itemGutter != null ? itemGutter : findGutter(segs, W);
  const byY = (a, b) => a.base - b.base || a.x0 - b.x0;
  if (g === null) {
    const out = [];
    for (const s of [...segs].sort(byY)) {
      const r = out[out.length - 1];
      if (r && Math.abs(r.base - s.base) <= Math.max(1.5, 0.35 * s.h)) { r.text += ' ' + s.text; r.x1 = Math.max(r.x1, s.x1); r.items.push(...s.items); r.parts++; }
      else out.push({ ...s, col: 1, parts: 1 });
    }
    return { lines: out, gutter: null };
  }
  const L = [], R = [], F = [];
  for (const s of segs) (s.x1 <= g + 2 ? L : s.x0 >= g - 2 ? R : F).push(s);
  const merge = (list, col) => {
    const out = [];
    for (const s of list.sort(byY)) {
      const r = out[out.length - 1];
      if (r && Math.abs(r.base - s.base) <= Math.max(1.5, 0.35 * s.h)) { r.text += ' ' + s.text; r.x1 = Math.max(r.x1, s.x1); r.items.push(...s.items); r.parts++; }
      else out.push({ ...s, col, parts: 1 });
    }
    return out;
  };
  let left = merge(L, 1), right = merge(R, 2), full = merge(F, 0);
  // header band: everything above the first prose line of the columns (title, author grids, affiliations) is read
  // row by row before the columns, even where it happens to sit on one side of the gutter
  const firstProse = (list, lo, hi) => { const w = hi - lo; const s = list.filter(x => x.x1 - x.x0 >= 0.85 * w && x.text.length > 40).sort((a, b) => a.top - b.top)[0]; return s ? s.top : Infinity; };
  const minL = left.length ? Math.min(...left.map(s => s.x0)) : 0, maxR = right.length ? Math.max(...right.map(s => s.x1)) : W;
  const bandBottom = Math.min(firstProse(left, minL, g), firstProse(right, g, maxR));
  let band = [];
  if (pageNo === 1 && Number.isFinite(bandBottom)) {
    const inBand = s => s.bottom <= bandBottom + 1;
    band = [...left, ...right, ...full].filter(inBand).sort(byY).map(s => ({ ...s, col: 0 }));
    left = left.filter(s => !inBand(s)); right = right.filter(s => !inBand(s)); full = full.filter(s => !inBand(s));
  }
  const cols = [...left, ...right];
  const colTop = cols.length ? Math.min(...cols.map(s => s.top)) : 0, colBottom = cols.length ? Math.max(...cols.map(s => s.bottom)) : 0;
  return { gutter: g, lines: [...band, ...full.filter(s => s.bottom <= colTop + 2), ...left, ...full.filter(s => s.top > colTop + 2 && s.bottom < colBottom - 2 && s.x1 < g + 30).map(s => ({ ...s, col: 1 })), ...right, ...full.filter(s => s.top > colTop + 2 && s.bottom < colBottom - 2 && s.x1 >= g + 30).map(s => ({ ...s, col: 2 })), ...full.filter(s => s.top >= colBottom - 2)] };
}

// ── main ───────────────────────────────────────────────────
export async function readPdf(file, onProgress = () => {}) {
  const lib = await pdfjs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false, stopAtErrors: false }).promise;
  let metaTitle = '';
  try { const md = await doc.getMetadata(); metaTitle = (md.info && md.info.Title) || ''; } catch { /* none */ }
  const N = doc.numPages;
  if (N > 400) throw new Error('This PDF has more than 400 pages.');
  const pages = [], allLines = [], figures = [], tables = [], pageImages = [];
  const ids = { fig: 1, tab: 1 };
  for (let n = 1; n <= N; n++) {
    onProgress(0.03 + (n - 1) / N * 0.8, `Reading page ${n} of ${N}…`);
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.6, 1500 / vp1.width);
    const pg = await readPage(lib, page, n, scale);
    const a = await analysePage(pg, scale, ids);
    const { lines, gutter } = orderSegments(a.segs, pg.W, a.gutter, n);
    for (const l of lines) { l.page = n; l.pageH = pg.H; l.pageW = pg.W; l.gutter = gutter; }
    allLines.push(...lines);
    figures.push(...a.figures); tables.push(...a.tables);
    pages.push({ w: pg.W, h: pg.H, items: pg.items.length });
    pageImages.push({ n, blob: await toBlob(pg.canvas, 'image/webp', 0.86) });
    pg.canvas.width = pg.canvas.height = 1;
    page.cleanup();
  }
  await doc.destroy();
  const textItems = pages.reduce((n, p) => n + p.items, 0);
  if (textItems < 50) throw Object.assign(new Error('This PDF has almost no text layer (is it a scan?). Upload a PDF exported from Word/LaTeX, or the LaTeX source.'), { code: 'notext' });
  onProgress(0.86, 'Finding paragraphs, sections, figures and tables…');
  return build({ allLines, figures, tables, pages, pageImages, metaTitle, filename: file.name, size: file.size });
}

function build({ allLines, figures, tables, pages, pageImages, metaTitle, filename, size }) {
  // body font size and leading
  const sizes = new Map();
  for (const l of allLines) { const k = Math.round(l.size * 2) / 2; sizes.set(k, (sizes.get(k) || 0) + l.text.length); }
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const leadings = [];
  for (let i = 1; i < allLines.length; i++) { const a = allLines[i - 1], b = allLines[i]; if (a.page === b.page && a.col === b.col && Math.abs(a.size - body) < 0.6 && Math.abs(b.size - body) < 0.6) { const d = b.base - a.base; if (d > 0 && d < body * 2.2) leadings.push(d); } }
  const lead = pct(leadings, 0.5) || body * 1.2;
  // running heads/feet and page numbers
  const key = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const freq = new Map();
  const byPage = new Map();
  for (const l of allLines) { if (!byPage.has(l.page)) byPage.set(l.page, []); byPage.get(l.page).push(l); }
  for (const [, ls] of byPage) { const sorted = [...ls].sort((a, b) => a.top - b.top); for (const k of new Set([...sorted.slice(0, 2), ...sorted.slice(-2)].map(l => key(l.text)))) freq.set(k, (freq.get(k) || 0) + 1); }
  const minRep = Math.max(2, Math.ceil(byPage.size * 0.3));
  const furniture = l => {
    const t = l.text.trim();
    const edge = l.top < l.pageH * 0.08 || l.bottom > l.pageH * 0.93;
    if (edge && /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)) return true;
    if (edge && byPage.size >= 3 && freq.get(key(t)) >= minRep) return true;
    if (/^arXiv:\d{4}\.\d{4,5}/.test(t) && l.size < body) return true;
    return false;
  };
  // column bounds
  const colB = new Map();
  for (const l of allLines) { if (Math.abs(l.size - body) > 0.8) continue; const k = `${l.page}:${l.col}`; if (!colB.has(k)) colB.set(k, { x0: [], x1: [] }); colB.get(k).x0.push(l.x0); colB.get(k).x1.push(l.x1); }
  const colLeft = l => { const c = colB.get(`${l.page}:${l.col}`); return c ? pct(c.x0, 0.1) : l.x0; };
  const colRight = l => { const c = colB.get(`${l.page}:${l.col}`); return c ? pct(c.x1, 0.9) : l.x1; };
  const lines = allLines.filter(l => !furniture(l));

  const isHeading = (l, next, prev = null) => {
    const t = l.text.trim();
    if (l.cap || t.length > 110 || t.split(/\s+/).length > 15 || /[,;]$/.test(t) || !next) return false;
    if (/^(\d{1,3}:|Require:|Ensure:|Input:|Output:)\s?/.test(t)) return false; // algorithm lines
    // the last line of a paragraph (same column, normal gap, previous line unfinished) is not a heading
    if (!/^([IVXL]+\.|\d+(\.\d+)*\.?|[A-Z]\.)\s+[A-Z]/.test(t) && prev && prev.page === l.page && prev.col === l.col && l.base - prev.base > 0 && l.base - prev.base < lead * 1.35 && Math.abs(prev.size - l.size) < 0.6 && !/[.!?:]["”’)]?$/.test(prev.text.trim()) && prev.text.trim().length > 40) return false;
    if (HEADING.test(t) || SECTION_WORDS.test(t.replace(/^((?:\d+\.)*\d+\.?|[IVXL]+\.|[A-Z]\.)\s+/, ''))) return l.size >= body * 0.95 || l.bold || /^[A-Z\s]+$/.test(t);
    const numbered = /^((?:\d+\.)*\d+\.?|[IVXL]+\.|[A-Z]\.)\s+\S/.test(t);
    const big = l.size >= body * 1.12;
    const caps = /^([IVXL]+\.|\d+(\.\d+)*\.?)?\s*[A-Z][A-Z\s\-:&,]{3,}$/.test(t);
    const endsSentence = /[.!?]$/.test(t) && !/^((?:\d+\.)*\d+\.?|[IVXL]+\.)\s+\S+\.?$/.test(t);
    const shortLine = l.x1 - l.x0 < (colRight(l) - colLeft(l)) * 0.85;
    if (endsSentence) return false;
    if (big && t.length < 100 && !/[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(t)) return true;
    if (numbered && (l.bold || caps || l.italic || big) && shortLine) return true;
    if (l.bold && shortLine && t.length < 70 && !/[a-z]\s+(the|of|and|to|in|a)\s+[a-z]/.test(t.slice(30))) return t.split(/\s+/).length <= 9;
    if (caps && shortLine && t.length < 60) return true;
    return false;
  };
  const isEquation = l => {
    const t = l.text.trim();
    const L = colLeft(l), R = colRight(l);
    const centered = l.x0 > L + 1.8 * body && l.x1 < R - 0.5 * body && (l.x1 - l.x0) < (R - L) * 0.85;
    const eqNum = /\(\s*\d{1,3}[a-z]?\s*\)$/.test(t);
    const mathy = l.math > 0.25 || (t.match(/[=+−×∑∏∫√≤≥≈∈∀∂αβγδθλμσφψωΣΠ^_|‖]/g) || []).length / Math.max(1, t.length) > 0.06;
    if (eqNum && (centered || mathy || t.length < 70) && !/^(fig|table)/i.test(t)) return true;
    return centered && mathy && t.length < 140 && !/\.\s*$/.test(t) && !/^[•▪]/.test(t);
  };
  const bullet = /^([•▪◦‣●○■□➢►–]\s*|-\s|\(\d{1,2}\)\s+(?=[A-Z])|\d{1,2}\)\s+(?=[A-Z])|\([a-z]\)\s+(?=[A-Z])|[a-z]\)\s+(?=[A-Z]))/;
  const brk = (p, l) => {
    if (!p) return true;
    if (Math.abs(l.size - p.size) > 0.18 * body) return true;
    const sameCol = p.page === l.page && p.col === l.col;
    if (sameCol) { const gap = l.base - p.base; if (gap < -2 || gap > lead * 1.55) return true; }
    const indent = l.x0 - colLeft(l);
    if (indent > 0.55 * body && indent < 4.5 * body && !(sameCol && Math.abs(l.x0 - p.x0) < 1)) return true;
    const pShort = p.x1 < colRight(p) - 2.2 * body;
    if (pShort && /[.!?:]["”’)]?$/.test(p.text.trim())) return true;
    if (bullet.test(l.text) && !bullet.test(p.text)) return true;
    return false;
  };

  const sections = [], blocks = [], refLines = [];
  let sec = null, cur = null, prev = null, inRefs = false, front = true, abstract = false, bid = 1;
  const boxOf = ls => {
    const m = new Map();
    for (const l of ls) { const k = `${l.page}:${l.col}`; m.set(k, union(m.get(k), { x0: l.x0, y0: l.top, x1: l.x1, y1: l.bottom })); }
    return [...m.entries()].map(([k, b]) => ({ p: +k.split(':')[0], x0: +(b.x0 - 1).toFixed(1), y0: +(b.y0 - 1).toFixed(1), x1: +(b.x1 + 1).toFixed(1), y1: +(b.y1 + 1).toFixed(1) }));
  };
  const flush = () => {
    if (!cur) return;
    const ls = cur.lines;
    let text;
    if (cur.algo) text = ls.map(l => l.text.trim()).join('\n');
    else if (cur.kind === 'list') { const items = []; for (const l of ls) { if (bullet.test(l.text) || !items.length) items.push([l.text]); else items[items.length - 1].push(l.text); } text = items.map(joinLines).join('\n'); }
    else if (cur.kind === 'equation') text = ls.map(l => l.text.trim()).join(' ');
    else text = joinLines(ls.map(l => l.text));
    if (cur.block) { cur.block.text = text.trim(); cur.block.boxes = boxOf(ls); } // a paragraph resumed after a float
    else if (text.trim()) { cur.block = { id: `b${bid++}`, kind: cur.kind, sec: cur.sec, text: text.trim(), page: ls[0].page, boxes: boxOf(ls), cap: cur.cap || null }; blocks.push(cur.block); }
    if (cur.kind === 'para' || cur.kind === 'abstract') lastBody = cur;
    if (cur.kind === 'caption') lastCaption = cur;
    cur = null;
  };
  let lastBody = null, lastCaption = null;
  const start = (kind, l, extra = {}) => { flush(); cur = { kind, lines: [l], sec: sec && sec.id, ...extra }; };
  const titleLines = [];
  // title: biggest text near the top of page 1
  const p1 = lines.filter(l => l.page === 1 && l.top < l.pageH * 0.45);
  const maxSize = Math.max(0, ...p1.filter(l => l.text.length > 3).map(l => l.size));
  if (maxSize > body * 1.25) for (const l of p1) if (l.size >= maxSize - 0.6 && titleLines.length < 5) titleLines.push(l);
  const titleSet = new Set(titleLines);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1];
    const t = l.text.trim();
    if (titleSet.has(l)) { if (cur && cur.kind !== 'title') flush(); if (!cur) cur = { kind: 'title', lines: [], sec: null }; cur.lines.push(l); prev = l; continue; }
    if (inRefs) {
      if (isHeading(l, next) && END_HEADING.test(t) && refLines.length > 3) { inRefs = false; }
      else { refLines.push({ text: t, x: l.x0, y: l.base, page: l.page, col: l.col, line: l }); prev = l; continue; }
    }
    if (l.cap) { start('caption', l, { cap: l.cap }); prev = l; continue; }
    // algorithms: "Algorithm 1 …" followed by numbered lines → one block
    if (/^Algorithm\s+\d+\b/.test(t) && (l.bold || l.firstBold || /^Algorithm\s+\d+\s+[A-Z]/.test(t))) { start('list', l, { algo: true }); prev = l; continue; }
    if (cur && cur.algo && prev && l.page === prev.page && l.col === prev.col && l.base - prev.base > 0 && l.base - prev.base < lead * 2.2 && (/^(\d{1,3}:|Require:|Ensure:|Input:|Output:|return\b|end\b)/.test(t) || l.x0 > colLeft(l) + 0.5 * body || cur.lines.length < 3)) { cur.lines.push(l); prev = l; continue; }
    const abs = t.match(/^(Abstract|ABSTRACT|A B S T R A C T|Summary)\s*[—–:.\-]\s*(.*)$/);
    if (abs && (front || abstract || l.bold || l.italic || l.firstBold)) {
      flush(); front = false; abstract = true;
      sec = { id: `s${sections.length + 1}`, title: 'Abstract', level: 1, num: '' }; sections.push(sec);
      start('abstract', l); prev = l; continue;
    }
    if (isHeading(l, next, prev)) {
      flush();
      let title = t.replace(/\b([A-Z]) ([A-Z]{2,})\b/g, '$1$2');
      // a heading split over two lines
      if (next && isHeading(next, lines[i + 2]) && next.page === l.page && next.col === l.col && next.base - l.base < lead * 1.6 && Math.abs(next.size - l.size) < 0.4 && !/^((?:\d+\.)*\d+\.?|[IVXL]+\.|[A-Z]\.)\s/.test(next.text.trim())) { title += ' ' + next.text.trim(); i++; }
      const m = title.match(/^((?:\d+\.)*\d+|[IVXL]+|[A-Z])\.?\s+(.+)$/);
      const num = m && (m[1].length <= 6) ? m[1] : '';
      const name = m && num ? m[2] : title;
      const allCaps = /^[A-Z0-9\s\-:&,()]+$/.test(name);
      const level = /^\d+(\.\d+)+$/.test(num) ? num.split('.').length : /^[A-Z]$/.test(num) && !(/^[IVXL]$/.test(num) && allCaps) ? 2 : l.size >= body * 1.12 || /^[IVXL]+$|^\d+$/.test(num) || allCaps ? 1 : 2;
      front = false; abstract = /^abstract$/i.test(name);
      if (HEADING.test(title) || /^(references|bibliography)$/i.test(name)) { inRefs = true; sec = { id: `s${sections.length + 1}`, title: name.replace(/\s+/g, ' '), level: 1, num }; sections.push(sec); blocks.push({ id: `b${bid++}`, kind: 'heading', sec: sec.id, text: title, page: l.page, boxes: boxOf([l]) }); prev = l; continue; }
      sec = { id: `s${sections.length + 1}`, title: name.replace(/\s+/g, ' '), level, num };
      sections.push(sec);
      blocks.push({ id: `b${bid++}`, kind: 'heading', sec: sec.id, text: title, page: l.page, boxes: boxOf([l]) });
      prev = l; continue;
    }
    // small-caps caption lines of a full-width float that the column split moved away from their caption
    const capCand = cur && cur.kind === 'caption' && cur.lines[0].page === l.page ? cur : lastCaption && lastCaption.block && lastCaption.lines[0].page === l.page ? lastCaption : null;
    if (capCand && l.size < body * 0.95 && /[A-Z]{3,}/.test(t) && !/[a-z]{3,}/.test(t.replace(/\b(of|and|the|in|on|at|to|for|with|vs)\b/g, '')) && t.length > 12) { if (cur !== capCand) { flush(); cur = capCand; } cur.lines.push(l); prev = l; continue; }
    const smallRow = l.size < body * 0.86;
    const footLike = /^[\d*†‡§¶]{1,2}\s*[A-Za-z(]/.test(t) && (t.match(/[A-Za-z]{3,}/g) || []).length >= 5;
    // stray rows of symbols (sub/superscripts, delimiters of a display formula) stay with the block they belong to
    const symbolRow = t.length <= 24 && (t.match(/[A-Za-z]{4,}/g) || []).length <= 1;
    if ((smallRow || symbolRow) && !footLike && cur && prev && l.page === prev.page && l.col === prev.col && Math.abs(l.base - prev.base) < lead * 1.6 && !/[a-z]{4,}\s+[a-z]{4,}/i.test(t) && !/^(\d{1,3}:|Require:|Ensure:)/.test(t)) { cur.lines.push(l); prev = l; continue; }
    if (isEquation(l)) {
      if (cur && cur.kind === 'equation' && prev && prev.page === l.page && prev.col === l.col && l.base - prev.base < lead * 2.4) cur.lines.push(l);
      else start('equation', l);
      prev = l; continue;
    }
    const small = l.size < body * 0.86;
    const kindNow = front ? 'front' : abstract ? 'abstract' : small && l.top > l.pageH * 0.7 && footLike ? 'footnote' : bullet.test(t) ? 'list' : 'para';
    // IEEE: "TABLE II" on its own line, the caption text (small caps) on the next one
    const labelOnly = cur && cur.kind === 'caption' && cur.lines.length === 1 && /^(TABLE|Table|Fig\.?|Figure)\s+[\dIVX]+[.:]?$/.test(cur.lines[0].text.trim());
    if (labelOnly && prev && l.page === prev.page && l.base - prev.base > 0 && l.base - prev.base < lead * 2.2) { cur.lines.push(l); prev = l; continue; }
    if (cur && cur.kind === 'caption' && prev && l.page === prev.page && l.base - prev.base > 0 && l.base - prev.base < lead * 1.5 && Math.abs(l.size - prev.size) < 1 && (/^[^a-z]*$/.test(t) || !brk(prev, l) || Math.abs((l.x0 + l.x1) / 2 - (prev.x0 + prev.x1) / 2) < 12)) { cur.lines.push(l); prev = l; continue; }
    if (cur && cur.kind === 'caption' && !brk(prev, l)) { cur.lines.push(l); prev = l; continue; }
    if (cur && cur.kind === 'list' && !cur.algo && prev && l.page === prev.page && l.col === prev.col && l.base - prev.base > 0 && l.base - prev.base < lead * 1.5 && l.x0 > colLeft(l) + 0.5 * body && !bullet.test(t)) { cur.lines.push(l); prev = l; continue; }
    if (cur && cur.kind === 'list' && (kindNow === 'list' || !brk(prev, l))) { cur.lines.push(l); prev = l; continue; }
    // a paragraph interrupted by floats (figures/tables/captions at a page or column top) resumes here
    const interrupted = lastBody && (!cur || cur.kind === 'caption') && lastBody.kind === kindNow && lastBody.sec === (sec && sec.id) && !/[.!?:]["”’)]?$/.test(lastBody.lines[lastBody.lines.length - 1].text.trim()) && /^[a-z(]/.test(t) && lastBody.block && blocks[blocks.length - 1] !== lastBody.block;
    if (interrupted) { flush(); cur = lastBody; cur.lines.push(l); prev = l; continue; }
    if (!cur || cur.kind === 'equation' || cur.kind === 'caption' || cur.kind === 'title' || brk(prev, l) || (cur.kind !== kindNow && !(cur.kind === 'para' && kindNow === 'list' && !bullet.test(t)))) {
      start(kindNow, l);
    } else cur.lines.push(l);
    prev = l;
  }
  flush();
  // references
  const refs = [];
  if (refLines.length) {
    const sp = splitLines(refLines);
    let k = 0;
    const refSec = sections.find(s => /^(references|bibliography)$/i.test(s.title)) || null;
    for (const raw of sp.refs) {
      // map back to lines for boxes
      const used = []; let acc = '';
      while (k < refLines.length && acc.replace(/\s/g, '').length < raw.replace(/\s/g, '').length - 2) { used.push(refLines[k].line); acc += refLines[k].text; k++; }
      refs.push({ raw });
      blocks.push({ id: `b${bid++}`, kind: 'ref', sec: refSec && refSec.id, text: raw, page: used[0] ? used[0].page : null, boxes: used.length ? boxOf(used) : [], ref: String(refs.length) });
    }
    refs.style = sp.style;
  }
  // figures and tables: labels, captions
  const capBlocks = blocks.filter(b => b.kind === 'caption');
  const capFor = cap => capBlocks.find(b => b.cap && cap && b.cap.label === cap.label && Math.abs(b.page - (cap.page || b.page)) <= 1);
  const outFigs = figures.map(f => {
    const cb = f.cap ? capBlocks.find(b => b.cap && b.cap.kind === 'figure' && b.cap.num === f.cap.cap.num && b.page === f.page) || capFor(f.cap.cap) : null;
    return { id: f.id, label: f.cap ? f.cap.cap.label : `Figure (p. ${f.page})`, num: f.cap ? f.cap.cap.num : '', caption: cb ? cb.text : '', bid: cb ? cb.id : null, page: f.page, box: f.box, kind: f.kind, data: f.data, text: f.text.slice(0, 300), blob: f.blob, ocrCanvas: f.ocrCanvas };
  });
  const outTabs = tables.map(t => {
    const cb = capBlocks.find(b => b.cap && b.cap.kind === 'table' && b.cap.num === t.cap.cap.num && b.page === t.page) || capFor(t.cap.cap);
    return { id: t.id, label: t.cap.cap.label, num: t.cap.cap.num, caption: cb ? cb.text : t.cap.text, bid: cb ? cb.id : null, page: t.page, box: t.box, grid: t.grid, rows: t.rows, source: 'pdf' };
  });
  // caption-only figures (graphics not found): keep them so references to them resolve
  for (const b of capBlocks) if (b.cap.kind === 'figure' && !outFigs.some(f => f.bid === b.id)) outFigs.push({ id: `f${outFigs.length + 100}`, label: b.cap.label, num: b.cap.num, caption: b.text, bid: b.id, page: b.page, box: null, kind: 'none', data: null, text: [] });
  for (const b of blocks) delete b.cap;
  const title = (titleLines.length ? joinLines(titleLines.map(l => l.text)) : '') || (metaTitle && metaTitle.length > 8 && !/^(untitled|microsoft word|document)/i.test(metaTitle) ? metaTitle : '') || filename.replace(/\.pdf$/i, '');
  if (!blocks.some(b => b.kind === 'title') && title) blocks.unshift({ id: 'b0', kind: 'title', sec: null, text: title, page: 1, boxes: [] });
  const bodyText = blocks.filter(b => ['para', 'abstract', 'list'].includes(b.kind)).map(b => b.text).join('\n');
  const citations = refs.length ? analyzeCitations(bodyText, refs.map(r => r.raw), refs.style || 'numeric') : null;
  const notes = [];
  if (!refs.length) notes.push('No reference list was found, so references cannot be checked.');
  if (!outFigs.length) notes.push('No figures were detected.');
  return {
    title, sections, blocks, tables: outTabs, figures: outFigs, refs, citations,
    source: { kind: 'pdf', filename, pages: pages.map(p => ({ w: +p.w.toFixed(2), h: +p.h.toFixed(2) })), size, notes },
    assets: { pageImages }, stats: { body, lead },
  };
}
