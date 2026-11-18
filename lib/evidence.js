/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Evidence graph: quantitative claims in the text ↔ the paper's own tables and figures.
 *   1. candidate paragraphs (numbers, or mentions of a table/figure)
 *   2. AI extracts claims (quotes are checked against the paragraph)
 *   3. deterministic hints: where does the claimed number occur in the tables / figure data?
 *   4. AI verifies each claim against the referenced evidence (tables as grids, figures as extracted data)
 *   5. AI looks for the same quantity reported with different values in different places
 */
const crypto = require('crypto');

const labelNum = s => { const m = String(s || '').match(/(fig(?:ure)?s?\.?|tab(?:le)?s?\.?)\s*~?\s*(\d+|[IVXL]+)/i); return m ? { kind: /^fig/i.test(m[1]) ? 'figure' : 'table', num: m[2] } : null; };

function evidenceText(item, kind, maxRows = 60) {
  if (kind === 'table') {
    const g = (item.grid || []).slice(0, maxRows);
    return `[${item.label}] ${item.caption || ''}\n${g.length ? g.map(r => r.map(c => String(c || '').replace(/\s+/g, ' ').trim()).join(' | ')).join('\n') : '(table contents could not be extracted)'}`;
  }
  const d = item.data || {};
  const lines = [`[${item.label}] ${item.caption || ''}`];
  const axesLine = a => `axes: x = ${a.x ? `${a.x.title || '?'} (${a.x.type || '?'}${a.x.labels ? `: ${a.x.labels.slice(0, 30).join(', ')}` : ''})` : '?'}; y = ${a.y ? `${a.y.title || '?'} (${a.y.type || '?'}${a.y.min != null ? `, ${a.y.min}…${a.y.max}` : ''})` : '?'}`;
  const num = v => (typeof v === 'number' ? +v.toFixed(4) : v);
  const pt = p => (p.q1 != null ? `(${p.x}: median ${num(p.y)}, quartiles ${num(p.q1)}–${num(p.q3)}${p.lo != null ? `, whiskers ${num(p.lo)}–${num(p.hi)}` : ''})` : `(${p.x}, ${num(p.y)})`);
  const seriesLines = list => list.slice(0, 16).map(s => `series "${s.name || '?'}" (${s.kind || 'line'}): ${(s.points || []).slice(0, 60).map(pt).join(' ')}`);
  if (Array.isArray(d.panels) && d.panels.length > 1) {
    d.panels.forEach((pn, i) => {
      lines.push(`panel ${pn.label || i + 1}${pn.title ? ` "${pn.title}"` : ''}`);
      if (pn.axes) lines.push('  ' + axesLine(pn.axes));
      for (const l of seriesLines((d.series || []).filter(s => (s.panel || 0) === i))) lines.push('  ' + l);
    });
  } else {
    if (d.axes) lines.push(axesLine(d.axes));
    lines.push(...seriesLines(d.series || []));
  }
  if (d.source) lines.push(`data source: ${d.source}${d.source === 'vector' || d.source === 'manual' ? ' (read from the plot)' : d.source === 'ocr' ? ' (traced automatically from a raster image: approximate, allow a few percent of the axis range)' : ''}`);
  const txt = [...(item.text || []), item.ocr || ''].join(' ').replace(/\s+/g, ' ').trim();
  if (txt) lines.push(`text inside the figure: ${txt.slice(0, 1500)}`);
  if (!d.series || !d.series.length) lines.push('(no numeric data could be extracted from this figure)');
  return lines.join('\n');
}

/** Where does value v occur in the tables? → hint strings */
function findInTables(p, raw, tk) {
  const hits = [];
  for (const t of p.tables || []) {
    const g = t.grid || [];
    const head = g[0] || [];
    g.forEach((row, ri) => row.forEach((cell, ci) => {
      const nums = String(cell || '').match(/[−\-]?\d+(?:\.\d+)?/g) || [];
      if (nums.some(n => tk.sameNumber(n.replace('−', '-'), raw))) hits.push({ id: t.id, label: t.label, where: `${t.label}, row “${String(row[0] || '').slice(0, 40)}”, column “${String(head[ci] || '').slice(0, 40)}”` });
    }));
  }
  return hits;
}

