/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Checks (consistency, AI, references), the evidence graph, and figures & tables with a digitizer. */
import { html, useState, useEffect, useMemo, useRef, api, getStore, navigate, useRoute, Icon, Spinner, Empty, Bar, ago, plural, toast, toastError, confirmDialog, openModal, closeModal, tk, blockPlain, catLabel } from './lib.js';
import { IssueCard, blockLabel, Chart, DataTable, TableGrid, FigureImage, applyIssue } from './blocks.js';
import { ClaimRow } from './manuscript.js';
import { PrecheckButton } from './project.js';
import { AuthorsExposure } from './rexp.js';

// ── Checks ─────────────────────────────────────────────────
export function Checks({ p }) {
  const { query } = useRoute();
  const [f, setF] = useState(query.get('f') || 'consistency');
  const [busy, setBusy] = useState(false);
  const lint = (p.lint && p.lint.issues) || [];
  const aiBlocks = Object.entries(p.ai.review || {}).map(([bid, r]) => ({ b: p.blockById.get(bid), issues: r.issues })).filter(x => x.b).map(x => ({ ...x, issues: x.issues.filter(i => tk.findQuote(x.b.cur, i.quote)) })).filter(x => x.issues.length).sort((a, b) => a.b.i - b.b.i);
  const aiCount = aiBlocks.reduce((n, x) => n + x.issues.length, 0);
  const rerun = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/lint`, { method: 'POST', body: {} }); toast('Checks updated', 'ok'); } catch (e) { toastError(e); } setBusy(false); };
  const applyAllAi = async () => {
    if (!(await confirmDialog({ title: `Apply all ${aiCount} AI fixes?`, body: 'Each paragraph gets one change you can undo in History. Review a few first if unsure.', ok: 'Apply all' }))) return;
    let n = 0;
    for (const x of aiBlocks) {
      let text = x.b.cur;
      for (const i of x.issues) { const t = tk.applyFix(text, i.quote, i.fix); if (t != null) { text = t; n++; } }
      if (text !== x.b.cur) await api(`/api/projects/${p.id}/blocks/${x.b.id}/edit`, { method: 'POST', body: { text, baseVer: x.b.ver || 0, cause: 'ai', note: `${x.issues.length} AI fixes` } }).catch(() => {});
      for (const i of x.issues) api(`/api/projects/${p.id}/ai/issues/${i.id}/dismiss`, { method: 'POST', body: {} }).catch(() => {});
    }
    toast(`${n} fixes applied`, 'ok');
  };
  const sev = s => lint.filter(i => i.sev === s);
  const open = bid => navigate(`/app/p/${p.id}/manuscript/${bid}`);
  return html`<div class="checks">
    <div class="card ms-tools">
      <div class="seg">${[['consistency', `Consistency ${lint.length}`], ...(p.ai.enabled ? [['ai', `AI proofreading ${aiCount}`]] : []), ['refs', `References ${p.refs.length}`], ...(p.rexpEnabled ? [['authors', 'Authors']] : [])].map(([k, l]) => html`<button class=${f === k ? 'on' : ''} onClick=${() => setF(k)}>${l}</button>`)}</div>
      <span class="grow"></span>
      ${f === 'consistency' ? html`<button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${rerun}>${busy ? html`<${Spinner} small />` : Icon('refresh')} Re-run</button>` : null}
      ${f === 'ai' && aiCount ? html`<button class="btn btn-soft btn-sm" onClick=${applyAllAi}>${Icon('check')} Apply all</button>` : null}
      <${PrecheckButton} p=${p} />
    </div>
    ${f === 'consistency' ? html`<div class="check-cols">${[['error', 'Errors', 'bad'], ['warn', 'Warnings', 'warn'], ['info', 'Notes', 'info']].map(([s, l, c]) => html`<section class="card pad"><h3 class="card-h"><span class=${`sev-dot s-${s === 'error' ? 'high' : s === 'warn' ? 'medium' : 'low'}`}></span> ${l} <span class="count">${sev(s).length}</span></h3>
      ${sev(s).length ? sev(s).map(i => { const b = i.bid && p.blockById.get(i.bid); return html`<div class="lint-row">${b ? html`<button class="sug-where" onClick=${() => open(b.id)}>${Icon('pin')} ${blockLabel(p, b)}</button>` : html`<span class="sug-where">${Icon('doc')} Whole document</span>`}<${IssueCard} p=${p} b=${b} issue=${i} kind="lint" /></div>`; }) : html`<p class="faint small">None.</p>`}</section>`)}</div>
      <p class="faint tiny">Checked: unresolved references (??), placeholders, repeated words, a/an, acronyms (defined, used before definition, defined twice), figure/table/citation references, mixed US/UK spelling and hyphenation, duplicate sentences, brackets, numbers in the abstract, LaTeX citation keys.${p.lint ? ` Last run ${ago(p.lint.at)}.` : ''}</p>` : null}
    ${f === 'ai' ? (aiBlocks.length ? html`<div class="ai-list">${aiBlocks.map(x => html`<div class="card pad ai-block"><button class="sug-where" onClick=${() => open(x.b.id)}>${Icon('pin')} ${blockLabel(p, x.b)}</button><div class="ai-issues">${x.issues.map(i => html`<${IssueCard} p=${p} b=${x.b} issue=${i} key=${i.id} />`)}</div></div>`)}</div>` : html`<div class="card"><${Empty} icon="sparkle" title=${Object.keys(p.ai.review || {}).length ? 'No open AI findings' : 'AI proofreading has not run yet'}>${Object.keys(p.ai.review || {}).length ? 'Every AI suggestion was applied or dismissed.' : 'Run the full check to have the AI proofread every paragraph.'}</${Empty}></div>`) : null}
    ${f === 'refs' ? html`<${References} p=${p} />` : null}
    ${f === 'authors' && p.rexpEnabled ? html`<${AuthorsExposure} p=${p} />` : null}
  </div>`;
}

const VERDICT = { verified: ['c-ok', 'Verified'], warning: ['c-warn', 'Minor issues'], problem: ['c-bad', 'Problem'], notfound: ['c-bad', 'Not found'], retracted: ['c-bad', 'Retracted'], web: ['c-info', 'Found online'], error: ['', 'Error'] };
function References({ p }) {
  const [busy, setBusy] = useState(false);
  const rc = p.refcheck;
  const start = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/refcheck`, { method: 'POST', body: {} }); toast('Reference check started', 'ok'); } catch (e) { toastError(e); } setBusy(false); };
  if (!p.refs.length) return html`<div class="card"><${Empty} icon="check" title="No reference list found">For PDFs, the list after a “References” heading is used; for LaTeX, the .bbl, .bib or thebibliography.</${Empty}></div>`;
  const s = rc && rc.summary;
  const running = rc && ['queued', 'running'].includes(rc.status);
  const refs = rc && rc.refs ? [...rc.refs].sort((a, b) => a.i - b.i) : null;
  return html`<div class="col">
    <div class="card pad"><div class="row-wrap">
      <div class="grow"><h3 class="card-h">${Icon('check')} RefCheck</h3><p class="muted small">Every reference is matched against OpenAlex, Crossref (with Retraction Watch), Semantic Scholar, arXiv and the web: fabricated, mistyped, retracted or duplicated references, wrong DOIs, preprints that have a published version.</p></div>
      ${!p.refcheckEnabled ? html`<span class="chip c-warn">not connected</span>` : running ? html`<span class="row small"><${Spinner} small /> ${rc.phase || 'checking'}${rc.progress ? ` · ${rc.progress.done}/${rc.progress.total}` : ''}</span>` : html`<button class="btn btn-primary" disabled=${busy} onClick=${start}>${Icon('check')} ${rc ? 'Check again' : `Check ${p.refs.length} references`}</button>`}
      ${rc && rc.link ? html`<a class="btn btn-ghost" href=${rc.link} target="_blank" rel="noopener">${Icon('external')} Full report</a>` : null}
    </div>
    ${s ? html`<div class="row-wrap" style="margin-top:10px">${Object.entries(VERDICT).filter(([k]) => s[k]).map(([k, [c, l]]) => html`<span class=${`chip ${c}`}>${l}: ${s[k]}</span>`)}${s.score != null ? html`<span class="chip c-brand">Score ${s.score}</span>` : ''}</div>` : null}
    ${rc && rc.error ? html`<p class="bad-text small">${rc.error}</p>` : null}
    </div>
    <div class="card pad"><ol class="ref-list">${(refs || p.refs.map(r => ({ i: r.i, raw: r.raw }))).map(r => { const [c, l] = VERDICT[r.verdict] || ['', r.status === 'pending' || r.status === 'checking' ? 'checking…' : '']; return html`<li><div class="row-wrap">${l ? html`<span class=${`chip ${c}`}>${l}</span>` : null}<span class="faint tiny">[${r.i + 1}]</span></div><div class="small">${r.raw}</div>${(r.issues || []).filter(i => i.sev !== 'info').map(i => html`<div class="issue-why small">• ${i.msg}</div>`)}${r.ai && r.ai.note ? html`<div class="issue-why small">${Icon('sparkle')} ${r.ai.note}</div>` : null}</li>`; })}</ol></div>
  </div>`;
}

