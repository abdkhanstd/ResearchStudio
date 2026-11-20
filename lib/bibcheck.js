/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
// Reference check for .bib entries against Crossref: is the entry real, and do title, authors, year, venue,
// volume, pages and DOI match the published record? Returns a status per entry and a corrected version.
// Crossref is asked politely (identified User-Agent, a few requests at a time) and answers are cached.
// THE SAME CHECK AS RYKHET LATEX (latex.rykhet.com server/lib/bibcheck.js, cache v12): everything above the factory at
// the end is a verbatim copy — when the matching rules change there, copy that part here.
const fs = require('fs');
const crypto = require('crypto');

const UA = 'ResearchStudio/1.0 (self-hosted; reference check)';
const API = 'https://api.crossref.org';

const clean = s => String(s || '')
  .replace(/<[^>]+>/g, '')                                   // JATS/HTML tags in Crossref titles
  .replace(/\\[`'^"~=.]\s*\{?([A-Za-z])\}?/g, '$1')           // \"u, \'{e} → u, e
  .replace(/\\[uvHtcdbrk](?:\s+|\{)([A-Za-z])\}?/g, '$1')       // \v{s}, \c c → s, c (not \textit)
  .replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1')              // \emph{x} → x
  .replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}\\$~]/g, '')
  .replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(w => w.length > 2));
  const B = new Set(norm(b).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return (2 * n) / (A.size + B.size);
}
/** An entry's authors as surname + initials ("Stoica, Ion T." and "Ion T. Stoica" both → stoica, [i, t]), with the
 *  text as written (kept in corrections) and its style ("Surname, First" or "First Surname"). */
function parseAuthors(field) {
  return String(field || '').split(/\s+and\s+/i).map(r => r.trim()).filter(r => r && !/^others$/i.test(r)).map(raw => {
    const a = clean(raw);
    let family, given;
    if (a.includes(',')) { const [f, ...g] = a.split(','); family = f; given = g.join(' '); }
    else {
      const parts = a.split(/\s+/);
      family = parts.pop();
      // "Jan van der Berg": the particles belong to the surname
      while (parts.length > 1 && /^(van|von|der|den|de|da|di|du|del|della|des|le|la|ter|ten|dos|das|do|bin|ibn|al|el)$/i.test(parts[parts.length - 1])) family = `${parts.pop()} ${family}`;
      given = parts.join(' ');
    }
    return { raw, comma: a.includes(','), name: a, family: norm(family), initials: norm(given).split(/[\s-]+/).filter(Boolean).map(w => w[0]) };
  });
}
const sameFamily = (a, b) => a === b || a.replace(/ /g, '') === b.replace(/ /g, '') || a.endsWith(' ' + b) || b.endsWith(' ' + a);
/** A record's author written the way the entry writes its names. */
const styled = (t, comma) => (comma ? [t.family0, t.given0].filter(Boolean).join(', ') : [t.given0, t.family0].filter(Boolean).join(' '));
/**
 * What is wrong with an entry's author list compared with the record, or null: a different number of authors
 * (unless "and others"), a different surname at a position, or initials that differ or are extra ("Ion T." for
 * "Ion"). A middle initial the entry leaves out is fine. Returns what differs (detail) and the corrected list: only the
 * authors that differ are replaced, in the entry's own name style; the others stay exactly as written.
 */
function authorDiff(field, recordAuthors, strictInitials = true) {
  const mine = parseAuthors(field);
  const theirs = (recordAuthors || []).map(a => {
    const family0 = clean(String(a.family || a.name || '')), given0 = a.family ? clean(String(a.given || '')) : '';
    return { family: norm(family0), initials: norm(given0).split(/[\s-]+/).filter(Boolean).map(w => w[0]), name: [given0, family0].filter(Boolean).join(' '), family0, given0 };
  }).filter(a => a.family);
  if (!mine.length || !theirs.length) return null;
  const etAl = /\band\s+others\b/i.test(String(field || ''));
  const comma = mine.filter(m => m.comma).length > mine.length / 2;
  const whole = () => theirs.map(t => styled(t, comma)).join(' and ');
  if (!etAl && mine.length !== theirs.length) return { detail: `${mine.length} author${mine.length > 1 ? 's' : ''} here, ${theirs.length} in the record`, corrected: whole() };
  if (etAl && mine.length > theirs.length) return { detail: `${mine.length} authors before "others", ${theirs.length} in the record`, corrected: whole() };
  const problems = [];
  const out = mine.map(m => m.raw);
  for (let i = 0; i < Math.min(mine.length, theirs.length); i++) {
    let m = mine[i];
    const t = theirs[i];
    // a record whose name for this author is broken ("Ed H." with no surname) says nothing about it
    if (t.family.length <= 2) continue;
    // a surname of several words ("Abu Alhaija", "van der Berg") written first-name-first ("Hassan Abu Alhaija"): the entry
    // can't show where the first name ends, so the record's surname decides — "Abu" is not a middle name
    const words = norm(m.name).split(/\s+/).filter(Boolean), fam = t.family.split(/\s+/).filter(Boolean);
    if (fam.length > 1 && words.length > fam.length && words.slice(-fam.length).join(' ') === fam.join(' ')) {
      m = { ...m, family: t.family, initials: words.slice(0, -fam.length).map(w => w[0]) };
    }
    // nothing to correct when the correction would read the same
    if (norm(styled(t, m.comma)) === norm(m.raw)) continue;
    let why = '';
    if (!sameFamily(m.family, t.family)) why = 'a different surname';
    else if (t.initials.length) {
      // an initial the publisher's record (as printed in the paper) doesn't have: "Tom M. Mitchell" for "Tom Mitchell"
      // (preprint and index records drop middle initials, so there only a different initial counts)
      if (m.initials.some((x, k) => k < t.initials.length && x !== t.initials[k])) why = m.initials[0] !== t.initials[0] ? 'a different first name' : 'a different middle initial';
      else if (strictInitials && m.initials.length > t.initials.length) why = 'a middle initial the record doesn’t have';
    }
    if (!why) continue;
    problems.push(`Author ${i + 1}: “${m.name}” here, “${t.name}” in the record (${why})`);
    out[i] = styled(t, m.comma);
  }
  if (!problems.length) return null;
  return { detail: problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; and ${problems.length - 3} more` : ''), corrected: out.join(' and ') + (etAl ? ' and others' : '') };
}

