/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * Research Studio — text toolkit shared by the browser and the server (ES module, no dependencies).
 *   wordDiff(a, b)            → [{ t: '=' | '-' | '+', s }]
 *   merge3(base, mine, theirs) → { ok, text, conflicts }   (apply a suggestion made on an older version)
 *   renderTex(src, ctx, opts)  → plain text or HTML from a LaTeX paragraph
 *   sentences, words, extractNumbers, findQuote, applyFix
 */

// ── Tokens and diffs ────────────────────────────────────────
const TOKEN = /\\[a-zA-Z@]+\*?|[\p{L}\p{N}]+(?:['’][\p{L}]+)*|\s+|[^\s\p{L}\p{N}]/gu;
export const tokenize = s => String(s || '').match(TOKEN) || [];

/** LCS-based token diff with common prefix/suffix trimming. Returns ops over tokens. */
function diffTok(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const A = a.slice(p, sa), B = b.slice(p, sb);
  const ops = [];
  for (let i = 0; i < p; i++) ops.push(['=', a[i]]);
  const n = A.length, m = B.length;
  if (n * m > 6_000_000) { // too large: replace the middle wholesale
    for (const t of A) ops.push(['-', t]);
    for (const t of B) ops.push(['+', t]);
  } else if (n && m) {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push(['=', A[i]]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) ops.push(['-', A[i++]]);
      else ops.push(['+', B[j++]]);
    }
    while (i < n) ops.push(['-', A[i++]]);
    while (j < m) ops.push(['+', B[j++]]);
  } else {
    for (const t of A) ops.push(['-', t]);
    for (const t of B) ops.push(['+', t]);
  }
  for (let i = sa; i < a.length; i++) ops.push(['=', a[i]]);
  return ops;
}

/** Human-friendly word diff: merged runs, whitespace-only equalities between changes folded in. */
export function wordDiff(a, b) {
  const ops = diffTok(tokenize(a), tokenize(b));
  const runs = [];
  for (const [t, s] of ops) { const r = runs[runs.length - 1]; if (r && r.t === t) r.s += s; else runs.push({ t, s }); }
  // fold "= <space>" sandwiched between changes, and tiny equalities, into the surrounding change
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.t === '=' && i > 0 && i < runs.length - 1 && runs[i - 1].t !== '=' && runs[i + 1].t !== '=' && (/^\s+$/.test(r.s) || (r.s.length <= 2 && !/\s/.test(r.s)))) {
      out.push({ t: '-', s: r.s }, { t: '+', s: r.s });
      continue;
    }
    out.push({ ...r });
  }
  // regroup: all deletions of a change block first, then insertions
  const res = [];
  let del = '', ins = '';
  const flush = () => { if (del) res.push({ t: '-', s: del }); if (ins) res.push({ t: '+', s: ins }); del = ins = ''; };
  for (const r of out) {
    if (r.t === '=') { flush(); const last = res[res.length - 1]; if (last && last.t === '=') last.s += r.s; else res.push({ t: '=', s: r.s }); }
    else if (r.t === '-') del += r.s; else ins += r.s;
  }
  flush();
  return res;
}
export const diffStats = ops => ({ ins: ops.filter(o => o.t === '+').reduce((n, o) => n + o.s.trim().split(/\s+/).filter(Boolean).length, 0), del: ops.filter(o => o.t === '-').reduce((n, o) => n + o.s.trim().split(/\s+/).filter(Boolean).length, 0) });

/** Hunks of base→other over base token indices: [{ s, e, ins: string[] }] */
function hunks(base, other) {
  const ops = diffTok(base, other);
  const out = [];
  let i = 0, cur = null;
  for (const [t, s] of ops) {
    if (t === '=') { if (cur) { out.push(cur); cur = null; } i++; continue; }
    if (!cur) cur = { s: i, e: i, ins: [] };
    if (t === '-') { i++; cur.e = i; } else cur.ins.push(s);
  }
  if (cur) out.push(cur);
  return out;
}

