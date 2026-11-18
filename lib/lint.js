/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Deterministic manuscript checks (no AI): placeholders, unresolved references, repeated words, a/an, acronyms,
 * figure/table/citation references, mixed US/UK spelling and hyphenation, duplicate sentences, brackets, numbers
 * in the abstract that appear nowhere else, LaTeX labels and citation keys.
 * lint(project, tk) → [{ id, code, sev: 'error'|'warn'|'info', bid, msg, quote, fix }]
 */
const crypto = require('crypto');

const COMMON_ACR = new Set('AI ML DL NLP CV GPU GPUs CPU CPUs TPU RAM ROM IoT USA US UK EU UN URL URLs HTTP HTTPS API APIs PDF PDFs ID IDs OK IEEE ACM RGB HD UTC GMT PhD MSc BSc DNA RNA LaTeX TeX SI ISO ASCII UTF CSV JSON XML HTML CSS SQL PC PCs OS IT FAQ CEO CTO R&D TV 2D 3D 4D 1D GB MB KB TB GHz MHz kHz Hz FPS FLOPs MSE RMSE MAE AUC ROC F1 SOTA COVID SARS WHO NASA GPS LED LCD USB WiFi Wi-Fi LTE 5G 4G 3G NAS SSD HDD CUDA ARM IID I.I.D. NN DNN CNN RNN LSTM GAN GANs VAE BERT GPT LLM LLMs ReLU SGD Adam ImageNet CIFAR MNIST COCO II III IV VI VII VIII IX XI XII ACL ICML NeurIPS ICLR CVPR ICCV ECCV AAAI IJCAI KDD WWW SIGIR EMNLP NAACL OSDI NSDI MDPI arXiv DOI ISBN ISSN Fig Eq Sec'.split(' '));
const IZE = 'optimiz normaliz generaliz recogniz organiz utiliz minimiz maximiz characteriz summariz visualiz regulariz initializ parameteriz discretiz quantiz tokeniz randomiz emphasiz realiz categoriz prioritiz stabiliz synchroniz specializ standardiz personaliz vectoriz serializ hypothesiz finaliz localiz centraliz decentraliz customiz factoriz lineariz polariz memoriz criticiz authoriz digitiz binariz anonymiz harmoniz'.split(' ');
const PAIRS = [['color', 'colour'], ['behavior', 'behaviour'], ['neighbor', 'neighbour'], ['favor', 'favour'], ['labor', 'labour'], ['honor', 'honour'], ['flavor', 'flavour'], ['modeling', 'modelling'], ['modeled', 'modelled'], ['labeled', 'labelled'], ['labeling', 'labelling'], ['traveled', 'travelled'], ['canceled', 'cancelled'], ['signaling', 'signalling'], ['center', 'centre'], ['centers', 'centres'], ['fiber', 'fibre'], ['defense', 'defence'], ['gray', 'grey'], ['analyze', 'analyse'], ['analyzed', 'analysed'], ['analyzing', 'analysing'], ['catalog', 'catalogue'], ['program', 'programme'], ['fulfill', 'fulfil'], ['enrollment', 'enrolment'], ['aging', 'ageing'], ['judgment', 'judgement'], ['acknowledgment', 'acknowledgement']];
const AN_EXC_VOWEL_A = /^(uni|use|usa|usu|ute|uti|uro|eu|ewe|one|once|ubiq|ukr|uran|utop|uvul|euler)/i; // vowel letter, consonant sound → "a"
const AN_EXC_CONS_AN = /^(hour|honest|honou?r|heir|herb\b)/i; // consonant letter, vowel sound → "an"
const VOWEL_LETTER_SOUND = new Set('AEFHILMNORSX'.split('')); // letters pronounced with a vowel sound (an MSE, an FPGA)

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

