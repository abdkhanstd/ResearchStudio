/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Reference lists: splitting, in-text citation analysis, BibTeX (adapted from RefCheck's extract.js). */
export const HEADING = /^(?:(?:\d{1,2}|[IVXL]{1,5}|[A-Z])[.)]?\s+)?(references?|bibliography|works\s+cited|literature\s+cited|reference\s+list|references\s+and\s+notes|cited\s+literature|bibliograf[ií]a|r[ée]f[ée]rences(?:\s+bibliographiques)?|literatur(?:verzeichnis)?|riferimenti\s+bibliografici|refer[êe]ncias|参考文献|引用文献)\s*:?$/i;
export const END_HEADING = /^(?:(?:\d{1,2}|[IVXL]{1,5}|[A-Z])[.)]?\s+)?(appendix|appendices|supplementary|supplemental|acknowledg(?:e)?ments?|author\s+contributions?|author\s+biograph|biograph(?:y|ies)|about\s+the\s+authors?|conflicts?\s+of\s+interest|competing\s+interests?|declaration|funding|data\s+availability|ethics|abbreviations|nomenclature|list\s+of\s+(?:figures|tables))\b/i;
export const KEEP_HYPHEN = new Set('self non multi semi cross co pre post re anti inter intra sub super over under well state end real long short high low large small fine data model graph time user deep zero few one two three open closed domain task class object text image video vision language knowledge attention feature point word sentence token patch pixel frame scene event human machine cost energy risk privacy context content sample label noise edge server client peer path tree rule query meta bi tri quasi pseudo out in on off up down auto e x t'.split(' '));
export function looksLikeRef(t) { return /\b(19|20)\d{2}\b/.test(t) || /^\s*\[\d+\]/.test(t) || /doi|arxiv|https?:/i.test(t); }

