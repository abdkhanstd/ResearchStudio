/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
// Shared by the browser (exports are made on the user's computer) and the server (hand-off to Rykhet LaTeX).
/** Text exports: change list (Markdown / plain text), unified diff, revised LaTeX sources, revised plain text. */

const READ_KINDS = new Set(['title', 'abstract', 'para', 'list', 'caption', 'equation', 'footnote']);
/** Location of a block, numbered like the app (¶ n = position in the reading order). */
function where(p, b) {
  const sec = (p.sections || []).find(s => s.id === b.sec);
  const n = (p.blocks || []).filter(x => READ_KINDS.has(x.kind)).indexOf(b) + 1;
  const kind = { para: '¶', abstract: 'Abstract ¶', caption: 'Caption', list: 'List', footnote: 'Footnote', title: 'Title', heading: 'Heading', equation: 'Equation', ref: 'Reference', front: 'Front matter' }[b.kind] || '¶';
  return { sec: sec ? `${sec.num ? sec.num + ' ' : ''}${sec.title}` : '', label: n > 0 ? `${kind} ${n}` : kind, page: b.page ? `p. ${b.page}` : '', n };
}
const fmtDate = s => (s ? String(s).slice(0, 16).replace('T', ' ') : '');
const nameOf = (p, sub) => { if (sub === p.owner) return p.ownerName || 'the owner'; const m = (p.members || []).find(x => x.sub === sub); return m ? m.name || m.email : sub === 'ai' ? 'Studio AI' : 'someone'; };
const applied = p => (p.changes || []).filter(c => !c.undone && c.cause !== 'undo');

function inlineDiff(tk, a, b, style) {
  return tk.wordDiff(a, b).map(o => {
    if (o.t === '=') return o.s;
    const s = o.s;
    if (!s.trim()) return s;
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
    if (style === 'md') return `${lead}${o.t === '-' ? `~~${core}~~` : `**${core}**`}${trail}`;
    return `${lead}${o.t === '-' ? `[-${core}-]` : `{+${core}+}`}${trail}`;
  }).join('');
}

/** Changes applied, open suggestions and comments, grouped by section and paragraph. */
function changeList(p, tk, { style = 'md', include = { applied: true, open: true, comments: true, rejected: false } } = {}) {
  const md = style === 'md';
  const H = (lvl, t) => (md ? `${'#'.repeat(lvl)} ${t}` : lvl === 1 ? `${t}\n${'='.repeat(Math.min(78, t.length))}` : lvl === 2 ? `\n${t}\n${'-'.repeat(Math.min(78, t.length))}` : `\n${t}`);
  const out = [];
  const changed = (p.blocks || []).filter(b => (b.cur ?? b.text) !== b.text);
  const sugs = (p.suggestions || []).filter(s => s.status !== 'withdrawn');
  const open = sugs.filter(s => s.status === 'open' && s.kind === 'edit');
  const comments = sugs.filter(s => s.kind === 'comment' && s.status !== 'rejected');
  out.push(H(1, `Proofreading report — ${p.title}`));
  out.push('', `${md ? '_' : ''}Generated ${fmtDate(new Date().toISOString())} UTC by Research Studio${md ? '_' : ''}`, '');
  out.push(`${md ? '- ' : '* '}${changed.length} paragraph${changed.length === 1 ? '' : 's'} changed (${applied(p).length} edit${applied(p).length === 1 ? '' : 's'} applied)`);
  out.push(`${md ? '- ' : '* '}${open.length} open suggestion${open.length === 1 ? '' : 's'}, ${comments.length} comment${comments.length === 1 ? '' : 's'}`);
  out.push(`${md ? '- ' : '* '}Notation: ${md ? '~~deleted~~ **inserted**' : '[-deleted-] {+inserted+}'}`, '');
  let lastSec = null;
  for (const b of p.blocks || []) {
    const bs = sugs.filter(s => s.bid === b.id);
    const isChanged = (b.cur ?? b.text) !== b.text;
    const showApplied = include.applied && isChanged;
    const showOpen = include.open && bs.some(s => s.status === 'open' && s.kind === 'edit');
    const showRej = include.rejected && bs.some(s => s.status === 'rejected');
    const showCom = include.comments && bs.some(s => (s.kind === 'comment' || s.kind === 'mark') && s.status !== 'rejected');
    if (!showApplied && !showOpen && !showCom && !showRej) continue;
    const w = where(p, b);
    if (w.sec !== lastSec) { out.push(H(2, w.sec || 'Front matter')); lastSec = w.sec; }
    out.push(H(3, `${w.label}${w.page ? ` (${w.page})` : ''}`));
    if (showApplied) {
      const cs = applied(p).filter(c => c.bid === b.id);
      out.push('', `${md ? '**Applied**' : 'APPLIED'}${cs.length ? ` — ${[...new Set(cs.map(c => c.byName || nameOf(p, c.by)))].join(', ')}` : ''}:`);
      out.push(md ? `> ${inlineDiff(tk, b.text, b.cur, 'md').replace(/\n/g, '\n> ')}` : inlineDiff(tk, b.text, b.cur, 'txt'));
    }
    for (const s of bs) {
      if (s.kind === 'edit' && s.status === 'open' && include.open) {
        out.push('', `${md ? '**Suggestion**' : 'SUGGESTION'} by ${s.byName || nameOf(p, s.by)}${s.cat ? ` [${s.cat}]` : ''}${s.note ? ` — ${s.note}` : ''}:`);
        out.push(md ? `> ${inlineDiff(tk, s.base, s.text, 'md').replace(/\n/g, '\n> ')}` : inlineDiff(tk, s.base, s.text, 'txt'));
      } else if (s.kind === 'edit' && s.status === 'rejected' && include.rejected) {
        out.push('', `${md ? '_Rejected suggestion_' : 'REJECTED'} by ${s.byName || nameOf(p, s.by)}: ${inlineDiff(tk, s.base, s.text, md ? 'md' : 'txt')}`);
      } else if (s.kind === 'mark' && s.status !== 'rejected' && include.comments) {
        out.push('', `${md ? '**Highlight**' : 'HIGHLIGHT'} (${s.color || 'yellow'}) by ${s.byName || nameOf(p, s.by)}${s.quote ? ` on “${s.quote}”` : s.area ? ` (area on page ${s.area.p})` : ''}${s.note ? `: ${s.note}` : ''}`);
      } else if (s.kind === 'comment' && s.status !== 'rejected' && include.comments) {
        out.push('', `${md ? '**Comment**' : 'COMMENT'} by ${s.byName || nameOf(p, s.by)}${s.status === 'resolved' ? ' (resolved)' : ''}${s.quote ? ` on “${s.quote}”` : ''}: ${s.note}`);
      }
      for (const r of s.replies || []) out.push(`${md ? '  - ' : '    > '}${r.byName}: ${r.text}`);
    }
    out.push('');
  }
  // paragraphs removed in a version brought back from an editor
  const gone = include.applied ? (p.removedBlocks || []) : [];
  if (gone.length) {
    out.push(H(2, 'Removed paragraphs'));
    for (const r of gone) out.push('', `${md ? '**Removed**' : 'REMOVED'} ${r.via ? `(${r.via}) ` : ''}${fmtDate(r.at)}:`, md ? `> ~~${String(r.text).replace(/\n+/g, ' ')}~~` : `[-${String(r.text).replace(/\n+/g, ' ')}-]`);
  }
  return out.join('\n');
}