function lint(p, tk) {
  const ctx = p.latex || {};
  const isTex = p.source && p.source.kind === 'latex';
  const blocks = (p.blocks || []).filter(b => b.kind !== 'ref' && b.kind !== 'equation');
  const text = new Map(blocks.map(b => [b.id, tk.blockText(b, ctx)]));
  const issues = [];
  const add = (code, sev, bid, msg, quote = null, fix = null) => {
    const id = hash(`${code}|${bid}|${quote || msg}`);
    if (!issues.some(x => x.id === id)) issues.push({ id, code, sev, bid, msg, quote, fix });
  };
  const prose = b => ['para', 'abstract', 'caption', 'list', 'footnote', 'title'].includes(b.kind);

  // ── per block ──
  for (const b of blocks) {
    const t = text.get(b.id) || '';
    if (!t) continue;
    const src = b.cur ?? b.text;
    // placeholders and unresolved references
    for (const m of t.matchAll(/\b(TODO|TBD|FIXME|XXX+|TK)\b|\[citation needed\]|lorem ipsum|\?\?+/gi)) {
      if (m[0] === 'TK' && !/\bTK\b/.test(src)) continue;
      const q = t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 10).trim();
      add('placeholder', 'error', b.id, m[0].startsWith('?') ? 'Unresolved reference or citation (“??”) — a label or citation key is missing.' : `Placeholder text left in the manuscript: “${m[0]}”.`, q);
    }
    for (const m of t.matchAll(/\[\?([^\]]+)\]/g)) add('cite-key', 'error', b.id, `Citation key “${m[1]}” is not in the bibliography.`, m[0]);
    if (!prose(b)) continue;
    // repeated words
    for (const m of t.matchAll(/\b([A-Za-z]{2,})\s+\1\b/gi)) {
      if (/^(that|had|is|in|do|can|bye|so|very|really|ha)$/i.test(m[1]) && m[1].toLowerCase() !== m[0].split(/\s+/)[1].toLowerCase()) continue;
      if (/^(that|had)$/i.test(m[1])) continue;
      add('repeat', 'warn', b.id, `Repeated word “${m[1]} ${m[1]}”.`, m[0], m[1]);
    }
    // a / an
    for (const m of t.matchAll(/\b(a|an|A|An)\s+([A-Za-z][\w-]*)/g)) {
      const art = m[1].toLowerCase(), w = m[2];
      if (w.length === 1 && !/[A-Z]/.test(w)) continue;
      let wantAn;
      if (/^[A-Z]{2,}s?$/.test(w) || /^[A-Z]-/.test(w) || (w.length === 1 && /[A-Z]/.test(w))) wantAn = VOWEL_LETTER_SOUND.has(w[0]);
      else if (/^[aeiou]/i.test(w)) wantAn = !AN_EXC_VOWEL_A.test(w);
      else wantAn = AN_EXC_CONS_AN.test(w);
      if (art === 'a' && wantAn) add('article', 'warn', b.id, `“a ${w}” should probably be “an ${w}”.`, m[0], `${m[1] === 'A' ? 'An' : 'an'} ${w}`);
      if (art === 'an' && !wantAn && !/^(h)/i.test(w)) add('article', 'warn', b.id, `“an ${w}” should probably be “a ${w}”.`, m[0], `${m[1] === 'An' ? 'A' : 'a'} ${w}`);
    }
    // et al. / e.g. / i.e.
    for (const m of t.matchAll(/\bet\.\s?al\.?|\bet al(?![.\w])/g)) add('etal', 'warn', b.id, 'Write “et al.” (no period after “et”, period after “al”).', m[0], 'et al.');
    for (const m of t.matchAll(/\b(e\.g|i\.e)(?!\.)\b/g)) add('abbr', 'warn', b.id, `Write “${m[1]}.” with a final period.`, m[0], `${m[1]}.`);
    // contractions
    for (const m of t.matchAll(/\b(don't|doesn't|didn't|can't|cannot't|won't|isn't|aren't|wasn't|weren't|haven't|hasn't|wouldn't|couldn't|shouldn't|we're|they're|let's|it'll|we'll)\b/gi)) add('contraction', 'info', b.id, `Contraction “${m[1]}” — formal writing usually spells it out.`, m[0]);
    // long sentences
    for (const s of tk.sentences(t)) { const n = tk.countWords(s.s); if (n > 60) add('long', 'info', b.id, `Very long sentence (${n} words) — consider splitting it.`, s.s.split(/\s+/).slice(0, 8).join(' ')); }
    // brackets (outside math)
    const noMath = t.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '');
    const open = (noMath.match(/\(/g) || []).length, close = (noMath.match(/\)/g) || []).length;
    if (open !== close && Math.abs(open - close) <= 3 && !/\b\d\)|\b[a-z]\)\s/.test(noMath)) add('brackets', 'warn', b.id, `Unbalanced parentheses: ${open} “(” but ${close} “)”.`);
    // spacing problems (LaTeX output keeps them; PDF extraction often creates them, so only for LaTeX)
    if (isTex) {
      for (const m of t.matchAll(/\S \s*([,.;:!?])(?=\s|$)/g)) if (!/\d/.test(m[0][0])) add('space', 'info', b.id, 'Space before punctuation.', m[0].trim());
      for (const m of src.matchAll(/[a-z]\\cite/g)) add('cite-space', 'info', b.id, 'Put a (non-breaking) space before \\cite: “word~\\cite{…}”.', m[0]);
    }
  }

  // ── acronyms ──
  const order = blocks.filter(prose).map(b => ({ b, t: text.get(b.id) || '' }));
  const defs = new Map(); // ACR → [{ bid, long, pos }]
  const uses = new Map(); // ACR → [{ bid, pos }]
  let pos = 0;
  for (const { b, t } of order) {
    for (const m of t.matchAll(/([A-Za-z][A-Za-z\-]+(?:\s+(?:of|and|for|the|in|on|to|with|[A-Za-z][A-Za-z\-]+)){0,7})\s+\(([A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*s?)\)/g)) {
      const acr = m[2].replace(/s$/, '');
      const letters = acr.replace(/[^A-Z]/g, '');
      const words = m[1].split(/\s+/).filter(w => !/^(of|and|for|the|in|on|to|with|a|an)$/i.test(w));
      const tail = words.slice(-Math.max(letters.length, 1) - 1);
      const initials = tail.map(w => w.split('-').map(x => x[0]).join('')).join('').toUpperCase();
      if (!initials.includes(letters[0])) continue;
      const long = tail.join(' ');
      (defs.get(acr) || defs.set(acr, []).get(acr)).push({ bid: b.id, long, pos: pos + m.index });
    }
    for (const m of t.matchAll(/\b([A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)(s?)\b/g)) {
      const acr = m[1];
      if (acr.length > 8 || /^[IVXLC]+$/.test(acr) || COMMON_ACR.has(acr) || /^\d/.test(acr) || /[a-z]{3,}/.test(acr)) continue;
      if (t[m.index - 1] === '(' && t[m.index + m[0].length] === ')') continue; // the definition itself
      (uses.get(acr) || uses.set(acr, []).get(acr)).push({ bid: b.id, pos: pos + m.index });
    }
    pos += t.length + 1;
  }
  const abstractIds = new Set(blocks.filter(b => b.kind === 'abstract' || b.kind === 'title').map(b => b.id));
  for (const [acr, list] of defs) {
    const uniq = [...new Set(list.map(d => d.long.toLowerCase()))];
    const bodyDefs = list.filter(d => !abstractIds.has(d.bid));
    if (uniq.length > 1) add('acronym-def', 'warn', list[1].bid, `${acr} is defined differently: ${uniq.map(u => `“${u}”`).join(' vs ')}.`, `(${acr})`);
    else if (bodyDefs.length > 1) add('acronym-def', 'info', bodyDefs[1].bid, `${acr} is defined more than once (${bodyDefs.length}×${list.length > bodyDefs.length ? ' after the abstract' : ''}).`, `(${acr})`);
    const u = uses.get(acr) || [];
    const first = list[0];
    const early = u.filter(x => x.pos < first.pos && !abstractIds.has(x.bid));
    if (early.length) add('acronym-early', 'warn', early[0].bid, `${acr} is used before it is defined (definition comes later: “${first.long} (${acr})”).`, acr);
    if (!u.length) add('acronym-unused', 'info', first.bid, `${acr} is defined but never used again — consider writing it out only.`, `(${acr})`);
  }
  for (const [acr, list] of uses) {
    if (defs.has(acr) || list.length < 3) continue;
    add('acronym-undef', 'info', list[0].bid, `${acr} is used ${list.length}× but never defined.`, acr);
  }

  // ── figures, tables, citations ──
  const figNums = new Set((p.figures || []).map(f => String(f.num || '').trim()).filter(Boolean));
  const tabNums = new Set((p.tables || []).map(t => String(t.num || '').trim()).filter(Boolean));
  const refd = { fig: new Map(), tab: new Map() };
  for (const { b, t } of order) {
    if (b.kind === 'caption') continue;
    for (const m of t.matchAll(/\b(Fig(?:ure)?s?\.?|FIG(?:URE)?S?\.?)\s*~?\s*(\d+|[IVX]+)(?:\s*\(?([a-z])\)?)?/g)) { const n = m[2]; if (!refd.fig.has(n)) refd.fig.set(n, { bid: b.id, q: m[0] }); }
    for (const m of t.matchAll(/\b(Tab(?:le)?s?\.?|TABLE)\s*~?\s*(\d+|[IVX]+)\b/g)) { const n = m[2]; if (!refd.tab.has(n)) refd.tab.set(n, { bid: b.id, q: m[0] }); }
  }
  if (figNums.size) {
    for (const [n, r] of refd.fig) if (!figNums.has(n)) add('fig-missing', 'error', r.bid, `Figure ${n} is referenced but there is no Figure ${n}.`, r.q);
    for (const f of p.figures || []) if (f.num && !refd.fig.has(String(f.num))) add('fig-unref', 'warn', f.bid || null, `Figure ${f.num} is never referenced in the text.`, null);
    const firsts = [...refd.fig.keys()].filter(n => /^\d+$/.test(n)).map(Number);
    for (let k = 1; k < firsts.length; k++) if (firsts[k] < firsts[k - 1] && firsts[k] !== firsts[k - 1]) { const r = refd.fig.get(String(firsts[k - 1])); add('fig-order', 'info', r.bid, `Figure ${firsts[k - 1]} is referenced before Figure ${firsts[k]} — figures are usually numbered in the order they are first cited.`, r.q); break; }
  }
  if (tabNums.size) {
    for (const [n, r] of refd.tab) if (!tabNums.has(n)) add('tab-missing', 'error', r.bid, `Table ${n} is referenced but there is no Table ${n}.`, r.q);
    for (const t of p.tables || []) if (t.num && !refd.tab.has(String(t.num))) add('tab-unref', 'warn', t.bid || null, `Table ${t.num} is never referenced in the text.`, null);
  }
  const nRefs = (p.refs || []).length;
  if (nRefs && !isTex) {
    for (const { b, t } of order) for (const m of t.matchAll(/\[(\d{1,4}(?:\s*[,–-]\s*\d{1,4})*)\]/g)) {
      for (const part of m[1].split(',')) { const [a, z] = part.split(/[–-]/).map(x => parseInt(x, 10)); const hi = z || a; if (hi > nRefs && hi < 1900) add('cite-range', 'error', b.id, `Citation [${hi}] but the reference list has only ${nRefs} entries.`, m[0]); }
    }
  }
  const c = p.citations;
  if (c && Array.isArray(c.uncited) && c.uncited.length && c.uncited.length < nRefs) add('uncited', 'warn', null, `${c.uncited.length} reference${c.uncited.length === 1 ? ' is' : 's are'} never cited in the text: ${c.uncited.slice(0, 12).map(i => `[${i + 1}]`).join(', ')}${c.uncited.length > 12 ? ' …' : ''}.`);

  // ── consistency across the document ──
  const all = order.map(x => x.t).join('\n');
  const countRe = re => (all.match(re) || []).length;
  for (const stem of IZE) {
    const us = countRe(new RegExp(`\\b${stem}(e|es|ed|ing|ation|ations|er|ers)\\b`, 'gi')), uk = countRe(new RegExp(`\\b${stem.replace(/z$/, 's')}(e|es|ed|ing|ation|ations|er|ers)\\b`, 'gi'));
    if (us && uk) {
      const minority = us < uk ? stem : stem.replace(/z$/, 's'), majority = us < uk ? stem.replace(/z$/, 's') : stem;
      const re = new RegExp(`\\b${minority}(e|es|ed|ing|ation|ations|er|ers)\\b`, 'i');
      const hit = order.find(x => re.test(x.t));
      const m = hit && hit.t.match(re);
      add('spelling-mix', 'warn', hit ? hit.b.id : null, `Mixed spelling: “${minority}-” (${Math.min(us, uk)}×) and “${majority}-” (${Math.max(us, uk)}×). Use one consistently.`, m ? m[0] : null, m ? m[0].replace(new RegExp(minority, 'i'), w => (w[0] === w[0].toUpperCase() ? majority[0].toUpperCase() + majority.slice(1) : majority)) : null);
    }
  }
  for (const [a, b] of PAIRS) {
    const na = countRe(new RegExp(`\\b${a}\\b`, 'gi')), nb = countRe(new RegExp(`\\b${b}\\b`, 'gi'));
    if (na && nb) {
      const [minority, majority] = na < nb ? [a, b] : [b, a];
      const re = new RegExp(`\\b${minority}\\b`, 'i');
      const hit = order.find(x => re.test(x.t));
      add('spelling-mix', 'warn', hit ? hit.b.id : null, `Mixed spelling: “${minority}” (${Math.min(na, nb)}×) and “${majority}” (${Math.max(na, nb)}×).`, hit ? hit.t.match(re)[0] : null, majority);
    }
  }
  const hyph = new Map();
  for (const m of all.matchAll(/\b([a-z]{2,})-([a-z]{2,})\b/g)) hyph.set(`${m[1]}${m[2]}`, `${m[1]}-${m[2]}`);
  for (const [closed, h] of hyph) {
    const nc = countRe(new RegExp(`\\b${closed}\\b`, 'gi')), nh = countRe(new RegExp(`\\b${h}\\b`, 'gi'));
    if (nc && nh) {
      const [minority, majority] = nc < nh ? [closed, h] : [h, closed];
      const re = new RegExp(`\\b${minority}\\b`, 'i');
      const hit = order.find(x => re.test(x.t));
      add('hyphen-mix', 'warn', hit ? hit.b.id : null, `Written both “${h}” (${nh}×) and “${closed}” (${nc}×). Pick one.`, hit ? hit.t.match(re)[0] : null, majority);
    }
  }
  const pctTight = countRe(/\d%/g), pctSpaced = countRe(/\d\s%/g);
  if (pctTight && pctSpaced) {
    const minorityRe = pctTight < pctSpaced ? /\d+(?:\.\d+)?%/ : /\d+(?:\.\d+)?\s%/;
    const hit = order.find(x => minorityRe.test(x.t));
    add('percent-mix', 'info', hit ? hit.b.id : null, `Percentages are written both as “85%” (${pctTight}×) and “85 %” (${pctSpaced}×).`, hit ? hit.t.match(minorityRe)[0] : null);
  }
  // duplicate sentences
  const seen = new Map();
  for (const { b, t } of order) for (const s of tk.sentences(t)) {
    if (tk.countWords(s.s) < 9) continue;
    const k = s.s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
    if (seen.has(k) && seen.get(k) !== b.id) add('duplicate', 'warn', b.id, 'This sentence appears twice in the manuscript.', s.s.split(/\s+/).slice(0, 10).join(' '));
    else seen.set(k, b.id);
  }
  // caption full stops
  const caps = blocks.filter(b => b.kind === 'caption').map(b => (text.get(b.id) || '').trim());
  if (caps.length >= 3) {
    const withDot = caps.filter(t => /[.!?]$/.test(t)).length;
    if (withDot && withDot < caps.length) add('caption-dot', 'info', null, `${withDot} of ${caps.length} captions end with a full stop and ${caps.length - withDot} do not.`);
  }
  // abstract numbers that appear nowhere else
  const abs = blocks.filter(b => b.kind === 'abstract');
  if (abs.length) {
    const rest = order.filter(x => !abstractIds.has(x.b.id)).map(x => x.t).join(' ') + ' ' + (p.tables || []).map(t => (t.grid || []).flat().join(' ')).join(' ');
    const restNums = tk.extractNumbers(rest).map(n => n.raw.replace(/\s/g, ''));
    for (const b of abs) for (const n of tk.extractNumbers(text.get(b.id) || '')) {
      if (n.value === 0 || (!n.pct && !/\./.test(n.raw))) continue;
      const found = restNums.some(r => tk.sameNumber(r.replace(/[^0-9.\-eE]/g, ''), n.value)) || rest.includes(n.raw.replace(/\s+/g, ''));
      if (!found) add('abstract-number', 'warn', b.id, `${n.raw.trim()} in the abstract does not appear in the body or tables — check that it matches the results.`, n.raw.trim());
    }
  }
  // LaTeX: labels never referenced, references to missing labels
  if (isTex && ctx.labels) {
    const used = new Set();
    for (const b of p.blocks || []) for (const m of String(b.cur ?? b.text).matchAll(/\\(?:eq|auto|c|C|page|v|name)?ref\{([^}]+)\}/g)) for (const k of m[1].split(',')) used.add(k.trim());
    for (const [k, L] of Object.entries(ctx.labels)) if (!used.has(k) && /^(figure|table)$/.test(L.kind)) { /* reported as fig-unref/tab-unref */ }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  const pos2 = new Map((p.blocks || []).map((b, i) => [b.id, i]));
  return issues.sort((a, b) => rank[a.sev] - rank[b.sev] || (pos2.get(a.bid) ?? 1e9) - (pos2.get(b.bid) ?? 1e9));
}

module.exports = { lint };