// ── Evidence ───────────────────────────────────────────────
export function Evidence({ p }) {
  const [busy, setBusy] = useState(false);
  const [vf, setVf] = useState('problems');
  const [sel, setSel] = useState(null);
  const ev = p.evidence;
  const run = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/evidence`, { method: 'POST', body: {} }); toast('Cross-checking started', 'ok'); } catch (e) { toastError(e); } setBusy(false); };
  const job = p.ai.job && p.ai.job.status === 'running' ? p.ai.job : null;
  if (!ev) return html`<div class="card pad-lg center ev-empty"><div class="big-ic">${Icon('graph')}</div><h2 class="serif">Do the numbers in the text match the tables and figures?</h2><p class="muted">${p.ai.enabled ? 'The AI extracts' : 'Research Studio finds'} every quantitative claim (“reaches 83.5% accuracy”, “2.1 points better than…”), links it to the table or figure it relies on, and checks it against the data — tables as grids, figures as numbers read from the vector drawing, OCR or your digitised points. It also finds the same number reported differently in different places.</p>${job ? html`<p><${Spinner} small /> ${job.label}</p>` : html`<button class="btn btn-primary btn-lg" disabled=${busy || !(p.ai.checks ?? p.ai.enabled)} onClick=${run}>${Icon('graph')} Build the evidence graph</button>`}</div>`;
  const claims = ev.claims.map(c => ({ ...c, v: c.override || c.verdict }));
  const n = k => claims.filter(c => c.v === k).length;
  const shown = claims.filter(c => vf === 'all' || (vf === 'problems' ? ['mismatch', 'partly'].includes(c.v) : c.v === vf)).filter(c => !sel || (sel.kind === 'b' ? c.bid === sel.id : c.refers.some(r => r.id === sel.id)));
  return html`<div class="evidence">
    <div class="card ms-tools">
      <div class="stat-inline"><b>${claims.length}</b> claims</div><span class="chip c-ok">${n('consistent')} match</span><span class="chip c-bad">${n('mismatch')} mismatch</span><span class="chip c-warn">${n('partly')} partly</span><span class="chip">${n('unverifiable')} unverifiable</span><span class="chip">${n('unlinked')} no evidence</span>${ev.consistency.length ? html`<span class="chip c-bad">${ev.consistency.length} inconsistent across sections</span>` : null}
      <span class="grow"></span><span class="faint tiny">${ago(ev.at)}</span>${job ? html`<span class="small"><${Spinner} small /> ${job.label}</span>` : html`<button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${run}>${Icon('refresh')} Re-run</button>`}
    </div>
    <div class="ev-grid">
      <div class="card pad ev-graph-card"><div class="row"><h3 class="card-h grow">${Icon('graph')} Evidence graph</h3>${sel ? html`<button class="btn btn-text btn-sm" onClick=${() => setSel(null)}>Clear selection</button>` : html`<span class="faint tiny">Click a node to filter</span>`}</div><${EvidenceGraph} p=${p} claims=${claims} consistency=${ev.consistency} sel=${sel} onSel=${setSel} /></div>
      <div class="col">
        ${ev.consistency.length ? html`<div class="card pad"><h3 class="card-h">${Icon('alert')} Reported differently in different places</h3>${ev.consistency.map(x => html`<div class="issue sev-${x.sev === 'high' ? 'high' : 'medium'}"><div class="issue-why">${x.explain}</div>${x.claims.map(id => { const c = claims.find(z => z.id === id); const b = c && p.blockById.get(c.bid); return c ? html`<div class="small"><a href=${`/app/p/${p.id}/manuscript/${c.bid}`}>${b ? blockLabel(p, b) : ''}</a>: “${c.quote}”</div>` : null; })}</div>`)}</div>` : null}
        <div class="card pad"><div class="row-wrap"><h3 class="card-h grow">Claims</h3><div class="seg">${[['problems', 'Problems'], ['consistent', 'Match'], ['unverifiable', 'Unverifiable'], ['unlinked', 'Unlinked'], ['all', 'All']].map(([k, l]) => html`<button class=${vf === k ? 'on' : ''} onClick=${() => setVf(k)}>${l}</button>`)}</div></div>
          ${shown.length ? shown.map(c => html`<${ClaimRow} p=${p} c=${c} showBlock key=${c.id} />`) : html`<p class="faint small">No claims in this view.</p>`}</div>
      </div>
    </div>
  </div>`;
}
function EvidenceGraph({ p, claims, consistency, sel, onSel }) {
  const W = 760;
  const paras = [...new Set(claims.map(c => c.bid))].map(id => p.blockById.get(id)).filter(Boolean).sort((a, b) => a.i - b.i);
  const evIds = [...new Set(claims.flatMap(c => c.refers.map(r => r.id)))];
  const ev = [...p.tables.filter(t => evIds.includes(t.id)).map(t => ({ ...t, k: 'table' })), ...p.figures.filter(f => evIds.includes(f.id)).map(f => ({ ...f, k: 'figure' }))].sort((a, b) => (a.k === b.k ? String(a.num).localeCompare(String(b.num), undefined, { numeric: true }) : a.k === 'table' ? -1 : 1));
  const rowH = 30, top = 24;
  const H = Math.max(paras.length, ev.length) * rowH + top * 2;
  const pY = i => top + i * (H - top * 2) / Math.max(1, paras.length - 1 || 1) * (paras.length > 1 ? 1 : 0) + (paras.length === 1 ? (H - top * 2) / 2 : 0);
  const eY = i => top + i * (H - top * 2) / Math.max(1, ev.length - 1 || 1) * (ev.length > 1 ? 1 : 0) + (ev.length === 1 ? (H - top * 2) / 2 : 0);
  const xP = 250, xE = 560;
  const worst = list => (list.some(c => c.v === 'mismatch') ? 'mismatch' : list.some(c => c.v === 'partly') ? 'partly' : list.some(c => c.v === 'consistent') ? 'consistent' : 'unverifiable');
  const edges = [];
  paras.forEach((b, i) => { const cs = claims.filter(c => c.bid === b.id); const by = new Map(); for (const c of cs) for (const r of c.refers) { if (!by.has(r.id)) by.set(r.id, []); by.get(r.id).push(c); } for (const [id, list] of by) { const j = ev.findIndex(e => e.id === id); if (j >= 0) edges.push({ i, j, v: worst(list), n: list.length, bid: b.id, eid: id }); } });
  const arcs = consistency.map(x => { const bs = [...new Set(x.claims.map(id => (claims.find(c => c.id === id) || {}).bid).filter(Boolean))]; return bs.map(id => paras.findIndex(b => b.id === id)).filter(i => i >= 0); }).filter(a => a.length >= 2);
  const secColor = b => { const s = p.secById.get(b.sec); let h = 0; for (const ch of String(s ? s.title : '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 55% 52%)`; };
  const dim = e => sel && !(sel.kind === 'b' ? e.bid === sel.id : e.eid === sel.id);
  if (!paras.length) return html`<p class="faint small">No claims were linked to tables or figures.</p>`;
  return html`<div class="ev-svg-wrap"><svg viewBox=${`0 0 ${W} ${H}`} class="ev-svg" role="img" aria-label="Evidence graph: paragraphs linked to the tables and figures they rely on">
    ${arcs.map(a => { const ys = a.map(pY); const y0 = Math.min(...ys), y1 = Math.max(...ys); return html`<path d=${`M ${xP - 8} ${y0} C ${xP - 60 - (y1 - y0) * 0.15} ${y0}, ${xP - 60 - (y1 - y0) * 0.15} ${y1}, ${xP - 8} ${y1}`} class="arc" />`; })}
    ${edges.map(e => html`<path d=${`M ${xP + 8} ${pY(e.i)} C ${(xP + xE) / 2} ${pY(e.i)}, ${(xP + xE) / 2} ${eY(e.j)}, ${xE - 10} ${eY(e.j)}`} class=${`edge v-${e.v} ${dim(e) ? 'dim' : ''}`} stroke-width=${1.5 + Math.min(4, e.n)}><title>${e.n} claim(s): ${e.v}</title></path>`)}
    ${paras.map((b, i) => { const cs = claims.filter(c => c.bid === b.id); const w = worst(cs); const on = sel && sel.kind === 'b' && sel.id === b.id; return html`<g class=${`node p ${on ? 'on' : ''}`} onClick=${() => onSel(on ? null : { kind: 'b', id: b.id })}><circle cx=${xP} cy=${pY(i)} r=${6 + Math.min(6, cs.length)} fill=${secColor(b)} class=${`v-${w}`} /><text x=${xP - 16} y=${pY(i) + 4} text-anchor="end" class="lbl">${blockLabel(p, b).split(' · ').slice(0, 2).join(' · ').slice(0, 34)}</text><title>${blockPlain(p, b).slice(0, 200)}</title></g>`; })}
    ${ev.map((e, j) => { const on = sel && sel.kind === 'e' && sel.id === e.id; const cs = claims.filter(c => c.refers.some(r => r.id === e.id)); return html`<g class=${`node e ${on ? 'on' : ''}`} onClick=${() => onSel(on ? null : { kind: 'e', id: e.id })}>${e.k === 'table' ? html`<rect x=${xE - 9} y=${eY(j) - 9} width="18" height="18" rx="3" class=${`v-${worst(cs)}`} />` : html`<path d=${`M ${xE} ${eY(j) - 11} L ${xE + 11} ${eY(j)} L ${xE} ${eY(j) + 11} L ${xE - 11} ${eY(j)} Z`} class=${`v-${worst(cs)}`} />`}<text x=${xE + 18} y=${eY(j) + 4} class="lbl">${e.label}${e.k === 'figure' && e.data && e.data.source ? ` · ${e.data.source}` : ''}</text><title>${e.caption || ''}</title></g>`; })}
  </svg><div class="legend small"><span><i class="lg v-consistent"></i>matches</span><span><i class="lg v-partly"></i>partly</span><span><i class="lg v-mismatch"></i>mismatch</span><span><i class="lg v-unverifiable"></i>cannot verify</span><span><i class="lg arc"></i>reported inconsistently</span><span>● paragraph ■ table ◆ figure</span></div></div>`;
}

