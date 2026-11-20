/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Checks (consistency, AI, references), the evidence graph, and figures & tables with a digitizer. */
import { html, useState, useEffect, useMemo, useRef, api, getStore, navigate, useRoute, Icon, Spinner, Empty, Bar, ago, plural, toast, toastError, confirmDialog, openModal, closeModal, tk, blockPlain, catLabel } from './lib.js';
import { IssueCard, blockLabel, Chart, DataTable, TableGrid, FigureImage, applyIssue } from './blocks.js';
import { ClaimRow } from './manuscript.js';
import { PrecheckButton } from './project.js';
import { AuthorsExposure } from './rexp.js';
import * as BIB from './shared/bib.mjs';

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
/** LaTeX projects with a .bib: every cited entry checked against its published record (the check of Rykhet LaTeX);
 *  RefCheck stays available below as a second opinion (retractions, the web). PDFs: RefCheck. */
function References({ p }) {
  const bib = useBibState(p);
  if (p.source.kind === 'latex' && !bib.st && !bib.err) return html`<div class="card pad"><${Spinner} small /> Reading the .bib files…</div>`;
  if (bib.st && bib.st.entries.length) return html`<div class="col"><${BibReferences} p=${p} st=${bib.st} />${p.refcheckEnabled && p.refs.length ? html`<details class="card pad bibc-more"><summary><b>RefCheck</b> <span class="muted small">— a second opinion: retractions (Retraction Watch), Semantic Scholar and the web</span>${p.refcheck && p.refcheck.summary ? html` <span class="chip c-brand">checked</span>` : null}</summary><${RefCheckPanel} p=${p} /></details>` : null}</div>`;
  return html`<${RefCheckPanel} p=${p} />`;
}
function RefCheckPanel({ p }) {
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

// ── .bib reference check (the same check as Rykhet LaTeX) ──
/** The project's .bib entries as checked: the stored sources with the corrections applied. */
export function useBibState(p) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (p.source.kind !== 'latex') return; import('./exports.js').then(m => m.sourcesOf(p)).then(setSrc, setErr); }, [p.id, p.imported && p.imported.at, p.source.layoutVer]);
  const fixes = (p.bib && p.bib.fixes) || [];
  const st = useMemo(() => (src ? BIB.bibState(src.texFiles || {}, fixes) : null), [src, fixes]);
  return { st, err };
}
const NO_BIB = { results: {}, fixes: [], ignore: [], skipDoi: false, job: null };
/** An entry's state: s = ok | warn | err | unknown | pending | uncited | ignored | skipped | dup, r = the result as shown. */
export function bibStatus(B, ignore, e) {
  if (!e.cited) return { s: 'uncited' };
  if (ignore.has(e.id)) return { s: 'ignored' };
  if (e.dup) return { s: 'dup' };
  if (!e.checkable) return { s: 'skipped' };
  const x = B.results[e.id];
  if (!x || x.fp !== e.fp) return { s: 'pending' };
  const r = BIB.shown(x.r, B.skipDoi);
  return { s: r.status, r };
}
/** Counts for the overview and the report. */
export function bibSummary(p, st) {
  const B = p.bib || NO_BIB;
  const ignore = new Set(B.ignore || []);
  const c = { ok: 0, warn: 0, err: 0, unknown: 0, pending: 0, uncited: 0, ignored: 0, skipped: 0, dup: 0 };
  for (const e of st.entries) c[bibStatus(B, ignore, e).s]++;
  return c;
}
const untex = s => String(s || '').replace(/\\[`'^"~=.]\s*\{?([A-Za-z])\}?/g, '$1').replace(/\\[uvHtcdbrk](?:\s+|\{)([A-Za-z])\}?/g, '$1').replace(/\\((?:La|Bib)?TeX)\b/g, '$1').replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1').replace(/\\[a-zA-Z]+\s*/g, ' ').replace(/\\([&%#_$])/g, '$1').replace(/[{}]/g, '').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
const authorsShort = a => { const l = String(a || '').split(/\s+and\s+/i).map(x => untex(x)).filter(x => x && !/^others$/i.test(x)).map(x => (x.includes(',') ? x.split(',')[0] : x.split(' ').pop()).trim()); return l.length > 3 || /\band\s+others\b/i.test(a || '') ? `${l.slice(0, 3).join(', ')} et al.` : l.join(', '); };
const PILL = { ok: ['c-ok', '✓'], warn: ['c-warn', '⚠'], err: ['c-bad', '✗'], unknown: ['c-info', '?'], uncited: ['', 'not cited'], ignored: ['', 'ignored'], skipped: ['', 'not checked'], dup: ['c-warn', 'duplicate key'] };
const FILTERS = [['problems', 'Problems'], ['ok', '✓ Match'], ['warn', '⚠ Differ'], ['err', '✗ Not found'], ['unknown', '? Unsure'], ['uncited', 'Not cited'], ['skipped', 'Not checked'], ['ignored', 'Ignored'], ['all', 'All']];
const inFilter = (f, s) => (f === 'all' ? true : f === 'problems' ? ['warn', 'err', 'unknown', 'dup'].includes(s) : f === 'skipped' ? s === 'skipped' || s === 'dup' : s === f);

function BibReferences({ p, st }) {
  const { query } = useRoute();
  const B = p.bib || NO_BIB;
  const ignore = useMemo(() => new Set(B.ignore || []), [B.ignore]);
  const rows = st.entries.map(e => ({ e, ...bibStatus(B, ignore, e) }));
  const n = k => rows.filter(x => inFilter(k, x.s)).length;
  const running = !!(B.job && B.job.status === 'running');
  const pending = rows.filter(x => x.s === 'pending').length;
  const [f, setF] = useState(() => (query.get('bib') ? 'all' : 'problems'));
  const [busy, setBusy] = useState(false);
  // entries never checked (a project from before this check, or entries just changed) are checked when the tab opens
  const asked = useRef(false);
  useEffect(() => { if (!asked.current && !running && pending) { asked.current = true; api(`/api/projects/${p.id}/bib/check`, { method: 'POST', body: {} }).catch(() => {}); } }, [pending, running]);
  // ?bib=<key>: that entry, with its details
  useEffect(() => {
    const k = query.get('bib');
    const x = k && rows.find(y => y.e.key === k);
    if (!x) return;
    setTimeout(() => { const el = document.getElementById(`bib-${x.e.id}`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
    if (x.r) openBib(p, x.e, x.r);
  }, [query.get('bib')]);
  const recheck = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/bib/check`, { method: 'POST', body: { force: true } }); toast('Every cited entry is being checked again', 'ok'); } catch (e) { toastError(e); } setBusy(false); };
  const setSkipDoi = async v => { try { await api(`/api/projects/${p.id}/bib`, { method: 'PATCH', body: { skipDoi: v } }); } catch (e) { toastError(e); } };
  const shownRows = rows.filter(x => inFilter(f, x.s));
  const fixes = B.fixes || [];
  return html`<div class="col">
    <div class="card pad">
      <div class="row-wrap">
        <div class="grow"><h3 class="card-h">${Icon('book')} Reference check</h3>
          <p class="muted small">Every cited entry of ${st.files.map((x, i) => html`${i ? ', ' : ''}<span class="mono">${x.path}</span>`)} is compared with its published record — Crossref, then OpenAlex and arXiv: is it real, and do the title, authors, year, venue, volume, pages, DOI and entry type match?</p></div>
        ${running ? html`<span class="row small"><${Spinner} small /> checking ${B.job.done || 0} of ${B.job.total || '…'}</span>` : p.canDecide ? html`<button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${recheck} title="Check every cited entry again">${busy ? html`<${Spinner} small />` : Icon('refresh')} Check again</button>` : null}
      </div>
      <div class="row-wrap bibc-filters">
        ${FILTERS.filter(([k]) => k === 'problems' || k === 'all' || n(k)).map(([k, l]) => html`<button class=${`chip-btn bibc-f-${k} ${f === k ? 'on' : ''}`} onClick=${() => setF(k)}>${l} <b>${n(k)}</b></button>`)}
        ${pending && !running ? html`<span class="faint tiny">${pending} waiting to be checked</span>` : null}
        <span class="grow"></span>
        ${p.canDecide ? html`<label class="row small" title="Some venues don't print DOIs: don't flag missing DOIs or add them in corrections"><label class="switch"><input type="checkbox" checked=${!B.skipDoi} onChange=${e => setSkipDoi(!e.target.checked)} /><span></span></label> Check DOIs</label>` : B.skipDoi ? html`<span class="faint tiny">DOIs not checked</span>` : null}
      </div>
      ${B.job && B.job.status === 'error' ? html`<p class="bad-text small">${B.job.error}</p>` : null}
      ${st.missing.length ? html`<p class="warn-text small">${Icon('alert')} Cited but not in the .bib: ${st.missing.slice(0, 12).map((k, i) => html`${i ? ', ' : ''}<span class="mono">${k}</span>`)}${st.missing.length > 12 ? ` and ${st.missing.length - 12} more` : ''}</p>` : null}
      ${fixes.length ? html`<p class="tiny faint">${plural(fixes.length, 'entry', 'entries')} corrected here — the corrections are in the revised project: the Source tab, downloads, compiled PDFs and your connected folder.</p>` : null}
    </div>
    <div class="card pad">${shownRows.length ? html`<div class="bibc-list">${shownRows.map(x => html`<${BibRow} p=${p} x=${x} key=${x.e.id} />`)}</div>`
      : html`<p class="faint small">${f === 'problems' ? (running || pending ? 'Nothing found so far — results appear as each entry is checked.' : 'No problems: every checked entry matches its published record.') : 'No entries in this view.'}</p>`}</div>
  </div>`;
}