/** Join PDF lines into one string, removing line-end hyphenation (keeping real compounds). */
export function joinLines(parts) {
  let out = '';
  for (const raw of parts) {
    const t = String(raw).trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    const m = out.match(/([A-Za-z]+)-$/);
    const lastTok = out.split(/\s+/).pop();
    if (m && /^[a-z]/.test(t) && !/https?:|doi/i.test(lastTok)) {
      out = KEEP_HYPHEN.has(m[1].toLowerCase()) || /[A-Z]/.test(m[1].slice(1)) ? out + t : out.slice(0, -1) + t;
    } else if (/^(https?:\/\/|10\.\d{4,})/.test(lastTok) && /[\/\-_.=?&#~]$/.test(lastTok) && /^[\w\-.\/=?&#~%]+/.test(t) && !/^(and|in|pp|vol|available|accessed)\b/i.test(t)) {
      out += t;
    } else out += ' ' + t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Split lines (with x/col/page) into reference strings. */
export function splitLines(lines) {
  const texts = lines.map(l => l.text);
  const bracket = texts.filter(t => /^\s*\[\d{1,4}\]/.test(t)).length;
  const refs = [];
  if (bracket >= 3) {
    let cur = [];
    for (const t of texts) { if (/^\s*\[\d{1,4}\]/.test(t) && cur.length) { refs.push(cur); cur = []; } cur.push(t); }
    if (cur.length) refs.push(cur);
    return { refs: refs.map(joinLines).filter(r => r.length > 10), style: 'numeric', how: 'brackets' };
  }
  let expect = 1;
  const starts = [];
  texts.forEach((t, i) => { const m = t.match(/^\s*(\d{1,4})[.)]\s+\S/); if (m && +m[1] === expect) { starts.push(i); expect++; } });
  if (starts.length >= 3) {
    for (let k = 0; k < starts.length; k++) refs.push(texts.slice(starts[k], starts[k + 1] ?? texts.length));
    if (starts[0] > 0 && refs.length) refs[0] = texts.slice(0, starts[0]).concat(refs[0]);
    return { refs: refs.map(joinLines).filter(r => r.length > 10), style: 'numeric', how: 'numbers' };
  }
  const groups = new Map();
  for (const l of lines) { const k = `${l.page}:${l.col}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const minX = new Map(), hanging = new Map();
  for (const [k, ls] of groups) {
    const xs = ls.map(l => l.x ?? 0);
    const mn = Math.min(...xs);
    minX.set(k, mn);
    const indented = xs.filter(x => x > mn + 4 && x < mn + 40).length, flush = xs.filter(x => x <= mn + 1.5).length;
    hanging.set(k, indented >= 2 && flush >= 2 && indented >= flush * 0.4);
  }
  const gaps = [];
  for (let i = 1; i < lines.length; i++) if (lines[i].page === lines[i - 1].page && lines[i].col === lines[i - 1].col && lines[i].y != null) gaps.push(Math.abs(lines[i].y - lines[i - 1].y));
  gaps.sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const startPat = /^(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos|al|el)\s+)*[\p{Lu}][\p{L}'’\-]+(?:\s+[\p{Lu}][\p{L}'’\-]+)?,?\s+(?:[\p{Lu}]\.|[\p{Lu}][\p{L}]+[,.]|[\p{Lu}]{1,3}[,.\s])/u;
  let cur = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const k = `${l.page}:${l.col}`;
    let isStart = false;
    if (!cur.length) isStart = true;
    else if (hanging.get(k) && l.x != null) isStart = l.x <= minX.get(k) + 1.5;
    else {
      const bigGap = prev && prev.page === l.page && prev.col === l.col && medGap && l.y != null && Math.abs(l.y - prev.y) > medGap * 1.45;
      const prevEnds = /[.)\]]\s*$|\d\s*$|https?:\/\/\S+$/.test(prev.text.trim());
      isStart = bigGap || (prevEnds && startPat.test(l.text.trim()) && cur.join(' ').length > 50);
    }
    if (isStart && cur.length) { refs.push(cur); cur = []; }
    cur.push(l.text);
  });
  if (cur.length) refs.push(cur);
  return { refs: refs.map(joinLines).filter(r => r.length > 10), style: 'author-year', how: 'layout' };
}

/** Split pasted text into references. */
export function splitText(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const paras = t.split(/\n\s*\n+/).map(s => s.replace(/\s*\n\s*/g, ' ').trim()).filter(s => s.length > 10);
  if (paras.length >= 2) return paras.flatMap(p => ((p.match(/(?:^|\s)\[\d{1,4}\]\s/g) || []).length >= 2 ? splitInline(p) : [p]));
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2) { const sp = splitLines(lines.map(x => ({ text: x }))); if (sp.refs.length >= 2) return sp.refs; }
  return splitInline(t);
}
function splitInline(t) {
  const s = t.replace(/\s+/g, ' ');
  if ((s.match(/(?:^|\s)\[\d{1,4}\]\s/g) || []).length >= 2) return s.split(/\s(?=\[\d{1,4}\]\s)/).map(x => x.trim()).filter(x => x.length > 10);
  const parts = s.split(/\s(?=\d{1,3}\.\s+[\p{Lu}])/u);
  if (parts.length >= 3) return parts.map(x => x.trim()).filter(x => x.length > 10);
  return [s];
}

// ── In-text citations ──
const NOT_NAMES = new Set('In The See Table Figure Fig Section Sec Eq Equation Since From During Until Before After Between Also And Or For With Using Following January February March April May June July August September October November December Spring Summer Fall Autumn Winter Version Vol Chapter Appendix Note Data Source Accessed Retrieved Available Online Published Updated Received Accepted Copyright Year Years Cf Ibid Eg Ie Both Each Here This That These Those Our We Their'.split(' '));
const firstSurname = raw => { const s = String(raw).replace(/^\s*(?:\[[^\]]{1,12}\]|\d{1,4}[.)])\s*/, ''); const m = s.match(/^((?:(?:van|von|de|der|den|da|di|du|le|la|del|dos|al|el)\s+)*[\p{Lu}][\p{L}'’\-]+)/u); return m ? m[1] : null; };
const firstYear = raw => { const m = String(raw).match(/\b((?:19|20)\d{2})([a-z])?\b/); return m ? m[1] + (m[2] || '') : null; };
const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function analyzeCitations(body, refs, style) {
  if (!body || body.length < 500 || !refs.length) return null;
  const n = refs.length;
  if (style === 'numeric') {
    const counts = new Array(n).fill(0), firstSeen = [], missing = new Set();
    let total = 0;
    const re = /\[((?:\s*\d{1,4}\s*(?:[-–—]\s*\d{1,4}\s*)?[,;]?)+)\]/g;
    body = body.replace(/\[(\d{1,4})\]\s*[-–—]\s*\[(\d{1,4})\]/g, '[$1–$2]');
    let m;
    while ((m = re.exec(body))) {
      const nums = [];
      for (const part of m[1].split(/[,;]/)) {
        const r = part.split(/[-–—]/).map(x => parseInt(x, 10)).filter(Number.isFinite);
        if (r.length === 2 && r[1] >= r[0] && r[1] - r[0] < 60) for (let k = r[0]; k <= r[1]; k++) nums.push(k);
        else if (r.length === 1) nums.push(r[0]);
      }
      if (nums.some(x => x > 1800 && x < 2100)) continue;
      for (const k of nums) {
        if (k < 1) continue;
        total++;
        if (k > n) { if (k <= n + 200) missing.add(k); continue; }
        if (!counts[k - 1]) firstSeen.push(k);
        counts[k - 1]++;
      }
    }
    if (!total) return { style, counts, uncited: [], missing: [], outOfOrder: [], firstSeen: [], total: 0, note: 'No bracketed citations like [1] were found in the text.' };
    const outOfOrder = [];
    let expected = 1;
    const seen = new Set();
    for (const k of firstSeen) { seen.add(k); if (k > expected) outOfOrder.push(k); while (seen.has(expected)) expected++; }
    return { style, counts, uncited: counts.map((c, i) => (c ? -1 : i)).filter(i => i >= 0), missing: [...missing].sort((a, b) => a - b), outOfOrder: outOfOrder.slice(0, 50), firstSeen: firstSeen.slice(0, 600), total };
  }
  const flat = fold(body).replace(/\s+/g, ' ');
  const keys = refs.map(r => ({ s: firstSurname(r), y: firstYear(r) }));
  const counts = keys.map(k => {
    if (!k.s || !k.y) return 0;
    const s = fold(k.s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const y = k.y.replace(/[a-z]$/, '');
    const re = new RegExp(`\\b${s}\\b[^()\\d]{0,80}?\\(?(?:[a-z]+\\.? )?${y}${k.y.length > 4 ? k.y.slice(4) : '[a-z]?'}\\b`, 'g');
    return (flat.match(re) || []).length;
  });
  const total = counts.reduce((a, b) => a + b, 0);
  return { style, counts, uncited: counts.map((c, i) => (c ? -1 : i)).filter(i => i >= 0 && keys[i].s && keys[i].y), missing: [], outOfOrder: [], firstSeen: [], total, note: 'Author–year matching is approximate.' };
}

// ── BibTeX / LaTeX ──
const ACC = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨' };
export function delatex(s) {
  return String(s || '')
    .replace(/\\(['`^"~=.uvHck])\s*\{?\\?([a-zA-Z])\}?/g, (_, a, ch) => (ch + (ACC[a] || '')).normalize('NFC'))
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)\b\s*/g, (_, x) => ({ ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ' })[x])
    .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\\$/g, '$').replace(/\\_/g, '_').replace(/\\#/g, '#')
    .replace(/\\(?:textit|textbf|emph|textrm|textsc|texttt|mathrm|mathbf|mathit|url|href\{[^}]*\})\s*\{([^{}]*)\}/g, '$1')
    .replace(/``/g, '“').replace(/''/g, '”').replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, ' ').replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}$]/g, '').replace(/\s+/g, ' ').trim();
}
export function parseBib(text) {
  const out = [];
  const src = String(text || '');
  let i = 0;
  while ((i = src.indexOf('@', i)) >= 0) {
    const head = src.slice(i).match(/^@\s*([a-zA-Z]+)\s*[({]\s*/);
    if (!head) { i++; continue; }
    const type = head[1].toLowerCase();
    let j = i + head[0].length, depth = 1;
    const open = head[0].trim().slice(-1);
    const close = open === '(' ? ')' : '}';
    const startBody = j;
    while (j < src.length && depth > 0) { const ch = src[j]; if (ch === '{' || (close === ')' && ch === '(')) depth++; else if (ch === '}' || (close === ')' && ch === ')')) depth--; j++; }
    const body = src.slice(startBody, j - 1);
    i = j;
    if (['comment', 'preamble', 'string'].includes(type)) continue;
    const key = (body.match(/^\s*([^,\s]+)\s*,/) || [])[1] || '';
    const fields = {};
    let k = body.indexOf(',') + 1;
    while (k > 0 && k < body.length) {
      const fm = body.slice(k).match(/^\s*([a-zA-Z][\w\-:.]*)\s*=\s*/);
      if (!fm) break;
      k += fm[0].length;
      let val = '';
      if (body[k] === '{') { let d = 0; const s = k; do { if (body[k] === '{') d++; else if (body[k] === '}') d--; k++; } while (k < body.length && d > 0); val = body.slice(s + 1, k - 1); }
      else if (body[k] === '"') { const s = ++k; while (k < body.length && !(body[k] === '"' && body[k - 1] !== '\\')) k++; val = body.slice(s, k); k++; }
      else { const vm = body.slice(k).match(/^[^,]*/); val = vm[0]; k += val.length; }
      fields[fm[1].toLowerCase()] = val.trim();
      const comma = body.indexOf(',', k); if (comma < 0) break; k = comma + 1;
    }
    out.push(bibToRef(type, key, fields));
  }
  return out.filter(r => r.parsed.title || r.raw.length > 15);
}
function bibAuthors(s) {
  const list = String(s || '').split(/\s+and\s+/i).map(x => x.trim()).filter(Boolean);
  let org = false;
  const fams = list.filter(a => a.toLowerCase() !== 'others').map(a => {
    if (/^\{.*\}$/.test(a) && !a.includes(',')) { org = list.length === 1; return delatex(a); }
    const d = delatex(a);
    if (d.includes(',')) return d.split(',')[0].trim();
    const parts = d.split(/\s+/);
    let i = parts.length - 1;
    while (i > 0 && /^(van|von|der|den|de|di|da|du|le|la|del|dos)$/i.test(parts[i - 1])) i--;
    return parts.slice(i).join(' ');
  });
  const display = list.filter(a => a.toLowerCase() !== 'others').map(a => { const d = delatex(a); const p = d.split(','); return p.length === 2 ? `${p[1].trim()} ${p[0].trim()}`.trim() : d; });
  return { fams, etal: list.some(a => a.toLowerCase() === 'others'), org, display };
}
function bibToRef(type, key, f) {
  const au = bibAuthors(f.author || f.editor);
  const title = delatex(f.title || f.booktitle || '');
  const venue = delatex(f.journal || f.journaltitle || (f.title ? f.booktitle : '') || f.publisher || f.institution || f.school || f.howpublished || '');
  const year = parseInt(((f.year || f.date || '').match(/\d{4}/) || [])[0] || '', 10) || null;
  const eprint = (/arxiv/i.test(f.archiveprefix || f.eprinttype || '') && f.eprint ? f.eprint.replace(/^arxiv:/i, '') : null)
    || (`${f.journal || ''} ${f.note || ''} ${f.url || ''}`.match(/arxiv[:\s.]*(?:org\/abs\/)?(?:preprint\s*)?(?:arxiv:)?(\d{4}\.\d{4,5})/i) || [])[1] || null;
  const tmap = { article: 'journal', inproceedings: 'conference', conference: 'conference', proceedings: 'conference', book: 'book', inbook: 'chapter', incollection: 'chapter', phdthesis: 'thesis', mastersthesis: 'thesis', thesis: 'thesis', techreport: 'report', report: 'report', online: 'web', electronic: 'web', www: 'web', software: 'software', dataset: 'dataset', patent: 'patent', standard: 'standard', unpublished: 'other', manual: 'report' };
  let ptype = tmap[type] || (eprint ? 'preprint' : f.url ? 'web' : 'other');
  if (eprint && (ptype === 'other' || /arxiv|preprint/i.test(f.journal || ''))) ptype = 'preprint';
  const doi = (f.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim() || null;
  const url = f.url ? delatex(f.url).replace(/\s/g, '') : null;
  const pages = delatex(f.pages || '').replace(/–/g, '-');
  const auStr = au.display.length > 6 || au.etal ? `${au.display.slice(0, 6).join(', ')} et al.` : au.display.join(', ');
  const raw = [auStr, title ? `"${title}"` : '', venue, f.volume ? `vol. ${delatex(f.volume)}` : '', f.number ? `no. ${delatex(f.number)}` : '', pages ? `pp. ${pages}` : '', year || '', eprint ? `arXiv:${eprint}` : '', doi ? `doi: ${doi}` : '', !doi && url ? url : ''].filter(Boolean).join(', ') + '.';
  return { raw, key, parsed: { authors: au.fams, etal: au.etal, org: au.org, title: title || null, venue: venue || null, year, volume: delatex(f.volume || '') || null, issue: delatex(f.number || '') || null, pages: pages || null, type: ptype, doi, arxiv: eprint, urls: url ? [url] : [], key }, display: { authors: au.display, year } };
}
export function texCites(tex) {
  const keys = new Map();
  const re = /\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(tex))) for (const k of m[1].split(',').map(s => s.trim()).filter(Boolean)) if (!keys.has(k)) keys.set(k, keys.size + 1);
  return keys;
}
export function texBibitems(tex) {
  const m = String(tex).match(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/);
  if (!m) return [];
  return m[0].split(/\\bibitem/).slice(1).map(s => {
    const km = s.match(/^\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/);
    const text = s.slice(km ? km[0].length : 0).replace(/\\end\{thebibliography\}[\s\S]*$/, '').replace(/\\newblock/g, ' ');
    return { key: km ? km[1].trim() : '', raw: delatex(text) };
  }).filter(x => x.raw.length > 10);
}
