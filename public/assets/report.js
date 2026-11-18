/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Browser-side exports: annotated PDF with side notes (pdf-lib), printable review report. */
import { tk, toast, esc, fmtDate, fmtMin, blockPlain, catLabel } from './lib.js';
import { blockLabel } from './blocks.js';

function loadScript(src) { return new Promise((res, rej) => { if (window.PDFLib) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the PDF writer')); document.head.appendChild(s); }); }
const MAP = { '−': '-', '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...', '•': '*', '×': 'x', '≤': '<=', '≥': '>=', '≈': '~', '±': '+/-', '→': '->', '←': '<-', 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'eps', 'θ': 'theta', 'λ': 'lambda', 'μ': 'mu', 'σ': 'sigma', 'π': 'pi', 'ρ': 'rho', 'τ': 'tau', 'φ': 'phi', 'ω': 'omega', 'Σ': 'Sum', '∑': 'Sum', '∈': 'in', '∞': 'inf', '√': 'sqrt', '·': '.', ' ': ' ' };

export async function annotatedPdf(p, mode = 'all', { download = true } = {}) {
  await loadScript('/vendor/pdf-lib.min.js');
  const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
  const r = await fetch(`/api/projects/${p.id}/files/source.pdf`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('The original PDF is not available.');
  const src = await PDFDocument.load(await r.arrayBuffer(), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.setTitle(`${p.title} — proofreading notes`); out.setProducer('Research Studio'); out.setCreator('Research Studio');
  const F = await out.embedFont(StandardFonts.Helvetica), FB = await out.embedFont(StandardFonts.HelveticaBold), FI = await out.embedFont(StandardFonts.HelveticaOblique);
  const okChar = new Map();
  const clean = s => [...String(s || '')].map(ch => { if (MAP[ch] != null) return MAP[ch]; if (!okChar.has(ch)) { try { F.widthOfTextAtSize(ch, 8); okChar.set(ch, true); } catch { okChar.set(ch, false); } } return okChar.get(ch) ? ch : '?'; }).join('').replace(/[\r\n\t]+/g, ' ');
  const MK = { yellow: rgb(0.85, 0.66, 0), green: rgb(0.12, 0.62, 0.35), pink: rgb(0.86, 0.24, 0.55), blue: rgb(0.16, 0.43, 0.86) };
  const C = { ins: rgb(0.04, 0.48, 0.36), del: rgb(0.71, 0.14, 0.09), ink: rgb(0.08, 0.1, 0.15), muted: rgb(0.42, 0.45, 0.51), sug: rgb(0.7, 0.42, 0), com: rgb(0.11, 0.37, 0.7), app: rgb(0.04, 0.48, 0.36), brand: rgb(0.2, 0.27, 0.78), line: rgb(0.85, 0.83, 0.78), bg: rgb(0.97, 0.96, 0.93) };
  // items in document order
  const items = [];
  for (const b of p.blocks) {
    if (mode === 'all' && b.cur !== b.text) items.push({ kind: 'applied', b, a: b.text, z: b.cur, who: [...new Set(p.changes.filter(c => c.bid === b.id && !c.undone).map(c => c.byName))].join(', ') });
    for (const s of p.suggestions.filter(x => x.bid === b.id)) {
      if (s.kind === 'edit' && s.status === 'open') items.push({ kind: 'sug', b, a: s.base, z: s.text, who: s.byName, note: s.note, cat: s.cat, replies: s.replies });
      if (s.kind === 'comment' && (s.status === 'open' || mode === 'all')) items.push({ kind: 'com', b, who: s.byName, note: s.note, quote: s.quote, status: s.status, replies: s.replies });
      if (s.kind === 'mark' && (s.status === 'open' || mode === 'all')) items.push({ kind: 'mark', b, who: s.byName, note: s.note, quote: s.quote, area: s.area, color: s.color, status: s.status, replies: s.replies });
    }
  }
  items.forEach((x, i) => { x.n = i + 1; });
  const M = 232, PAD = 12;
  const pagesSrc = src.getPages();
  const embedded = await out.embedPages(pagesSrc);
  // cover
  const s0 = pagesSrc[0].getSize();
  const cover = out.addPage([s0.width + M, s0.height]);
  let y = s0.height - 70;
  cover.drawRectangle({ x: 0, y: s0.height - 8, width: s0.width + M, height: 8, color: C.brand });
  cover.drawText('Proofreading notes', { x: 60, y, size: 12, font: FB, color: C.brand }); y -= 34;
  for (const line of wrap(clean(p.title), FB, 22, s0.width + M - 120)) { cover.drawText(line, { x: 60, y, size: 22, font: FB, color: C.ink }); y -= 28; }
  y -= 10;
  const counts = { applied: items.filter(x => x.kind === 'applied').length, sug: items.filter(x => x.kind === 'sug').length, com: items.filter(x => x.kind === 'com' || x.kind === 'mark').length };
  const readers = p.members.filter(m => m.role !== 'owner' && m.status === 'active');
  for (const t of [`Generated ${fmtDate(new Date().toISOString())} by Research Studio`, `${counts.applied} paragraphs changed · ${counts.sug} open suggestions · ${counts.com} comments`, readers.length ? `Proofreaders: ${readers.map(m => m.name).join(', ')}` : '']) { if (!t) continue; for (const l of wrap(clean(t), F, 10.5, s0.width + M - 120)) { cover.drawText(l, { x: 60, y, size: 10.5, font: F, color: C.muted }); y -= 15; } }
  y -= 18;
  for (const [col, label, desc] of [[C.app, 'Applied', 'changes already made to the manuscript'], [C.sug, 'Suggestion', 'open, waiting for a decision'], [C.com, 'Comment', 'questions and remarks']]) { cover.drawRectangle({ x: 60, y: y - 2, width: 12, height: 12, color: col, opacity: 0.25, borderColor: col, borderWidth: 1 }); cover.drawText(`${label}: ${desc}`, { x: 80, y, size: 10.5, font: F, color: C.ink }); y -= 18; }
  y -= 6;
  cover.drawText('In the notes, deleted text is red and struck through; inserted text is green and underlined.', { x: 60, y, size: 10, font: FI, color: C.muted });
  // pages
  for (let i = 0; i < embedded.length; i++) {
    const pg = embedded[i];
    const { width: w, height: h } = pagesSrc[i].getSize();
    const page = out.addPage([w + M, h]);
    page.drawPage(pg, { x: 0, y: 0, width: w, height: h });
    page.drawRectangle({ x: w, y: 0, width: M, height: h, color: C.bg });
    page.drawLine({ start: { x: w, y: 0 }, end: { x: w, y: h }, thickness: 0.6, color: C.line });
    const scaleX = w / (p.source.pages[i] ? p.source.pages[i].w : w), scaleY = h / (p.source.pages[i] ? p.source.pages[i].h : h);
    const here = items.filter(x => (x.area ? x.area.p === i + 1 : (x.b.boxes || []).some(bx => bx.p === i + 1)));
    let ny = h - PAD - 4;
    const overflow = [];
    for (const it of here) {
      const col = it.kind === 'applied' ? C.app : it.kind === 'sug' ? C.sug : it.kind === 'mark' ? MK[it.color] || MK.yellow : C.com;
      const bx = (it.area && it.area.p === i + 1 ? it.area : null) || it.b.boxes.find(q => q.p === i + 1);
      if (it.area && it.area.p === i + 1) page.drawRectangle({ x: it.area.x0 * scaleX, y: h - it.area.y1 * scaleY, width: (it.area.x1 - it.area.x0) * scaleX, height: (it.area.y1 - it.area.y0) * scaleY, color: col, opacity: 0.3, borderColor: col, borderWidth: 0.8 });
      for (const q of (it.kind === 'mark' ? [] : it.b.boxes.filter(q => q.p === i + 1))) page.drawRectangle({ x: q.x0 * scaleX - 1.5, y: h - q.y1 * scaleY - 1.5, width: (q.x1 - q.x0) * scaleX + 3, height: (q.y1 - q.y0) * scaleY + 3, color: col, opacity: 0.09, borderColor: col, borderWidth: 0.6, borderOpacity: 0.7 });
      const ay = h - bx.y0 * scaleY;
      const badge = (pgx, x, yy) => { pgx.drawCircle({ x, y: yy, size: 6.5, color: col }); const t = String(it.n); pgx.drawText(t, { x: x - FB.widthOfTextAtSize(t, 6.5) / 2, y: yy - 2.3, size: 6.5, font: FB, color: rgb(1, 1, 1) }); };
      badge(page, Math.max(8, bx.x0 * scaleX - 8), ay - 4);
      const height = noteHeight(it);
      if (ny - height < PAD) { overflow.push(it); continue; }
      page.drawLine({ start: { x: Math.max(8, bx.x0 * scaleX - 8) + 6, y: ay - 4 }, end: { x: w + 6, y: ny - 4 }, thickness: 0.4, color: col, opacity: 0.5, dashArray: [1.5, 1.5] });
      const top = ny;
      ny = drawNote(page, it, w + 10, ny, col);
      badge(page, w + 10 + 5, top - 6.5);
    }
    // notes that did not fit: continuation page
    if (overflow.length) {
      let cp = out.addPage([w + M, h]);
      let cy = h - 40;
      cp.drawText(clean(`Notes for page ${i + 1} (continued)`), { x: 40, y: cy, size: 12, font: FB, color: C.ink }); cy -= 24;
      let x0 = 40;
      const colW = (w + M - 100) / 2;
      for (const it of overflow) {
        const col = it.kind === 'applied' ? C.app : it.kind === 'sug' ? C.sug : it.kind === 'mark' ? MK[it.color] || MK.yellow : C.com;
        const hh = noteHeight(it, colW);
        if (cy - hh < 30) { if (x0 === 40) { x0 = 40 + colW + 20; cy = h - 64; } else { cp = out.addPage([w + M, h]); cy = h - 40; x0 = 40; } }
        const top = cy;
        cy = drawNote(cp, it, x0, cy, col, colW);
        cp.drawCircle({ x: x0 + 5, y: top - 6.5, size: 6.5, color: col }); cp.drawText(String(it.n), { x: x0 + 5 - FB.widthOfTextAtSize(String(it.n), 6.5) / 2, y: top - 8.8, size: 6.5, font: FB, color: rgb(1, 1, 1) });
      }
    }
  }
  function diffRuns(a, z) {
    const ops = tk.wordDiff(a, z);
    const runs = [];
    ops.forEach((o, i) => {
      if (o.t !== '=') { runs.push({ t: o.t, s: o.s }); return; }
      const words = o.s.split(/(\s+)/);
      if (words.length <= 16) { runs.push({ t: '=', s: o.s }); return; }
      const head = i === 0 ? '' : words.slice(0, 10).join('');
      const tail = i === ops.length - 1 ? '' : words.slice(-10).join('');
      runs.push({ t: '=', s: head }); runs.push({ t: '…', s: ' ... ' }); runs.push({ t: '=', s: tail });
    });
    return runs.map(r => ({ ...r, s: clean(r.s) }));
  }
  function layoutRuns(runs, size, maxW) {
    const lines = [[]]; let x = 0;
    for (const r of runs) for (const tok of r.s.split(/(\s+)/)) {
      if (!tok) continue;
      const wd = F.widthOfTextAtSize(tok, size);
      if (x + wd > maxW && !/^\s+$/.test(tok) && x > 0) { lines.push([]); x = 0; }
      if (x === 0 && /^\s+$/.test(tok)) continue;
      lines[lines.length - 1].push({ t: r.t, s: tok, x, w: wd }); x += wd;
    }
    return lines;
  }
  function noteHeight(it, W = M - 22) {
    let hgt = 14;
    if (it.a != null) hgt += layoutRuns(diffRuns(it.a, it.z), 7.2, W).length * 9.4 + 3;
    if (it.quote) hgt += wrap(clean(`"${it.quote}"`), FI, 7.2, W).length * 9.4 + 2;
    if (it.note) hgt += wrap(clean(it.note), FI, 7.2, W).length * 9.4 + 2;
    for (const rp of it.replies || []) hgt += wrap(clean(`${rp.byName}: ${rp.text}`), F, 6.8, W - 8).length * 8.8 + 2;
    return hgt + 8;
  }
  function drawNote(page, it, x, y, col, W = M - 22) {
    const head = `${it.kind === 'applied' ? 'Applied' : it.kind === 'sug' ? `Suggestion${it.cat ? ` (${catLabel(it.cat)})` : ''}` : it.kind === 'mark' ? 'Highlight' : `Comment${it.status === 'resolved' ? ' (resolved)' : ''}`} - ${it.who || ''}`;
    page.drawText(clean(head).slice(0, 70), { x: x + 12, y: y - 9, size: 7.6, font: FB, color: col });
    page.drawText(clean(blockLabel(p, it.b).split(' · ')[0]), { x: x + W - FB.widthOfTextAtSize(clean(blockLabel(p, it.b).split(' · ')[0]), 6.5), y: y - 9, size: 6.5, font: F, color: C.muted });
    let yy = y - 14;
    if (it.a != null) {
      for (const line of layoutRuns(diffRuns(it.a, it.z), 7.2, W)) {
        yy -= 9.4;
        for (const tkn of line) {
          const color = tkn.t === '-' ? C.del : tkn.t === '+' ? C.ins : tkn.t === '…' ? C.muted : C.ink;
          page.drawText(tkn.s, { x: x + tkn.x, y: yy, size: 7.2, font: tkn.t === '=' || tkn.t === '…' ? F : FB, color });
          if (tkn.t === '-' && tkn.s.trim()) page.drawLine({ start: { x: x + tkn.x, y: yy + 2.4 }, end: { x: x + tkn.x + tkn.w, y: yy + 2.4 }, thickness: 0.6, color: C.del });
          if (tkn.t === '+' && tkn.s.trim()) page.drawLine({ start: { x: x + tkn.x, y: yy - 1.2 }, end: { x: x + tkn.x + tkn.w, y: yy - 1.2 }, thickness: 0.5, color: C.ins });
        }
      }
      yy -= 3;
    }
    if (it.quote) for (const l of wrap(clean(`"${it.quote}"`), FI, 7.2, W)) { yy -= 9.4; page.drawText(l, { x, y: yy, size: 7.2, font: FI, color: C.muted }); }
    if (it.note) { yy -= 2; for (const l of wrap(clean(it.note), FI, 7.2, W)) { yy -= 9.4; page.drawText(l, { x, y: yy, size: 7.2, font: FI, color: C.ink }); } }
    for (const rp of it.replies || []) for (const l of wrap(clean(`${rp.byName}: ${rp.text}`), F, 6.8, W - 8)) { yy -= 8.8; page.drawText(l, { x: x + 8, y: yy, size: 6.8, font: F, color: C.muted }); }
    page.drawLine({ start: { x, y: yy - 4 }, end: { x: x + W, y: yy - 4 }, thickness: 0.3, color: C.line });
    return yy - 8;
  }
  function wrap(text, font, size, maxW) {
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const wd of words) { const t = cur ? `${cur} ${wd}` : wd; if (font.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = wd; } else cur = t; }
    if (cur) lines.push(cur);
    return lines;
  }
  const blob = new Blob([await out.save()], { type: 'application/pdf' });
  if (!download) return blob;
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${p.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manuscript'}-annotated.pdf`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  toast(`Annotated PDF ready: ${items.length} notes`, 'ok');
}

// ── PDF documents written in the browser (pdf-lib): the review report, and the diff of a PDF upload ──
async function flowDoc(title) {
  await loadScript('/vendor/pdf-lib.min.js');
  const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(title); pdf.setProducer('Research Studio'); pdf.setCreator('Research Studio');
  const F = await pdf.embedFont(StandardFonts.Helvetica), FB = await pdf.embedFont(StandardFonts.HelveticaBold), FI = await pdf.embedFont(StandardFonts.HelveticaOblique), FS = await pdf.embedFont(StandardFonts.TimesRoman), FSB = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const okChar = new Map();
  const clean = s => [...String(s ?? '')].map(ch => { if (MAP[ch] != null) return MAP[ch]; if (!okChar.has(ch)) { try { F.widthOfTextAtSize(ch, 8); okChar.set(ch, true); } catch { okChar.set(ch, false); } } return okChar.get(ch) ? ch : '?'; }).join('').replace(/[\r\t]+/g, ' ');
  const C = { ink: rgb(0.08, 0.1, 0.15), muted: rgb(0.42, 0.45, 0.51), brand: rgb(0.2, 0.27, 0.78), del: rgb(0.71, 0.14, 0.09), ins: rgb(0.04, 0.42, 0.62), line: rgb(0.85, 0.83, 0.78), soft: rgb(0.965, 0.955, 0.93), warn: rgb(0.7, 0.42, 0) };
  const W = 595.28, H = 841.89, M = 54, CW = W - 2 * M;
  let page = null, y = 0;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = h => { if (!page || y - h < M) newPage(); };
  const wrap = (text, font, size, maxW) => {
    const out = [];
    for (const para of clean(text).split('\n')) {
      let cur = '';
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const t = cur ? `${cur} ${w}` : w;
        if (font.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
      }
      out.push(cur);
    }
    return out;
  };
  const api = {
    clean, C, rgb, pdf,
    text(str, { size = 10, font = F, color = C.ink, indent = 0, gap = 5, lead = 1.38 } = {}) {
      for (const l of wrap(str, font, size, CW - indent)) { ensure(size * lead); page.drawText(l, { x: M + indent, y: y - size, size, font, color }); y -= size * lead; }
      y -= gap;
    },
    heading(str, level = 1) {
      const size = level === 0 ? 20 : level === 1 ? 14 : 11.5;
      ensure(size * 3);
      y -= level === 0 ? 0 : 8;
      for (const l of wrap(str, FB, size, CW)) { ensure(size * 1.3); page.drawText(l, { x: M, y: y - size, size, font: FB, color: level === 0 ? C.ink : level === 1 ? C.brand : C.ink }); y -= size * 1.3; }
      if (level === 1) { page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.6, color: C.line }); y -= 4; }
      y -= 4;
    },
    /** Word diff with deletions struck through in red and insertions underlined in blue. */
    diff(a, z, { size = 9.5, indent = 0, lead = 1.45 } = {}) {
      const runs = tk.wordDiff(String(a || ''), String(z || '')).map(o => ({ t: o.t, s: clean(o.s) }));
      const maxW = CW - indent;
      let x = 0;
      const lines = [[]];
      for (const r of runs) for (const tok of r.s.split(/(\s+)/)) {
        if (!tok) continue;
        const font = r.t === '=' ? FS : FSB;
        if (/\n/.test(tok)) { lines.push([]); x = 0; continue; }
        const wd = font.widthOfTextAtSize(tok, size);
        if (x + wd > maxW && !/^\s+$/.test(tok) && x > 0) { lines.push([]); x = 0; }
        if (x === 0 && /^\s+$/.test(tok)) continue;
        lines[lines.length - 1].push({ t: r.t, s: tok, x, w: wd, font }); x += wd;
      }
      for (const line of lines) {
        ensure(size * lead);
        for (const k of line) {
          const color = k.t === '-' ? C.del : k.t === '+' ? C.ins : C.ink;
          page.drawText(k.s, { x: M + indent + k.x, y: y - size, size, font: k.font, color });
          if (k.t === '-' && k.s.trim()) page.drawLine({ start: { x: M + indent + k.x, y: y - size + size * 0.33 }, end: { x: M + indent + k.x + k.w, y: y - size + size * 0.33 }, thickness: 0.7, color: C.del });
          if (k.t === '+' && k.s.trim()) page.drawLine({ start: { x: M + indent + k.x, y: y - size - 1.6 }, end: { x: M + indent + k.x + k.w, y: y - size - 1.6 }, thickness: 0.6, color: C.ins });
        }
        y -= size * lead;
      }
      y -= 6;
    },
    table(rows, widths, { size = 9 } = {}) {
      const total = widths.reduce((n, w) => n + w, 0), ws = widths.map(w => (w / total) * CW);
      rows.forEach((r, ri) => {
        const cells = r.map((c, i) => wrap(String(c ?? ''), ri === 0 ? FB : F, size, ws[i] - 8));
        const h = Math.max(...cells.map(c => c.length)) * size * 1.3 + 6;
        ensure(h);
        if (ri === 0) page.drawRectangle({ x: M, y: y - h, width: CW, height: h, color: C.soft });
        let x = M;
        cells.forEach((c, i) => { c.forEach((l, k) => page.drawText(l, { x: x + 4, y: y - 4 - size - k * size * 1.3, size, font: ri === 0 ? FB : F, color: C.ink })); x += ws[i]; });
        y -= h;
        page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.4, color: C.line });
      });
      y -= 8;
    },
    space(h = 8) { y -= h; },
    label(str) { ensure(24); page.drawText(clean(str).slice(0, 110), { x: M, y: y - 8, size: 8, font: FB, color: C.muted }); y -= 13; },
    async save(name) {
      const pages = pdf.getPages();
      pages.forEach((pg, i) => { const t = `${clean(title).slice(0, 80)}  ·  ${i + 1} / ${pages.length}`; pg.drawText(t, { x: M, y: 28, size: 7.5, font: F, color: C.muted }); pg.drawText('Research Studio', { x: W - M - F.widthOfTextAtSize('Research Studio', 7.5), y: 28, size: 7.5, font: F, color: C.muted }); });
      const blob = new Blob([await pdf.save()], { type: 'application/pdf' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    },
    fonts: { F, FB, FI, FS },
  };
  return api;
}
const fileBase = p => (p.title || 'manuscript').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manuscript';

/** The review report as a PDF document (no print dialog). */
export async function reportPdf(p) {
  const d = await flowDoc(`${p.title} — review report`);
  const { F, FI } = d.fonts;
  const total = p.reading.length;
  const readers = p.members.filter(m => m.role !== 'owner' && m.status === 'active');
  const lint = (p.lint && p.lint.issues || []).filter(i => i.sev !== 'info');
  const claims = (p.evidence && p.evidence.claims || []).filter(c => ['mismatch', 'partly'].includes(c.override || c.verdict));
  const rc = p.refcheck && p.refcheck.refs ? p.refcheck.refs.filter(r => ['problem', 'notfound', 'retracted'].includes(r.verdict)) : [];
  const changed = p.blocks.filter(b => b.cur !== b.text);
  const open = p.suggestions.filter(s => s.status === 'open');
  d.label('RESEARCH STUDIO · REVIEW REPORT');
  d.heading(p.title, 0);
  d.text(`${fmtDate(new Date().toISOString())} · ${total} blocks · ${readers.length} proofreader(s) · ${changed.length} paragraphs changed · ${open.length} open notes`, { color: d.C.muted, size: 9.5, gap: 10 });
  d.heading('Readers', 1);
  if (readers.length) d.table([['Reader', 'Read', 'Reading checks', 'Fast reads', 'Time', 'Suggestions'], ...readers.map(m => { const pr = m.progress || { read: 0, checks: { asked: 0, passed: 0 }, fast: 0, time: 0 }; return [m.name, `${pr.read}/${total}${pr.done ? ' (done)' : ''}`, pr.checks.asked ? `${pr.checks.passed}/${pr.checks.asked}` : '-', String(pr.fast || 0), fmtMin(pr.time), String(p.suggestions.filter(s => s.by === m.sub).length)]; })], [3, 1.3, 1.5, 1.1, 1, 1.2]);
  else d.text('No proofreaders yet.', { color: d.C.muted });
  d.heading('Findings', 1);
  d.heading(`Consistency (${lint.length})`, 2);
  if (lint.length) for (const i of lint) d.text(`• ${i.code}: ${i.msg}${i.bid && p.blockById.get(i.bid) ? ` — ${blockLabel(p, p.blockById.get(i.bid))}` : ''}`, { size: 9.5, indent: 6, gap: 2 });
  else d.text('None.', { color: d.C.muted });
  d.heading(`Numbers against tables and figures (${claims.length} problem${claims.length === 1 ? '' : 's'}${p.evidence ? ` of ${p.evidence.claims.length} claims` : ', not run'})`, 2);
  for (const c of claims) d.text(`• "${c.quote}" — ${c.explain || ''}${c.expected ? ` Evidence: ${c.expected}` : ''}`, { size: 9.5, indent: 6, gap: 2 });
  if (p.evidence && p.evidence.consistency && p.evidence.consistency.length) { d.heading('Reported inconsistently', 2); for (const x of p.evidence.consistency) d.text(`• ${x.explain}`, { size: 9.5, indent: 6, gap: 2 }); }
  d.heading(`References${p.refcheck && p.refcheck.summary ? ` (score ${p.refcheck.summary.score ?? '-'})` : ''}`, 2);
  if (rc.length) for (const r of rc) d.text(`• [${r.i + 1}] ${r.raw} — ${r.verdict}: ${(r.issues || []).map(i => i.msg).join('; ')}`, { size: 9, indent: 6, gap: 2 });
  else d.text(p.refcheck ? 'No problems found.' : 'Not checked.', { color: d.C.muted });
  d.heading(`Changes made (${changed.length})`, 1);
  d.text('Deleted text is red and struck through; inserted text is blue and underlined.', { size: 8.5, font: FI, color: d.C.muted, gap: 8 });
  for (const b of changed) { d.label(blockLabel(p, b)); d.diff(b.text, b.cur); }
  if (!changed.length) d.text('None yet.', { color: d.C.muted });
  d.heading(`Open suggestions and comments (${open.length})`, 1);
  for (const s of open) {
    const b = p.blockById.get(s.bid);
    d.label(`${b ? blockLabel(p, b) : ''} · ${s.byName}${s.kind === 'edit' ? ` · ${catLabel(s.cat)}` : s.kind === 'mark' ? ' · highlight' : ' · comment'}`);
    if (s.kind === 'edit') d.diff(s.base, s.text);
    if (s.quote) d.text(`"${s.quote}"`, { size: 9, font: FI, color: d.C.muted, gap: 2 });
    if (s.note) d.text(s.note, { size: 9.5, font: F, gap: 6 });
  }
  if (!open.length) d.text('None.', { color: d.C.muted });
  await d.save(`${fileBase(p)}-review-report.pdf`);
}

/** Diff of a PDF upload: every changed paragraph, original against current, in reading order. */
export async function diffPdf(p) {
  const d = await flowDoc(`${p.title} — changes`);
  const changed = p.blocks.filter(b => b.cur !== b.text);
  d.label('RESEARCH STUDIO · CHANGES');
  d.heading(p.title, 0);
  d.text(`${fmtDate(new Date().toISOString())} · ${changed.length} of ${p.blocks.length} paragraphs changed. Deleted text is red and struck through; inserted text is blue and underlined.`, { color: d.C.muted, size: 9.5, gap: 12 });
  let sec = null;
  for (const b of changed) {
    const s = p.sections.find(x => x.id === b.sec);
    if (s && s !== sec) { sec = s; d.heading(`${s.num ? `${s.num} ` : ''}${s.title}`, 2); }
    d.label(blockLabel(p, b));
    d.diff(b.text, b.cur, { size: 10 });
  }
  if (!changed.length) d.text('No paragraph has been changed yet.', { color: d.C.muted });
  await d.save(`${fileBase(p)}-changes.pdf`);
}

/** Printable report (rendered into the page and printed; save as PDF from the print dialog). */
export function printReport(p) {
  const el = document.createElement('div');
  el.id = 'print-root';
  const total = p.reading.length;
  const readers = p.members.filter(m => m.role !== 'owner' && m.status === 'active');
  const lint = (p.lint && p.lint.issues || []).filter(i => i.sev !== 'info');
  const claims = (p.evidence && p.evidence.claims || []).filter(c => ['mismatch', 'partly'].includes(c.override || c.verdict));
  const rc = p.refcheck && p.refcheck.refs ? p.refcheck.refs.filter(r => ['problem', 'notfound', 'retracted'].includes(r.verdict)) : [];
  const diffHtml = (a, b) => tk.wordDiff(a, b).map(o => (o.t === '=' ? esc(o.s) : o.t === '-' ? `<del>${esc(o.s)}</del>` : `<ins>${esc(o.s)}</ins>`)).join('');
  const changed = p.blocks.filter(b => b.cur !== b.text);
  const open = p.suggestions.filter(s => s.status === 'open');
  el.innerHTML = `<article class="report">
    <header><div class="r-brand">Research Studio · Review report</div><h1>${esc(p.title)}</h1><p>${fmtDate(new Date().toISOString())} · ${total} blocks · ${readers.length} proofreader(s) · ${changed.length} paragraphs changed · ${open.length} open notes</p></header>
    <h2>Readers</h2>${readers.length ? `<table><tr><th>Reader</th><th>Read</th><th>Reading checks</th><th>Fast reads</th><th>Time</th><th>Suggestions</th></tr>${readers.map(m => { const pr = m.progress || { read: 0, checks: { asked: 0, passed: 0 }, fast: 0, time: 0 }; return `<tr><td>${esc(m.name)}</td><td>${pr.read}/${total}${pr.done ? ' ✓' : ''}</td><td>${pr.checks.asked ? `${pr.checks.passed}/${pr.checks.asked}` : '—'}</td><td>${pr.fast || 0}</td><td>${fmtMin(pr.time)}</td><td>${p.suggestions.filter(s => s.by === m.sub).length}</td></tr>`; }).join('')}</table>` : '<p>No proofreaders.</p>'}
    <h2>Findings</h2>
    <h3>Consistency (${lint.length})</h3>${lint.length ? `<ul>${lint.map(i => `<li><b>${esc(i.code)}</b> ${esc(i.msg)}${i.bid && p.blockById.get(i.bid) ? ` <span class="w">— ${esc(blockLabel(p, p.blockById.get(i.bid)))}</span>` : ''}</li>`).join('')}</ul>` : '<p>None.</p>'}
    <h3>Numbers vs. tables and figures (${claims.length} problems${p.evidence ? ` of ${p.evidence.claims.length} claims` : ', not run'})</h3>${claims.length ? `<ul>${claims.map(c => `<li>“${esc(c.quote)}” — ${esc(c.explain || '')}${c.expected ? ` <b>Evidence:</b> ${esc(c.expected)}` : ''}</li>`).join('')}</ul>` : ''}
    ${p.evidence && p.evidence.consistency.length ? `<h3>Reported inconsistently</h3><ul>${p.evidence.consistency.map(x => `<li>${esc(x.explain)}</li>`).join('')}</ul>` : ''}
    <h3>References${p.refcheck && p.refcheck.summary ? ` (score ${p.refcheck.summary.score ?? '—'})` : ''}</h3>${rc.length ? `<ul>${rc.map(r => `<li>[${r.i + 1}] ${esc(r.raw)} — <b>${esc(r.verdict)}</b>: ${esc((r.issues || []).map(i => i.msg).join('; '))}</li>`).join('')}</ul>` : `<p>${p.refcheck ? 'No problems found.' : 'Not checked.'}</p>`}
    <h2>Changes made (${changed.length})</h2>${changed.map(b => `<div class="chg"><div class="w">${esc(blockLabel(p, b))}</div><p>${diffHtml(b.text, b.cur)}</p></div>`).join('') || '<p>None yet.</p>'}
    <h2>Open suggestions and comments (${open.length})</h2>${open.map(s => { const b = p.blockById.get(s.bid); return `<div class="chg"><div class="w">${esc(b ? blockLabel(p, b) : '')} · ${esc(s.byName)}${s.kind === 'edit' ? ` · ${esc(catLabel(s.cat))}` : ' · comment'}</div>${s.kind === 'edit' ? `<p>${diffHtml(s.base, s.text)}</p>` : ''}${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}</div>`; }).join('') || '<p>None.</p>'}
  </article>`;
  document.body.appendChild(el);
  document.body.classList.add('printing');
  const done = () => { el.remove(); document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 100);
}