async function runEvidence(p, { ai, tk, onProgress = () => {}, cancelled = () => false }) {
  const ctx = p.latex || {};
  const items = [...(p.tables || []).map(t => ({ ...t, kind: 'table' })), ...(p.figures || []).map(f => ({ ...f, kind: 'figure' }))];
  const byNum = new Map(items.map(it => [`${it.kind}:${it.num}`, it]));
  const secTitle = new Map((p.sections || []).map(s => [s.id, s.title]));
  const cand = [];
  (p.blocks || []).forEach((b, i) => {
    if (!['para', 'abstract', 'list'].includes(b.kind)) return;
    const t = tk.blockText(b, ctx);
    if (tk.extractNumbers(t).length || /\b(fig(?:ure)?s?\.?|tab(?:le)?s?\.?)\s*~?\s*\d/i.test(t)) cand.push({ b, i, t });
  });
  const claims = [];
  // batches by size
  const batches = [];
  let cur = [], size = 0;
  for (const c of cand) { if (cur.length && (size + c.t.length > 7000 || cur.length >= 8)) { batches.push(cur); cur = []; size = 0; } cur.push(c); size += c.t.length; }
  if (cur.length) batches.push(cur);
  const total = batches.length + 2;
  let step = 0;
  const evList = items.map(it => ({ label: it.label, caption: String(it.caption || '').slice(0, 300) }));
  for (const batch of batches) {
    if (cancelled()) return null;
    onProgress(++step, total, 'Finding claims');
    let out = [];
    try { out = await ai.claims({ title: p.title, evidence: evList, items: batch.map(c => ({ b: c.i + 1, text: c.t.slice(0, 4000), section: secTitle.get(c.b.sec) || '' })) }); } catch (e) { console.error('[evidence] claims', e.message); }
    for (const x of out) {
      const c = batch.find(z => z.i + 1 === Number(x.b));
      if (!c || typeof x.quote !== 'string' || !tk.findQuote(c.t, x.quote)) continue;
      const refers = [];
      for (const r of Array.isArray(x.refers) ? x.refers : []) { const ln = labelNum(r); const it = ln && byNum.get(`${ln.kind}:${ln.num}`); if (it && !refers.some(z => z.id === it.id)) refers.push({ kind: it.kind, id: it.id, label: it.label }); }
      // mentions in the quote itself
      for (const m of x.quote.matchAll(/(fig(?:ure)?s?\.?|tab(?:le)?s?\.?)\s*~?\s*(\d+|[IVXL]+)/gi)) { const it = byNum.get(`${/^fig/i.test(m[1]) ? 'figure' : 'table'}:${m[2]}`); if (it && !refers.some(z => z.id === it.id)) refers.push({ kind: it.kind, id: it.id, label: it.label }); }
      const id = crypto.createHash('sha1').update(`${c.b.id}|${x.quote}`).digest('hex').slice(0, 10);
      if (claims.some(z => z.id === id)) continue;
      claims.push({ id, bid: c.b.id, ver: c.b.ver || 0, quote: x.quote.slice(0, 600), value: x.value == null ? null : String(x.value).slice(0, 40), metric: String(x.metric || '').slice(0, 80), subject: String(x.subject || '').slice(0, 160), kind: String(x.kind || 'value').slice(0, 20), refers, section: secTitle.get(c.b.sec) || '', verdict: null });
    }
  }
  // hints from the tables
  for (const c of claims) {
    if (!c.value) continue;
    const hits = findInTables(p, c.value, tk);
    if (hits.length) {
      c.hint = hits.slice(0, 3).map(h => `the number occurs in ${h.where}`).join('; ');
      if (!c.refers.length) for (const h of hits.slice(0, 2)) if (!c.refers.some(z => z.id === h.id)) c.refers.push({ kind: 'table', id: h.id, label: h.label, inferred: true });
    }
  }
  // verify, grouped by the evidence they need
  if (cancelled()) return null;
  onProgress(++step, total, 'Checking claims against tables and figures');
  const linked = claims.filter(c => c.refers.length);
  for (const c of claims) if (!c.refers.length) { c.verdict = 'unlinked'; c.explain = 'No table or figure holds this value, and the paragraph does not point to one.'; }
  const groups = new Map();
  for (const c of linked) { const k = c.refers.map(r => r.id).sort().join(','); (groups.get(k) || groups.set(k, []).get(k)).push(c); }
  const itemById = new Map(items.map(it => [it.id, it]));
  for (const [k, list] of groups) {
    if (cancelled()) return null;
    const ev = k.split(',').map(id => itemById.get(id)).filter(Boolean).map(it => evidenceText(it, it.kind)).join('\n\n');
    for (let s = 0; s < list.length; s += 20) {
      const part = list.slice(s, s + 20);
      let out = [];
      try { out = await ai.verify({ title: p.title, evidence: ev.slice(0, 30000), items: part.map(c => ({ id: c.id, quote: c.quote, value: c.value, metric: c.metric, subject: c.subject, refers: c.refers.map(r => r.label), hint: c.hint })) }); } catch (e) { console.error('[evidence] verify', e.message); }
      for (const v of out) {
        const c = part.find(z => z.id === String(v.c));
        if (!c) continue;
        c.verdict = ['consistent', 'mismatch', 'partly', 'unverifiable'].includes(v.verdict) ? v.verdict : 'unverifiable';
        c.where = String(v.where || '').slice(0, 200); c.expected = v.expected == null ? null : String(v.expected).slice(0, 200);
        c.explain = String(v.explain || '').slice(0, 600); c.fix = v.fix && c.verdict !== 'consistent' ? String(v.fix).slice(0, 600) : null;
      }
      for (const c of part) if (!c.verdict) { c.verdict = 'unverifiable'; c.explain = c.explain || 'The AI could not judge this claim.'; }
    }
  }
  // cross-document consistency
  if (cancelled()) return null;
  onProgress(++step, total, 'Comparing numbers across sections');
  let consistency = [];
  const withVal = claims.filter(c => c.value);
  if (withVal.length >= 2) {
    try {
      const out = await ai.consistency({ title: p.title, items: withVal.slice(0, 200).map(c => ({ id: c.id, quote: c.quote, section: c.section, subject: c.subject, metric: c.metric, value: c.value })) });
      consistency = out.filter(x => Array.isArray(x.claims) && x.claims.length >= 2 && x.claims.every(id => claims.some(c => c.id === String(id))))
        .map(x => ({ id: crypto.createHash('sha1').update(x.claims.join(',')).digest('hex').slice(0, 10), claims: x.claims.map(String), explain: String(x.explain || '').slice(0, 500), sev: x.sev === 'high' ? 'high' : 'medium' }));
    } catch (e) { console.error('[evidence] consistency', e.message); }
  }
  return { at: new Date().toISOString(), claims, consistency, candidates: cand.length };
}

module.exports = { runEvidence, evidenceText, labelNum };