/** Three-way merge on tokens. mine = base + suggestion, theirs = current text. */
export function merge3(base, mine, theirs) {
  if (base === theirs) return { ok: true, text: mine, conflicts: 0 };
  if (base === mine) return { ok: true, text: theirs, conflicts: 0 };
  if (mine === theirs) return { ok: true, text: mine, conflicts: 0 };
  const B = tokenize(base), H1 = hunks(B, tokenize(mine)), H2 = hunks(B, tokenize(theirs));
  const all = [...H1.map(h => ({ ...h, w: 1 })), ...H2.map(h => ({ ...h, w: 2 }))].sort((x, y) => x.s - y.s || x.e - y.e);
  let conflicts = 0;
  const keep = [];
  for (const h of all) {
    const prev = keep[keep.length - 1];
    const overlap = prev && (h.s < prev.e || (h.s === prev.s && h.e === prev.e) || (h.s === prev.e && h.s === h.e && prev.s === prev.e));
    if (overlap) {
      if (prev.w !== h.w && prev.s === h.s && prev.e === h.e && prev.ins.join('') === h.ins.join('')) continue; // same change on both sides
      if (prev.w !== h.w) { conflicts++; continue; }
    }
    keep.push(h);
  }
  if (conflicts) return { ok: false, text: theirs, conflicts };
  let out = '', i = 0;
  for (const h of keep) { out += B.slice(i, h.s).join('') + h.ins.join(''); i = h.e; }
  out += B.slice(i).join('');
  return { ok: true, text: out, conflicts: 0 };
}

// ── Locating and applying short fixes ──────────────────────
const squash = s => s.replace(/\s+/g, ' ');
/** Find a quote in text, exactly or ignoring whitespace differences. Returns { start, end } or null. */
export function findQuote(text, quote) {
  if (!quote) return null;
  const i = text.indexOf(quote);
  if (i >= 0) return { start: i, end: i + quote.length };
  const q = squash(quote).trim();
  if (!q) return null;
  // map squashed positions back to the original
  const map = [];
  let sq = '';
  for (let k = 0; k < text.length; k++) {
    const ch = /\s/.test(text[k]) ? ' ' : text[k];
    if (ch === ' ' && sq.endsWith(' ')) continue;
    sq += ch; map.push(k);
  }
  const j = sq.indexOf(q);
  if (j < 0) return null;
  return { start: map[j], end: map[j + q.length - 1] + 1 };
}
export function applyFix(text, quote, fix) {
  const at = findQuote(text, quote);
  if (!at) return null;
  return text.slice(0, at.start) + fix + text.slice(at.end);
}

// ── Words, sentences, numbers ───────────────────────────────
export const words = s => (String(s || '').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []);
export const countWords = s => words(s).length;
const ABBR = /\b(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Sec|Secs|Tab|No|Nos|approx|resp|Ref|Refs|Dr|Mr|Ms|Prof|St|Jr|Sr|Inc|Ltd|Co|Vol|vol|pp|ca|viz|al|Ch|Thm|Def|Prop|Lem|Alg|Appx|min|max|avg|std)\.$/;
export function sentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let start = 0;
  const re = /([.!?])(["”’)\]]*)\s+(?=["“(\[]?[\p{Lu}\p{N}\\$])/gu;
  let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[1].length + m[2].length;
    const head = t.slice(start, end);
    if (m[1] === '.' && (ABBR.test(head) || /\b[A-Z]\.$/.test(head) || /\d\.$/.test(head) && /^\d/.test(t.slice(re.lastIndex)))) continue;
    out.push({ s: head.trim(), start, end });
    start = re.lastIndex;
  }
  if (start < t.length) out.push({ s: t.slice(start).trim(), start, end: t.length });
  return out.filter(x => x.s);
}