/** Unified-style diff of every changed block (original → current). */
function unifiedDiff(p) {
  const out = [`--- ${p.source && p.source.filename || 'original'}`, `+++ ${p.title} (revised ${fmtDate(new Date().toISOString())})`];
  for (const b of p.blocks || []) {
    const cur = b.cur ?? b.text;
    if (cur === b.text) continue;
    const w = where(p, b);
    out.push(`@@ ${w.label}${w.sec ? ` · ${w.sec}` : ''}${w.page ? ` · ${w.page}` : ''}${b.src ? ` · ${b.src.file}:${b.src.line || ''}` : ''} @@`);
    for (const l of b.text.split('\n')) out.push(`-${l}`);
    for (const l of cur.split('\n')) out.push(`+${l}`);
  }
  return out.join('\n') + '\n';
}

/** Apply current block texts to the LaTeX sources. Returns { files: { path: text }, applied, skipped: [] } */
function revisedTex(p) {
  const files = { ...(p.source && p.source.texFiles || {}) };
  const byFile = new Map();
  // spans point into texFiles; `base` is the text there (the upload, or a version brought back from an editor)
  for (const b of p.blocks || []) if (b.src && (b.cur ?? b.text) !== (b.base ?? b.text)) (byFile.get(b.src.file) || byFile.set(b.src.file, []).get(b.src.file)).push(b);
  let applied = 0;
  const skipped = [];
  for (const [file, list] of byFile) {
    let t = files[file];
    if (typeof t !== 'string') { skipped.push(...list.map(b => b.id)); continue; }
    list.sort((a, b) => b.src.start - a.src.start);
    for (const b of list) {
      if (t.slice(b.src.start, b.src.end) !== (b.base ?? b.text)) { skipped.push(b.id); continue; }
      t = t.slice(0, b.src.start) + b.cur + t.slice(b.src.end);
      applied++;
    }
    files[file] = t;
  }
  return { files, applied, skipped };
}

/** Regions of one revised source file: where each paragraph sits in the revised text and whether it changed. */
function regions(p, file) {
  const orig = (p.source && p.source.texFiles || {})[file];
  if (typeof orig !== 'string') return [];
  const list = (p.blocks || []).filter(b => b.src && b.src.file === file).sort((a, b) => a.src.start - b.src.start);
  const out = [];
  let pos = 0, delta = 0;
  for (const b of list) {
    if (b.src.start < pos || orig.slice(b.src.start, b.src.end) !== (b.base ?? b.text)) continue;
    const cur = b.cur ?? b.text;
    const start = b.src.start + delta;
    out.push({ bid: b.id, start, end: start + cur.length, changed: cur !== b.text, kind: b.kind });
    delta += cur.length - (b.src.end - b.src.start);
    pos = b.src.end;
  }
  return out;
}

/** Revised manuscript as plain text (for PDF uploads). */
function revisedText(p, tk) {
  const out = [p.title, '='.repeat(Math.min(78, p.title.length)), ''];
  for (const b of p.blocks || []) {
    if (b.kind === 'heading') { out.push('', b.cur ?? b.text, '-'.repeat(Math.min(78, (b.cur ?? b.text).length))); continue; }
    if (b.kind === 'equation') { out.push(`    ${(b.cur ?? b.text).replace(/\n/g, ' ')}`, ''); continue; }
    out.push(tk.blockText(b, p.latex || {}), '');
  }
  return out.join('\n');
}

export { changeList, unifiedDiff, revisedTex, revisedText, regions, where };
