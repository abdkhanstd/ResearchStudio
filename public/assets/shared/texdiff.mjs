/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
// Shared by the browser (exports are made on the user's computer) and the server (hand-off to Rykhet LaTeX).
/**
 * latexdiff-style markup for the "Diff PDF": the revised LaTeX source with deletions struck through in red and
 * insertions underlined in blue, compiled on the user's machine. Safety first: the source is split into atomic tokens
 * (words, commands with their arguments, math, groups, environments, comments) so markup never cuts a construct in
 * half; only plain words get \sout / \uwave, everything else is coloured or, for structure (labels, \item, &), left as is.
 */

import { applyBibFixes } from './bib.mjs';

const ACCENT = /^[`'^"~=.uvHtcdbrk]$/;
const DROP_DELETED = new Set(['label', 'begin', 'end', 'item', 'section', 'subsection', 'subsubsection', 'paragraph', 'chapter', 'par', 'newline', 'linebreak', 'pagebreak', 'newpage', 'clearpage', 'hline', 'toprule', 'midrule', 'bottomrule', 'centering', 'noindent', 'vspace', 'hspace', 'caption', 'includegraphics', 'bibliography', 'bibliographystyle', 'input', 'include', 'maketitle', 'appendix']);

function tokenize(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  const group = (open, close, j) => {
    let depth = 0;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  };
  while (i < n) {
    const c = s[i];
    let j;
    if (/\s/.test(c)) { j = i; while (j < n && /\s/.test(s[j])) j++; out.push({ t: 'ws', s: s.slice(i, j) }); i = j; continue; }
    if (c === '%') { j = s.indexOf('\n', i); j = j < 0 ? n : j + 1; out.push({ t: 'cm', s: s.slice(i, j) }); i = j; continue; }
    if (c === '$') {
      const delim = s[i + 1] === '$' ? '$$' : '$';
      let k = i + delim.length;
      while (k < n) { if (s[k] === '\\') { k += 2; continue; } if (s.startsWith(delim, k)) break; k++; }
      j = k < n ? k + delim.length : n;
      out.push({ t: 'math', s: s.slice(i, j) }); i = j; continue;
    }
    if (c === '\\') {
      const nx = s[i + 1] || '';
      if (nx === '(' || nx === '[') { const end = nx === '(' ? '\\)' : '\\]'; const k = s.indexOf(end, i + 2); j = k < 0 ? n : k + 2; out.push({ t: 'math', s: s.slice(i, j) }); i = j; continue; }
      j = i + 1;
      let name = '';
      if (/[a-zA-Z@]/.test(nx)) { while (j < n && /[a-zA-Z@]/.test(s[j])) j++; name = s.slice(i + 1, j); if (s[j] === '*') j++; }
      else { j = Math.min(n, j + 1); name = nx; }
      if (/^[a-zA-Z@]+$/.test(name)) {
        // arguments directly after the command: [..] and {..}
        while (j < n && (s[j] === '{' || s[j] === '[')) { const e = group(s[j], s[j] === '{' ? '}' : ']', j); if (e < 0) break; j = e; }
        // a whole environment is one token
        if (name === 'begin') {
          const m = /^\\begin\{([^}]+)\}/.exec(s.slice(i, i + 80));
          if (m) { const endTok = `\\end{${m[1]}}`; const k = s.indexOf(endTok, j); if (k >= 0) j = k + endTok.length; }
        }
      } else if (ACCENT.test(name)) {
        // accents take the next character or group: \'e, \'{e}
        if (s[j] === '{') { const e = group('{', '}', j); if (e > 0) j = e; } else if (j < n && /\S/.test(s[j])) j++;
      }
      out.push({ t: 'cmd', s: s.slice(i, j), name }); i = j; continue;
    }
    if (c === '{') { j = group('{', '}', i); if (j < 0) j = i + 1; out.push({ t: 'grp', s: s.slice(i, j) }); i = j; continue; }
    if ('}&#^_~'.includes(c)) { out.push({ t: c === '~' ? 'w' : 'sp', s: c }); i++; continue; }
    // plain text: words and single punctuation marks
    j = i;
    while (j < n && !/[\s\\{}$%&#^_~]/.test(s[j])) j++;
    for (const m of s.slice(i, j).match(/\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{N}'’\-]+|[^\p{L}\p{N}'’\-]/gu) || []) out.push({ t: 'w', s: m });
    i = j;
  }
  return out;
}

const key = t => (t.t === 'ws' ? (/\n\s*\n/.test(t.s) ? '¶' : ' ') : `${t.t}:${t.s}`);

/** Token-level LCS diff → [{ op: '=', '-', '+', tok }] */
function diffTokens(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4e6) return [...a.map(tok => ({ op: '-', tok })), ...b.map(tok => ({ op: '+', tok }))];
  const ka = a.map(key), kb = b.map(key);
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = ka[i] === kb[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { ops.push({ op: '=', tok: b[j] }); i++; j++; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) ops.push({ op: '-', tok: a[i++] });
    else ops.push({ op: '+', tok: b[j++] });
  }
  while (i < n) ops.push({ op: '-', tok: a[i++] });
  while (j < m) ops.push({ op: '+', tok: b[j++] });
  return ops;
}

const safe = t => t.t === 'w' || (t.t === 'ws' && !/\n\s*\n/.test(t.s));

/** Markup for one run of deleted or added tokens. `moving`: heading or caption text (no \sout / \uwave there). */
function runMarkup(toks, op, moving) {
  let out = '';
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.map(t => t.s).join('');
    buf = [];
    if (!text.trim()) { if (op === '+') out += text; else out += text.includes('\n') ? '\n' : ''; return; }
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    const core = text.trim();
    const cmd = moving ? (op === '+' ? '\\DIFaddtx' : '\\DIFdeltx') : (op === '+' ? '\\DIFadd' : '\\DIFdel');
    out += `${op === '+' ? lead : lead ? ' ' : ''}${cmd}{${core}}${op === '+' ? trail : trail ? ' ' : ''}`;
  };
  for (const t of toks) {
    if (safe(t)) { buf.push(t); continue; }
    flush();
    if (op === '+') {
      if (t.t === 'math' || t.t === 'grp') out += `{\\color{blue}${t.s}}`;
      else if (t.t === 'cmd' && t.name === 'begin') out += `\\begingroup\\color{blue}${t.s}\\endgroup `;
      else if (t.t === 'cmd' && !DROP_DELETED.has(t.name) && (/^[a-zA-Z@]+$/.test(t.name) || ACCENT.test(t.name) || /^[%&#$_{}]$/.test(t.name))) out += `{\\color{blue}${t.s}}`;
      else out += t.s; // structure and symbols stay exactly as written
    } else {
      if (t.t === 'math' && !/^\$\$|^\\\[/.test(t.s)) out += `{\\color{red}${t.s}}`;
      else if (t.t === 'grp') out += `{\\color{red}${t.s}}`;
      else if (t.t === 'cmd' && !DROP_DELETED.has(t.name) && (/^[a-zA-Z@]+$/.test(t.name) || ACCENT.test(t.name) || /^[%&#$_{}]$/.test(t.name))) out += `{\\color{red}${t.s}}`;
      else if (t.t === 'ws' && /\n\s*\n/.test(t.s)) out += ' ';
      // dropped: comments, labels, environments, \item, alignment marks (re-emitting them would change the structure)
    }
  }
  flush();
  return out;
}

/** Marked-up LaTeX for one block: original `a` against current `b`. */
function markBlock(a, b, kind) {
  if (a === b) return b;
  const moving = kind === 'heading' || kind === 'caption';
  if (!['para', 'heading', 'caption', 'item', 'abstract', 'quote', 'footnote', 'list'].includes(kind) && kind) {
    // displayed maths, tables, algorithms: show the new version in colour
    return b.trim() ? `\\begingroup\\color{blue}${b}\\endgroup ` : '';
  }
  const ops = diffTokens(tokenize(a), tokenize(b));
  let out = '';
  for (let k = 0; k < ops.length;) {
    const op = ops[k].op;
    if (op === '=') { out += ops[k].tok.s; k++; continue; }
    const run = [];
    while (k < ops.length && ops[k].op === op) run.push(ops[k++].tok);
    out += runMarkup(run, op, moving);
  }
  return out;
}

const PREAMBLE = String.raw`
%% ---- Research Studio: change markup (latexdiff style) ----
\makeatletter
\@ifpackageloaded{xcolor}{}{\@ifpackageloaded{color}{}{\usepackage{xcolor}}}
\@ifpackageloaded{ulem}{}{\usepackage[normalem]{ulem}}
\makeatother
\providecommand{\DIFadd}[1]{{\protect\color{blue}\uwave{#1}}}
\providecommand{\DIFdel}[1]{{\protect\color{red}\sout{#1}}}
\providecommand{\DIFaddtx}[1]{{\protect\color{blue}#1}}
\providecommand{\DIFdeltx}[1]{{\protect\color{red}#1}}
%% ----
`;

/**
 * The marked-up project: { files: { path: text }, main, marked } — `texFiles` is the base the block spans point into,
 * `b.text` the version first uploaded and `b.cur` the current one.
 */
function diffProject(p) {
  const files = { ...(p.source && p.source.texFiles || {}) };
  const byFile = new Map();
  for (const b of p.blocks || []) if (b.src && typeof files[b.src.file] === 'string') (byFile.get(b.src.file) || byFile.set(b.src.file, []).get(b.src.file)).push(b);
  const removedBy = new Map();
  for (const r of p.removedBlocks || []) if (r.anchor) (removedBy.get(r.anchor) || removedBy.set(r.anchor, []).get(r.anchor)).push(r);
  let marked = 0;
  for (const [file, list] of byFile) {
    let t = files[file];
    list.sort((x, y) => y.src.start - x.src.start);
    list.forEach((b, k) => {
      const base = b.base ?? b.text, cur = b.cur ?? b.text;
      if (t.slice(b.src.start, b.src.end) !== base) return;
      const rep = b.added ? markBlock('', cur, b.kind) : cur !== b.text ? markBlock(b.text, cur, b.kind) : cur;
      if (rep !== base) { t = t.slice(0, b.src.start) + rep + t.slice(b.src.end); marked++; }
      // removed paragraphs go in as their own paragraph at the blank line before this block (never inside \section{…})
      const gone = removedBy.get(b.id);
      if (gone) {
        const prevEnd = list[k + 1] ? list[k + 1].src.end : 0;
        const at = t.lastIndexOf('\n\n', b.src.start);
        if (at >= prevEnd) { t = t.slice(0, at + 1) + gone.map(r => `\n${markBlock(r.text, '', r.kind)}\n`).join('') + t.slice(at + 1); marked += gone.length; }
      }
    });
    files[file] = t;
  }
  // corrections of .bib entries from the reference check: applied as they are (a bibliography is not marked up)
  if (p.bib && p.bib.fixes && p.bib.fixes.length) Object.assign(files, applyBibFixes(files, p.bib.fixes).files);
  const main = p.source && p.source.main;
  if (main && typeof files[main] === 'string') {
    const t = files[main];
    const at = t.indexOf('\\begin{document}');
    if (at >= 0) files[main] = t.slice(0, at) + PREAMBLE + t.slice(at);
    else { const dc = t.search(/\\documentclass[^\n]*\n/); files[main] = dc >= 0 ? t.replace(/(\\documentclass[^\n]*\n)/, `$1${PREAMBLE}`) : PREAMBLE + t; }
  }
  return { files, main, marked };
}

export { tokenize, diffTokens, markBlock, diffProject };
