/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
// Shared by the browser and the server. BibTeX entries of a LaTeX project: reading and writing them, which entries the
// manuscript cites, what the reference check is sent, and the corrections an owner applies to the .bib files.
// Reading, writing and the check follow Rykhet LaTeX's reference check (its bib.ts and BibCheck.tsx), so an entry is
// judged the same way in both apps.

function readValue(s, i) {
  while (/\s/.test(s[i] || '')) i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '"') {
    let depth = 0;
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '{') depth++;
      else if (s[j] === '}') depth--;
      else if (s[j] === '"' && depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  const m = /^[^,}\s]+/.exec(s.slice(i));
  return [m ? m[0] : '', i + (m ? m[0].length : 0)];
}

/**
 * Every @type{key, …} entry (not @string/@comment/@preamble): { key, type, from, to, headEnd, fields, commented? }.
 * from/to are the offsets of "@type{" and just after the closing brace.
 */
export function parseBibEntries(text) {
  text = String(text || '');
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (['string', 'comment', 'preamble'].includes(type)) continue;
    const start = m.index;
    const open = text.indexOf('{', start);
    let depth = 0, end = text.length;
    for (let j = open; j < text.length; j++) {
      if (text[j] === '\\') { j++; continue; }
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    const body = text.slice(m.index + m[0].length, end - 1);
    const fields = {};
    const commented = {};
    let i = 0;
    while (i < body.length) {
      // a line commented out with % inside the entry: read past it (BibTeX itself stops reading the entry there — the
      // check warns about it); "%doi = {…}" is remembered as a field hidden on purpose
      const cm = /^[\s,]*%[ \t]*(?:([A-Za-z][\w-]*)\s*=\s*)?/.exec(body.slice(i));
      if (cm) {
        const lineEnd = body.indexOf('\n', i + cm[0].length);
        const stop = lineEnd < 0 ? body.length : lineEnd;
        if (cm[1]) commented[cm[1].toLowerCase()] = body.slice(i + cm[0].length, stop).trim().replace(/,\s*$/, '').replace(/^\{([\s\S]*)\}$|^"([\s\S]*)"$/, '$1$2').trim();
        i = stop;
        continue;
      }
      const fm = /^[\s,]*([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(i));
      if (!fm) break;
      const [val, next] = readValue(body, i + fm[0].length);
      fields[fm[1].toLowerCase()] = val.replace(/\s+/g, ' ').trim();
      i = next;
    }
    const nl = text.indexOf('\n', start);
    out.push({ key: m[2], type, from: start, to: end, headEnd: nl < 0 || nl > end ? m.index + m[0].length : nl, fields, ...(Object.keys(commented).length ? { commented } : {}) });
    re.lastIndex = end;
  }
  return out;
}

const ORDER = ['author', 'title', 'journal', 'booktitle', 'publisher', 'year', 'volume', 'number', 'pages', 'doi'];
/** Write an entry, corrected fields first in the usual order, then the original's other fields (note, url…). */
export function formatEntry(type, key, fields, original) {
  const all = { ...(original || {}), ...fields };
  // a journal article has no booktitle and the other way round
  if (type === 'article') delete all.booktitle;
  if (type === 'inproceedings' || type === 'incollection') delete all.journal;
  const keys = [...ORDER.filter(k => all[k]), ...Object.keys(all).filter(k => !ORDER.includes(k) && all[k])];
  const w = Math.max(...keys.map(k => k.length));
  // keep capitals in titles as typed in the record
  const val = (k, v) => (k === 'title' && /[A-Z]{2,}|[a-z][A-Z]/.test(v) && !/^\{.*\}$/.test(v) ? `{${v}}` : v);
  return `@${type}{${key},\n${keys.map(k => `  ${k.padEnd(w)} = {${val(k, all[k])}}`).join(',\n')}\n}`;
}

const uncomment = t => String(t || '').split('\n').map(l => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
/** The keys the manuscript cites (\cite, \citep, \parencite, \nocite…, comments ignored); `all` for \nocite{*}. */
export function citedKeys(texts) {
  const keys = new Set();
  let all = false;
  const re = /\\[A-Za-z]*cite[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
  for (const t of texts) {
    for (const m of uncomment(t).matchAll(re)) {
      for (const k of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        if (k === '*') all = true;
        else keys.add(k);
      }
    }
  }
  return { all, keys };
}

/** Does this LaTeX source name the .bib file (\bibliography{refs,other}, \addbibresource{refs.bib}, comments ignored)? */
export function usesBib(tex, bibPath) {
  const name = bibPath.replace(/^.*\//, '').replace(/\.bib$/i, '').toLowerCase();
  for (const m of uncomment(tex).matchAll(/\\(?:bibliography|addbibresource|addglobalbib|nobibliography)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const f of m[1].split(',')) if (f.trim().replace(/^.*\//, '').replace(/\.bib$/i, '').toLowerCase() === name) return true;
  }
  return false;
}

/** The text range that deleting an entry removes: the entry, its line break and one blank line after it. */
export function entryRemoval(text, e) {
  let to = e.to;
  const nl = () => (text.startsWith('\r\n', to) ? 2 : text[to] === '\n' ? 1 : 0);
  while (text[to] === ' ' || text[to] === '\t') to++;
  to += nl();
  const blankBefore = /\n[ \t]*\r?\n[ \t]*$/.test(text.slice(Math.max(0, e.from - 4), e.from)) || e.from === 0;
  if (blankBefore) { let k = to; while (text[k] === ' ' || text[k] === '\t') k++; const n = text.startsWith('\r\n', k) ? 2 : text[k] === '\n' ? 1 : 0; if (n) to = k + n; }
  return { from: e.from, to };
}

/** A DOI kept out of the printed bibliography on purpose: as xdoi = {…} (BibTeX ignores fields it doesn't know) or "%doi = {…}". */
export const hiddenDoi = e => e.fields.xdoi || (e.commented && e.commented.doi) || '';
/** What is checked, so an unchanged entry isn't checked again. */
export const bibFingerprint = e => JSON.stringify([e.type, e.fields.title, e.fields.author, e.fields.year, e.fields.doi || hiddenDoi(e), e.fields.journal || e.fields.booktitle, e.fields.volume, e.fields.pages, e.fields.eprint, e.fields.url || e.fields.xurl]);

/** Entry types Crossref doesn't hold (web pages, software, theses, reports…): not checked — unless the entry cites an
 *  arXiv paper or has a DOI, which can be looked up whatever the type (@misc preprints are common). */
export const SKIP_TYPES = new Set(['misc', 'online', 'electronic', 'www', 'webpage', 'software', 'manual', 'techreport', 'report', 'phdthesis', 'mastersthesis', 'thesis', 'unpublished', 'patent', 'dataset', 'standard']);
/** An arXiv preprint, also as DBLP writes them (journal = {CoRR}, volume = {abs/2510.17543}). */
export const isArxiv = f => /arxiv/i.test([f.journal, f.eprint, f.archiveprefix, f.eprinttype, f.url, f.xurl, f.doi, f.xdoi, f.note, f.howpublished].join(' ')) || /^corr$/i.test(String(f.journal || '').trim()) || /^abs\//i.test(String(f.volume || '').trim());
export const checkable = e => !!(e.fields.title || e.fields.doi || hiddenDoi(e)) && (!SKIP_TYPES.has(e.type) || isArxiv(e.fields) || !!(e.fields.doi || hiddenDoi(e)));

/** What the server's reference check is given for an entry (a DOI hidden from the bibliography is still checked). */
export function payloadOf(e) {
  const f = e.fields;
  return {
    key: e.key, type: e.type, title: f.title, author: f.author || f.editor, year: f.year || (f.date || '').slice(0, 4),
    doi: f.doi || hiddenDoi(e), journal: f.journal || f.journaltitle, booktitle: f.booktitle, volume: f.volume, pages: f.pages, arxiv: isArxiv(f),
    eprint: f.eprint, url: f.url || f.xurl,
  };
}

/** The result as shown: with DOIs not checked, a missing or different DOI is not a difference and isn't added. */
export function shown(r, skipDoi) {
  if (!r || !skipDoi) return r;
  const diffs = (r.diffs || []).filter(d => d.field !== 'doi');
  const suggestion = r.suggestion && { ...r.suggestion, fields: Object.fromEntries(Object.entries(r.suggestion.fields).filter(([k]) => k !== 'doi')) };
  if (r.status === 'warn' && !diffs.length && r.suggestion) return { ...r, status: 'ok', message: 'Matches the published record', diffs, suggestion };
  const message = r.status === 'warn' && diffs.length !== r.diffs.length ? `${diffs.length} difference${diffs.length > 1 ? 's' : ''} from the published record` : r.message;
  return { ...r, message, diffs, suggestion: suggestion || undefined };
}

/** Google Scholar search for an entry's title (opened by the user: no API, no scraping). */
export function scholarUrl(e) {
  const title = String(e.fields.title || '').replace(/\\((?:La|Bib)?TeX)\b/g, '$1').replace(/\\[a-zA-Z]+\s*/g, ' ').replace(/[{}$\\]/g, '').replace(/\s+/g, ' ').trim();
  const a = String(e.fields.author || '').split(/\s+and\s+/i)[0] || '';
  const last = (a.includes(',') ? a.split(',')[0] : a.trim().split(/\s+/).pop() || '').replace(/[{}\\"']/g, '').trim();
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(title || [last, e.fields.year].filter(Boolean).join(' ') || e.key)}`;
}
/** The entry's DOI and URL as addresses to open (also xdoi/xurl and "%doi" kept out of the bibliography). */
export function entryLinks(e) {
  const out = [];
  const f = { ...(e.commented || {}), ...e.fields };
  const plain = v => String(v || '').replace(/\\url\{([^}]*)\}/g, '$1').replace(/\\([_%#&$~])/g, '$1').replace(/[{}\s]/g, '');
  const doi = plain(f.doi || f.xdoi);
  if (doi) out.push({ kind: 'DOI', url: /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi.replace(/^doi:\s*/i, '')}` });
  const url = plain(f.url || f.xurl);
  if (/^https?:\/\//i.test(url) && !(doi && url.includes(doi))) out.push({ kind: 'URL', url });
  return out;
}

/**
 * Lines commented out with % inside an entry. BibTeX does not skip them: it stops reading the entry there ("You're
 * missing a field name") and drops the fields after it. A field line ("%doi = {…}") can be written as xdoi = {…},
 * which BibTeX ignores like any field it doesn't know: `fixed` is the entry with that change (and a comma the line
 * before may need). Offsets are within the file text.
 */
export function commentedLines(text, e) {
  const out = [];
  const start = e.headEnd;
  const body = text.slice(start, e.to);
  let entry = text.slice(e.from, e.to);
  // applied from the last line up, so earlier offsets stay valid
  const fixes = [];
  for (const m of body.matchAll(/^([ \t]*)(%[ \t]*)(?:([A-Za-z][\w-]*)\s*=)?[^\n]*/gm)) {
    const at = start + m.index;
    const pct = at + m[1].length;
    const item = { line: m[0].trim().slice(0, 120) };
    if (m[3]) {
      item.field = m[3].toLowerCase();
      let k = pct - 1;
      for (;;) {
        while (k >= start && /\s/.test(text[k])) k--;
        const ls = text.lastIndexOf('\n', k) + 1;
        if (k >= start && /^[ \t]*%/.test(text.slice(ls, k + 1))) { k = ls - 1; continue; }
        break;
      }
      const needComma = k >= start && text[k] !== ',' && text[k] !== '{';
      fixes.push(needComma ? { from: k + 1, to: pct + m[2].length, insert: ',' + text.slice(k + 1, pct) + 'x' } : { from: pct, to: pct + m[2].length, insert: 'x' });
    }
    out.push(item);
  }
  for (const f of fixes.sort((a, b) => b.from - a.from)) entry = entry.slice(0, f.from - e.from) + f.insert + entry.slice(f.to - e.from);
  return { lines: out, fixed: fixes.length ? entry : null };
}

const isTex = f => /\.(tex|ltx)$/i.test(f);
/** The project's .bib files and whether a .tex file names each (when none is named, all of them count). */
export function bibFiles(texFiles) {
  const names = Object.keys(texFiles || {}).filter(f => /\.bib$/i.test(f)).sort();
  const texs = Object.entries(texFiles || {}).filter(([f]) => isTex(f)).map(([, t]) => t);
  const list = names.map(path => ({ path, uses: texs.some(t => usesBib(t, path)) }));
  return list.some(x => x.uses) ? list.filter(x => x.uses) : list;
}

/**
 * The project's .bib files with the owner's corrections applied. A correction is { id, file, key, orig, text }: the
 * entry as uploaded (orig) and as corrected (text; '' removes the entry). It is applied only where the entry still
 * reads as uploaded; one that is there already (a newer version brought in with it) counts as present, and one whose
 * entry changed otherwise is stale. Returns { files, applied, present, stale } (ids).
 */
export function applyBibFixes(texFiles, fixes) {
  const files = { ...(texFiles || {}) };
  const applied = [], present = [], stale = [];
  const byFile = new Map();
  for (const f of fixes || []) (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(f);
  for (const [file, list] of byFile) {
    const t = files[file];
    if (typeof t !== 'string') { stale.push(...list.map(f => f.id)); continue; }
    const entries = parseBibEntries(t);
    const edits = [];
    for (const f of list) {
      const e = entries.find(x => x.key === f.key) || entries.find(x => x.key.toLowerCase() === String(f.key).toLowerCase());
      const now = e ? t.slice(e.from, e.to) : null;
      if (now === null) { (f.text === '' ? present : stale).push(f.id); continue; }
      if (now === f.orig) {
        edits.push(f.text === '' ? { ...entryRemoval(t, e), insert: '' } : { from: e.from, to: e.to, insert: f.text });
        applied.push(f.id);
      } else if (now === f.text) present.push(f.id);
      else stale.push(f.id);
    }
    let out = t;
    for (const x of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, x.from) + x.insert + out.slice(x.to);
    files[file] = out;
  }
  return { files, applied, present, stale };
}

/** Where corrected entries sit in a revised .bib text (for the source view): [{ start, end, key, changed: true }]. */
export function fixRegions(text, fixes) {
  const keys = new Map((fixes || []).filter(f => f.text).map(f => [f.key, f.text]));
  if (!keys.size) return [];
  return parseBibEntries(text).filter(e => keys.get(e.key) === text.slice(e.from, e.to)).map(e => ({ start: e.from, end: e.to, key: e.key, changed: true, bib: true }));
}

/**
 * The bibliography as the reference check sees it: every entry of the .bib files in use (with corrections applied),
 * whether the manuscript cites it, and what is checked. id = "<file>#<key>".
 */
export function bibState(texFiles, fixes) {
  const { files } = applyBibFixes(texFiles, fixes);
  const used = bibFiles(files);
  const cited = citedKeys(Object.entries(files).filter(([f]) => isTex(f)).map(([, t]) => t));
  const entries = [];
  const seen = new Set();
  for (const { path } of used) {
    const text = files[path] || '';
    for (const e of parseBibEntries(text)) {
      // IEEEtran's style control entry (\bstctlcite) is not a reference
      if (e.type === 'ieeetranbstctl') continue;
      const dup = seen.has(e.key.toLowerCase());
      seen.add(e.key.toLowerCase());
      entries.push({ ...e, id: `${path}#${e.key}`, file: path, text: text.slice(e.from, e.to), dup, cited: cited.all || cited.keys.has(e.key), fp: bibFingerprint(e), checkable: checkable(e) });
    }
  }
  // a manuscript whose \cite commands couldn't be found: check every entry rather than none
  const none = !cited.all && entries.length && !entries.some(e => e.cited);
  if (none) for (const e of entries) e.cited = true;
  const have = new Set(entries.map(e => e.key));
  // \bstctlcite{IEEEexample:BSTcontrol} is not a citation either
  const missing = [...cited.keys].filter(k => !have.has(k) && !/^IEEEexample:/i.test(k));
  return { files: used.filter(f => entries.some(e => e.file === f.path)), entries, all: cited.all || none, missing };
}
