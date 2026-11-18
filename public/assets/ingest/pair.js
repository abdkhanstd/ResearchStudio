/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * Pair a LaTeX project with its compiled PDF: every LaTeX block gets the page boxes of the PDF text it produced, so
 * readers see the paragraph as typeset while edits still patch the exact .tex source.
 * Matching is by word shingles (rendered LaTeX text vs. text extracted from the PDF), in reading order with a look-ahead,
 * and a paragraph may cover several PDF blocks (split by a page/column break or a display equation).
 * Captions are matched anywhere (floats move); figures and tables take their box from the PDF caption/region.
 */
import { renderTex } from '../shared/textkit.mjs';

const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/\$[^$]*\$/g, ' ');
const words = s => norm(s).match(/[a-z]{2,}|\d+(?:\.\d+)?/g) || [];
function shingles(s, k = 3) { const w = words(s); const out = new Set(); if (w.length < k) { if (w.length) out.add(w.join(' ')); return out; } for (let i = 0; i <= w.length - k; i++) out.add(w.slice(i, i + k).join(' ')); return out; }
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

export function pairLatexWithPdf(ldoc, pdoc) {
  const ctx = ldoc.latex || {};
  const L = ldoc.blocks.map(b => ({ b, sh: shingles(b.tex ? renderTex(b.text, ctx) : b.text) }));
  const P = pdoc.blocks.map((b, i) => ({ b, i, sh: shingles(b.text), used: false }));
  const body = P.filter(x => !['caption', 'front', 'ref'].includes(x.b.kind));
  const caps = P.filter(x => x.b.kind === 'caption');
  let j = 0, placed = 0, total = 0;
  const place = (lb, list) => { lb.boxes = list.flatMap(x => x.b.boxes || []).slice(0, 12); lb.page = list[0].b.page; for (const x of list) x.used = true; placed++; };
  for (const x of L) {
    const lb = x.b;
    if (['ref', 'heading'].includes(lb.kind)) continue;
    if (lb.kind === 'heading') continue;
    total++;
    if (!x.sh.size) continue;
    if (lb.kind === 'caption') {
      let best = null, bs = 0;
      for (const c of caps) { if (c.used) continue; const s = inter(x.sh, c.sh) / Math.max(1, Math.min(x.sh.size, c.sh.size)); if (s > bs) { bs = s; best = c; } }
      if (best && bs >= 0.4) { place(lb, [best]); continue; }
      // algorithm captions and the like are read as body text in the PDF
      let alt = null, as = 0;
      for (const c of P) { if (c.used || !c.sh.size) continue; const s2 = inter(x.sh, c.sh) / Math.max(1, Math.min(x.sh.size, c.sh.size)); if (s2 > as) { as = s2; alt = c; } }
      if (alt && as >= 0.5) place(lb, [alt]);
      continue;
    }
    // best start within a look-ahead window (allow small backtracking for floats placed early)
    let best = -1, bs = 0;
    for (let k = Math.max(0, j - 3); k < Math.min(body.length, j + 40); k++) {
      const c = body[k];
      if (c.used || !c.sh.size) continue;
      const s = inter(x.sh, c.sh) / Math.max(1, Math.min(x.sh.size, c.sh.size));
      if (s > bs + 1e-9) { bs = s; best = k; }
    }
    if (best < 0 || bs < 0.35) continue;
    const group = [body[best]];
    // extend over continuation blocks (page/column breaks, display equations, sub-lines)
    let k = best + 1, miss = 0;
    while (k < body.length && miss <= 1 && group.length < 10) {
      const c = body[k];
      const own = c.sh.size ? inter(x.sh, c.sh) / c.sh.size : 0;
      if (own >= 0.5 && !c.used) { group.push(c); miss = 0; }
      else if ((c.b.kind === 'equation' || words(c.b.text).length < 8) && !c.used && k + 1 < body.length && body[k + 1].sh.size && inter(x.sh, body[k + 1].sh) / body[k + 1].sh.size >= 0.5) { group.push(c); }
      else miss++;
      k++;
      if (miss) break;
    }
    place(lb, group);
    j = body.indexOf(group[group.length - 1]) + 1;
  }
  // figures and tables: box from the PDF float with the same label
  const byLabel = (list, lbl) => list.find(f => f.label && lbl && f.label.replace(/\s+/g, '').toLowerCase() === lbl.replace(/\s+/g, '').toLowerCase());
  ldoc.assets = ldoc.assets || {};
  ldoc.assets.figImages = ldoc.assets.figImages || [];
  for (const f of ldoc.figures || []) {
    const m = byLabel(pdoc.figures || [], f.label);
    if (!m) continue;
    if (m.box) { f.box = m.box; f.page = m.page; }
    if (!f.data && m.data) f.data = m.data;
    // TikZ / EPS figures have no image file: use the figure as typeset in the PDF
    if (m.blob && !ldoc.assets.figImages.some(x => x.id === f.id)) { ldoc.assets.figImages.push({ id: f.id, blob: m.blob, canvas: m.ocrCanvas || null }); if (f.kind === 'none' || f.kind === 'tikz') f.kind = f.data ? 'tikz' : m.kind; }
  }
  for (const t of ldoc.tables || []) { const m = byLabel(pdoc.tables || [], t.label); if (m && m.box) { t.box = m.box; t.page = m.page; } }
  ldoc.source.pages = pdoc.source.pages;
  ldoc.source.pdfPaired = true;
  ldoc.assets.pageImages = pdoc.assets.pageImages;
  return { placed, total };
}
