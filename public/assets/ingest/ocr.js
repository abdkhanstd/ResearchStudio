/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** OCR for raster figures (Tesseract.js, served locally; runs in a Web Worker in the reader's browser). */
let workerP = null;
function loadScript(src) {
  return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the OCR engine')); document.head.appendChild(s); });
}
async function worker() {
  if (!workerP) workerP = (async () => {
    await loadScript('/vendor/tesseract/tesseract.min.js');
    const w = await window.Tesseract.createWorker('eng', 1, { workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core', langPath: '/vendor/tesseract/lang', workerBlobURL: false, gzip: true });
    // charts: scattered labels → sparse-text page segmentation
    try { await w.setParameters({ tessedit_pageseg_mode: '12' }); } catch { await w.setParameters({ tessedit_pageseg_mode: '11' }).catch(() => {}); }
    return w;
  })();
  return workerP;
}
/** canvas → { text, words: [{ s, conf, x0, y0, x1, y1 }] } in the canvas' own pixels. Small images are upscaled for OCR. */
export async function ocr(canvas) {
  const w = await worker();
  const k = canvas.width < 1600 ? 2 : 1;
  let src = canvas;
  if (k > 1) {
    src = document.createElement('canvas'); src.width = canvas.width * k; src.height = canvas.height * k;
    const g = src.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, src.width, src.height); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, src.width, src.height);
  }
  const { data } = await w.recognize(src);
  const words = (data.words || []).filter(x => x.text && x.text.trim() && x.confidence > 35).map(x => ({ s: x.text.trim(), conf: Math.round(x.confidence), x0: x.bbox.x0 / k, y0: x.bbox.y0 / k, x1: x.bbox.x1 / k, y1: x.bbox.y1 / k }));
  return { text: words.map(x => x.s).join(' '), words: words.slice(0, 400), w: canvas.width, h: canvas.height };
}
export async function stopOcr() { if (workerP) { try { (await workerP).terminate(); } catch { /* gone */ } workerP = null; } }

/** Axis calibration guess from OCR words (numeric tick labels in a column / a row). */
export function guessCalibration(words) {
  const nums = words.filter(w => /^[−\-]?\d+(?:[.,]\d+)?%?$/.test(w.s)).map(w => ({ v: Number(w.s.replace(/[−]/g, '-').replace('%', '').replace(',', '.')), cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, x1: w.x1, y0: w.y0 }));
  const group = (arr, key, tol) => { const g = []; for (const t of arr) { const k = key(t); const x = g.find(z => Math.abs(z.k - k) <= tol); if (x) x.items.push(t); else g.push({ k, items: [t] }); } return g.sort((a, b) => b.items.length - a.items.length); };
  const lin = pts => { const n = pts.length; if (n < 2) return null; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; } const d = n * sxx - sx * sx; if (!d) return null; const a = (n * sxy - sx * sy) / d, b = (sy - a * sx) / n; let ss = 0, st = 0; const my = sy / n; for (const [x, y] of pts) { ss += (y - a * x - b) ** 2; st += (y - my) ** 2; } return st && 1 - ss / st > 0.995 ? { a, b } : null; };
  let y = null, x = null;
  for (const g of group(nums, t => t.x1, 6)) { if (g.items.length < 3) break; const f = lin(g.items.map(t => [t.cy, t.v])); if (f) { const s = g.items.sort((p, q) => p.cy - q.cy); y = { p1: s[0].cy, v1: s[0].v, p2: s[s.length - 1].cy, v2: s[s.length - 1].v }; break; } }
  for (const g of group(nums, t => t.cy, 6)) { if (g.items.length < 3) break; const f = lin(g.items.map(t => [t.cx, t.v])); if (f) { const s = g.items.sort((p, q) => p.cx - q.cx); x = { p1: s[0].cx, v1: s[0].v, p2: s[s.length - 1].cx, v2: s[s.length - 1].v }; break; } }
  return { x, y };
}