const NUM = /(?<![\p{L}\d.\-_/\\])([−\-–]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[−\-–]?\d+(?:\.\d+)?(?:\s*[×x]\s*10\s*\^?\s*\{?[−\-]?\d+\}?|e[−\-+]?\d+)?)(\s*(?:%|\\%|percent|pp\b|‰|×|x\b|ms\b|s\b|sec\b|min\b|h\b|hours?\b|days?\b|GB\b|MB\b|KB\b|TB\b|M\b|K\b|B\b|k\b|dB\b|Hz\b|kHz\b|MHz\b|GHz\b|mm\b|cm\b|m\b|km\b|kg\b|g\b|mg\b|°C?|K\b|fps\b|FPS\b|FLOPs?\b|GFLOPs?\b|params?\b|M\s*params?\b))?/gu;
/** Numbers that carry results (not citations, years, section/figure/table numbers). */
export function extractNumbers(text) {
  const t = String(text || '');
  const out = [];
  NUM.lastIndex = 0;
  let m;
  while ((m = NUM.exec(t))) {
    const raw = m[1];
    const unit = (m[2] || '').replace(/\\%/, '%').trim();
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/\[\s*(?:\d+\s*[,–-]\s*)*$/.test(before) && /^\s*[\],–-]/.test(after)) continue; // citation [12]
    if (/(?:Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?|Sec(?:tion)?s?\.?|Eq(?:uation)?s?\.?|Alg(?:orithm)?\.?|Chapter|Appendix|Step|Stage|Phase|Theorem|Lemma|Definition|Proposition|Corollary|Remark|Example|Part|Line|Row|Column|Page|p\.|pp\.|Ref\.?|Refs\.?|§)\s*\(?$/i.test(before)) continue;
    let v = Number(raw.replace(/[−–]/g, '-').replace(/,/g, '').replace(/\s*[×x]\s*10\s*\^?\s*\{?([−\-]?\d+)\}?/, 'e$1').replace(/−/g, '-'));
    if (!Number.isFinite(v)) continue;
    const isInt = /^[−\-–]?\d+$/.test(raw);
    if (isInt && v >= 1900 && v <= 2099 && !unit) continue; // years
    if (isInt && !unit && Math.abs(v) < 10 && !/\b(?:of|by|to|from|than|top|over|under|about|nearly|only|just|achieves?|reaches?|obtains?|reduces?|improves?|increases?|decreases?|drops?|gains?)\s*$/i.test(before)) continue; // small counts ("two", "3 datasets")
    out.push({ raw: raw + (m[2] || ''), value: v, unit, pct: unit === '%' || unit === 'percent' || unit === 'pp', idx: m.index, end: m.index + m[0].length });
  }
  return out;
}
/** Do two reported numbers agree up to the precision written? */
export function sameNumber(a, b) {
  const da = (String(a).split('.')[1] || '').replace(/\D.*$/, '').length, db = (String(b).split('.')[1] || '').replace(/\D.*$/, '').length;
  const x = typeof a === 'number' ? a : Number(String(a).replace(/[−–]/g, '-').replace(/[^0-9eE.+-]/g, ''));
  const y = typeof b === 'number' ? b : Number(String(b).replace(/[−–]/g, '-').replace(/[^0-9eE.+-]/g, ''));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const tol = 0.5 * Math.pow(10, -Math.min(da, db)) + 1e-9;
  return Math.abs(x - y) <= tol || Math.abs(x * 100 - y) <= tol || Math.abs(x - y * 100) <= tol;
}