// ── Figures & tables ───────────────────────────────────────
export function Figures({ p }) {
  const [tab, setTab] = useState('figures');
  return html`<div class="figs">
    <div class="card ms-tools"><div class="seg"><button class=${tab === 'figures' ? 'on' : ''} onClick=${() => setTab('figures')}>Figures ${p.figures.length}</button><button class=${tab === 'tables' ? 'on' : ''} onClick=${() => setTab('tables')}>Tables ${p.tables.length}</button></div>
    <span class="faint small grow">Figures are turned into data so their numbers can be checked: from the vector drawing, OCR of raster images, pgfplots source, or points you click in the digitizer. Check that the replot matches the original.</span></div>
    ${tab === 'figures' ? (p.figures.length ? html`<div class="fig-grid">${p.figures.map(f => html`<${FigureCard} p=${p} f=${f} key=${f.id} />`)}</div>` : html`<div class="card"><${Empty} icon="image" title="No figures detected" /></div>`) : (p.tables.length ? html`<div class="fig-grid">${p.tables.map(t => html`<${TableCard} p=${p} t=${t} key=${t.id} />`)}</div>` : html`<div class="card"><${Empty} icon="table" title="No tables detected" /></div>`)}
  </div>`;
}
const SRC = { vector: ['c-ok', 'from vector drawing'], pgfplots: ['c-ok', 'from pgfplots source'], manual: ['c-brand', 'digitised by hand'], ocr: ['c-warn', 'OCR'], table: ['c-ok', 'table'] };
function FigureCard({ p, f }) {
  const [show, setShow] = useState(false);
  const d = f.data;
  const has = d && d.series && d.series.length;
  const [c, l] = has ? (SRC[d.source] || ['', d.source]) : ['', ''];
  return html`<div class="card fig-card">
    <div class="fig-top"><b>${f.label}</b><span class="chip">${f.kind === 'raster' ? 'image' : f.kind === 'mixed' ? 'image + text' : f.kind === 'tikz' ? 'TikZ' : f.kind === 'vector' ? 'vector' : 'no graphics'}</span>${has ? html`<span class=${`chip ${c}`}>${d.panels && d.panels.length > 1 ? `${d.panels.length} panels · ` : ''}${plural(d.series.length, 'series', 'series')} · ${l}</span>` : html`<span class="chip">no data</span>`}${f.page ? html`<span class="faint tiny">p. ${f.page}</span>` : null}</div>
    <div class="fig-media"><${FigureImage} p=${p} f=${f} /></div>
    ${f.caption ? html`<div class="fig-cap small">${f.caption.length > 260 ? f.caption.slice(0, 260) + '…' : f.caption}</div>` : null}
    ${d && d.note ? html`<div class="faint tiny">${d.note}</div>` : null}
    <div class="row-wrap">
      ${has ? html`<button class="btn btn-ghost btn-sm" onClick=${() => setShow(s => !s)}>${Icon('chart')} ${show ? 'Hide data' : 'Data & replot'}</button>` : null}
      ${p.canDecide && f.image ? html`<button class="btn btn-ghost btn-sm" onClick=${() => openDigitizer(p, f)}>${Icon('crosshair')} ${has ? 'Re-digitise' : 'Digitise'}</button>` : null}
      ${p.canDecide ? html`<button class="btn btn-text btn-sm" onClick=${() => editData(p, f)}>${Icon('edit')} Edit data</button>` : null}
    </div>
    ${show && has ? html`<div class="fig-data"><${Chart} data=${d} /><details class="mini-det" open><summary>Values</summary><${DataTable} data=${d} /></details></div>` : null}
    ${f.ocr || (f.text && f.text.length) ? html`<details class="mini-det"><summary>Text in the figure${f.ocr ? ' (OCR)' : ''}</summary><div class="small faint">${f.ocr || f.text.join(' · ')}</div></details>` : null}
  </div>`;
}
function TableCard({ p, t }) {
  const [busy, setBusy] = useState(false);
  const rebuild = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/tables/${t.id}/rebuild`, { method: 'POST', body: {} }); toast('Table rebuilt — check it against the original', 'ok'); } catch (e) { toastError(e); } setBusy(false); };
  const edit = async () => {
    const tsv = (t.grid || []).map(r => r.join('\t')).join('\n');
    openModal(close => { let v = tsv; return html`<div class="modal-body"><h3>Edit ${t.label}</h3><p class="muted small">One row per line, cells separated by tabs (or |). The evidence check reads these values.</p><textarea class="input mono-ish" rows="14" onInput=${e => (v = e.target.value)}>${tsv}</textarea><div class="modal-actions"><button class="btn btn-ghost" onClick=${close}>Cancel</button><button class="btn btn-primary" onClick=${async () => { const grid = v.split('\n').filter(l => l.trim()).map(l => l.split(/\t|\s\|\s|\|/).map(x => x.trim())); try { await api(`/api/projects/${p.id}/tables/${t.id}`, { method: 'PUT', body: { grid } }); toast('Saved', 'ok'); close(); } catch (e) { toastError(e); } }}>Save</button></div></div>`; }, { wide: true });
  };
  return html`<div class="card fig-card">
    <div class="fig-top"><b>${t.label}</b><span class="chip ${t.source === 'latex' ? 'c-ok' : t.source === 'ai' ? 'c-ai' : t.source === 'manual' ? 'c-brand' : ''}">${t.source === 'latex' ? 'from LaTeX source' : t.source === 'ai' ? 'rebuilt by AI' : t.source === 'manual' ? 'edited' : 'read from PDF'}</span>${t.page ? html`<span class="faint tiny">p. ${t.page}</span>` : null}</div>
    ${t.caption ? html`<div class="fig-cap small">${t.caption.length > 260 ? t.caption.slice(0, 260) + '…' : t.caption}</div>` : null}
    ${t.box && p.source.pageImages ? html`<details class="mini-det"><summary>As typeset</summary><${CropBox} p=${p} box=${t.box} /></details>` : null}
    <${TableGrid} grid=${t.grid} max=${30} />
    ${p.canDecide ? html`<div class="row-wrap">${p.source.kind === 'pdf' && p.ai.enabled ? html`<button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${rebuild}>${busy ? html`<${Spinner} small />` : Icon('sparkle')} Rebuild with AI</button>` : null}<button class="btn btn-text btn-sm" onClick=${edit}>${Icon('edit')} Edit cells</button></div>` : null}
  </div>`;
}
function CropBox({ p, box }) { const [m, setM] = useState(null); useEffect(() => { import('./lib.js').then(setM); }, []); return m ? html`<${m.Crop} p=${p} boxes=${[box]} />` : null; }

function editData(p, f) {
  const d = f.data || { source: 'manual', axes: { x: { title: '', type: 'linear' }, y: { title: '', type: 'linear' } }, series: [] };
  const multi = Array.isArray(d.panels) && d.panels.length > 1;
  const groups = multi ? d.panels.map((pn, i) => ({ pn, series: d.series.filter(s => (s.panel || 0) === i) })) : [{ pn: null, series: d.series }];
  const block = g => {
    const xs = [...new Set(g.series.flatMap(s => s.points.map(pt => String(pt.x))))];
    const head = ['x', ...g.series.map(s => s.name)].join('\t');
    const rows = xs.map(x => [x, ...g.series.map(s => { const pt = s.points.find(q => String(q.x) === x); return pt && pt.y != null ? pt.y : ''; })].join('\t'));
    return [...(g.pn ? [`# ${g.pn.label} ${(g.pn.title || '').replace(/^\([a-z]\)\s*/i, '')}`.trim()] : []), head, ...rows].join('\n');
  };
  const text = groups.map(block).join('\n\n');
  openModal(close => { let v = text; return html`<div class="modal-body"><h3>Data of ${f.label}</h3><p class="muted small">First row: <code>x</code> then one column per series (its name). Then one row per x value. Tabs (or |) separate cells.${multi ? html` Each panel starts with a line beginning with <code>#</code>.` : null}</p><textarea class="input mono-ish" rows="16" onInput=${e => (v = e.target.value)}>${text}</textarea><div class="modal-actions"><button class="btn btn-ghost" onClick=${close}>Cancel</button><button class="btn btn-primary" onClick=${async () => {
    const split = l => l.split(/\t/.test(l) ? /\t/ : /\|/.test(l) ? /\|/ : /,/).map(x => x.trim());
    const parts = [];
    for (const raw of v.split('\n')) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#')) { const m = /^#\s*(\([a-z]\))?\s*(.*)$/i.exec(l); parts.push({ label: m[1] || null, title: m[2] || '', lines: [] }); continue; }
      if (!parts.length) parts.push({ label: null, title: '', lines: [] });
      parts[parts.length - 1].lines.push(split(l));
    }
    const valid = parts.filter(g => g.lines.length >= 2);
    if (!valid.length) return toast('Add a header and at least one row.', 'bad');
    const series = [], panels = [];
    valid.forEach((g, gi) => {
      const old = multi ? (d.panels.findIndex(pn => g.label && pn.label === g.label) + 1 || gi + 1) - 1 : 0;
      const before = multi ? d.series.filter(s => (s.panel || 0) === old) : d.series;
      if (valid.length > 1) panels.push({ ...(multi && d.panels[old] ? d.panels[old] : { axes: d.axes }), label: g.label || `(${String.fromCharCode(97 + gi)})`, title: g.title ? `${g.label || ''} ${g.title}`.trim() : (multi && d.panels[old] ? d.panels[old].title : null) });
      g.lines[0].slice(1).forEach((n, k) => {
        const prev = before.find(s => s.name === n) || before[k];
        const points = g.lines.slice(1).map(r => {
          const x = Number.isFinite(Number(r[0])) && r[0] !== '' ? Number(r[0]) : r[0];
          const y = r[k + 1] === '' || r[k + 1] == null ? null : Number(r[k + 1]);
          const o = prev && prev.kind === 'box' ? prev.points.find(q => String(q.x) === String(x)) : null;
          return o ? { ...o, x, y } : { x, y };
        }).filter(pt => pt.y == null || Number.isFinite(pt.y));
        series.push({ name: n || `Series ${k + 1}`, kind: (prev && prev.kind) || 'line', color: prev ? prev.color : undefined, panel: valid.length > 1 ? gi : undefined, points });
      });
    });
    const data = { ...d, source: 'manual', series, panels: panels.length > 1 ? panels : undefined };
    try { await api(`/api/projects/${p.id}/figures/${f.id}`, { method: 'PUT', body: { data } }); toast('Saved', 'ok'); close(); } catch (e) { toastError(e); }
  }}>Save</button></div></div>`; }, { wide: true });
}

// ── Digitizer (raster or any figure image) ─────────────────
function openDigitizer(p, f) { openModal(close => html`<${Digitizer} p=${p} f=${f} close=${close} />`, { wide: true, cls: 'digi-modal' }); }
function Digitizer({ p, f, close }) {
  const img = useRef(null);
  const [step, setStep] = useState('x');
  const [cal, setCal] = useState({ x: [], y: [], xType: 'linear', yType: 'linear' }); // [{ px, v }]
  const [series, setSeries] = useState(() => (f.data && f.data.source === 'manual' ? f.data.series.map(s => ({ ...s, pts: [] })) : [{ name: 'Series 1', kind: 'line', pts: [] }]));
  const [cur, setCur] = useState(0);
  const [nat, setNat] = useState(null);
  const [guess, setGuess] = useState(null);
  useEffect(() => {
    if (!f.words || !f.words.length) return;
    import('./ingest/ocr.js').then(m => setGuess(m.guessCalibration(f.words)));
  }, []);
  const toImg = e => { const r = img.current.getBoundingClientRect(); const sx = img.current.naturalWidth / r.width; return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sx }; };
  const mapAxis = (pts, type, pos) => { if (pts.length < 2) return null; const [a, b] = pts; if (type === 'log') { const la = Math.log10(a.v), lb = Math.log10(b.v); return 10 ** (la + (pos - a.px) * (lb - la) / (b.px - a.px)); } return a.v + (pos - a.px) * (b.v - a.v) / (b.px - a.px); };
  const click = async e => {
    const pt = toImg(e);
    if (step === 'x' || step === 'y') {
      const list = cal[step];
      if (list.length >= 2) return;
      const v = prompt(`Value at this ${step === 'x' ? 'x' : 'y'} position (${list.length + 1} of 2)`);
      if (v == null || !Number.isFinite(Number(v))) return;
      const next = { ...cal, [step]: [...list, { px: step === 'x' ? pt.x : pt.y, v: Number(v) }] };
      setCal(next);
      if (next[step].length === 2) setStep(step === 'x' ? 'y' : 'pts');
      return;
    }
    setSeries(ss => ss.map((s, i) => (i === cur ? { ...s, pts: [...s.pts, pt].sort((a, b) => a.x - b.x) } : s)));
  };
  const useGuess = () => {
    if (!guess) return;
    const c = { ...cal };
    if (guess.x) c.x = [{ px: guess.x.p1, v: guess.x.v1 }, { px: guess.x.p2, v: guess.x.v2 }];
    if (guess.y) c.y = [{ px: guess.y.p1, v: guess.y.v1 }, { px: guess.y.p2, v: guess.y.v2 }];
    setCal(c);
    if (c.x.length === 2 && c.y.length === 2) setStep('pts'); else if (c.x.length === 2) setStep('y');
  };
  const values = s => s.pts.map(pt => ({ x: +(mapAxis(cal.x, cal.xType, pt.x) ?? pt.x).toPrecision(5), y: +(mapAxis(cal.y, cal.yType, pt.y) ?? pt.y).toPrecision(5) }));
  const save = async () => {
    const out = series.filter(s => s.pts.length).map(s => ({ name: s.name, kind: s.kind, points: values(s) }));
    if (!out.length) return toast('Click some data points first.', 'bad');
    const data = { source: 'manual', axes: { x: { title: (f.data && f.data.axes && f.data.axes.x && f.data.axes.x.title) || '', type: cal.xType }, y: { title: (f.data && f.data.axes && f.data.axes.y && f.data.axes.y.title) || '', type: cal.yType } }, series: out, calib: { x: cal.x, y: cal.y } };
    try { await api(`/api/projects/${p.id}/figures/${f.id}`, { method: 'PUT', body: { data } }); toast('Figure data saved', 'ok'); close(); } catch (e) { toastError(e); }
  };
  const W = nat ? nat.w : 1, H = nat ? nat.h : 1;
  const colors = ['#e0662b', '#3346c8', '#12a58a', '#b33dc6', '#d4a017', '#2b8fd6'];
  return html`<div class="modal-body digi">
    <div class="row"><h3 class="grow">${Icon('crosshair')} Digitise ${f.label}</h3><button class="btn btn-text btn-sm" onClick=${close}>${Icon('x')}</button></div>
    <div class="digi-steps"><span class=${step === 'x' ? 'on' : cal.x.length === 2 ? 'done' : ''}>1. Two points on the x axis</span><span class=${step === 'y' ? 'on' : cal.y.length === 2 ? 'done' : ''}>2. Two points on the y axis</span><span class=${step === 'pts' ? 'on' : ''}>3. Click the data</span>
      ${guess && (guess.x || guess.y) && step !== 'pts' ? html`<button class="btn btn-soft btn-sm" onClick=${useGuess}>${Icon('sparkle')} Use axes read by OCR</button>` : null}
      <label class="small">x <select class="input sm" value=${cal.xType} onChange=${e => setCal({ ...cal, xType: e.target.value })}><option value="linear">linear</option><option value="log">log</option></select></label>
      <label class="small">y <select class="input sm" value=${cal.yType} onChange=${e => setCal({ ...cal, yType: e.target.value })}><option value="linear">linear</option><option value="log">log</option></select></label>
      <button class="btn btn-text btn-sm" onClick=${() => { setCal({ ...cal, x: [], y: [] }); setStep('x'); }}>Reset axes</button></div>
    <div class="digi-body">
      <div class="digi-canvas">
        <img ref=${img} src=${`/api/projects/${p.id}/files/${f.image}`} onLoad=${e => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })} onClick=${click} alt=${f.label} />
        ${nat ? html`<svg viewBox=${`0 0 ${W} ${H}`} class="digi-over" preserveAspectRatio="none">
          ${cal.x.map(c => html`<line x1=${c.px} x2=${c.px} y1="0" y2=${H} class="cal-x" />`)}${cal.y.map(c => html`<line y1=${c.px} y2=${c.px} x1="0" x2=${W} class="cal-y" />`)}
          ${series.map((s, i) => html`${s.kind === 'line' && s.pts.length > 1 ? html`<polyline points=${s.pts.map(q => `${q.x},${q.y}`).join(' ')} fill="none" stroke=${colors[i % colors.length]} stroke-width=${Math.max(1.5, W / 400)} />` : null}${s.pts.map(q => html`<circle cx=${q.x} cy=${q.y} r=${Math.max(3, W / 160)} fill=${colors[i % colors.length]} stroke="#fff" stroke-width=${Math.max(1, W / 600)} />`)}`)}
        </svg>` : null}
      </div>
      <div class="digi-side">
        ${series.map((s, i) => html`<div class=${`digi-s ${i === cur ? 'on' : ''}`} onClick=${() => setCur(i)}><i style=${`background:${colors[i % colors.length]}`}></i><input class="input sm" value=${s.name} onInput=${e => setSeries(ss => ss.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} /><select class="input sm" value=${s.kind} onChange=${e => setSeries(ss => ss.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}><option value="line">line</option><option value="bar">bar</option><option value="scatter">points</option></select><span class="faint tiny">${s.pts.length}</span><button class="btn btn-text btn-sm" title="Remove last point" onClick=${e => { e.stopPropagation(); setSeries(ss => ss.map((x, k) => (k === i ? { ...x, pts: x.pts.slice(0, -1) } : x))); }}>${Icon('undo')}</button></div>`)}
        <button class="btn btn-ghost btn-sm" onClick=${() => { setSeries(ss => [...ss, { name: `Series ${ss.length + 1}`, kind: 'line', pts: [] }]); setCur(series.length); }}>${Icon('plus')} Add series</button>
        ${step === 'pts' && series[cur] && series[cur].pts.length ? html`<div class="tgrid-wrap"><table class="tgrid"><tbody><tr class="th"><td>x</td><td>y</td></tr>${values(series[cur]).map(v => html`<tr><td>${v.x}</td><td>${v.y}</td></tr>`)}</tbody></table></div>` : html`<p class="faint small">${step === 'pts' ? 'Click each data point (bar tops, line vertices, markers) for the selected series.' : 'Click a tick on the axis, then type its value. Do this for two ticks far apart.'}</p>`}
        <button class="btn btn-primary" onClick=${save}>${Icon('check')} Save data</button>
      </div>
    </div>
  </div>`;
}
