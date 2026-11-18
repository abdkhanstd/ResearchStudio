/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Manuscript workspace (whole document + review panel) and the suggestions inbox. */
import { html, useState, useEffect, useMemo, useRef, api, getStore, navigate, Icon, Avatar, Diff, Spinner, Empty, ago, fmtDate, plural, toast, toastError, confirmDialog, TexView, KIND_LABEL, CATS, catLabel, blockPlain, secLabel, tk, useKeys } from './lib.js';
import { BlockBody, SuggestionCard, IssueCard, blockLabel, decide, referencedItems, RefItem } from './blocks.js';

export function Manuscript({ p, arg }) {
  const [sel, setSel] = useState(arg && p.blockById.get(arg) ? arg : null);
  const [filter, setFilter] = useState('all');
  const [changes, setChanges] = useState(true);
  const [q, setQ] = useState('');
  useEffect(() => { if (arg && arg !== sel) setSel(arg); }, [arg]);
  useEffect(() => { if (sel) { const el = document.getElementById(`blk-${sel}`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, [sel]);
  const open = (bid) => { setSel(bid); history.replaceState({}, '', `/app/p/${p.id}/manuscript/${bid}`); };
  const counts = useMemo(() => {
    const m = new Map();
    const bump = (bid, k) => { if (!bid) return; const x = m.get(bid) || { sug: 0, com: 0, ai: 0, lint: 0, ev: 0 }; x[k]++; m.set(bid, x); };
    for (const s of p.suggestions) if (s.status === 'open') bump(s.bid, s.kind === 'edit' ? 'sug' : 'com');
    for (const [bid, r] of Object.entries(p.ai.review || {})) for (const i of r.issues) { const b = p.blockById.get(bid); if (b && tk.findQuote(b.cur, i.quote)) bump(bid, 'ai'); }
    for (const i of (p.lint && p.lint.issues) || []) bump(i.bid, 'lint');
    for (const c of (p.evidence && p.evidence.claims) || []) if (['mismatch', 'partly'].includes(c.override || c.verdict)) bump(c.bid, 'ev');
    return m;
  }, [p.rev, p.suggestions.length, p.lint, p.evidence, p.ai.review]);
  const blocks = p.blocks.filter(b => b.kind !== 'ref' || filter !== 'all').filter(b => {
    const c = counts.get(b.id);
    if (filter === 'sug') return c && (c.sug || c.com);
    if (filter === 'changed') return b.cur !== b.text;
    if (filter === 'issues') return c && (c.ai || c.lint || c.ev);
    return true;
  }).filter(b => !q || blockPlain(p, b).toLowerCase().includes(q.toLowerCase()));
  const lastMine = [...p.changes].reverse().find(c => c.by === p.me.sub && !c.undone && c.cause !== 'undo');
  const undo = async () => { if (!lastMine) return; try { await api(`/api/projects/${p.id}/changes/${lastMine.id}/undo`, { method: 'POST', body: {} }); toast('Undone', 'ok'); } catch (e) { toastError(e); } };
  useKeys({ 'mod+z': undo }, [lastMine && lastMine.id]);
  const b = sel ? p.blockById.get(sel) : null;
  return html`<div class="ms">
    <div class="ms-tools card">
      <div class="seg">${[['all', 'Everything'], ['sug', 'With notes'], ['changed', 'Changed'], ['issues', 'With findings']].map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
      <label class="row small"><label class="switch"><input type="checkbox" checked=${changes} onChange=${e => setChanges(e.target.checked)} /><span></span></label> Show changes</label>
      <div class="search grow">${Icon('search')}<input class="input" placeholder="Search the text…" value=${q} onInput=${e => setQ(e.target.value)} /></div>
      ${p.canDecide ? html`<button class="btn btn-ghost btn-sm" disabled=${!lastMine} onClick=${undo} title="Undo your last change (Ctrl+Z)">${Icon('undo')} Undo</button>` : null}
    </div>
    <div class=${`ms-grid ${b ? 'has-sel' : ''}`}>
      <div class="doc card">
        ${blocks.length ? blocks.map(x => {
          if (x.kind === 'heading') { const s = p.secById.get(x.sec); return html`<h2 class=${`doc-h l${s ? s.level : 1}`} id=${`blk-${x.id}`}>${x.tex ? html`<${TexView} src=${x.cur} ctx=${p.latex} cls="inline" />` : x.cur}</h2>`; }
          const c = counts.get(x.id);
          const changed = x.cur !== x.text;
          return html`<div id=${`blk-${x.id}`} class=${`doc-b k-${x.kind} ${sel === x.id ? 'sel' : ''} ${changed ? 'changed' : ''}`} onClick=${() => open(x.id)}>
            ${x.kind === 'caption' || x.kind === 'equation' || x.kind === 'footnote' || x.kind === 'title' || x.kind === 'abstract' || x.kind === 'ref' ? html`<span class="doc-kind">${KIND_LABEL[x.kind]}</span>` : null}
            ${changes && changed ? html`<div class="text-view"><${Diff} a=${x.text} b=${x.cur} /></div>` : x.tex ? html`<${TexView} src=${x.cur} ctx=${p.latex} cls="text-view" />` : html`<div class="text-view plain">${x.cur}</div>`}
            ${c ? html`<div class="doc-badges">${c.sug ? html`<span class="chip c-sug">${Icon('edit')} ${c.sug}</span>` : ''}${c.com ? html`<span class="chip c-info">${Icon('comment')} ${c.com}</span>` : ''}${c.ai ? html`<span class="chip c-ai">${Icon('sparkle')} ${c.ai}</span>` : ''}${c.lint ? html`<span class="chip c-warn">${Icon('target')} ${c.lint}</span>` : ''}${c.ev ? html`<span class="chip c-bad">${Icon('graph')} ${c.ev}</span>` : ''}</div>` : null}
          </div>`;
        }) : html`<${Empty} icon="search" title="Nothing matches" />`}
      </div>
      ${b ? html`<${ReviewPanel} p=${p} b=${b} onClose=${() => { setSel(null); history.replaceState({}, '', `/app/p/${p.id}/manuscript`); }} onNav=${d => { const list = blocks.filter(x => x.kind !== 'heading'); const i = list.indexOf(b); const n = list[i + d]; if (n) open(n.id); }} />` : html`<div class="ms-hint card pad"><div class="big-ic">${Icon('pin')}</div><h3 class="serif">Select a paragraph</h3><p class="muted small">See it as typeset, its suggestions and comments, AI and consistency findings, related figures and tables, and its version history. ${p.canDecide ? 'Accept, reject or edit directly — every change can be undone.' : ''}</p></div>`}
    </div>
  </div>`;
}

function ReviewPanel({ p, b, onClose, onNav }) {
  const [tab, setTab] = useState('notes');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(b.cur);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState(null);
  useEffect(() => { setEditing(false); setDraft(b.cur); setHist(null); }, [b.id]);
  useEffect(() => { if (tab === 'history') api(`/api/projects/${p.id}/blocks/${b.id}/history`).then(setHist, toastError); }, [tab, b.id, b.ver]);
  const sugs = p.suggestions.filter(s => s.bid === b.id && s.status !== 'withdrawn').sort((a, x) => (a.status === 'open' ? -1 : 1) - (x.status === 'open' ? -1 : 1) || x.at.localeCompare(a.at));
  const review = p.ai.review[b.id];
  const aiIssues = review ? review.issues.filter(i => tk.findQuote(b.cur, i.quote)) : [];
  const lint = (p.lint && p.lint.issues || []).filter(i => i.bid === b.id);
  const claims = (p.evidence && p.evidence.claims || []).filter(c => c.bid === b.id);
  const refs = referencedItems(p, b);
  const save = async () => {
    setBusy(true);
    try { await api(`/api/projects/${p.id}/blocks/${b.id}/edit`, { method: 'POST', body: { text: draft, baseVer: b.ver || 0 } }); toast('Saved', 'ok'); setEditing(false); }
    catch (e) { toastError(e); }
    setBusy(false);
  };
  const restore = async v => { try { await api(`/api/projects/${p.id}/blocks/${b.id}/restore`, { method: 'POST', body: { v } }); toast(`Version ${v} restored`, 'ok'); } catch (e) { toastError(e); } };
  const runAi = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/ai/review/${b.id}`, { method: 'POST', body: {} }); setTab('ai'); } catch (e) { toastError(e); } setBusy(false); };
  const acceptAllAi = async () => {
    let text = b.cur, n = 0;
    for (const i of aiIssues) { const t = tk.applyFix(text, i.quote, i.fix); if (t != null) { text = t; n++; } }
    if (!n) return;
    try { await api(`/api/projects/${p.id}/blocks/${b.id}/edit`, { method: 'POST', body: { text, baseVer: b.ver || 0, cause: 'ai', note: `${n} AI fixes` } }); for (const i of aiIssues) api(`/api/projects/${p.id}/ai/issues/${i.id}/dismiss`, { method: 'POST', body: {} }).catch(() => {}); toast(`${plural(n, 'fix', 'fixes')} applied`, 'ok'); } catch (e) { toastError(e); }
  };
  return html`<aside class="review-panel card">
    <div class="rp-head"><div class="grow"><b>${blockLabel(p, b)}</b><div class="faint tiny">${b.ver ? `version ${b.ver}` : 'original'}${b.src ? ` · ${b.src.file}:${b.src.line}` : ''}</div></div>
      <button class="btn btn-text btn-sm" onClick=${() => onNav(-1)} title="Previous">${Icon('chevU')}</button><button class="btn btn-text btn-sm" onClick=${() => onNav(1)} title="Next">${Icon('chevD')}</button>
      <a class="btn btn-text btn-sm" href=${`/app/p/${p.id}/read/${b.id}`} title="Open in the Proof Room">${Icon('book')}</a><button class="btn btn-text btn-sm" onClick=${onClose}>${Icon('x')}</button></div>
    <div class="rp-body">
      <div class="rp-view"><${BlockBody} p=${p} b=${b} showChanges /></div>
      ${editing ? html`<div class="rp-edit"><textarea class="input" rows=${Math.min(18, Math.max(6, Math.ceil(draft.length / 80)))} value=${draft} onInput=${e => setDraft(e.target.value)}></textarea>
        <div class="diff-live text-view small">${draft === b.cur ? html`<span class="faint">No changes yet.</span>` : html`<${Diff} a=${b.cur} b=${draft} />`}</div>
        <div class="row"><button class="btn btn-primary btn-sm" disabled=${busy || draft === b.cur} onClick=${save}>${Icon('check')} Save change</button><button class="btn btn-text btn-sm" onClick=${() => setEditing(false)}>Cancel</button></div></div>`
        : html`<div class="row-wrap rp-actions">${p.canDecide ? html`<button class="btn btn-ghost btn-sm" onClick=${() => { setDraft(b.cur); setEditing(true); }}>${Icon('edit')} Edit directly</button>` : html`<a class="btn btn-ghost btn-sm" href=${`/app/p/${p.id}/read/${b.id}`}>${Icon('edit')} Suggest in the Proof Room</a>`}${p.ai.enabled ? html`<button class="btn btn-ai btn-sm" disabled=${busy} onClick=${runAi}>${busy ? html`<${Spinner} small />` : Icon('sparkle')} AI proofread</button>` : null}</div>`}
      <div class="side-tabs">
        <button class=${tab === 'notes' ? 'on' : ''} onClick=${() => setTab('notes')}>Notes ${sugs.length ? html`<span class="count">${sugs.length}</span>` : ''}</button>
        <button class=${tab === 'ai' ? 'on' : ''} onClick=${() => setTab('ai')}>AI ${aiIssues.length ? html`<span class="count ai">${aiIssues.length}</span>` : ''}</button>
        <button class=${tab === 'checks' ? 'on' : ''} onClick=${() => setTab('checks')}>Checks ${lint.length + claims.length ? html`<span class="count warn">${lint.length + claims.length}</span>` : ''}</button>
        ${refs.length ? html`<button class=${tab === 'ctx' ? 'on' : ''} onClick=${() => setTab('ctx')}>Figures ${html`<span class="count">${refs.length}</span>`}</button>` : null}
        ${p.canDecide ? html`<button class=${tab === 'history' ? 'on' : ''} onClick=${() => setTab('history')}>History</button>` : null}
      </div>
      ${tab === 'notes' ? (sugs.length ? sugs.map(s => html`<${SuggestionCard} p=${p} s=${s} key=${s.id} />`) : html`<p class="faint small">No suggestions or comments here.</p>`) : null}
      ${tab === 'ai' ? html`${aiIssues.length > 1 && p.canDecide ? html`<button class="btn btn-soft btn-sm" onClick=${acceptAllAi}>${Icon('check')} Apply all ${aiIssues.length} AI fixes</button>` : null}${aiIssues.length ? aiIssues.map(i => html`<${IssueCard} p=${p} b=${b} issue=${i} key=${i.id} />`) : html`<p class="faint small">${review ? 'No AI findings.' : 'Not proofread by the AI yet.'}</p>`}` : null}
      ${tab === 'checks' ? html`${lint.map(i => html`<${IssueCard} p=${p} b=${b} issue=${i} kind="lint" key=${i.id} />`)}${claims.map(c => html`<${ClaimRow} p=${p} c=${c} />`)}${!lint.length && !claims.length ? html`<p class="faint small">No findings.</p>` : null}` : null}
      ${tab === 'ctx' ? refs.map(r => html`<${RefItem} p=${p} r=${r} />`) : null}
      ${tab === 'history' ? (hist ? html`<ol class="versions">${[...hist.versions].reverse().map(v => html`<li class=${v.v === (b.ver || 0) ? 'cur' : ''}><div class="row"><b>${v.v === 0 ? 'Original' : `Version ${v.v}`}</b><span class="faint tiny grow">${v.v ? ago(v.at) : 'upload'}</span>${v.v !== (b.ver || 0) ? html`<button class="btn btn-text btn-sm" onClick=${() => restore(v.v)}>${Icon('refresh')} Restore</button>` : html`<span class="chip c-brand">current</span>`}</div><div class="text-view small"><${Diff} a=${b.text} b=${v.text} compact /></div></li>`)}</ol>` : html`<${Spinner} small />`) : null}
    </div>
  </aside>`;
}

export function ClaimRow({ p, c, showBlock }) {
  const v = c.override || c.verdict;
  const map = { consistent: ['c-ok', 'Matches'], mismatch: ['c-bad', 'Mismatch'], partly: ['c-warn', 'Partly'], unverifiable: ['', 'Cannot verify'], unlinked: ['', 'No evidence'], dismissed: ['', 'Dismissed'] };
  const [cls, l] = map[v] || ['', '—'];
  const b = p.blockById.get(c.bid);
  const fix = async () => {
    if (!b || !c.fix) return;
    const next = tk.applyFix(b.cur, c.quote, c.fix);
    if (next == null) return toast('The quoted text is no longer in the paragraph.', 'bad');
    try { if (p.canDecide) await api(`/api/projects/${p.id}/blocks/${b.id}/edit`, { method: 'POST', body: { text: next, baseVer: b.ver || 0, cause: 'evidence', note: c.explain } }); else await api(`/api/projects/${p.id}/suggestions`, { method: 'POST', body: { bid: b.id, kind: 'edit', text: next, note: c.explain, cat: 'number' } }); toast('Applied', 'ok'); } catch (e) { toastError(e); }
  };
  const mark = async verdict => { try { await api(`/api/projects/${p.id}/evidence/claims/${c.id}`, { method: 'PATCH', body: { verdict } }); } catch (e) { toastError(e); } };
  return html`<div class=${`issue claim v-${v}`}>
    <div class="issue-head"><span class=${`chip ${cls}`}>${Icon('graph')} ${l}</span>${c.refers.map(r => html`<span class="chip">${r.label}${r.inferred ? '?' : ''}</span>`)}${c.override ? html`<span class="faint tiny">set by ${c.overrideBy}</span>` : null}</div>
    ${showBlock && b ? html`<a class="sug-where" href=${`/app/p/${p.id}/manuscript/${b.id}`}>${Icon('pin')} ${blockLabel(p, b)}</a>` : null}
    <div class="text-view small">“${c.quote}”</div>
    ${c.explain ? html`<div class="issue-why">${c.explain}</div>` : null}
    ${c.expected && v !== 'consistent' ? html`<div class="issue-why"><b>Evidence:</b> ${c.expected}${c.where ? html` <span class="faint">(${c.where})</span>` : ''}</div>` : c.where ? html`<div class="faint tiny">${c.where}</div>` : null}
    ${c.fix && ['mismatch', 'partly'].includes(v) ? html`<div class="issue-fix text-view small"><del>${c.quote}</del> → <ins>${c.fix}</ins></div>` : null}
    ${p.canDecide ? html`<div class="row-wrap">${c.fix && ['mismatch', 'partly'].includes(v) ? html`<button class="btn btn-soft btn-sm" onClick=${fix}>${Icon('check')} Apply correction</button>` : null}
      ${v !== 'consistent' ? html`<button class="btn btn-text btn-sm" onClick=${() => mark('consistent')}>It’s correct</button>` : null}${v !== 'dismissed' ? html`<button class="btn btn-text btn-sm" onClick=${() => mark('dismissed')}>Dismiss</button>` : html`<button class="btn btn-text btn-sm" onClick=${() => mark(c.verdict)}>Restore</button>`}</div>` : null}
  </div>`;
}

// ── Suggestions inbox ──────────────────────────────────────
export function Suggestions({ p }) {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('all');
  const [who, setWho] = useState('all');
  const [cat, setCat] = useState('all');
  const [sort, setSort] = useState('doc');
  const authors = [...new Map(p.suggestions.map(s => [s.by, s.byName])).entries()];
  let list = p.suggestions.filter(s => s.status !== 'withdrawn')
    .filter(s => status === 'all' || s.status === status || (status === 'open' && s.status === 'open'))
    .filter(s => kind === 'all' || s.kind === kind).filter(s => who === 'all' || s.by === who).filter(s => cat === 'all' || s.cat === cat);
  if (!p.canDecide) list = list.filter(s => s.by === p.me.sub || p.settings.blind === false);
  list = sort === 'doc' ? list.sort((a, b) => ((p.blockById.get(a.bid) || {}).i ?? 0) - ((p.blockById.get(b.bid) || {}).i ?? 0) || a.at.localeCompare(b.at)) : list.sort((a, b) => b.at.localeCompare(a.at));
  const acceptAll = async () => {
    const edits = list.filter(s => s.kind === 'edit' && s.status === 'open');
    if (!edits.length) return;
    if (!(await confirmDialog({ title: `Accept ${plural(edits.length, 'suggestion')}?`, body: 'They are applied one by one in document order; suggestions that overlap with an earlier change are skipped for you to merge by hand. Every change can be undone in History.', ok: 'Accept all' }))) return;
    let ok = 0, skipped = 0;
    for (const s of edits) { try { await api(`/api/projects/${p.id}/suggestions/${s.id}/accept`, { method: 'POST', body: {} }); ok++; } catch { skipped++; } }
    toast(`${ok} accepted${skipped ? `, ${skipped} need a manual merge` : ''}`, skipped ? 'info' : 'ok', 6000);
  };
  const go = bid => navigate(`/app/p/${p.id}/manuscript/${bid}`);
  const counts = { open: p.suggestions.filter(s => s.status === 'open').length, accepted: p.suggestions.filter(s => s.status === 'accepted').length, rejected: p.suggestions.filter(s => s.status === 'rejected').length };
  return html`<div class="inbox">
    <div class="card ms-tools">
      <div class="seg">${[['open', `Open ${counts.open}`], ['accepted', `Accepted ${counts.accepted}`], ['rejected', `Rejected ${counts.rejected}`], ['resolved', 'Resolved'], ['all', 'All']].map(([k, l]) => html`<button class=${status === k ? 'on' : ''} onClick=${() => setStatus(k)}>${l}</button>`)}</div>
      <select class="input sm" value=${kind} onChange=${e => setKind(e.target.value)}><option value="all">Edits, comments & highlights</option><option value="edit">Edits</option><option value="comment">Comments</option><option value="mark">Highlights</option></select>
      ${p.canDecide ? html`<select class="input sm" value=${who} onChange=${e => setWho(e.target.value)}><option value="all">Everyone</option>${authors.map(([s, n]) => html`<option value=${s}>${n}</option>`)}</select>` : null}
      <select class="input sm" value=${cat} onChange=${e => setCat(e.target.value)}><option value="all">All categories</option>${CATS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      <select class="input sm" value=${sort} onChange=${e => setSort(e.target.value)}><option value="doc">Document order</option><option value="new">Newest first</option></select>
      <span class="grow"></span>
      ${p.canDecide && status === 'open' && list.some(s => s.kind === 'edit') ? html`<button class="btn btn-ok btn-sm" onClick=${acceptAll}>${Icon('check')} Accept all shown</button>` : null}
    </div>
    ${list.length ? html`<div class="inbox-list">${list.map(s => html`<${SuggestionCard} p=${p} s=${s} key=${s.id} showBlock onOpenBlock=${go} />`)}</div>` : html`<div class="card"><${Empty} icon="comment" title=${status === 'open' ? 'Nothing open' : 'Nothing here'}>${status === 'open' ? 'Suggestions and comments from readers appear here as they make them.' : ''}</${Empty}></div>`}
  </div>`;
}