// ── LaTeX ───────────────────────────────────────────────────
export function stripTexComments(s) {
  return String(s || '').replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2');
}
const ACC = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', k: '\u0328', r: '\u030A' };
const SYM = { ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', ldots: '…', dots: '…', textellipsis: '…', textendash: '–', textemdash: '—', textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”', textasciitilde: '~', textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>', textdegree: '°', copyright: '©', textregistered: '®', texttrademark: '™', S: '§', P: '¶', dag: '†', ddag: '‡', textbullet: '•', textpm: '±', texttimes: '×', LaTeX: 'LaTeX', TeX: 'TeX', today: '', quad: ' ', qquad: ' ', enspace: ' ', thinspace: ' ', newline: ' ', linebreak: ' ', par: ' ', noindent: '', centering: '', raggedright: '', raggedleft: '', maketitle: '', clearpage: '', newpage: '', pagebreak: '', bigskip: '', medskip: '', smallskip: '', protect: '', phantomsection: '', appendix: '', footnotesize: '', small: '', normalsize: '', large: '', Large: '', LARGE: '', huge: '', Huge: '', scriptsize: '', tiny: '', bfseries: '', itshape: '', rmfamily: '', sffamily: '', ttfamily: '', em: '', hline: '', toprule: '', midrule: '', bottomrule: '', relax: '', unskip: '', ignorespaces: '', hfill: ' ', vfill: '', break: '', allowbreak: '', sloppy: '', nolinebreak: '', IEEEpeerreviewmaketitle: '', IEEEpubidadjcol: '', item: '\n• ' };
const DROP1 = new Set('label vspace hspace vskip hskip index nocite bibliographystyle bibliography thispagestyle pagestyle color pagecolor input include includegraphics graphicspath usepackage documentclass keywords setcounter addtocounter linespread fontsize selectfont IEEEoverridecommandlockouts markboth hypersetup captionsetup addbibresource printbibliography newcolumntype'.split(' '));
const DROP2 = new Set('setlength addtolength setcounter newcommand renewcommand providecommand definecolor resizebox scalebox'.split(' '));
const KEEP1 = new Set('emph textbf textit textsc texttt textrm textsf textmd textup textsl textnormal mbox text underline uline hl ul so textsuperscript textsubscript fbox makebox framebox enquote mathrm mathbf mathit boldsymbol mathcal mathbb operatorname ensuremath sout xout uppercase lowercase MakeUppercase MakeLowercase titlecap'.split(' '));
const FMT = { emph: 'em', textit: 'em', textsl: 'em', textbf: 'strong', textsc: 'span class="sc"', texttt: 'code', underline: 'u', uline: 'u', ul: 'u', hl: 'mark', textsuperscript: 'sup', textsubscript: 'sub', sout: 's', xout: 's' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REFNAME = { figure: ['Fig.', 'Figure'], table: ['Table', 'Table'], section: ['Section', 'Section'], equation: ['Eq.', 'Equation'], algorithm: ['Algorithm', 'Algorithm'], appendix: ['Appendix', 'Appendix'], item: ['', ''], theorem: ['Theorem', 'Theorem'], lemma: ['Lemma', 'Lemma'], listing: ['Listing', 'Listing'] };

/**
 * Render a LaTeX fragment as plain text (default) or HTML.
 * ctx: { labels: { key: { n, kind } }, cites: { key: n | "Author et al., 2020" }, macros: { name: body } }
 * opts: { html: false, math: (tex, display) => html }
 */
export function renderTex(src, ctx = {}, opts = {}) {
  const html = !!opts.html;
  const s = stripTexComments(src);
  const labels = ctx.labels || {}, cites = ctx.cites || {}, macros = ctx.macros || {};
  const esc = html ? escHtml : x => x;
  let i = 0, depth = 0;
  const out = [];
  function readGroup() { // after skipping spaces, read {…} (balanced) or a single token
    while (s[i] === ' ' || s[i] === '\n' || s[i] === '\t') i++;
    if (s[i] === '{') {
      let d = 0, st = i;
      for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (!d) { i++; return s.slice(st + 1, i - 1); } } }
      return s.slice(st + 1);
    }
    if (s[i] === '\\') { const m = s.slice(i).match(/^\\([a-zA-Z@]+|.)/); i += m ? m[0].length : 1; return m ? m[0] : ''; }
    return s[i++] || '';
  }
  function readOpt() { // [ … ] (balanced)
    const save = i;
    while (s[i] === ' ' || s[i] === '\n') i++;
    if (s[i] !== '[') { i = save; return null; }
    let d = 0, st = i;
    for (; i < s.length; i++) { if (s[i] === '[') d++; else if (s[i] === ']') { d--; if (!d) { i++; return s.slice(st + 1, i - 1); } } }
    i = save; return null;
  }
  const sub = x => (depth > 40 ? '' : (depth++, (() => { const r = renderTex(x, ctx, opts); depth--; return r; })()));
  function cite(keysStr, cmd) {
    const keys = keysStr.split(',').map(k => k.trim()).filter(Boolean);
    const nums = keys.map(k => cites[k]);
    if (nums.every(n => typeof n === 'number')) {
      const sorted = [...nums].sort((a, b) => a - b);
      const parts = [];
      for (let k = 0; k < sorted.length; k++) { let e = k; while (e + 1 < sorted.length && sorted[e + 1] === sorted[e] + 1) e++; parts.push(e - k >= 2 ? `${sorted[k]}–${sorted[e]}` : sorted.slice(k, e + 1).join(', ')); k = e; }
      const t = `[${parts.join(', ')}]`;
      return html ? `<span class="cite" title="${escHtml(keys.join(', '))}">${t}</span>` : t;
    }
    const txt = keys.map(k => (typeof cites[k] === 'string' ? cites[k] : cites[k] != null ? `[${cites[k]}]` : `[?${k}]`)).join('; ');
    const t = /^citet|^citeauthor|^textcite/.test(cmd) ? txt : `(${txt})`;
    return html ? `<span class="cite">${escHtml(t)}</span>` : t;
  }
  function ref(key, cmd) {
    const L = labels[key];
    const n = L ? L.n : '??';
    const kind = L ? L.kind : null;
    let t = String(n);
    if (cmd === 'eqref') t = `(${n})`;
    else if (cmd === 'autoref' || cmd === 'Cref' || cmd === 'cref' || cmd === 'Autoref') {
      const nm = (REFNAME[kind] || ['', ''])[cmd === 'cref' ? 0 : 1];
      t = nm ? `${nm}${kind === 'equation' ? ` (${n})` : ` ${n}`}` : String(n);
    } else if (cmd === 'pageref') t = '?';
    return html ? `<span class="xref${L ? '' : ' bad'}" title="${escHtml(key)}">${escHtml(t)}</span>` : t;
  }
  function math(tex, display) {
    if (html && opts.math) return opts.math(tex, display);
    if (html) return `<code class="math">${escHtml(tex)}</code>`;
    return display ? ` $$${tex.trim()}$$ ` : `$${tex}$`;
  }
  /**
   * A tabular as a grid: rows split at \\ and cells at & (outside braces), rules dropped, \multicolumn spans kept.
   * HTML: a table (rows above the first rule are the header). Text: cells separated by tabs, rows by new lines.
   */
  function tabular(env) {
    if (/^(tabular\*|tabularx|tabulary)$/.test(env)) readGroup();
    readOpt(); readGroup(); // position, column spec
    const open = new RegExp(`\\\\begin\\s*\\{${env.replace('*', '\\*')}\\}`, 'g'), close = new RegExp(`\\\\end\\s*\\{${env.replace('*', '\\*')}\\}`, 'g');
    let d = 1, j = -1, endLen = 0;
    for (let k = i; k < s.length && d > 0;) {
      open.lastIndex = k; close.lastIndex = k;
      const o = open.exec(s), c = close.exec(s);
      if (!c) break;
      if (o && o.index < c.index) { d++; k = o.index + o[0].length; continue; }
      d--; k = c.index + c[0].length;
      if (!d) { j = c.index; endLen = c[0].length; }
    }
    const body = j >= 0 ? s.slice(i, j) : s.slice(i);
    i = j >= 0 ? j + endLen : s.length;
    // split at depth 0
    const split = (t, sep) => { const parts = []; let b = 0, st = 0; for (let k = 0; k < t.length; k++) { const ch = t[k]; if (ch === '\\') { if (sep === '\\\\' && t[k + 1] === '\\' && !b) { parts.push(t.slice(st, k)); st = k + 2; k++; continue; } k++; continue; } if (ch === '{') b++; else if (ch === '}') b--; else if (ch === sep && !b) { parts.push(t.slice(st, k)); st = k + 1; } } parts.push(t.slice(st)); return parts; };
    const RULE = /\\(toprule|midrule|bottomrule|hline|endhead|endfirsthead|endfoot|endlastfoot|morecmidrules)\b(\[[^\]]*\])?|\\(cline|cmidrule)\s*(\([^)]*\))?\s*\{[^}]*\}|\\addlinespace\s*(\[[^\]]*\])?|\\specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\}|\\(rowcolor|arrayrulecolor)\s*(\[[^\]]*\])?\s*\{[^}]*\}|\\noalign\s*\{[^}]*\}/g;
    const rows = [];
    let ruleAfter = -1;
    for (let raw of split(body.replace(/\\tabularnewline\b/g, '\\\\'), '\\\\')) {
      raw = raw.replace(/^\s*\[[^\]]*\]/, ''); // \\[2pt]
      const hadRule = RULE.test(raw); RULE.lastIndex = 0;
      const t = raw.replace(RULE, ' ');
      if (hadRule && rows.length && ruleAfter < 0 && /^\s*(\\(midrule|hline|cmidrule|cline))/.test(raw)) ruleAfter = rows.length;
      const cells = split(t, '&').map(x => {
        x = x.replace(/\s+/g, ' ');
        const mc = x.match(/^\s*\\multicolumn\s*\{\s*(\d+)\s*\}\s*\{[^}]*\}\s*\{([\s\S]*)\}\s*$/);
        return mc ? { span: +mc[1], v: sub(mc[2]).trim() } : { span: 1, v: sub(x).trim() };
      });
      if (cells.every(c => !c.v)) continue;
      rows.push(cells);
    }
    if (!rows.length) return '';
    if (!html) return '\u0002' + rows.map(r => r.map(c => c.v + '\u0001'.repeat(c.span - 1)).join('\u0001')).join('\u0002') + '\u0002';
    const head = ruleAfter > 0 && ruleAfter < rows.length ? ruleAfter : 0;
    const tr = (r, tag) => `<tr>${r.map(c => `<${tag}${c.span > 1 ? ` colspan="${c.span}"` : ''}>${c.v}</${tag}>`).join('')}</tr>`;
    return `<table class="tex-tab">${head ? `<thead>${rows.slice(0, head).map(r => tr(r, 'th')).join('')}</thead>` : ''}<tbody>${rows.slice(head).map(r => tr(r, 'td')).join('')}</tbody></table>`;
  }
  function readMath(close) {
    const st = i;
    for (; i < s.length; i++) {
      if (s[i] === '\\' && !s.startsWith(close, i)) { i++; continue; }
      if (s.startsWith(close, i)) { const t = s.slice(st, i); i += close.length; return t; }
    }
    return s.slice(st);
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = s.slice(i).match(/^\\([a-zA-Z@]+\*?|.)/);
      if (!m) { i++; continue; }
      i += m[0].length;
      let name = m[1];
      if (name === '(') { out.push(math(readMath('\\)'), false)); continue; }
      if (name === '[') { out.push(math(readMath('\\]'), true)); continue; }
      if (name === '\\') { readOpt(); out.push(html ? '<br>' : ' '); continue; }
      if (name.length === 1 && !/[a-zA-Z]/.test(name)) {
        if (ACC[name]) { const g = readGroup().replace(/^\\/, ''); const ch = g === 'i' ? 'i' : g; out.push(esc((ch + ACC[name]).normalize('NFC'))); continue; }
        if (name === ',' || name === ';' || name === ':' || name === ' ' || name === '!' || name === '/') { out.push(name === '!' || name === '/' ? '' : ' '); continue; }
        if (name === '-') continue;
        out.push(esc(name)); continue; // \% \& \$ \# \_ \{ \}
      }
      const star = name.endsWith('*');
      const base = star ? name.slice(0, -1) : name;
      if (/^(cite[a-zA-Z]*|nocite|parencite|textcite|autocite|footcite|citep|citet|citealp|citealt|citeauthor|citeyear)$/.test(base)) {
        readOpt(); readOpt();
        const keys = readGroup();
        if (base === 'nocite') continue;
        out.push(cite(keys, base)); continue;
      }
      if (/^(ref|eqref|autoref|Autoref|cref|Cref|pageref|vref|nameref)$/.test(base)) { const k = readGroup(); out.push(ref(k.split(',')[0].trim(), base)); continue; }
      if (base === 'url' || base === 'path') { const u = readGroup(); out.push(html ? `<a href="${escHtml(u)}" target="_blank" rel="noopener noreferrer">${escHtml(u)}</a>` : u); continue; }
      if (base === 'href') { const u = readGroup(); const t = readGroup(); out.push(html ? `<a href="${escHtml(u)}" target="_blank" rel="noopener noreferrer">${sub(t)}</a>` : sub(t)); continue; }
      if (base === 'footnote' || base === 'footnotetext' || base === 'thanks') { readOpt(); const t = readGroup(); out.push(html ? `<span class="fn" title="Footnote">${sub(t)}</span>` : ` [footnote: ${sub(t)}]`); continue; }
      if (base === 'IEEEPARstart') { const a = readGroup(); const b = readGroup(); out.push(sub(a) + sub(b)); continue; }
      if (base === 'textcolor' || base === 'colorbox') { readOpt(); readGroup(); out.push(sub(readGroup())); continue; }
      if (base === 'begin' || base === 'end') {
        const env = readGroup();
        if (base === 'begin' && /^(equation|align|gather|multline|eqnarray|displaymath|flalign|alignat|math)\*?$/.test(env)) {
          if (/^alignat/.test(env)) readGroup();
          const endTag = `\\end{${env}}`;
          const j = s.indexOf(endTag, i);
          const body = j >= 0 ? s.slice(i, j) : s.slice(i);
          i = j >= 0 ? j + endTag.length : s.length;
          const lab = (body.match(/\\label\{([^}]*)\}/) || [])[1];
          const clean = body.replace(/\\label\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
          const tex = /^(align|eqnarray|flalign|alignat)/.test(env) ? `\\begin{aligned}${clean.replace(/&\s*=\s*&/g, '&=')}\\end{aligned}` : /^(gather|multline)/.test(env) ? `\\begin{gathered}${clean}\\end{gathered}` : clean;
          const num = lab && labels[lab] ? labels[lab].n : null;
          out.push(html ? `<span class="eq">${math(tex, true)}${num ? `<span class="eqn">(${escHtml(String(num))})</span>` : ''}</span>` : ` $$${clean.trim()}$$${num ? ` (${num})` : ''} `);
          continue;
        }
        if (base === 'begin' && /^(itemize|enumerate|description)$/.test(env)) { readOpt(); out.push(html ? '<span class="list">' : ''); continue; }
        if (base === 'end' && /^(itemize|enumerate|description)$/.test(env)) { out.push(html ? '</span>' : ''); continue; }
        if (base === 'begin' && /^(tabular\*?|tabularx|tabulary|longtable\*?|array|tabu)$/.test(env)) { out.push(tabular(env)); continue; }
        if (base === 'begin') readOpt();
        continue;
      }
      if (base === 'item') { const lab = readOpt(); out.push(html ? `<span class="li">${lab ? `<b>${sub(lab)}</b> ` : '• '}` : `\n• ${lab ? sub(lab) + ' ' : ''}`); continue; }
      if (base === 'caption') { readOpt(); out.push(sub(readGroup())); continue; }
      if (/^(section|subsection|subsubsection|paragraph|subparagraph|chapter|part)$/.test(base)) { readOpt(); const t = readGroup(); out.push(html ? `<b>${sub(t)}</b> ` : `${sub(t)}. `); continue; }
      if (base === 'multicolumn') { readGroup(); readGroup(); out.push(sub(readGroup())); continue; }
      if (base === 'multirow') { readGroup(); readOpt(); readGroup(); out.push(sub(readGroup())); continue; }
      if (base === 'si' || base === 'SI' || base === 'num' || base === 'qty') { readOpt(); const v = readGroup(); const u = base === 'SI' || base === 'qty' ? ' ' + readGroup().replace(/\\percent/g, '%').replace(/\\/g, '') : ''; out.push(esc(v + u)); continue; }
      if (base === 'pm' || base === 'textpm') { out.push('±'); continue; }
      if (base === 'times') { out.push('×'); continue; }
      if (KEEP1.has(base)) {
        readOpt();
        const inner = sub(readGroup());
        if (html && FMT[base]) { const tag = FMT[base]; out.push(`<${tag}>${inner}</${tag.split(' ')[0]}>`); }
        else if (base === 'enquote') out.push(`“${inner}”`);
        else if (base === 'uppercase' || base === 'MakeUppercase') out.push(inner.toUpperCase());
        else out.push(inner);
        continue;
      }
      if (DROP1.has(base)) { readOpt(); readGroup(); continue; }
      if (DROP2.has(base)) { readOpt(); readGroup(); readOpt(); readGroup(); continue; }
      if (Object.prototype.hasOwnProperty.call(SYM, base)) { if (s[i] === '{' && s[i + 1] === '}') i += 2; out.push(esc(SYM[base])); continue; }
      if (Object.prototype.hasOwnProperty.call(macros, base) && depth < 20) { out.push(sub(String(macros[base]))); if (s[i] === '{' && s[i + 1] === '}') i += 2; continue; }
      // unknown command: keep its first argument, if any
      const save = i;
      while (s[i] === ' ') i++;
      if (s[i] === '[') readOpt();
      if (s[i] === '{') { out.push(sub(readGroup())); continue; }
      i = save;
      continue;
    }
    if (c === '$') {
      if (s[i + 1] === '$') { i += 2; out.push(math(readMath('$$'), true)); }
      else { i++; out.push(math(readMath('$'), false)); }
      continue;
    }
    if (c === '{' || c === '}') { i++; continue; }
    if (c === '~') { out.push(html ? '&nbsp;' : ' '); i++; continue; }
    if (c === '`' && s[i + 1] === '`') { out.push('“'); i += 2; continue; }
    if (c === "'" && s[i + 1] === "'") { out.push('”'); i += 2; continue; }
    if (c === '`') { out.push('‘'); i++; continue; }
    if (c === '-' && s[i + 1] === '-') { if (s[i + 2] === '-') { out.push('—'); i += 3; } else { out.push('–'); i += 2; } continue; }
    if (c === '&') { out.push(html ? ' &nbsp;' : ' | '); i++; continue; }
    // plain run
    let j = i;
    while (j < s.length && !'\\${}~`\'-&'.includes(s[j])) j++;
    if (j === i) { out.push(esc(s[i])); i++; continue; }
    out.push(esc(s.slice(i, j)));
    i = j;
  }
  const r = out.join('');
  return html ? r.replace(/\n\s*\n/g, '<br><br>') : r.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n(?!•)/g, ' ').replace(/ {2,}/g, ' ').replace(/ ?\u0002 ?/g, '\n').replace(/ ?\u0001 ?/g, '\t').replace(/^\n+|\n+$/g, '').trim();
}

/** Visible text of a block (LaTeX source is rendered, plain text is returned as is). */
export const blockText = (b, ctx) => (b && b.tex ? renderTex(b.cur ?? b.text, ctx) : String((b && (b.cur ?? b.text)) || ''));