/** Entry types that fit a Crossref record type (the first is the one to suggest), and what the record is. */
const TYPE_FIT = {
  'proceedings-article': [['inproceedings', 'conference'], 'a conference paper'],
  // LNCS and similar conference papers are book chapters in Crossref
  'book-chapter': [['incollection', 'inbook', 'inproceedings', 'conference'], 'a chapter in a book'],
  'journal-article': [['article'], 'a journal article'],
  book: [['book'], 'a book'], monograph: [['book'], 'a book'], 'edited-book': [['book', 'proceedings'], 'an edited book'], 'reference-book': [['book'], 'a book'],
  proceedings: [['proceedings', 'book'], 'a proceedings volume'],
  dissertation: [['phdthesis', 'mastersthesis', 'thesis'], 'a thesis'],
  report: [['techreport', 'report', 'misc'], 'a report'],
};
/** A @type that doesn't fit the publisher's record: { have, fix, kind } or null. */
function typeMismatch(entryType, recordType) {
  const fit = TYPE_FIT[recordType];
  const t = String(entryType || '').toLowerCase();
  if (!fit || !t || fit[0].includes(t)) return null;
  return { have: `@${t}`, fix: `@${fit[0][0]}`, kind: fit[1] };
}

/** Do the two author lists share anyone? null when either list is empty. */
function sameAuthors(authorField, items) {
  const mine = new Set(lastNames(authorField).map(norm).filter(n => n && n !== 'others'));
  const theirs = (items || []).map(a => norm(String(a.family || a.name || ''))).filter(Boolean);
  if (!mine.size || !theirs.length) return null;
  return theirs.some(t => mine.has(t) || [...mine].some(m => m.length > 3 && (t.endsWith(' ' + m) || m.endsWith(' ' + t))));
}
const lastNames = authorField => clean(authorField).split(/\s+and\s+/i).map(a => (a.includes(',') ? a.split(',')[0] : a.split(' ').slice(-1)[0]).trim().toLowerCase()).filter(Boolean);

