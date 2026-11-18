/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Retraction Exposure of the manuscript's authors, from Retraction Radar's report (rr.rykhet.com, OpenAlex data),
 * with Retraction Radar's default method so the numbers match its site:
 *   a paper is flagged when it is retracted (weight 1), when a co-author has any retracted paper (0.5), or when its
 *   journal has at least 3 retractions that make up more than 0.2 % of its papers (0.25).
 *   Ratio = flagged papers ÷ papers in the years chosen; Score = sum of the weights of the flags.
 */
const METHOD = { thr: 0.2, min: 3, wOwn: 1, wCo: 0.5, wJ: 0.25 };

function venueFlag(v) {
  if (!v || v.type !== 'journal' || !v.total) return false;
  return v.retracted >= METHOD.min && (v.retracted / v.total) * 100 > METHOD.thr;
}

/** Ratio, score and what drives them, from one Retraction Radar report. */
function summarize(report) {
  const rows = (report.papers || []).map(p => {
    const co = (p.authors || []).filter(a => !a.self && report.coauthors && report.coauthors[a.id]);
    const v = p.venue && report.venues ? report.venues[p.venue.id] : null;
    return { p, flags: [!!p.retracted, co.length > 0, venueFlag(v)], co, v };
  });
  const w = [METHOD.wOwn, METHOD.wCo, METHOD.wJ];
  const flagged = rows.filter(r => r.flags.some(Boolean));
  const score = flagged.reduce((s, r) => s + r.flags.reduce((t, f, i) => t + (f ? w[i] : 0), 0), 0);
  const journals = {};
  for (const r of rows) if (r.flags[2] && r.v) { const j = journals[r.v.id] = journals[r.v.id] || { name: r.v.name, share: r.v.retracted / r.v.total, papers: 0 }; j.papers++; }
  const coauthors = {};
  for (const r of rows) for (const c of r.co) { const e = coauthors[c.id] = coauthors[c.id] || { name: c.name, retracted: (report.coauthors[c.id].retracted || []).length, papers: 0 }; e.papers++; }
  return {
    papers: rows.length, flagged: flagged.length, ratio: rows.length ? flagged.length / rows.length : 0, score: +score.toFixed(2),
    own: rows.filter(r => r.flags[0]).length, co: rows.filter(r => r.flags[1]).length, journal: rows.filter(r => r.flags[2]).length,
    retracted: rows.filter(r => r.flags[0]).map(r => ({ title: r.p.title, year: r.p.year, doi: r.p.doi })).slice(0, 10),
    journals: Object.values(journals).sort((a, b) => b.papers - a.papers).slice(0, 8).map(j => ({ ...j, share: +(j.share * 100).toFixed(2) })),
    coauthors: Object.values(coauthors).sort((a, b) => b.papers - a.papers).slice(0, 8),
    profiles: (report.authors || []).map(a => ({ id: a.id, name: a.name, orcid: a.orcid, works: a.works, institution: ((a.current || [])[0] || {}).name || null })),
    years: report.years,
  };
}

/** Span of the balanced {…} group starting at src[i] === '{' → index after it. */
function groupEnd(src, i) {
  let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return i + 1; }
  return src.length;
}
/** First arguments of the named macros (balanced braces). */
function macroArgs(src, names) {
  const out = [], re = new RegExp(`\\\\(${names.join('|')})\\s*(\\[[^\\]]*\\])?\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(src))) { const st = re.lastIndex - 1, en = groupEnd(src, st); out.push(src.slice(st + 1, en - 1)); re.lastIndex = en; }
  return out;
}
/** The text without the named macros and their first argument. */
function stripMacros(src, names) {
  const re = new RegExp(`\\\\(${names.join('|')})\\s*(\\[[^\\]]*\\])?\\s*\\{`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(src))) { const st = re.lastIndex - 1, en = groupEnd(src, st); out += src.slice(last, m.index); last = en; re.lastIndex = en; }
  return out + src.slice(last);
}
/** Author names written in the LaTeX source (\author{…}, IEEE author blocks, elsarticle-style repeated \author). */
function authorsFromLatex(tex) {
  const src = String(tex || '').replace(/(^|[^\\])%.*$/gm, '$1');
  const args = [];
  const re = /\\author\s*(\[[^\]]*\])?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === '{') depth++; else if (src[i] === '}') depth--; }
    args.push(src.slice(re.lastIndex, i - 1));
  }
  const names = [];
  const looksLikeName = s => /^[A-Z][\p{L}.'’-]*(\s+[\p{L}.'’-]+){1,4}$/u.test(s) && !/\b(University|Institute|School|Department|College|Laboratory|Lab|Center|Centre|China|USA)\b/.test(s);
  const clean = s => s.replace(/\\(textsuperscript|thanks|footnote|IEEEauthorrefmark|orcidlink|inst|affil|ead)\s*(\[[^\]]*\])?\{[^{}]*\}/g, '').replace(/\$[^$]*\$/g, '').replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const a0 of args) {
    // affiliation blocks are not names
    const a = stripMacros(a0, ['IEEEauthorblockA', 'authorblockA', 'affil', 'affiliation', 'institute', 'address', 'email', 'thanks', 'footnote']);
    // names as the first argument of a block macro (\IEEEauthorblockN{…}, \authorbox{…}{…}, …)
    const firsts = macroArgs(a, ['IEEEauthorblockN', 'authorblockN', 'name', 'authorbox', 'authorname', 'textbf']).flatMap(x => clean(x).split(/\s*(?:,|\band\b|;)\s*/));
    const parts = firsts.length ? firsts : clean(a.replace(/\\and\b|\\\\|\\AND\b/g, ',')).split(/\s*(?:,|\band\b|;)\s*/);
    for (const raw of parts) {
      const n = raw.replace(/\d+/g, '').replace(/\s*\*\s*/g, ' ').trim();
      if (looksLikeName(n) && !names.includes(n)) names.push(n);
    }
  }
  return names.slice(0, 20);
}

module.exports = { METHOD, summarize, authorsFromLatex };
