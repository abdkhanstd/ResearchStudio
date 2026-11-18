/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * Automatic digitising of raster charts (PNG/JPG figures, or images inside a PDF).
 * Axis calibration comes from OCR'd tick labels; series are separated by colour; markers are found as column-count
 * peaks along each colour; legend entries (colour sample + OCR'd word) name the series. Values are approximate —
 * the UI shows a replot so a person can confirm, and the digitiser can correct them.
 *   autoDigitize(canvas, words) → { source: 'ocr', axes, series, confidence, note } | null
 */
import { guessCalibration } from './ocr.js';

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function autoDigitize(canvas, words) {
  if (!canvas || !words || !words.length) return null;
  const cal = guessCalibration(words);
  if (!cal.x || !cal.y) return null;
  const W = canvas.width, H = canvas.height;
  const mapX = px => cal.x.v1 + (px - cal.x.p1) * (cal.x.v2 - cal.x.v1) / (cal.x.p2 - cal.x.p1);
  const mapY = py => cal.y.v1 + (py - cal.y.p1) * (cal.y.v2 - cal.y.v1) / (cal.y.p2 - cal.y.p1);
  // plot area: between the outermost ticks, a little beyond
  const xs = [cal.x.p1, cal.x.p2], ys = [cal.y.p1, cal.y.p2];
  const yTickRight = Math.max(...words.filter(w => /^[−\-]?\d+(?:[.,]\d+)?%?$/.test(w.s) && Math.abs((w.y0 + w.y1) / 2 - cal.y.p1) < 3).map(w => w.x1), 0);
  const xTickTop = Math.min(...words.filter(w => /^[−\-]?\d+(?:[.,]\d+)?%?$/.test(w.s) && Math.abs((w.x0 + w.x1) / 2 - cal.x.p1) < 3).map(w => w.y0), H);
  const pad = Math.max(4, W * 0.01);
  const X0 = Math.max(0, Math.max(yTickRight + pad, Math.min(...xs) - W * 0.08)), X1 = Math.min(W - 1, Math.max(...xs) + W * 0.08);
  const Y0 = Math.max(0, Math.min(...ys) - H * 0.08), Y1 = Math.min(H - 1, Math.min(xTickTop - pad, Math.max(...ys) + H * 0.08));
  if (X1 - X0 < 40 || Y1 - Y0 < 30) return null;
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  // words inside the plot (legend labels, annotations) and the area just left of them (legend samples)
  const inside = words.filter(w => !/^[−\-]?\d+(?:[.,]\d+)?%?$/.test(w.s) && w.x0 > X0 && w.x1 < X1 && w.y0 > Y0 && w.y1 < Y1);
  const legendBoxes = inside.map(w => ({ w, x0: Math.max(X0, w.x0 - (w.y1 - w.y0) * 4.2), x1: w.x0 - 1, y0: w.y0 - 3, y1: w.y1 + 3 }));
  const masked = (x, y) => inside.some(w => x >= w.x0 - 2 && x <= w.x1 + 2 && y >= w.y0 - 2 && y <= w.y1 + 2) || legendBoxes.some(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  // colour clusters by hue (saturated pixels only: axes, text and grey grid lines are ignored)
  const bins = new Map();
  for (let y = Math.ceil(Y0); y <= Y1; y++) for (let x = Math.ceil(X0); x <= X1; x++) {
    const k = (y * W + x) * 4;
    const [h, s, v] = rgb2hsv(img[k], img[k + 1], img[k + 2]);
    if (s < 0.28 || v < 0.18) continue;
    const hb = Math.round(h / 14) % 26;
    if (!bins.has(hb)) bins.set(hb, { n: 0, r: 0, g: 0, b: 0, px: [] });
    const c = bins.get(hb);
    c.n++; c.r += img[k]; c.g += img[k + 1]; c.b += img[k + 2];
    if (!masked(x, y)) c.px.push(x, y);
  }
  // merge neighbouring hue bins
  const keys = [...bins.keys()].sort((a, b) => a - b);
  const groups = [];
  for (const k of keys) { const g = groups[groups.length - 1]; if (g && (k - g.last <= 1)) { g.keys.push(k); g.last = k; } else groups.push({ keys: [k], last: k }); }
  if (groups.length > 1 && groups[0].keys[0] === 0 && groups[groups.length - 1].last === 25) { groups[0].keys.push(...groups.pop().keys); }
  const total = (X1 - X0) * (Y1 - Y0);
  const clusters = groups.map(g => { const c = { n: 0, r: 0, g: 0, b: 0, px: [] }; for (const k of g.keys) { const b = bins.get(k); c.n += b.n; c.r += b.r; c.g += b.g; c.b += b.b; for (let i = 0; i < b.px.length; i++) c.px.push(b.px[i]); } return c; })
    .filter(c => c.n > total * 0.0015 && c.px.length > 40)
    .map(c => ({ ...c, color: '#' + [c.r, c.g, c.b].map(v => Math.round(v / c.n).toString(16).padStart(2, '0')).join('') }));
  if (!clusters.length) return null;
  // legend: which colour sits left of which word
  const nameOf = new Map();
  for (const lb of legendBoxes) {
    let best = null, bn = 0;
    for (const c of clusters) {
      let n = 0;
      for (let y = Math.ceil(lb.y0); y <= lb.y1; y++) for (let x = Math.ceil(lb.x0); x <= lb.x1; x++) { const k = (y * W + x) * 4; const [h, s, v] = rgb2hsv(img[k], img[k + 1], img[k + 2]); if (s >= 0.28 && v >= 0.18 && Math.abs(((h - hueOf(c) + 540) % 360) - 180) < 22) n++; }
      if (n > bn) { bn = n; best = c; }
    }
    if (best && bn >= 4 && !nameOf.has(best)) nameOf.set(best, lb.w.s.replace(/[^\w\-+.()% ]/g, ''));
  }
  function hueOf(c) { return rgb2hsv(c.r / c.n, c.g / c.n, c.b / c.n)[0]; }
  const series = [];
  for (const c of clusters) {
    const cols = new Map();
    for (let i = 0; i < c.px.length; i += 2) { const x = c.px[i]; if (!cols.has(x)) cols.set(x, []); cols.get(x).push(c.px[i + 1]); }
    const xsSorted = [...cols.keys()].sort((a, b) => a - b);
    if (xsSorted.length < 5) continue;
    const counts = xsSorted.map(x => cols.get(x).length);
    const base = median(counts);
    const thr = Math.max(4, base * 2.1);
    // marker runs: consecutive columns with many pixels
    const runs = [];
    let run = null;
    for (const x of xsSorted) {
      const n = cols.get(x).length;
      if (n >= thr) { if (run && x - run.x1 <= 2) run.x1 = x; else { run = { x0: x, x1: x }; runs.push(run); } }
    }
    let pts = runs.filter(r => r.x1 - r.x0 >= 3).map(r => { const yy = []; for (let x = r.x0; x <= r.x1; x++) if (cols.has(x)) yy.push(...cols.get(x)); return { px: (r.x0 + r.x1) / 2, py: median(yy) }; });
    const kind = pts.length >= 2 ? 'line' : 'line';
    if (pts.length < 2) {
      // no markers: sample the curve evenly
      const n = 12, a = xsSorted[0], b = xsSorted[xsSorted.length - 1];
      pts = [];
      for (let i = 0; i < n; i++) { const tx = Math.round(a + (b - a) * i / (n - 1)); const near = xsSorted.reduce((best, x) => (Math.abs(x - tx) < Math.abs(best - tx) ? x : best), xsSorted[0]); pts.push({ px: near, py: median(cols.get(near)) }); }
    }
    const xstep = Math.abs(cal.x.v2 - cal.x.v1) / 50, ystep = Math.abs(cal.y.v2 - cal.y.v1) / 200;
    const rnd = (v, st) => { const d = Math.max(0, Math.min(6, Math.ceil(-Math.log10(st || 1)))); return +v.toFixed(d); };
    series.push({ name: nameOf.get(c) || null, kind, color: c.color, points: pts.map(p => ({ x: rnd(mapX(p.px), xstep), y: rnd(mapY(p.py), ystep) })) });
  }
  if (!series.length) return null;
  series.forEach((s, i) => { if (!s.name) s.name = `Series ${i + 1}`; });
  const xt = words.filter(w => !/^[−\-]?\d/.test(w.s) && w.y0 > Y1 && w.x0 > X0 - 20).map(w => w.s).join(' ').slice(0, 80) || null;
  return { source: 'ocr', axes: { x: { title: xt, type: 'linear', min: Math.min(cal.x.v1, cal.x.v2), max: Math.max(cal.x.v1, cal.x.v2) }, y: { title: null, type: 'linear', min: Math.min(cal.y.v1, cal.y.v2), max: Math.max(cal.y.v1, cal.y.v2) } }, series, confidence: 0.6, note: 'Read automatically from the image (OCR axes, colour tracing). Values are approximate — compare the replot with the figure.' };
}