// one Crossref request at a time, a short gap between them (the public pool limits concurrency)
let queue = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(url) {
  const run = queue.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
        if (r.status === 404) return null;
        if (r.status === 429 || r.status === 503) { await sleep(1000 * (Number(r.headers.get('retry-after')) || 2 + attempt * 2)); continue; }
        if (!r.ok) throw new Error(`Crossref ${r.status}`);
        return await r.json();
      } finally { clearTimeout(t); await sleep(200); }
    }
    throw new Error('Crossref is busy');
  });
  queue = run.catch(() => {});
  return run;
}

/** Is a DOI registered at all (arXiv, Zenodo and others register with DataCite, not Crossref)? */
async function doiRegistered(doi) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://doi.org/api/handles/${encodeURIComponent(doi)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (j.responseCode === 1) return true;
    if (j.responseCode === 100 || r.status === 404) return false;
    return null;
  } catch { return null; } finally { clearTimeout(t); }
}

// arXiv, for preprints cited by their identifier (DBLP: journal = {CoRR}, volume = {abs/2510.17543}; or eprint, url,
// "arXiv preprint arXiv:…", 10.48550/arXiv.… DOIs). arXiv asks for one request every three seconds.
let arxivQueue = Promise.resolve();
function arxivGet(id, query) {
  const run = arxivQueue.then(async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`https://export.arxiv.org/api/query?${query || `id_list=${encodeURIComponent(id)}&max_results=1`}`, { headers: { 'User-Agent': UA }, signal: ctl.signal });
      if (!r.ok) throw new Error(`arXiv ${r.status}`);
      return await r.text();
    } finally { clearTimeout(t); await sleep(3000); }
  });
  arxivQueue = run.catch(() => {});
  return run;
}
const arxivIdOf = e => {
  const s = [e.eprint, e.volume, e.journal, e.doi, e.url].map(x => String(x || '')).join(' ');
  const m = /(?:arxiv[.:/\s]*|abs\/|^|\s)(\d{4}\.\d{4,5})(?:v\d+)?\b/i.exec(s) || /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/.exec(s);
  return m ? m[1] : '';
};
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
function parseArxiv(xml, id) {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml);
  if (!entry) return null;
  const get = tag => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry[1]); return m ? unxml(m[1]).replace(/\s+/g, ' ').trim() : ''; };
  const title = get('title');
  if (!title || /^error$/i.test(title) || !/arxiv\.org\/abs\//.test(get('id'))) return null;
  const authors = [...entry[1].matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map(m => { const parts = unxml(m[1]).trim().split(/\s+/); return { family: parts.pop() || '', given: parts.join(' ') }; });
  const year = Number((get('published').match(/^\d{4}/) || ['0'])[0]);
  return { title: [title], author: authors, issued: { 'date-parts': [[year]] }, type: 'posted-content', 'container-title': ['arXiv'], DOI: `10.48550/arXiv.${id}`, link: `https://arxiv.org/abs/${id}` };
}

/** The published record for an entry: by DOI when there is one, else the best title match. */
async function lookup(e) {
  // a preprint cited by its arXiv identifier: the arXiv record
  const axId = e.arxiv ? arxivIdOf(e) : '';
  if (axId && !/^10\.(?!48550)/.test(String(e.doi || ''))) {
    const item = parseArxiv(await arxivGet(axId), axId);
    if (!item) return { item: null, by: 'arxiv', arxivMissing: axId };
    // the identifier is another paper's: an error, unless the title and authors are this one
    if (clean(e.title) && similarity(e.title, item.title[0]) < 0.5 && sameAuthors(e.author, item.author) !== true) return { item: null, by: 'arxiv', arxivOther: { id: axId, title: item.title[0] } };
    return { item, by: 'arxiv', source: 'arxiv' };
  }
  const doi = String(e.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  if (doi) {
    const j = await get(`${API}/works/${encodeURIComponent(doi)}`);
    if (j && j.message) {
      // the DOI exists, but is it this paper? (a wrong DOI pasted from another entry)
      const t = (j.message.title || [])[0] || '';
      if (clean(e.title) && similarity(e.title, t) < 0.5 && sameAuthors(e.author, j.message.author) !== true) {
        const right = await lookup({ ...e, doi: '' });
        return { ...right, wrongDoi: { doi, title: clean(t) } };
      }
      return { item: j.message, by: 'doi' };
    }
    const reg = await doiRegistered(doi);
    if (reg === false) return { item: null, by: 'doi', doiMissing: true };
    // registered elsewhere (e.g. an arXiv preprint): check the title instead
    const byTitle = clean(e.title) ? await lookup({ ...e, doi: '' }) : { item: null, by: 'none' };
    return { ...byTitle, doiElsewhere: reg === true, doiUnknown: reg === null };
  }
  const title = clean(e.title);
  if (!title) return { item: null, by: 'none' };
  const first = lastNames(e.author)[0] || '';
  const q = [title, first].join(' ').slice(0, 300);
  const j = await get(`${API}/works?rows=6&query.bibliographic=${encodeURIComponent(q)}&select=DOI,title,author,issued,published-print,published-online,container-title,short-container-title,volume,issue,page,type,publisher,event`);
  const best = pick((j && j.message && j.message.items) || [], e);
  if (best) return { item: best.item, by: 'title', score: best.score, source: 'crossref' };
  // not in Crossref (many conference proceedings and preprints): OpenAlex
  const oa = await openAlex(e).catch(() => null);
  if (oa) return { item: oa.item, by: 'title', score: oa.score, source: 'openalex' };
  const ax = await arxivSearch(e).catch(() => null);
  if (ax) return { item: ax.item, by: 'title', score: ax.score, source: 'arxiv' };
  return { item: null, by: 'title' };
}

/** The candidate that is the cited work: same title, then the closest year and the same first author.
 *  A copy posted years later (a repository re-upload) is not the cited work. */
function pick(items, e) {
  const title = clean(e.title);
  const year = Number(String(e.year || '').slice(0, 4)) || 0;
  const first = norm(lastNames(e.author)[0] || '');
  let best = null;
  for (const it of items) {
    // the same paper: nearly the same title, written by at least one of the same people, in about the same year
    // (titles sharing a few words — "cost-efficient hybrid routing" — are different papers)
    const ts = similarity(title, (it.title || [])[0] || '');
    if (ts < 0.75) continue;
    const same = sameAuthors(e.author, it.author);
    if (same === false) continue;
    const y = Number(yearOf(it)) || 0;
    if (year && y && Math.abs(y - year) > 2 && ts < 0.95) continue;
    if (ts < 0.9 && same !== true && !(year && y && Math.abs(y - year) <= 1)) continue;
    let score = ts;
    if (year && y) score += Math.abs(y - year) <= 1 ? 0.3 : Math.abs(y - year) <= 3 ? 0.1 : -0.4;
    const fam = norm(String(((it.author || [])[0] || {}).family || ''));
    if (first && fam) score += fam === first ? 0.2 : -0.1;
    if (it.type === 'posted-content' || it.type === 'other' || it.type === 'peer-review') score -= 0.15;
    if (!best || score > best.score) best = { item: it, score, ts, y };
  }
  if (!best) return null;
  if (year && best.y && Math.abs(best.y - year) > 3 && best.item.type === 'posted-content') return null;
  return best;
}

// OpenAlex. Keys (OPENALEX_API_KEYS, comma-separated, in .env) are used in turn: when one's daily budget is spent it
// rests until the reset, then the next one, then the free shared pool. Only titles are sent.
let oaKeys = [];
const oaRest = new Map(); // key -> time it may be used again
function oaGet(url) {
  const run = queue.then(async () => {
    const keys = [...oaKeys.filter(k => !(oaRest.get(k) > Date.now())), ''];
    for (const k of keys) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      try {
        const r = await fetch(k ? `${url}&api_key=${encodeURIComponent(k)}` : url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
        if (r.ok) {
          // nearly spent: move on to the next key until the reset
          const left = Number(r.headers.get('x-ratelimit-remaining-usd'));
          const reset = Number(r.headers.get('x-ratelimit-reset'));
          if (k && Number.isFinite(left) && left < 0.002) oaRest.set(k, Date.now() + (Number.isFinite(reset) ? reset * 1000 : 3600e3));
          return await r.json();
        }
        if (r.status === 404) return null;
        if (r.status === 429 || r.status === 402 || (k && (r.status === 401 || r.status === 403))) {
          const reset = Number(r.headers.get('x-ratelimit-reset'));
          const body = await r.text().catch(() => '');
          // a spent budget (or a bad key) rests until the reset; a burst limit only briefly
          if (k) oaRest.set(k, Date.now() + (/budget|credit|exceed|daily|invalid/i.test(body) || r.status !== 429 ? (Number.isFinite(reset) && reset > 0 ? reset * 1000 : 3600e3) : 20e3));
          continue;
        }
        throw new Error(`OpenAlex ${r.status}`);
      } finally { clearTimeout(t); await sleep(120); }
    }
    return null;
  });
  queue = run.catch(() => {});
  return run;
}

const OA_TYPE = { article: 'journal-article', preprint: 'posted-content', 'book-chapter': 'book-chapter', book: 'book', dissertation: 'dissertation' };
async function openAlex(e) {
  const title = clean(e.title).replace(/[,:|!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const sel = '&per-page=8&select=id,doi,title,publication_year,type,authorships,primary_location,biblio';
  const strict = await oaGet(`https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title)}${sel}`);
  const first = pick(oaItems(strict), e);
  if (first) return first;
  const loose = await oaGet(`https://api.openalex.org/works?search=${encodeURIComponent(title)}${sel}`);
  return pick(oaItems(loose), e);
}
function oaItems(j) {
  return ((j && j.results) || []).map(w => {
    const loc = w.primary_location || {};
    const b = w.biblio || {};
    return {
      title: [w.title || ''],
      author: (w.authorships || []).map(a => {
        const n = String(a.raw_author_name || (a.author || {}).display_name || '').trim().replace(/,\s*$/, '');
        // some names come as "Sim, Robert"
        if (n.includes(',')) { const [f, ...g] = n.split(','); return { family: f.trim(), given: g.join(' ').trim() }; }
        const parts = n.split(/\s+/);
        return { family: parts.pop() || '', given: parts.join(' ') };
      }),
      issued: { 'date-parts': [[w.publication_year]] },
      'container-title': [((loc.source || {}).display_name) || ''],
      volume: b.volume || '', issue: b.issue || '',
      page: b.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}-${b.last_page}` : b.first_page) : '',
      type: OA_TYPE[w.type] || 'other',
      DOI: String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, ''),
      link: w.id || '',
    };
  });
}

/** arXiv title search, the last resort for preprints and ML conference papers neither Crossref nor OpenAlex has. */
async function arxivSearch(e) {
  // the most telling words only (all must match): a wrong small word ("from" for "with") doesn't hide the paper
  const STOP = new Set(['from', 'with', 'that', 'this', 'into', 'over', 'under', 'using', 'towards', 'toward', 'their', 'what', 'when', 'which', 'about', 'than', 'they', 'your', 'does', 'have', 'there']);
  const words = [...new Set(norm(e.title).split(' ').filter(w => w.length > 3 && !STOP.has(w)))].sort((a, b) => b.length - a.length).slice(0, 5);
  if (words.length < 2) return null;
  const xml = await arxivGet(null, `search_query=${encodeURIComponent(words.map(w => `ti:${w}`).join(' AND '))}&max_results=5`);
  const items = [...String(xml || '').matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => {
    const id = (/<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(?:v\d+)?<\/id>/.exec(m[0]) || [])[1];
    return id ? parseArxiv(`<feed>${m[0]}</feed>`, id) : null;
  }).filter(Boolean);
  return pick(items, e);
}

const SERIES = /^(lecture notes in|lecture notes of|communications in computer and information science|advances in intelligent systems and computing|studies in computational intelligence|smart innovation|ifip advances in|springer proceedings in|leibniz international proceedings in informatics|proceedings of machine learning research)/i;
const yearOf = it => { const d = (it.issued || it['published-print'] || it['published-online'] || {})['date-parts']; return d && d[0] && d[0][0] ? String(d[0][0]) : '' };
function suggestion(it, e) {
  const authors = (it.author || []).map(a => (a.family ? `${a.family}${a.given ? `, ${a.given}` : ''}` : a.name || '')).filter(Boolean).join(' and ');
  // a book chapter lists its series first (Lecture Notes in Computer Science) and then the book: the venue is the book
  const titles = (it['container-title'] || []).map(x => clean(x)).filter(Boolean);
  const venue = titles.find(t => !SERIES.test(t)) || titles[0] || '';
  const type = it.type === 'proceedings-article' ? 'inproceedings' : it.type === 'book-chapter' ? 'incollection' : it.type === 'book' || it.type === 'monograph' ? 'book' : it.type === 'posted-content' ? 'misc' : 'article';
  const f = { title: clean((it.title || [])[0] || ''), author: authors, year: yearOf(it) };
  if (type === 'article') f.journal = venue;
  else if (type === 'inproceedings' || type === 'incollection') f.booktitle = venue;
  if (it.volume) f.volume = String(it.volume);
  if (it.issue) f.number = String(it.issue);
  if (it.page) f.pages = String(it.page).replace(/-+/g, '--');
  if (it.publisher && (type === 'book' || type === 'incollection')) f.publisher = clean(it.publisher);
  if (it.DOI) f.doi = it.DOI;
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  return { type, fields: f };
}

/** Compare an entry with its record: what differs, and how serious it is. */
function compare(e, found) {
  if (found.wrongDoi && !found.item) return { status: 'err', message: `This DOI belongs to another paper: “${found.wrongDoi.title}”`, diffs: [{ field: 'doi', have: e.doi, crossref: '' }] };
  if (!found.item) {
    if (found.arxivOther) return { status: 'err', message: `arXiv ${found.arxivOther.id} is another paper: “${found.arxivOther.title}” — check the identifier`, diffs: [] };
    if (found.arxivMissing) return { status: 'err', message: `arXiv has no paper ${found.arxivMissing} — check the identifier`, diffs: [] };
    if (found.doiMissing) return { status: 'err', message: 'This DOI is not registered — it does not resolve at doi.org', diffs: [{ field: 'doi', have: e.doi, crossref: '' }] };
    if (found.doiElsewhere) return { status: 'unknown', message: 'The DOI is registered outside Crossref (for example arXiv, Zenodo or DataCite), so the details were not compared', diffs: [] };
    if (found.doiUnknown) return { status: 'unknown', message: 'The DOI is not in Crossref and doi.org could not be reached to check it', diffs: [] };
    if (found.by === 'none') return { status: 'warn', message: 'No title to check', diffs: [] };
    if (e.arxiv) return { status: 'unknown', message: 'An arXiv preprint with no published version in Crossref — not compared', diffs: [] };
    if (/^(book|inbook|booklet|proceedings|collection)$/i.test(String(e.type || ''))) return { status: 'unknown', message: 'Not found in Crossref or OpenAlex — many books, especially older ones, are not registered there', diffs: [] };
    if (/^(inproceedings|conference|incollection)$/i.test(String(e.type || ''))) return { status: 'unknown', message: 'Not found in Crossref or OpenAlex — some proceedings register no DOIs. Check that the title is exact.', diffs: [] };
    return { status: 'err', message: 'No published record matches this title in Crossref or OpenAlex — check that the reference is real and the title is exact', diffs: [] };
  }
  const it = found.item;
  const sug = suggestion(it, e);
  const diffs = [];
  const add = (field, have, crossref) => diffs.push({ field, have: have || '', crossref: crossref || '' });
  // not wrong, but could be written as the record has it (an abbreviated journal name): offered, not counted
  const hints = [];
  const tS = similarity(e.title, sug.fields.title);
  if (tS < 0.95 && clean(e.title).toLowerCase() !== (sug.fields.title || '').toLowerCase()) add('title', clean(e.title), sug.fields.title);
  const preprintOfPublished = it.type === 'posted-content' && !/^(misc|online|unpublished)$/i.test(String(e.type || '')) && !e.arxiv;
  const laterThanPreprint = preprintOfPublished && Number(e.year) >= Number(sug.fields.year) && Number(e.year) - Number(sug.fields.year) <= 2;
  if (e.year && sug.fields.year && String(e.year).trim() !== sug.fields.year && !laterThanPreprint) add('year', e.year, sug.fields.year);
  // the authors as the record has them, written the way this entry writes names (only the ones that differ change)
  const authorProblem = authorDiff(e.author, it.author, !(found.source === 'openalex' || found.source === 'arxiv'));
  if (authorProblem) { add('author', clean(e.author), authorProblem.corrected); diffs[diffs.length - 1].detail = authorProblem.detail; }
  // the entry type: only against publisher records (OpenAlex and arXiv types don't tell a conference paper from an article)
  const wrongType = !(found.source === 'openalex' || found.source === 'arxiv') ? typeMismatch(e.type, it.type) : null;
  if (wrongType) { add('type', wrongType.have, wrongType.fix); diffs[diffs.length - 1].detail = `The record is ${wrongType.kind}`; }
  const fromOA = found.source === 'openalex' || found.source === 'arxiv';
  if (fromOA) {
    // OpenAlex names venues differently ("arXiv (Cornell University)"): keep the entry's type and venue
    sug.type = e.type || sug.type;
    delete sug.fields.journal; delete sug.fields.booktitle;
    if (it.type === 'posted-content' && !/^(misc|online|unpublished)$/i.test(String(e.type || ''))) delete sug.fields.doi;
  }
  const venue = e.journal || e.booktitle;
  const sv = sug.fields.journal || sug.fields.booktitle;
  if (!fromOA && venue && sv && similarity(venue, sv) < 0.5) {
    const field = e.journal ? 'journal' : 'booktitle';
    const shortForms = [].concat(it['short-container-title'] || []).map(x => clean(x).toLowerCase());
    if (abbreviates(venue, sv) || shortForms.includes(clean(venue).toLowerCase())) {
      hints.push({ field, have: clean(venue), crossref: sv, detail: field === 'journal' ? 'Your entry uses the abbreviated journal name' : 'Your entry uses the short name of the conference' });
    } else if (!(field === 'booktitle' && spellsOut(venue, sv))) add(field, clean(venue), sv);
  }
  if (e.volume && sug.fields.volume && String(e.volume).trim() !== sug.fields.volume) add('volume', e.volume, sug.fields.volume);
  if (e.pages && sug.fields.pages && String(e.pages).replace(/[-–—]+/g, '--').trim() !== sug.fields.pages) add('pages', e.pages, sug.fields.pages);
  if (!e.doi && sug.fields.doi) add('doi', '', sug.fields.doi);
  else if (e.doi && fromOA) { /* a DOI that isn't in Crossref: not compared with OpenAlex */ }
  else if (e.doi && sug.fields.doi && e.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '') !== sug.fields.doi.toLowerCase()) add('doi', e.doi, sug.fields.doi);
  // the entry's DOI is another paper's: an error, with this paper's DOI as the correction
  if (found.wrongDoi) {
    const d = diffs.find(x => x.field === 'doi')
    if (d) d.have = e.doi; else add('doi', e.doi, fromOA ? '' : sug.fields.doi);
  }
  return {
    status: found.wrongDoi ? 'err' : diffs.length ? 'warn' : 'ok',
    message: found.wrongDoi ? `The DOI belongs to another paper (“${found.wrongDoi.title}”)`
      : diffs.length ? `${diffs.length} difference${diffs.length > 1 ? 's' : ''} from the ${found.source === 'arxiv' ? 'arXiv record' : preprintOfPublished ? 'preprint' : 'published record'}`
        : found.source === 'arxiv' ? 'Matches the arXiv record' : preprintOfPublished ? 'Matches the preprint of this paper' : 'Matches the published record',
    diffs, ...(hints.length ? { hints } : {}), suggestion: sug, doi: preprintOfPublished ? '' : it.DOI || '', score: found.score, preprint: preprintOfPublished,
    source: found.source === 'arxiv' ? 'arXiv' : fromOA ? 'OpenAlex' : 'Crossref', link: it.link || (it.DOI ? `https://doi.org/${it.DOI}` : ''),
  };
}

/** DOIs and URLs as .bib files write them (DBLP escapes them for LaTeX: 10.1007/978-3-540-88682-2\_5) → as registered. */
const unTeX = s => String(s || '').replace(/\\url\{([^}]*)\}/g, '$1').replace(/\\([_%&#$~])/g, '$1').replace(/[{}]/g, '').trim();

// ---- venue names written short: "Pattern Recognit. Lett." is Pattern Recognition Letters (ISO 4), "CVPR" is the conference
const VSTOP = new Set(['of', 'the', 'and', 'on', 'in', 'for', 'an', 'a', 'to', 'at', 'with', 'und', 'de', 'la', 'le', 'des', 'du', 'et', 'proceedings', 'proc']);
const PUBLISHERS = new Set(['ieee', 'acm', 'siam', 'aaai', 'springer', 'elsevier', 'wiley', 'iet', 'spie', 'osa', 'aip', 'aps', 'ams', 'rsc', 'acs', 'mdpi', 'iop']);
const vwords = s => clean(String(s || '').replace(/\([^)]*\)/g, ' ')).toLowerCase().replace(/[–—-]/g, ' ').replace(/&/g, ' and ')
  .split(/[\s,:;/]+/).map(w => w.replace(/\.$/, '').replace(/[^a-z0-9]/g, '')).filter(w => w && !VSTOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));
/** w abbreviates word: the same first letter and its letters in order ("recognit", "lett", "natl", "j") */
const abbrevWord = (w, word) => {
  if (w === word) return true;
  if (!w || w[0] !== word[0] || w.length > word.length) return false;
  let k = 0;
  for (const ch of word) if (ch === w[k]) k++;
  return k === w.length;
};
/** short is an abbreviation of full: word by word (every word of full accounted for), or the conference acronym. */
function abbreviates(short, full) {
  const a = vwords(short), b = vwords(full);
  if (!a.length || !b.length) return false;
  const acr = new Set((String(full).match(/\b[A-Z][A-Z0-9]{2,}\b/g) || []).map(x => x.toLowerCase()));
  if (a.every(w => acr.has(w)) && !a.every(w => PUBLISHERS.has(w))) return true;
  if (a.length !== b.length) return false;
  return a.every((w, i) => abbrevWord(w, b[i])) && a.some((w, i) => w !== b[i]);
}
/** every word of short appears in long, in order (a DBLP proceedings title that spells out the record's book title) */
function spellsOut(long, short) {
  const a = vwords(long), b = vwords(short);
  if (!b.length) return false;
  let i = 0;
  for (const w of a) if (i < b.length && abbrevWord(b[i], w)) i++;
  return i === b.length;
}

/**
 * Studio's checker: check(entry) → result (never throws). The cache (entries and their results) is kept in cacheFile,
 * sealed with the data key like every other file under var/.
 */
module.exports = Object.assign(function createBibCheck({ cacheFile, seal = null, open = null, env = {} }) {
  oaKeys = String(env.OPENALEX_API_KEYS || env.OPENALEX_API_KEY || '').split(/[\s,]+/).filter(Boolean);
  let cache = {};
  try { const buf = fs.readFileSync(cacheFile); cache = open ? open(buf) : JSON.parse(buf.toString('utf8')); } catch { /* none yet */ }
  let timer = null;
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const keys = Object.keys(cache);
      if (keys.length > 6000) for (const k of keys.slice(0, keys.length - 5000)) delete cache[k];
      const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try { fs.writeFileSync(tmp, seal ? seal(cache) : JSON.stringify(cache)); fs.renameSync(tmp, cacheFile); } catch (e) { console.error('[bibcheck] cache', e.message); }
    }, 2000);
  };

  async function checkOne(e) {
    e = { ...e, doi: unTeX(e.doi), url: unTeX(e.url) };
    // every author is part of the key: a corrected author list must be checked again
    const key = JSON.stringify(['v12', String(e.eprint || ''), String(e.url || '').slice(0, 200), norm(e.title), norm(e.author), String(e.year || ''), String(e.doi || '').toLowerCase(), String(e.journal || e.booktitle || ''), String(e.volume || ''), String(e.pages || ''), !!e.arxiv, String(e.type || '')]);
    const hit = cache[key];
    // a found record is kept a month; "not found" only a day (the lookups improve and new papers get indexed)
    if (hit && Date.now() - hit.at < (hit.r.status === 'ok' || hit.r.status === 'warn' ? 30 : 1) * 86400e3) return hit.r;
    const r = compare(e, await lookup(e));
    // answers that depended on a service being down are not kept
    if (!/could not be reached/.test(r.message)) { cache[key] = { at: Date.now(), r }; save(); }
    return r;
  }

  /** One entry (as payloadOf in shared/bib.mjs makes it); a service that can't be reached gives status 'unknown'. */
  async function check(e) {
    try { return await checkOne(e); } catch (err) { return { status: 'unknown', message: `Could not reach Crossref (${err.message})`, diffs: [] }; }
  }
  return { check };
}, { _test: { clean, pick, similarity, sameAuthors, arxivIdOf, parseArxiv, authorDiff, typeMismatch, abbreviates, spellsOut, unTeX } });