function BibRow({ p, x }) {
  const { e, s, r } = x;
  const B = p.bib || NO_BIB;
  const fix = (B.fixes || []).find(z => z.file === e.file && z.key === e.key);
  const [busy, setBusy] = useState(false);
  const pct = useMemo(() => BIB.commentedLines(e.text, { ...e, from: 0, to: e.text.length, headEnd: e.headEnd - e.from }), [e.text]);
  const [c, l] = PILL[s] || ['', ''];
  const label = s === 'warn' ? `⚠ ${r.diffs.length || ''}`.trim() : s === 'ok' && r.hints && r.hints.length ? '✓ ⓘ' : l;
  const venue = untex(e.fields.journal || e.fields.booktitle || e.fields.journaltitle || e.fields.publisher || '');
  const call = async (path, body, method = 'POST') => { setBusy(true); try { await api(`/api/projects/${p.id}/${path}`, { method, body }); } catch (err) { toastError(err); } setBusy(false); };
  const ignore = on => call('bib', { id: e.id, ignore: on }, 'PATCH');
  const undo = async () => { if (await confirmDialog({ title: `Undo the correction of ${e.key}?`, body: 'The entry goes back to how it was uploaded, everywhere the revised project is used.', ok: 'Undo' })) call(`bib/fix/${fix.id}`, undefined, 'DELETE'); };
  const usePct = () => call('bib/fix', { file: e.file, key: e.key, base: e.text, text: pct.fixed, note: '% line written as an x-field' });
  const open = () => r && openBib(p, e, r);
  const why = s === 'uncited' ? 'No \\cite in the manuscript uses it, so it is not in the bibliography (and not checked).' : s === 'skipped' ? 'Web pages, software, theses and reports are not in Crossref: not checked.' : s === 'dup' ? 'The same key is in another .bib file; BibTeX uses the first.' : s === 'ignored' ? 'You chose not to check this entry.' : s === 'pending' ? 'Checking against the published record…' : r ? r.message : '';
  return html`<div class=${`bibc-row s-${s}`} id=${`bib-${e.id}`}>
    <div class="bibc-pill-col">${s === 'pending' ? html`<span class="chip"><${Spinner} small /></span>` : html`<button class=${`chip bibc-pill ${c}`} disabled=${!r} onClick=${open} title=${r ? 'Details' : why}>${label}</button>`}</div>
    <div class="grow bibc-main">
      <div class="bibc-title" onClick=${open}>${untex(e.fields.title) || html`<span class="faint">(no title)</span>`}</div>
      <div class="tiny muted">${[authorsShort(e.fields.author || e.fields.editor), e.fields.year, venue].filter(Boolean).join(' · ')}</div>
      <div class=${`small bibc-msg ${s === 'err' ? 'bad-text' : s === 'warn' ? 'warn-text' : ''}`}>${why}${s === 'warn' && r.diffs.length ? html` — <span class="muted">${r.diffs.map(d => (FIELD_LABEL[d.field] || d.field).toLowerCase()).join(', ')}</span>` : null}${s === 'ok' && r.hints && r.hints.length ? html` — <span class="muted">suggestion: ${r.hints.map(h => h.detail || h.field).join('; ')}</span>` : null}</div>
      ${pct.lines.length ? html`<div class="small warn-text bibc-pct">${Icon('alert')} <span>A <code>%</code> line inside this entry ends it for BibTeX (“You're missing a field name”): the fields after it are lost.${pct.fixed ? ' Writing it as an x-field (xdoi = {…}) keeps it out of the bibliography without breaking the entry.' : ' Move the comment above the entry.'}</span>${pct.fixed && p.canDecide ? html` <button class="btn btn-soft btn-sm" disabled=${busy} onClick=${usePct}>Use x${(pct.lines.find(z => z.field) || {}).field}</button>` : null}</div>` : null}
      ${fix ? html`<div class="tiny bibc-fixed">${Icon('check')} Corrected by ${fix.byName} ${ago(fix.at)}${fix.note ? ` — ${fix.note}` : ''}${p.canDecide ? html` · <button class="btn btn-text btn-sm" disabled=${busy} onClick=${undo}>Undo</button>` : null}</div>` : null}
      <div class="row-wrap bibc-acts">
        ${r && s !== 'pending' ? html`<button class=${`btn btn-sm ${s === 'warn' && p.canDecide && r.suggestion ? 'btn-soft' : 'btn-ghost'}`} onClick=${open}>${s === 'warn' && p.canDecide && r.suggestion ? 'Review & fix' : 'Details'}</button>` : null}
        ${BIB.entryLinks(e).map(lk => html`<a class="btn btn-text btn-sm" href=${lk.url} target="_blank" rel="noopener noreferrer" title=${`Open ${lk.url}`}>${lk.kind} ↗</a>`)}
        <a class="btn btn-text btn-sm" href=${BIB.scholarUrl(e)} target="_blank" rel="noopener noreferrer" title="Search Google Scholar for this title (opens in your browser)">Scholar ↗</a>
        ${p.canDecide && s === 'ignored' ? html`<button class="btn btn-text btn-sm" disabled=${busy} onClick=${() => ignore(false)} title="Check this entry again">Check it ↺</button>` : null}
        ${p.canDecide && ['warn', 'err', 'unknown'].includes(s) ? html`<button class="btn btn-text btn-sm" disabled=${busy} onClick=${() => ignore(true)} title="Stop checking this entry in this project; “Ignored” brings it back">Ignore</button>` : null}
      </div>
    </div>
    <span class="mono tiny faint bibc-key" title=${`${e.key} (${e.file})`}>${e.key}</span>
  </div>`;
}

const FIELD_LABEL = { title: 'Title', author: 'Authors', year: 'Year', journal: 'Journal', booktitle: 'Proceedings', volume: 'Volume', pages: 'Pages', doi: 'DOI', type: 'Entry type' };
const ESCAPE = new Set(['title', 'journal', 'booktitle', 'publisher', 'author']);
const texEscape = (k, v) => (ESCAPE.has(k) ? v.replace(/(^|[^\\])([&%#])/g, '$1\\$2') : v);
function openBib(p, e, r) { openModal(close => html`<${BibDialog} p=${p} e=${e} r=${r} close=${close} />`, { wide: true }); }

/** What differs from the published record, with a choice of which corrections to apply (owner and editors). */
function BibDialog({ p, e, r, close }) {
  const B = p.bib || NO_BIB;
  const sug = r.suggestion;
  const decide = p.canDecide;
  // differences (ticked) and suggestions such as the full journal name for an abbreviated one (not ticked)
  const rows = useMemo(() => [...r.diffs, ...(r.hints || []).filter(h => !r.diffs.some(d => d.field === h.field)).map(h => ({ ...h, hint: true }))], [r]);
  const typeDiff = r.diffs.find(d => d.field === 'type');
  const [pick, setPick] = useState(() => Object.fromEntries(rows.map(x => [x.field, !x.hint])));
  const [busy, setBusy] = useState(false);
  // a DOI hidden from the printed bibliography (xdoi, or "%doi" which becomes xdoi) is corrected where it is
  const doiKey = e.fields.doi !== undefined ? 'doi' : BIB.hiddenDoi(e) ? 'xdoi' : 'doi';
  // "%name = {…}" lines are kept, written as xname = {…} (BibTeX can read the entry then)
  const kept = () => { const o = { ...e.fields }; for (const [k, v] of Object.entries(e.commented || {})) if (o[`x${k}`] === undefined && o[k] === undefined) o[`x${k}`] = v; return o; };
  const send = async (text, note) => {
    setBusy(true);
    try { await api(`/api/projects/${p.id}/bib/fix`, { method: 'POST', body: { file: e.file, key: e.key, base: e.text, text, note } }); toast(`${e.key} corrected — it goes into the revised project and is checked again`, 'ok', 6000); close(); }
    catch (err) { toastError(err); }
    setBusy(false);
  };
  const apply = () => {
    if (!sug) return;
    const fields = {};
    const type = typeDiff && pick.type ? typeDiff.crossref.replace(/^@/, '') : e.type;
    const chosen = rows.filter(d => pick[d.field]);
    for (const d of chosen) if (d.field !== 'type' && d.crossref) fields[d.field === 'doi' ? doiKey : d.field] = texEscape(d.field, d.crossref);
    // a changed entry type takes its venue field from the record (journal ↔ booktitle)
    if (type !== e.type) for (const k of ['journal', 'booktitle']) if (sug.fields[k]) fields[k] = texEscape(k, sug.fields[k]);
    const original = kept();
    if (type !== e.type) { delete original.journal; delete original.booktitle; }
    send(BIB.formatEntry(type, e.key, fields, original), `${chosen.map(d => (FIELD_LABEL[d.field] || d.field).toLowerCase()).join(', ')} as in the published record`);
  };
  const fullRecord = () => {
    if (!sug) return;
    const fields = Object.fromEntries(Object.entries(sug.fields).map(([k, v]) => [k, texEscape(k, v)]));
    const original = kept();
    delete original.journal; delete original.booktitle;
    if (B.skipDoi) delete fields.doi;
    if (fields.doi && doiKey !== 'doi') { fields[doiKey] = fields.doi; delete fields.doi; }
    send(BIB.formatEntry(sug.type, e.key, fields, original), 'replaced by the published record');
  };
  const ignore = async () => { try { await api(`/api/projects/${p.id}/bib`, { method: 'PATCH', body: { id: e.id, ignore: true } }); close(); } catch (err) { toastError(err); } };
  const tone = r.status === 'ok' ? 'ok' : r.status === 'err' ? 'bad' : r.status === 'warn' ? 'warn' : 'info';
  const nPick = rows.filter(x => pick[x.field]).length;
  return html`<div class="modal-body bibc-dialog">
    <div class="row"><h3 class="grow">Reference check · <code>${e.key}</code></h3><button class="btn btn-text btn-sm" onClick=${close}>${Icon('x')}</button></div>
    <div class=${`bibc-verdict t-${tone}`}>${r.message}${r.hints && r.hints.length && !r.diffs.length ? ` — ${r.hints.length === 1 ? 'one optional suggestion' : `${r.hints.length} optional suggestions`} below` : ''}</div>
    ${r.preprint ? html`<p class="small muted">Its published version isn’t in Crossref or OpenAlex (common for ICLR, NeurIPS and other OpenReview venues), so it was compared with the preprint of the same paper — title and authors only${r.link ? html` · <a href=${r.link} target="_blank" rel="noopener noreferrer">the preprint ${Icon('external')}</a>` : null}.</p>`
      : r.doi ? html`<p class="small">Published record${r.source ? ` (${r.source})` : ''}: <a href=${`https://doi.org/${r.doi}`} target="_blank" rel="noopener noreferrer">doi.org/${r.doi} ${Icon('external')}</a></p>`
      : r.link ? html`<p class="small">Record${r.source ? ` (${r.source})` : ''}: <a href=${r.link} target="_blank" rel="noopener noreferrer">${r.link} ${Icon('external')}</a></p>` : null}
    ${r.status === 'err' && !r.doi ? html`<p class="small muted">Check that the title is spelled exactly as published. Preprints, web pages and reports may not be in Crossref; an entry of type <code>@misc</code> is not checked.</p>` : null}
    ${rows.length ? html`<div class="tgrid-wrap"><table class="bibc-diff"><colgroup>${decide && sug ? html`<col style="width:36px" />` : null}<col style="width:26%" /><col /><col /></colgroup><thead><tr>${decide && sug ? html`<th></th>` : null}<th>Field</th><th>In the .bib</th><th>Published record</th></tr></thead><tbody>
      ${rows.map(x => html`<tr class=${x.hint ? 'hint' : ''} onClick=${() => decide && sug && setPick(q => ({ ...q, [x.field]: !q[x.field] }))}>
        ${decide && sug ? html`<td><input type="checkbox" checked=${!!pick[x.field]} onChange=${() => {}} /></td>` : null}
        <td class="f">${FIELD_LABEL[x.field] || x.field}${x.hint ? html` <span class="chip c-info">Suggestion</span>` : null}${x.detail ? html`<div class="tiny muted">${x.detail}</div>` : null}</td>
        <td class="have">${x.have || html`<span class="faint">(missing)</span>`}</td>
        <td class="theirs">${x.crossref || html`<span class="faint">(none)</span>`}</td></tr>`)}
    </tbody></table></div>` : null}
    <details class="mini-det"><summary>The entry in ${e.file}</summary><pre class="bibc-pre">${e.text}</pre></details>
    ${!decide ? html`<p class="tiny faint">Only the owner and editors can apply corrections.</p>` : null}
    <div class="modal-actions bibc-actions">
      <a class="btn btn-text btn-sm" href=${BIB.scholarUrl(e)} target="_blank" rel="noopener noreferrer">Google Scholar ↗</a>
      ${decide ? html`<button class="btn btn-text btn-sm" onClick=${ignore} title="Stop checking this entry in this project; “Ignored” brings it back">Ignore permanently</button>` : null}
      <span class="grow"></span>
      ${decide && sug ? html`<button class="btn btn-ghost" disabled=${busy} onClick=${fullRecord} title="Replace the entry with the published record (other fields such as url or note are kept)">Use the full record</button>` : null}
      ${decide && sug && rows.length ? html`<button class="btn btn-primary" disabled=${busy || !nPick} onClick=${apply}>${busy ? html`<${Spinner} small />` : Icon('check')} Apply ${plural(nPick, 'correction')}</button>` : html`<button class="btn btn-primary" onClick=${close}>Close</button>`}
    </div>
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
