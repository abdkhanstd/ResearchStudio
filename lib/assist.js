/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Rule-based checks for the self-hosted edition, which runs without an AI service.
 * Same interface as the hosted AI client for the parts that work without one:
 *   quiz({ items })                 reading checks: fill-in-the-blank questions made from the paragraph itself
 *   claims({ items })               numbers in the text that report results
 *   verify({ evidence, items })     each number compared with the paper's own tables and figure data
 *   consistency({ items })          the same quantity reported with different values in different places
 * Everything is deterministic: the same paragraph always gives the same questions.
 */
const crypto = require('crypto');

const STOP = new Set(('the a an and or of to in on for with by from as at is are was were be been being this that these those it its we our their they them which who whom whose than then also into over under between within without about after before such each per via both more most less least other some any not no can may might will would should could has have had do does did using used use based show shows shown here there when where while what how why all only very much many one two three first second new same different paper approach method results result work works however therefore thus because since although whether').split(' '));
const METRICS = ['accuracy', 'acc', 'precision', 'recall', 'f1', 'f-score', 'auc', 'auroc', 'auprc', 'map', 'iou', 'miou', 'bleu', 'rouge', 'error', 'loss', 'perplexity', 'cost', 'latency', 'throughput', 'speedup', 'risk', 'rate', 'score', 'mae', 'mse', 'rmse', 'psnr', 'ssim', 'dice', 'r2', 'correlation', 'coverage', 'reduction', 'improvement', 'gain', 'runtime', 'time', 'memory', 'parameters', 'params', 'flops'];

const hash = s => crypto.createHash('sha256').update(String(s)).digest();
const seededShuffle = (arr, seed) => { const h = hash(seed); const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = h[i % h.length] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const toNum = s => { const t = String(s).replace(/[−–]/g, '-').replace(/\s/g, '').replace(/%$/, '').replace(/,(?=\d{3}\b)/g, ''); const v = Number(t.replace(',', '.')); return Number.isFinite(v) ? v : null; };
const decimals = s => { const m = /[.,](\d+)/.exec(String(s).replace(/%$/, '').replace(/,(?=\d{3}\b)/g, '')); return m ? m[1].length : 0; };
const words = s => String(s).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];

