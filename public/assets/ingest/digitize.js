/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * Figure digitizer for vector charts. The AI gateway cannot see images, so charts are turned into numbers here:
 * axis tick labels give a calibration (linear or log), filled rectangles become bars, polylines become line series,
 * small repeated shapes become scatter points, and legend swatches name the series.
 * Coordinates are page/viewport points with y growing downwards.
 *   digitize({ texts, shapes }) → { axes, series, confidence, note } | null
 */
const NUMRE = /^[−\-–+]?\d+(?:[.,]\d+)?(?:[eE][−\-+]?\d+)?\s*%?$/;
const parseNum = s => Number(String(s).replace(/[−–]/g, '-').replace(/%$/, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.').trim());

function fit(pairs) { // value = a*pos + b ; returns { a, b, r2 }
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-9) return null;
  const a = (n * sxy - sx * sy) / d, b = (sy - a * sx) / n;
  const my = sy / n;
  let ssr = 0, sst = 0;
  for (const [x, y] of pairs) { ssr += (y - (a * x + b)) ** 2; sst += (y - my) ** 2; }
  return { a, b, r2: sst ? 1 - ssr / sst : 0 };
}
function calibrate(labels, coord) { // labels: [{ v, pos }]
  const uniq = [];
  for (const l of labels.sort((p, q) => p.pos - q.pos)) if (!uniq.some(u => Math.abs(u.pos - l.pos) < 1)) uniq.push(l);
  if (uniq.length < 2) return null;
  const lin = fit(uniq.map(l => [l.pos, l.v]));
  if (lin && lin.r2 > 0.998) return { type: 'linear', map: pos => lin.a * pos + lin.b, inv: v => (v - lin.b) / lin.a, labels: uniq, r2: lin.r2, coord };
  if (uniq.every(l => l.v > 0)) {
    const lg = fit(uniq.map(l => [l.pos, Math.log10(l.v)]));
    if (lg && lg.r2 > 0.998) return { type: 'log', map: pos => 10 ** (lg.a * pos + lg.b), inv: v => (Math.log10(v) - lg.b) / lg.a, labels: uniq, r2: lg.r2, coord };
  }
  return null;
}
const hex = c => (typeof c === 'string' ? c.toLowerCase() : null);
function rgb(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const isWhite = c => { const r = rgb(c); return r && r[0] > 238 && r[1] > 238 && r[2] > 238; };
const isGray = c => { const r = rgb(c); return r && Math.max(...r) - Math.min(...r) < 12; };
const cdist = (a, b) => { const x = rgb(a), y = rgb(b); return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999; };
function round(v, step) {
  if (!Number.isFinite(v)) return null;
  const prec = step ? Math.max(0, Math.ceil(-Math.log10(Math.abs(step) / 50))) : 3;
  return +v.toFixed(Math.min(6, prec));
}

/** Glyph runs that belong to one label ("0", ".", "2" → "0.2"); superscripts become "^n". */
function mergeTexts(texts) {
  const hz = texts.filter(t => !t.rot && t.s && t.s.trim()).map(t => ({ ...t, h: t.h || (t.bottom - t.top) / 1.02, base: t.base != null ? t.base : t.bottom - 0.22 * ((t.bottom - t.top) / 1.02) }));
  hz.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const out = [];
  for (const t of hz) {
    const prev = out.find(o => t.x0 - o.x1 < Math.max(1.2, 0.28 * Math.min(o.h, t.h)) && t.x0 - o.x1 > -1 && (Math.abs(o.base - t.base) < 0.3 * Math.max(o.h, t.h) || (t.h < o.h * 0.85 && t.base < o.base && o.base - t.base < o.h * 0.75)));
    if (prev) {
      const sup = t.h < prev.h * 0.85 && t.base < prev.base - 0.15 * prev.h;
      const gap = t.x0 - prev.x1, space = !sup && gap > 0.15 * Math.min(prev.h, t.h) && /\D$/.test(prev.s.trim()) && /^\D/.test(t.s.trim());
      prev.s = prev.s.trim() + (sup ? '^' : space ? ' ' : '') + t.s.trim(); prev.x1 = Math.max(prev.x1, t.x1); prev.top = Math.min(prev.top, t.top);
    } else out.push({ ...t, s: t.s.trim() });
  }
  // superscripts that come before their base in reading order ("10" then a raised "4")
  for (let i = out.length - 1; i >= 0; i--) {
    const sup = out[i];
    const base = out.find(o => o !== sup && sup.h < o.h * 0.85 && sup.x0 >= o.x1 - 1 && sup.x0 - o.x1 < 3 && sup.base < o.base - 0.15 * o.h && o.base - sup.base < 0.85 * o.h);
    if (base) { base.s += '^' + sup.s; base.x1 = Math.max(base.x1, sup.x1); out.splice(i, 1); }
  }
  return [...out, ...texts.filter(t => t.rot)];
}

const isDark = c => { const r = rgb(c); return r && Math.max(...r) < 90; };
const boxOf = t => ({ x0: t.x0, y0: t.top, x1: t.x1, y1: t.bottom });
const area = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const contains = (a, b, tol = 1) => b.x0 >= a.x0 - tol && b.x1 <= a.x1 + tol && b.y0 >= a.y0 - tol && b.y1 <= a.y1 + tol;

/** Legend entries: a swatch (small filled box or short line) with a label just to its right. */
function findLegend(hz, shapes, skip) {
  const legend = [];
  for (const s of shapes) {
    const b = s.box, w = b.x1 - b.x0, h = b.y1 - b.y0;
    const swatch = (s.kind === 'rect' && s.fill && !isWhite(s.fill) && w <= 30 && h <= 12 && w >= 2 && h >= 2) || (s.stroke && !s.fill && s.pts && s.pts.length <= 3 && w <= 34 && w >= 6 && h <= 3);
    if (!swatch) continue;
    const cy = (b.y0 + b.y1) / 2;
    const lab = hz.filter(t => !skip.has(t) && t.x0 >= b.x1 - 1 && t.x0 - b.x1 <= 12 && Math.abs((t.top + t.bottom) / 2 - cy) <= Math.max(4, (t.bottom - t.top) * 0.6)).sort((p, q) => p.x0 - q.x0)[0];
    if (!lab) continue;
    let name = lab.s.trim();
    for (const t of hz.filter(t => t !== lab && Math.abs(t.top - lab.top) < 2 && t.x0 > lab.x1 && t.x0 - lab.x1 < 6).sort((p, q) => p.x0 - q.x0)) name += ' ' + t.s.trim();
    legend.push({ color: hex(s.fill || s.stroke), name, kind: s.fill ? 'bar' : 'line', shape: s, box: b });
  }
  return legend;
}

/**
 * Axes frames of a multi-panel figure: axes background rectangles, stroked frames (pgfplots) or dark left+bottom
 * spines meeting in a corner. The figure background (holding several frames) and boxes inside a frame (legends,
 * insets) are dropped; a frame needs numeric tick labels next to it.
 */
export function findFrames(hz, shapes) {
  let c = [];
  for (const s of shapes) {
    const b = s.box, w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (s.kind === 'rect' && w >= 40 && h >= 25 && (s.fill || s.stroke)) c.push({ ...b });
  }
  const vs = shapes.filter(s => s.rule === 'v' && s.stroke && isDark(s.stroke) && s.box.y1 - s.box.y0 >= 25);
  const hs = shapes.filter(s => s.rule === 'h' && s.stroke && isDark(s.stroke) && s.box.x1 - s.box.x0 >= 40);
  for (const v of vs) for (const h of hs) {
    const vx = (v.box.x0 + v.box.x1) / 2, hy = (h.box.y0 + h.box.y1) / 2;
    if (Math.abs(vx - h.box.x0) < 1.5 && Math.abs(v.box.y1 - hy) < 1.5) c.push({ x0: vx, y0: v.box.y0, x1: h.box.x1, y1: hy });
  }
  // de-duplicate (background rectangle and spines of the same axes)
  const uniq = [];
  for (const b of c.sort((p, q) => area(q) - area(p))) if (!uniq.some(u => inter(u, b) > 0.8 * Math.max(area(u), area(b)))) uniq.push(b);
  c = uniq;
  // the figure background: contains two or more frames
  c = c.filter(b => c.filter(o => o !== b && contains(b, o)).length < 2);
  // legend boxes and insets: inside another frame
  c = c.filter(b => !c.some(o => o !== b && contains(o, b, 0.5) && area(o) > area(b) * 1.05));
  // real axes have numeric tick labels on the left or below
  const nums = hz.filter(t => NUMRE.test(t.s.trim()));
  c = c.filter(f => nums.filter(t => {
    const cx = (t.x0 + t.x1) / 2, cy = (t.top + t.bottom) / 2;
    const left = t.x1 <= f.x0 + 2 && t.x1 >= f.x0 - 40 && cy >= f.y0 - 4 && cy <= f.y1 + 4;
    const below = t.top >= f.y1 - 2 && t.top <= f.y1 + 22 && cx >= f.x0 - 4 && cx <= f.x1 + 4;
    return left || below;
  }).length >= 2);
  // reading order: rows top to bottom, then left to right
  c.sort((a, b) => (Math.abs(a.y0 - b.y0) < 20 ? a.x0 - b.x0 : a.y0 - b.y0));
  return c;
}

/** Which panel a text or shape belongs to. Labels left of an axes (y ticks, y title) belong to the panel on their right. */
function panelOf(frames, b) {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  let best = 0, bd = Infinity;
  frames.forEach((f, i) => {
    let dx = 0, dy = 0;
    if (cx > f.x1 + 2) dx = (cx - f.x1) * 4; else if (cx < f.x0) dx = Math.max(0, f.x0 - b.x1);
    if (cy > f.y1) dy = Math.max(0, b.y0 - f.y1); else if (cy < f.y0) dy = Math.max(0, f.y0 - b.y1) * 1.3;
    const d = dx + dy;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export function digitize({ texts: rawTexts, shapes }) {
  if (!shapes || shapes.length < 3) return null;
  const texts = mergeTexts(rawTexts);
  const hz = texts.filter(t => !t.rot);
  const frames = findFrames(hz, shapes);
  if (frames.length < 2) return digitizeOne({ texts, shapes });
  // multi-panel figure: one shared legend (outside every axes) plus optional legends inside each panel
  const legendAll = findLegend(hz, shapes, new Set()).map(l => ({ ...l, panel: frames.findIndex(f => contains(f, l.box, 1)) }));
  const swatches = new Set(legendAll.map(l => l.shape));
  const T = frames.map(() => []), S = frames.map(() => []);
  for (const t of texts) T[panelOf(frames, boxOf(t))].push(t);
  for (const s of shapes) {
    if (swatches.has(s)) continue;
    const i = frames.findIndex(f => contains(f, s.box, 1));
    S[i >= 0 ? i : panelOf(frames, s.box)].push(s);
  }
  const panels = [], series = [];
  frames.forEach((f, i) => {
    const r = digitizeOne({ texts: T[i], shapes: S[i], frame: f, legend: legendAll.filter(l => l.panel === i || l.panel === -1).map(l => ({ ...l, local: l.panel === i })) });
    // the panel title: the row with "(a)"-style label, else the top row just above the axes (not annotations inside)
    const above = T[i].filter(t => !t.rot && t.bottom <= f.y0 + 1 && f.y0 - t.bottom < 22 && t.x1 > f.x0 && t.x0 < f.x1).sort((a, b) => a.top - b.top || a.x0 - b.x0);
    const lead = above.find(t => /^\([a-z]\)/i.test(t.s.trim())) || above[0];
    const titleRow = lead ? above.filter(t => Math.abs(t.top - lead.top) < 4) : [];
    const title = titleRow.map(t => t.s).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140) || null;
    const m = title && /^\(([a-z])\)/i.exec(title);
    const label = m ? `(${m[1].toLowerCase()})` : `(${String.fromCharCode(97 + i)})`;
    panels.push({ label, title, box: [+f.x0.toFixed(1), +f.y0.toFixed(1), +f.x1.toFixed(1), +f.y1.toFixed(1)], axes: r ? r.axes : null, calib: r ? r.calib : null, confidence: r ? r.confidence : 0, note: r ? r.note : 'Nothing could be read from this panel.' });
    for (const s of (r ? r.series : [])) series.push({ ...s, panel: i });
  });
  if (!series.length) return digitizeOne({ texts, shapes });
  const conf = panels.reduce((n, p) => n + (p.confidence || 0), 0) / panels.length;
  return { source: 'vector', panels, series, axes: panels[0].axes, calib: panels[0].calib, confidence: +conf.toFixed(2), note: `${panels.length} panels read separately.` };
}

function digitizeOne({ texts, shapes, frame = null, legend: given = null }) {
  if (!shapes || shapes.length < 2) return null;
  const hz = texts.filter(t => !t.rot);
  // axis multipliers such as "·10^4" or "×10^-3" (pgfplots, matplotlib offset text)
  const mults = hz.filter(t => /^[·×x]?\s*10\^[−\-]?\d+$/.test(t.s)).map(t => ({ t, f: 10 ** Number(t.s.replace(/^.*\^/, '').replace('−', '-')) }));
  const nums = hz.filter(t => NUMRE.test(t.s.trim())).map(t => ({ ...t, orig: t, v: parseNum(t.s), cx: (t.x0 + t.x1) / 2, cy: t.base - 0.34 * t.h }));
  // snap labels to their tick marks (short lines next to the label) for an exact calibration
  const ticksH = shapes.filter(s => s.pts && s.pts.length === 2 && (s.box.y1 - s.box.y0) < 0.6 && (s.box.x1 - s.box.x0) > 1 && (s.box.x1 - s.box.x0) <= 10);
  const ticksV = shapes.filter(s => s.pts && s.pts.length === 2 && (s.box.x1 - s.box.x0) < 0.6 && (s.box.y1 - s.box.y0) > 1 && (s.box.y1 - s.box.y0) <= 10);
  for (const n of nums) {
    const th = ticksH.filter(s => s.box.x0 >= n.x1 - 1 && s.box.x0 - n.x1 < 12 && Math.abs((s.box.y0 + s.box.y1) / 2 - n.cy) < Math.max(3, n.h * 0.6)).sort((a, b) => Math.abs((a.box.y0 + a.box.y1) / 2 - n.cy) - Math.abs((b.box.y0 + b.box.y1) / 2 - n.cy))[0];
    if (th) n.cy = (th.box.y0 + th.box.y1) / 2;
    const tv = ticksV.filter(s => s.box.y1 <= n.top + 1 && n.top - s.box.y1 < 12 && Math.abs((s.box.x0 + s.box.x1) / 2 - n.cx) < Math.max(3, (n.x1 - n.x0) * 0.6)).sort((a, b) => Math.abs((a.box.x0 + a.box.x1) / 2 - n.cx) - Math.abs((b.box.x0 + b.box.x1) / 2 - n.cx))[0];
    if (tv) n.cx = (tv.box.x0 + tv.box.x1) / 2;
  }
  // ── y axis: right-aligned numeric column with varying y
  const groupBy = (arr, key, tol) => { const g = []; for (const t of arr) { const k = key(t); const x = g.find(z => Math.abs(z.k - k) <= tol); if (x) x.items.push(t); else g.push({ k, items: [t] }); } return g; };
  const yCands = groupBy(nums, t => t.x1, 4).filter(g => g.items.length >= 3 && new Set(g.items.map(t => Math.round(t.cy))).size >= 3);
  let ycal = null;
  for (const g of yCands.sort((a, b) => b.items.length - a.items.length)) { const c = calibrate(g.items.map(t => ({ v: t.v, pos: t.cy })), 'y'); if (c) { ycal = { ...c, x: g.k, items: g.items }; break; } }
  // ── x axis: numeric row
  const xCands = groupBy(nums.filter(t => !ycal || !ycal.items.includes(t)), t => t.cy, 3).filter(g => g.items.length >= 3 && new Set(g.items.map(t => Math.round(t.cx))).size >= 3);
  let xcal = null;
  for (const g of xCands.sort((a, b) => b.items.length - a.items.length)) { const c = calibrate(g.items.map(t => ({ v: t.v, pos: t.cx })), 'x'); if (c) { xcal = { ...c, y: g.k, items: g.items }; break; } }
  // apply a multiplier written near the end of an axis
  for (const m of mults) {
    const nearX = xcal && Math.abs(m.t.top - Math.max(...xcal.items.map(t => t.bottom))) < 18 && m.t.x0 >= Math.max(...xcal.items.map(t => t.x0)) - 30;
    const nearY = ycal && m.t.bottom <= Math.min(...ycal.items.map(t => t.top)) + 4 && Math.abs(m.t.x0 - ycal.x) < 50;
    const scale = c => { const map = c.map, inv = c.inv; c.map = pos => map(pos) * m.f; c.inv = v => inv(v / m.f); c.labels = c.labels.map(l => ({ ...l, v: l.v * m.f })); };
    if (nearX) scale(xcal); else if (nearY) scale(ycal);
  }
  const tickSet = new Set([...(ycal ? ycal.items : []), ...(xcal ? xcal.items : [])].map(t => t.orig).concat(mults.map(m => m.t)));
  // ── plot area (inside the tick labels)
  const sb = (shapes.filter(s => !(s.fill && isWhite(s.fill) && !s.stroke)).length ? shapes.filter(s => !(s.fill && isWhite(s.fill) && !s.stroke)) : shapes).map(s => s.box);
  let px0 = Math.min(...sb.map(b => b.x0)), px1 = Math.max(...sb.map(b => b.x1)), py0 = Math.min(...sb.map(b => b.y0)), py1 = Math.max(...sb.map(b => b.y1));
  if (frame) ({ x0: px0, y0: py0, x1: px1, y1: py1 } = frame);
  else {
    if (ycal) px0 = Math.max(px0, ycal.x);
    if (xcal) py1 = Math.min(py1, Math.min(...xcal.items.map(t => t.top)));
  }
  // ── categorical x labels: a row of non-tick texts just below the plot
  const below = hz.filter(t => !tickSet.has(t) && t.top >= py1 - 4 && t.top <= py1 + 40 && t.x1 > px0 - 10 && t.x0 < px1 + 10);
  const rows = groupBy(below, t => (t.top + t.bottom) / 2, 3).filter(g => g.items.length >= 2).sort((a, b) => a.k - b.k);
  const cats = !xcal && rows.length ? rows[0].items.map(t => ({ s: t.s.trim(), cx: (t.x0 + t.x1) / 2 })).sort((a, b) => a.cx - b.cx) : null;
  // ── legend: swatch + label to its right (a multi-panel figure passes its own: this panel's first, then the shared one)
  const legend = given || findLegend(hz, shapes, tickSet);
  const used = new Set(legend.map(l => l.shape).filter(Boolean));
  const nameFor = color => {
    for (const pool of [legend.filter(l => l.local), legend.filter(l => !l.local)]) { let best = null, bd = 60; for (const l of pool) { const d = cdist(l.color, color); if (d < bd) { bd = d; best = l; } } if (best) return best.name; }
    return null;
  };
  const inPlot = b => b.x1 >= px0 - 1 && b.x0 <= px1 + 1 && b.y1 >= py0 - 1 && b.y0 <= py1 + 1;
  const series = new Map();
  const add = (color, kind, pt) => { const k = `${kind}:${color}`; if (!series.has(k)) series.set(k, { color, kind, points: [] }); series.get(k).points.push(pt); };
  const ystep = ycal && ycal.labels.length > 1 ? Math.abs(ycal.labels[1].v - ycal.labels[0].v) : null;
  const xstep = xcal && xcal.labels.length > 1 ? Math.abs(xcal.labels[1].v - xcal.labels[0].v) : null;
  const catAt = cx => { if (!cats || !cats.length) return null; let best = cats[0]; for (const c of cats) if (Math.abs(c.cx - cx) < Math.abs(best.cx - cx)) best = c; return best.s; };
  const xval = cx => (xcal ? round(xcal.map(cx), xstep) : catAt(cx) ?? round(cx - px0, 1));
  // ── box plots: a filled box with a median line across it and whiskers above and below
  const twoPt = shapes.filter(s => s.stroke && !s.fill && s.pts && s.pts.length === 2);
  if (ycal) {
    const boxes = [];
    for (const r of shapes) {
      if (used.has(r) || r.kind !== 'rect' || !r.fill || isWhite(r.fill) || !inPlot(r.box)) continue;
      const b = r.box, w = b.x1 - b.x0, cx = (b.x0 + b.x1) / 2;
      if (w < 1.5 || w > (px1 - px0) * 0.3) continue;
      const med = twoPt.find(m => m.box.y1 - m.box.y0 < 0.6 && Math.abs(m.box.x0 - b.x0) < 1 && Math.abs(m.box.x1 - b.x1) < 1 && m.box.y0 >= b.y0 - 0.3 && m.box.y1 <= b.y1 + 0.3);
      if (!med) continue;
      const vert = twoPt.filter(v => v.box.x1 - v.box.x0 < 0.6 && Math.abs((v.box.x0 + v.box.x1) / 2 - cx) < 0.8);
      const low = vert.find(v => Math.abs(v.box.y0 - b.y1) < 0.6), high = vert.find(v => Math.abs(v.box.y1 - b.y0) < 0.6);
      boxes.push({ r, med, low, high, cx });
    }
    if (boxes.length >= 2) for (const x of boxes) {
      used.add(x.r); used.add(x.med); if (x.low) used.add(x.low); if (x.high) used.add(x.high);
      const v = y => round(ycal.map(y), ystep);
      add(hex(x.r.fill), 'box', { x: xval(x.cx), y: v((x.med.box.y0 + x.med.box.y1) / 2), q1: v(x.r.box.y1), q3: v(x.r.box.y0), lo: x.low ? v(x.low.box.y1) : undefined, hi: x.high ? v(x.high.box.y0) : undefined, _px: x.cx });
    }
  }
  // ── bars
  const rects = shapes.filter(s => !used.has(s) && s.kind === 'rect' && s.fill && !isWhite(s.fill) && inPlot(s.box) && (s.box.x1 - s.box.x0) >= 1.2 && (s.box.y1 - s.box.y0) >= 0.8 && (s.box.x1 - s.box.x0) < (px1 - px0) * 0.9);
  const bottoms = groupBy(rects, r => r.box.y1, 1.5).sort((a, b) => b.items.length - a.items.length);
  const lefts = groupBy(rects, r => r.box.x0, 1.5).sort((a, b) => b.items.length - a.items.length);
  let barMode = null;
  if (rects.length >= 2 && ycal && bottoms[0] && bottoms[0].items.length >= Math.max(2, rects.length * 0.5)) barMode = 'v';
  else if (rects.length >= 2 && xcal && lefts[0] && lefts[0].items.length >= Math.max(2, rects.length * 0.5)) barMode = 'h';
  if (barMode === 'v') {
    const base = ycal.inv(0);
    for (const r of rects) {
      const top = Number.isFinite(base) && r.box.y0 > base + 0.5 ? r.box.y1 : r.box.y0; // negative bars hang below zero
      add(hex(r.fill), 'bar', { x: xval((r.box.x0 + r.box.x1) / 2), y: round(ycal.map(top), ystep), _px: (r.box.x0 + r.box.x1) / 2 });
    }
  } else if (barMode === 'h') {
    const leftLabels = hz.filter(t => !tickSet.has(t) && t.x1 <= px0 + 4);
    for (const r of rects) {
      const cy = (r.box.y0 + r.box.y1) / 2;
      const lab = leftLabels.sort((p, q) => Math.abs((p.top + p.bottom) / 2 - cy) - Math.abs((q.top + q.bottom) / 2 - cy))[0];
      add(hex(r.fill), 'bar', { x: lab ? lab.s.trim() : round(cy, 1), y: round(xcal.map(r.box.x1), xstep), _px: cy });
    }
  }
  // ── lines
  const baseline = s => s.pts.length <= 2 && (s.box.y1 - s.box.y0) < 0.8 && (s.box.x1 - s.box.x0) > (px1 - px0) * 0.5 && !isGray(s.stroke) && !isDark(s.stroke) && !!nameFor(hex(s.stroke));
  if (ycal) {
    for (const s of shapes) {
      if (used.has(s) || s.fill || !s.stroke || !s.pts || !inPlot(s.box) || s.kind === 'rect' || (s.rule && !baseline(s))) continue;
      if (s.closed && s.pts.length <= 6 && (s.box.x1 - s.box.x0) < 10 && (s.box.y1 - s.box.y0) < 10) continue; // a marker outline
      const pts = s.pts;
      const w = s.box.x1 - s.box.x0, h = s.box.y1 - s.box.y0;
      const straight = pts.length <= 2 && (w < 0.8 || h < 0.8);
      // axes, ticks and grid lines are skipped; a coloured horizontal line named in the legend is a constant baseline
      if (straight && !baseline(s)) continue;
      if (pts.length < 3 && !(w > 4 && h > 1) && !baseline(s)) continue;
      if (isGray(s.stroke) && pts.length <= 3 && (w > (px1 - px0) * 0.9 || h > (py1 - py0) * 0.9)) continue;
      const color = hex(s.stroke);
      for (const [x, y] of pts) add(color, 'line', { x: xval(x), y: round(ycal.map(y), ystep), _px: x });
    }
    // markers: small closed shapes, many of the same colour
    const small = shapes.filter(s => !used.has(s) && !s.rule && (s.fill || s.closed) && inPlot(s.box) && (s.box.x1 - s.box.x0) <= 9 && (s.box.y1 - s.box.y0) <= 9 && (s.box.x1 - s.box.x0) >= 1.2 && (s.box.y1 - s.box.y0) >= 1.2);
    const byColor = new Map();
    for (const s of small) { const c = hex(s.fill || s.stroke); if (!byColor.has(c)) byColor.set(c, []); byColor.get(c).push(s); }
    const lineVerts = shapes.filter(s => s.stroke && !s.fill && s.pts && s.pts.length >= 2 && s.kind !== 'rect' && !s.rule).flatMap(s => s.pts);
    for (const [c, list] of byColor) {
      if (list.length < 3 || series.has(`line:${c}`) || series.has(`bar:${c}`) || series.has(`box:${c}`)) continue;
      const onLine = list.filter(s => { const [cx, cy] = [(s.box.x0 + s.box.x1) / 2, (s.box.y0 + s.box.y1) / 2]; return lineVerts.some(([x, y]) => Math.abs(x - cx) < 1.5 && Math.abs(y - cy) < 1.5); }).length;
      if (onLine >= list.length * 0.7) continue; // markers drawn on a line series
      for (const s of list) add(c, 'scatter', { x: xval((s.box.x0 + s.box.x1) / 2), y: round(ycal.map((s.box.y0 + s.box.y1) / 2), ystep), _px: (s.box.x0 + s.box.x1) / 2 });
    }
  }
  const out = [...series.values()].filter(s => s.points.length).map(s => {
    // de-duplicate points that a stroke visits twice, order along x
    const seen = new Set();
    const pts = s.points.sort((a, b) => a._px - b._px).filter(p => { const k = `${p.x}|${p.y}`; if (seen.has(k)) return false; seen.add(k); return true; }).map(({ _px, ...p }) => p);
    return { name: nameFor(s.color) || null, kind: s.kind, color: s.color, points: pts.slice(0, 500) };
  }).filter(s => s.points.length >= (s.kind === 'bar' || s.kind === 'box' ? 1 : 2));
  out.forEach((s, i) => { if (!s.name) s.name = `Series ${i + 1}`; });
  if (!out.length && !ycal && !xcal) return null;
  // axis titles: rotated text left of the plot (y), widest text below the tick row (x)
  const yTitle = texts.filter(t => t.rot && t.x1 <= px0 + 2).map(t => t.s).join(' ').trim() || null;
  const xRow = hz.filter(t => !tickSet.has(t) && (!cats || !rows.length || !rows[0].items.includes(t)) && t.top > py1 + 2 && t.top < py1 + 50 && t.x0 > px0 - 20 && t.x1 < px1 + 20);
  const xTitle = xRow.length ? xRow.sort((a, b) => a.top - b.top || a.x0 - b.x0).map(t => t.s).join(' ').trim().slice(0, 120) : null;
  const conf = (ycal ? 0.4 : 0) + (xcal || cats ? 0.25 : 0) + (out.length ? 0.25 : 0) + (legend.length ? 0.1 : 0);
  return {
    source: 'vector',
    axes: { x: { title: xTitle, type: xcal ? xcal.type : cats ? 'category' : 'linear', labels: cats ? cats.map(c => c.s) : undefined, min: xcal ? Math.min(...xcal.labels.map(l => l.v)) : undefined, max: xcal ? Math.max(...xcal.labels.map(l => l.v)) : undefined }, y: { title: yTitle, type: ycal ? ycal.type : 'linear', min: ycal ? Math.min(...ycal.labels.map(l => l.v)) : undefined, max: ycal ? Math.max(...ycal.labels.map(l => l.v)) : undefined } },
    series: out, confidence: +conf.toFixed(2),
    calib: { x: xcal ? { type: xcal.type, labels: xcal.labels.map(l => [l.pos, l.v]) } : null, y: ycal ? { type: ycal.type, labels: ycal.labels.map(l => [l.pos, l.v]) } : null, plot: [px0, py0, px1, py1] },
    note: !ycal ? 'No numeric y axis was recognised; values are not calibrated.' : '',
  };
}

// ── Operator-list scanning (pdf.js) ────────────────────────
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
function colorArg(a) {
  if (!a) return null;
  if (typeof a[0] === 'string') return a[0].toLowerCase();
  if (a.length >= 3) { const sc = Math.max(a[0], a[1], a[2]) <= 1 ? 255 : 1; return toHex(a[0] * sc, a[1] * sc, a[2] * sc); }
  return null;
}
/** Walk a pdf.js operator list: images, filled/stroked paths (in viewport coordinates), horizontal rules. */
export function scanGraphics(opList, viewportTransform, OPS) {
  const fn = opList.fnArray, args = opList.argsArray;
  let ctm = viewportTransform.slice();
  let fill = '#000000', stroke = '#000000';
  const stack = [];
  const images = [], shapes = [];
  let pending = null;
  const PAINT = new Map([[OPS.stroke, 's'], [OPS.closeStroke, 's'], [OPS.fill, 'f'], [OPS.eoFill, 'f'], [OPS.fillStroke, 'fs'], [OPS.eoFillStroke, 'fs'], [OPS.closeFillStroke, 'fs'], [OPS.closeEOFillStroke, 'fs']]);
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask].filter(x => x != null));
  function parsePath(ops, coords) {
    const subs = [];
    let cur = null, k = 0, rect = false;
    for (const op of ops) {
      if (op === OPS.rectangle) {
        const [x, y, w, h] = coords.slice(k, k + 4); k += 4;
        subs.push({ pts: [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)], closed: true, rect: true });
        rect = true; cur = null;
      } else if (op === OPS.moveTo) { cur = { pts: [apply(ctm, coords[k], coords[k + 1])], closed: false }; subs.push(cur); k += 2; }
      else if (op === OPS.lineTo) { if (!cur) { cur = { pts: [], closed: false }; subs.push(cur); } cur.pts.push(apply(ctm, coords[k], coords[k + 1])); k += 2; }
      else if (op === OPS.curveTo) { if (cur) { cur.pts.push(apply(ctm, coords[k + 4], coords[k + 5])); cur.curve = true; } k += 6; }
      else if (op === OPS.curveTo2 || op === OPS.curveTo3) { if (cur) { cur.pts.push(apply(ctm, coords[k + 2], coords[k + 3])); cur.curve = true; } k += 4; }
      else if (op === OPS.closePath) { if (cur) cur.closed = true; }
    }
    return { subs, rect };
  }
  // clipping: shapes are cut to the current clip box (matplotlib draws bars from 0 and clips them to the axes)
  let clip = null, clipNext = false;
  const cut = (b, c) => (c ? { x0: Math.max(b.x0, c.x0), y0: Math.max(b.y0, c.y0), x1: Math.min(b.x1, c.x1), y1: Math.min(b.y1, c.y1) } : b);
  const bboxOf = subs => { const all = subs.flatMap(s => s.pts); if (!all.length) return null; const xs = all.map(p => p[0]), ys = all.map(p => p[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
  function emitShape(paint) {
    if (!pending) return;
    const { subs } = pending;
    if (clipNext) { const b = bboxOf(subs); if (b) clip = cut(b, clip); clipNext = false; }
    pending = null;
    for (const s of subs) {
      if (!s.pts.length) continue;
      const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
      const raw = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const box = cut(raw, clip);
      if (box.x1 < box.x0 - 0.01 || box.y1 < box.y0 - 0.01) continue; // clipped away
      const rectLike = s.rect || (s.closed && s.pts.length <= 5 && !s.curve && s.pts.every(p => (Math.abs(p[0] - raw.x0) < 0.3 || Math.abs(p[0] - raw.x1) < 0.3) && (Math.abs(p[1] - raw.y0) < 0.3 || Math.abs(p[1] - raw.y1) < 0.3)));
      let pts = s.pts.length > 400 ? s.pts.filter((_, i) => i % Math.ceil(s.pts.length / 400) === 0) : s.pts;
      if (clip && rectLike) pts = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
      else if (clip) pts = pts.filter(p => p[0] >= clip.x0 - 0.5 && p[0] <= clip.x1 + 0.5 && p[1] >= clip.y0 - 0.5 && p[1] <= clip.y1 + 0.5);
      if (!pts.length) continue;
      shapes.push({ kind: rectLike ? 'rect' : 'path', box, fill: paint.includes('f') ? fill : null, stroke: paint.includes('s') ? stroke : null, pts, closed: s.closed, curve: !!s.curve });
    }
  }
  for (let i = 0; i < fn.length; i++) {
    const f = fn[i], a = args[i];
    if (f === OPS.save) stack.push({ ctm: ctm.slice(), fill, stroke, clip });
    else if (f === OPS.restore) { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; stroke = s.stroke; clip = s.clip; } }
    else if (f === OPS.transform) ctm = mul(ctm, Array.from(a));
    else if (f === OPS.paintFormXObjectBegin) { stack.push({ ctm: ctm.slice(), fill, stroke, clip }); if (a && a[0] && (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) && a[0].length === 6) ctm = mul(ctm, Array.from(a[0])); }
    else if (f === OPS.paintFormXObjectEnd) { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; stroke = s.stroke; clip = s.clip; } }
    else if (f === OPS.clip || f === OPS.eoClip) clipNext = true;
    else if (f === OPS.setFillRGBColor) fill = colorArg(a) || fill;
    else if (f === OPS.setStrokeRGBColor) stroke = colorArg(a) || stroke;
    else if (f === OPS.setFillGray) fill = a && a.length ? toHex(a[0] * 255, a[0] * 255, a[0] * 255) : fill;
    else if (f === OPS.setStrokeGray) stroke = a && a.length ? toHex(a[0] * 255, a[0] * 255, a[0] * 255) : stroke;
    else if (f === OPS.constructPath) {
      if (a && (Array.isArray(a[0]) || ArrayBuffer.isView(a[0]))) pending = parsePath(Array.from(a[0]), Array.from(a[1])); // pdf.js ≤ 4: [ops, coords, minMax], paint op follows
      else pending = null;
    } else if (PAINT.has(f)) emitShape(PAINT.get(f));
    else if (f === OPS.endPath) { if (clipNext && pending) { const b = bboxOf(pending.subs); if (b) clip = cut(b, clip); } clipNext = false; pending = null; }
    else if (IMG.has(f)) {
      const c = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
      const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
      images.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }
  // horizontal rules (table lines, underlines) and vertical rules
  const rules = [];
  for (const s of shapes) {
    const w = s.box.x1 - s.box.x0, h = s.box.y1 - s.box.y0;
    if ((s.kind === 'rect' && s.fill && h <= 1.6 && w >= 12) || (s.stroke && !s.fill && s.pts.length === 2 && h <= 0.6 && w >= 12)) { s.rule = 'h'; rules.push({ x0: s.box.x0, x1: s.box.x1, y: (s.box.y0 + s.box.y1) / 2 }); }
    else if ((s.kind === 'rect' && s.fill && w <= 1.6 && h >= 6) || (s.stroke && !s.fill && s.pts.length === 2 && w <= 0.6 && h >= 6)) s.rule = 'v';
  }
  return { images, shapes, rules };
}