/** Sentences as exact substrings of the text (so quotes can be found again). */
function sentences(text) {
  const out = [];
  const re = /[^.!?]*?(?:\d[.,]\d[^.!?]*?)*[.!?](?=\s+[A-Z(\[]|\s*$)|[^.!?]+$/g;
  let m;
  while ((m = re.exec(text))) { const s = m[0].trim(); if (s.length > 15) out.push(s); if (re.lastIndex === m.index) re.lastIndex++; }
  return out;
}
/** Numbers that read like results (decimals, percentages, or numbers next to a metric), not years, citations or labels. */
function resultNumbers(sentence) {
  const out = [];
  const re = /(?<![\w.\-])[−-]?\d+(?:[.,]\d+)?\s?%?(?![\w.]*\d)/g;
  let m;
  while ((m = re.exec(sentence))) {
    const raw = m[0].trim();
    const before = sentence.slice(Math.max(0, m.index - 14), m.index);
    if (/(table|tab\.|fig\.|figure|section|sec\.|eq\.|equation|algorithm|appendix|step|stage|phase|line)\s*~?\s*$/i.test(before)) continue;
    if (/\[\s*[\d,\s–-]*$/.test(sentence.slice(0, m.index)) && /^[\d,\s–-]*\]/.test(sentence.slice(m.index + m[0].length - 1))) continue;
    const v = toNum(raw);
    if (v == null) continue;
    // settings, not results: "α = 0.3", "set to 1%", numbers inside inline maths
    if (/(=|≈|set to|equal to|threshold of|fixed at)\s*$/i.test(before) || ((sentence.slice(0, m.index).match(/\$/g) || []).length % 2 === 1)) continue;
    const isPct = /%$/.test(raw), isDec = /[.,]\d/.test(raw);
    if (!isPct && !isDec && Number.isInteger(v) && v >= 1900 && v <= 2100) continue;
    const near = words(sentence.slice(Math.max(0, m.index - 40), m.index + raw.length + 30));
    if (!isPct && !isDec && !near.some(w => METRICS.includes(w))) continue;
    out.push({ raw, index: m.index, v });
  }
  return out;
}

// ── reading checks ─────────────────────────────────────────
function quiz({ items }) {
  const all = items.map(it => ({ ...it, sents: sentences(String(it.text || '')) }));
  const pool = { num: [], word: [] };
  for (const it of all) for (const s of it.sents) {
    for (const n of resultNumbers(s)) pool.num.push(n.raw);
    for (const w of s.match(/\b[A-Za-z][A-Za-z-]{6,}\b/g) || []) if (!STOP.has(w.toLowerCase())) pool.word.push(w);
  }
  return all.map(it => {
    const questions = [];
    const used = new Set();
    // sentences that read as prose: little or no maths; plain ones first (stable sort keeps the seeded order)
    const plainFirst = seededShuffle(it.sents.filter(x => x.length >= 50 && x.length <= 420 && mathShare(x) <= 0.15 && /^[A-Z0-9“"‘(]/.test(x) && !/^\(\s*$/.test(x[0] + x[1])), it.text).sort((a, b) => /[$\\{}]/.test(a) - /[$\\{}]/.test(b));
    for (const s of plainFirst) {
      if (questions.length >= 2) break;
      const nums = resultNumbers(s);
      let answer = null, kind = null;
      if (nums.length) { answer = nums[0].raw; kind = 'num'; }
      else {
        // a content word of the prose, never part of a LaTeX command or of maths
        const prose = s.replace(/\$[^$]*\$/g, m => ' '.repeat(m.length)).replace(/\\[A-Za-z@]+\*?/g, m => ' '.repeat(m.length));
        const cands = (prose.match(/\b[A-Za-z][A-Za-z-]{6,}\b/g) || []).filter((w, i) => i > 0 && !STOP.has(w.toLowerCase()) && !used.has(w.toLowerCase()) && s.indexOf(w) === prose.indexOf(w));
        if (cands.length) { answer = cands.sort((a, b) => b.length - a.length)[0]; kind = 'word'; }
      }
      if (!answer || used.has(answer.toLowerCase())) continue;
      const distract = kind === 'num' ? numberDistractors(answer, pool.num, s) : wordDistractors(answer, pool.word, s);
      if (distract.length < 3) continue;
      used.add(answer.toLowerCase());
      const at = s.indexOf(answer);
      let shown = `${s.slice(0, at)}_____${s.slice(at + answer.length)}`;
      if (shown.length > 240) { const c = Math.max(0, at - 110); shown = `${c ? '…' : ''}${shown.slice(c, c + 230)}…`; }
      const options = seededShuffle([answer, ...distract.slice(0, 3)], `${s}|opts`);
      questions.push({ q: `Fill in the blank, as the paragraph says it: “${shown}”`, options, answer: options.indexOf(answer), why: `The paragraph says: “${s.length > 280 ? `${s.slice(0, 277)}…` : s}”` });
    }
    return { b: it.b, questions };
  });
}
function numberDistractors(ans, pool, sentence = '') {
  const v = toNum(ans), d = decimals(ans), pct = /%$/.test(ans);
  const grouped = /\d,\d{3}\b/.test(ans); // "4,000" style
  const fmt = x => `${grouped ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : x.toFixed(d)}${pct ? '%' : ''}`;
  const out = [];
  for (const p of seededShuffle([...new Set(pool)], ans)) if (p !== ans && !sentence.includes(p) && /%$/.test(p) === pct && decimals(p) === d && toNum(p) !== v && out.length < 3) out.push(p);
  const steps = [0.07, -0.11, 0.16, -0.21, 0.27];
  for (const k of steps) { if (out.length >= 3) break; let x = v * (1 + k); if (Math.abs(x - v) < 10 ** -d) x = v + Math.sign(k || 1) * 10 ** -d * (out.length + 1); const f = fmt(pct ? Math.min(100, Math.max(0, x)) : x); if (f !== ans && !out.includes(f)) out.push(f); }
  return out;
}
/** Share of a sentence taken by maths and LaTeX commands. */
const mathShare = s => { let n = 0; for (const m of s.match(/\$[^$]*\$|\\[A-Za-z@]+\*?(\{[^}]*\})?/g) || []) n += m.length; return n / Math.max(1, s.length); };
/** Word form, so wrong options look like the right one ("calibrated" with "estimated", not with "together"). */
const FORMS = ['ing', 'ed', 'tion', 'sion', 'ment', 'ness', 'ity', 'ance', 'ence', 'ly', 'ous', 'ive', 'able', 'ible', 'al', 'er', 'or', 'ic', 's'];
const formOf = w => FORMS.find(f => w.toLowerCase().endsWith(f)) || '';
function wordDistractors(ans, pool, sentence) {
  const cap = /^[A-Z]/.test(ans), form = formOf(ans);
  const ok = [...new Set(pool)].filter(w => w.toLowerCase() !== ans.toLowerCase() && /^[A-Z]/.test(w) === cap && !sentence.includes(w) && Math.abs(w.length - ans.length) <= 5);
  // same word form first; others only when there are not enough
  const same = seededShuffle(ok.filter(w => formOf(w) === form), ans);
  return [...same, ...seededShuffle(ok.filter(w => formOf(w) !== form), ans)].slice(0, 3);
}

// a difference ("by 2.1 points", "12× less") rather than a value of its own
const DELTA = /\b(by|points?|pp|improv\w*|gain\w*|higher|lower|better|worse|more|less|fewer|reduc\w*|increas\w*|decreas\w*|drops?|outperform\w*|faster|slower|times|fold)\b|×|\\times/i;
const isDelta = (sentence, raw) => { const i = sentence.indexOf(raw); return i >= 0 && DELTA.test(sentence.slice(Math.max(0, i - 28), i + raw.length + 22)); };

// ── evidence: claims ───────────────────────────────────────
function claims({ items, evidence = [] }) {
  const out = [];
  const caps = evidence.map(e => ({ label: e.label, w: new Set(words(`${e.label} ${e.caption || ''}`).filter(x => x.length > 3 && !STOP.has(x))) }));
  for (const it of items) {
    for (const s of sentences(String(it.text || ''))) {
      let refers = [...s.matchAll(/\b(fig(?:ure)?s?\.?|tab(?:le)?s?\.?)\s*~?\s*(\d+|[IVXL]+)/gi)].map(m => `${/^fig/i.test(m[1]) ? 'Fig.' : 'Table'} ${m[2]}`);
      if (!refers.length && caps.length) {
        // no explicit reference: the table or figure whose caption shares the most words with the sentence
        const sw = new Set(words(s));
        refers = caps.map(c => ({ c, n: [...c.w].filter(x => sw.has(x)).length })).filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.c.label);
      }
      for (const n of resultNumbers(s)) {
        // the clause around the number, so several numbers in one sentence become separate claims
        const left = Math.max(...[', ', '; ', ' and ', ' while ', ' whereas '].map(d => { const i = s.lastIndexOf(d, n.index); return i >= 0 ? i + d.length : -1; }));
        const rightIdx = [', ', '; ', ' and ', ' while ', ' whereas '].map(d => s.indexOf(d, n.index + n.raw.length)).filter(i => i >= 0);
        const right = rightIdx.length ? Math.min(...rightIdx) : s.length;
        let quote = s.slice(left >= 0 ? left : 0, right).trim();
        if (quote.length < 12) quote = s;
        const metric = words(s).find(w => METRICS.includes(w)) || '';
        const subject = (s.match(/\b[A-Z][A-Za-z0-9-]*(?:\s[A-Z][A-Za-z0-9-]*)*/g) || []).filter(w => !STOP.has(w.toLowerCase()) && !/^(Table|Fig|Figure|Section|We|Our|In|On|The|This)$/.test(w)).join(', ').slice(0, 150);
        // names from the whole sentence help to find the table column later
        out.push({ b: it.b, quote, value: n.raw, metric, subject: subject || s.slice(0, 150), kind: 'result', refers });
      }
    }
  }
  return out;
}

// ── evidence: verification ─────────────────────────────────
function parseEvidence(text) {
  const items = [];
  let cur = null, panel = null;
  for (const line of String(text || '').split('\n')) {
    const h = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (h) { cur = { label: h[1], caption: h[2], rows: [], series: [] }; items.push(cur); panel = null; continue; }
    if (!cur) continue;
    const pn = /^panel\s+(\S+)(?:\s+"(.*)")?/.exec(line);
    if (pn) { panel = pn[1]; continue; }
    const sm = /^\s*series "([^"]*)" \(([a-z]+)\):\s*(.*)$/.exec(line);
    if (sm) {
      const points = [...sm[3].matchAll(/\(([^,()]+),\s*(?:median\s+)?([-\d.eE]+)/g)].map(m => ({ x: m[1].trim(), y: Number(m[2]) })).filter(p => Number.isFinite(p.y));
      cur.series.push({ name: sm[1], panel, points });
      continue;
    }
    if (line.includes(' | ')) cur.rows.push(line.split(' | ').map(c => c.trim()));
  }
  return items;
}
const close = (cellStr, valueStr) => {
  const c = toNum(cellStr), v = toNum(valueStr);
  if (c == null || v == null) return false;
  const tol = 0.5 * 10 ** -decimals(valueStr) + 1e-9;
  if (Math.abs(c - v) <= tol) return true;
  if (/%$/.test(valueStr) && Math.abs(c * 100 - v) <= tol) return true; // 0.835 in the table, 83.5% in the text
  return false;
};
function verify({ evidence, items }) {
  const ev = parseEvidence(evidence);
  return items.map(c => {
    const qw = new Set(words(c.quote)), sw = new Set([...qw, ...words(c.subject), ...words(c.metric)]);
    const mentions = (cell, set = qw) => { const w = words(cell).filter(x => !STOP.has(x)); return w.length && w.every(x => set.has(x)); };
    const xsNamed = (c.quote.match(/\d+(?:\.\d+)?/g) || []).filter(x => toNum(x) !== toNum(c.value));
    // 1. the value is in a referenced table or figure
    for (const it of ev) {
      const head = it.rows[0] || [];
      for (const [ri, row] of it.rows.entries()) for (const [ci, cell] of row.entries()) {
        if (ri === 0 && it.rows.length > 1) continue;
        if (close(cell, c.value)) return { c: c.id, verdict: 'consistent', where: `${it.label}, row “${row[0]}”${head[ci] ? `, column “${head[ci]}”` : ''}`, expected: cell, explain: `${c.value} matches ${it.label} (${row[0]}${head[ci] ? `, ${head[ci]}` : ''}: ${cell}).` };
      }
      for (const s of it.series) {
        const ys = s.points.map(p => p.y), range = Math.max(...ys) - Math.min(...ys) || Math.abs(ys[0]) || 1;
        const v = toNum(c.value);
        const pctV = /%$/.test(c.value) && Math.max(...ys) <= 1.5 ? v / 100 : v;
        const named = s.points.filter(p => xsNamed.includes(String(p.x)));
        const hit = (named.length ? named : s.points).map(p => ({ p, d: Math.abs(p.y - pctV) })).sort((a, b) => a.d - b.d).filter(x => x.d <= Math.max(0.02 * range, 0.5 * 10 ** -decimals(c.value))).map(x => x.p)[0];
        if (hit && (it.series.length === 1 || mentions(s.name))) return { c: c.id, verdict: 'consistent', where: `${it.label}${s.panel ? ` ${s.panel}` : ''}, ${s.name} at ${hit.x}`, expected: String(hit.y), explain: `${c.value} agrees with the plotted value (${hit.y} at ${hit.x}, read from the figure).` };
      }
    }
    // 2a. a difference: compare with the differences between rows of the matched column
    if (isDelta(c.quote, c.value)) {
      for (const it of ev) {
        const head = it.rows[0] || [];
        for (let col = 1; col < head.length; col++) {
          const rows = it.rows.slice(1).filter(r => toNum(r[col]) != null);
          for (const a of rows) for (const b of rows) {
            if (a === b) continue;
            const d = toNum(a[col]) - toNum(b[col]);
            if (d > 0 && close(d.toFixed(Math.max(decimals(a[col]), decimals(b[col]))), c.value) && (mentions(a[0]) || mentions(a[0], sw))) return { c: c.id, verdict: 'consistent', where: `${it.label}, ${a[0]} − ${b[0]} (${head[col]})`, expected: d.toFixed(decimals(c.value)), explain: `${c.value} is the difference between ${a[0]} (${a[col]}) and ${b[0]} (${b[col]}) in ${it.label}.` };
          }
        }
      }
      return { c: c.id, verdict: 'unverifiable', explain: 'This reads as a difference or a ratio; it does not match a difference between two rows of the referenced tables.' };
    }
    // 2b. a table row and column named in the sentence hold a different number
    for (const it of ev) {
      const head = it.rows[0] || [];
      // the row named closest before the number (several methods can be named in one sentence)
      const at = c.quote.indexOf(c.value);
      const named = it.rows.slice(1).filter(r => r[0] && mentions(r[0])).map(r => { const i = c.quote.toLowerCase().lastIndexOf(words(r[0])[0] || '\u0000', at >= 0 ? at : undefined); return { r, d: i >= 0 && at >= 0 ? at - i : 1e6 }; }).sort((a, b) => a.d - b.d);
      const row = named.length ? named[0].r : null;
      if (!row) continue;
      const numericCols = head.map((h, i) => i).filter(i => i > 0 && toNum(row[i]) != null);
      let col = head.findIndex((h, i) => i > 0 && h && (mentions(h, sw) || words(h).some(w => METRICS.includes(w) && sw.has(w))));
      if (col < 0 && numericCols.length === 1) col = numericCols[0];
      if (col > 0 && row[col] && toNum(row[col]) != null) {
        const fix = c.quote.replace(c.value, `${row[col]}${/%$/.test(c.value) && !/%$/.test(row[col]) ? '%' : ''}`);
        return { c: c.id, verdict: 'mismatch', where: `${it.label}, row “${row[0]}”, column “${head[col]}”`, expected: row[col], explain: `The text says ${c.value}, but ${it.label} reports ${row[col]} for ${row[0]} (${head[col]}).`, fix };
      }
    }
    // 3. a figure series named in the sentence, at an x value also named there
    for (const it of ev) for (const s of it.series) {
      if (!(it.series.length === 1 || mentions(s.name))) continue;
      const at = s.points.find(p => xsNamed.includes(String(p.x)));
      if (!at) continue;
      const ys = s.points.map(p => p.y), range = Math.max(...ys) - Math.min(...ys) || 1;
      if (Math.abs(at.y - toNum(c.value)) > 0.05 * range) return { c: c.id, verdict: 'partly', where: `${it.label}${s.panel ? ` ${s.panel}` : ''}, ${s.name} at ${at.x}`, expected: String(at.y), explain: `The figure shows about ${at.y} at ${at.x} for ${s.name}; the text says ${c.value}. Values read from a figure are approximate — check the underlying data.` };
    }
    return { c: c.id, verdict: 'unverifiable', explain: 'This number was not found in the referenced tables or figure data, and no row and column named in the sentence could be matched.' };
  });
}

// ── evidence: the same quantity reported differently ───────
function consistency({ items }) {
  const keyed = [];
  const NOT = /^(Table|Fig|Figure|Section|We|Our|In|On|The|This|With|For|It|At|As|And|Of)$/;
  for (const c of items) {
    const metric = words(`${c.quote} ${c.metric || ''}`).find(w => METRICS.includes(w));
    if (!metric) continue;
    // named things in the claim: methods, datasets ("On CIFAR-10" → "cifar-10")
    const names = new Map([...(c.quote.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/g) || []), ...String(c.subject || '').split(/,\s*/).map(x => x.replace(/^(On|In|For|At|With|The)\s+/, ''))].map(x => x.trim()).filter(w => w && !NOT.test(w) && !/^\d/.test(w)).map(x => [x.toLowerCase(), x]));
    const value = c.value || (resultNumbers(c.quote)[0] || {}).raw;
    if (!names.size || !value || isDelta(c.quote, value)) continue;
    keyed.push({ id: c.id, names, metric, unit: /%$/.test(value) ? '%' : '', value, section: c.section || '' });
  }
  // the same quantity reported slightly differently: shared names, same metric and unit, close but different values
  const out = [];
  for (let i = 0; i < keyed.length; i++) for (let j = i + 1; j < keyed.length; j++) {
    const a = keyed[i], b = keyed[j];
    if (a.metric !== b.metric || a.unit !== b.unit) continue;
    const shared = [...a.names.keys()].filter(n => b.names.has(n)).map(n => a.names.get(n));
    if (!shared.length) continue;
    const va = toNum(a.value), vb = toNum(b.value);
    if (close(a.value, b.value) || close(b.value, a.value) || Math.abs(va - vb) > 0.1 * Math.max(Math.abs(va), Math.abs(vb))) continue;
    out.push({ claims: [a.id, b.id], explain: `The ${a.metric} for ${shared.slice(0, 2).join(' / ')} is given as ${a.value}${a.section ? ` (${a.section})` : ''} and as ${b.value}${b.section ? ` (${b.section})` : ''}.`, sev: 'medium' });
  }
  return out.slice(0, 50);
}

function createAssist() {
  return {
    enabled: false, // no generative AI: no proofreading suggestions, rewrites or questions to an assistant
    checks: true, // reading checks and the evidence graph work without it
    quiz: async x => quiz(x),
    claims: async x => claims(x),
    verify: async x => verify(x),
    consistency: async x => consistency(x),
    status: () => ({ mode: 'rule-based' }),
  };
}

module.exports = { createAssist, quiz, claims, verify, consistency, sentences, resultNumbers };
