/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Shared pieces: block bodies, suggestion and issue cards, figure/table previews, data charts. */
import { html, useState, useMemo, useRef, useEffect, api, Icon, Avatar, Diff, TexView, Crop, ago, catLabel, toast, toastError, tk, promptDialog, blockPlain, Spinner, esc, useMarkHighlights, openModal } from './lib.js';

export const isReaderBlock = b => ['title', 'abstract', 'para', 'list', 'caption', 'equation', 'footnote', 'ref'].includes(b.kind);
export const MARK_COLORS = [['yellow', 'Yellow'], ['green', 'Green'], ['pink', 'Pink'], ['blue', 'Blue']];
/** Marks a viewer can see on a block. */
export const marksOf = (p, b) => p.suggestions.filter(s => s.kind === 'mark' && s.bid === b.id && s.status === 'open');

/** The figure or table a caption belongs to. */
export function floatOf(p, b) {
  if (!b || b.kind !== 'caption') return null;
  const t = (p.tables || []).find(x => x.bid === b.id);
  if (t) return { kind: 'table', item: t };
  const f = (p.figures || []).find(x => x.bid === b.id);
  return f ? { kind: 'figure', item: f } : null;
}
/** Caption boxes plus the float's own region: merged into one crop when they sit together on the page. */
function withFloat(boxes, box) {
  if (!box) return boxes;
  const out = boxes.map(x => ({ ...x }));
  const near = out.find(x => x.p === box.p && Math.max(x.y0, box.y0) - Math.min(x.y1, box.y1) < 90);
  if (near) Object.assign(near, { x0: Math.min(near.x0, box.x0), y0: Math.min(near.y0, box.y0), x1: Math.max(near.x1, box.x1), y1: Math.max(near.y1, box.y1) });
  else out.push({ ...box });
  return out.sort((a, b) => a.p - b.p || a.y0 - b.y0);
}

/** The paragraph as the author sees it: PDF crop or rendered LaTeX, optionally with changes and marks shown.
 *  A caption comes with its figure or table (the whole float as typeset, or the image / grid in text view). */
export function BlockBody({ p, b, mode = 'auto', showChanges = false, big = false, watermark = null, drawing = false, onArea, onMarkClick }) {
  const cur = b.cur ?? b.text;
  const changed = cur !== b.text;
  const marks = marksOf(p, b);
  const ref = useRef(null);
  const fl = floatOf(p, b);
  const boxes = fl && fl.item.box ? withFloat(b.boxes || [], fl.item.box) : b.boxes;
  const textMode = mode === 'text' || !boxes || !boxes.length || !p.source.pageImages;
  useMarkHighlights(ref, textMode ? marks : [], [b.id, cur, textMode, marks.map(m => m.id + m.status).join(','), showChanges]);
  const floatView = fl ? html`<div class="float-view">${fl.kind === 'table' ? html`<${TableGrid} grid=${fl.item.grid} max=${60} />` : html`<${FigureImage} p=${p} f=${fl.item} />`}</div>` : null;
  if (textMode) {
    if (showChanges && changed) return html`<div><div ref=${ref} class=${`text-view ${big ? 'big' : ''}`}><${Diff} a=${b.text} b=${cur} /></div>${floatView}</div>`;
    if (b.tex && mode !== 'source') return html`<div>${fl && fl.kind === 'figure' ? floatView : null}<div ref=${ref}><${TexView} src=${cur} ctx=${p.latex} cls=${`text-view ${big ? 'big' : ''} k-${b.kind}`} /></div>${fl && fl.kind === 'table' ? floatView : null}</div>`;
    return html`<div>${fl && fl.kind === 'figure' ? floatView : null}<div ref=${ref} class=${`text-view plain ${big ? 'big' : ''} k-${b.kind}`}>${cur}</div>${fl && fl.kind === 'table' ? floatView : null}</div>`;
  }
  const enlarge = () => openModal(close => html`<div class="modal-body zoom-body"><div class="row"><b class="grow">${fl.item.label}</b><button class="btn btn-text btn-sm" onClick=${close}>${Icon('x')}</button></div><${Crop} p=${p} boxes=${boxes} maxWidth=${2400} watermark=${watermark} /></div>`, { wide: true, cls: 'zoom-modal' });
  // a caption is never shown without its float: when the PDF did not give one of the two a place, show it from the source
  const capText = fl && !(b.boxes || []).length ? html`<div class=${`text-view ${big ? 'big' : ''} k-caption cap-above`}>${b.tex ? html`<${TexView} src=${cur} ctx=${p.latex} />` : cur}</div>` : null;
  const floatBelow = fl && !fl.item.box ? floatView : null;
  return html`<div class="crop-wrap">
    ${fl ? html`<button class="btn btn-ghost btn-sm zoom-btn" onClick=${enlarge} title="Show at full size">${Icon('search')} Enlarge ${fl.kind}</button>` : null}
    ${capText}
    <${Crop} key=${b.id} p=${p} boxes=${boxes} maxWidth=${fl ? 1000 : 820} watermark=${watermark} marks=${marks.filter(m => m.area).map(m => ({ id: m.id, area: m.area, color: m.color, title: `${m.byName}${m.note ? ': ' + m.note : ''}` }))} drawing=${drawing} onArea=${onArea} onMarkClick=${onMarkClick} />
    ${floatBelow}
    ${showChanges && changed ? html`<div class="changed-note">${Icon('edit')} <b>Changed since upload:</b> <span class="text-view small"><${Diff} a=${b.text} b=${cur} compact /></span></div>` : null}
  </div>`;
}

export function StatusChip({ s }) {
  const map = { open: ['c-sug', 'Open'], accepted: ['c-ok', 'Accepted'], rejected: ['c-bad', 'Rejected'], withdrawn: ['', 'Withdrawn'], resolved: ['c-ok', 'Resolved'] };
  const [c, l] = map[s.status] || ['', s.status];
  return html`<span class=${`chip ${c}`}>${l}</span>`;
}

/** Accept with a manual merge when the paragraph changed and the edits overlap. */
async function acceptWithMerge(p, s, conflict) {
  const merged = await promptDialog({ title: 'Merge by hand', body: 'The paragraph changed after this suggestion was made and the edits overlap. Edit the text below (it starts as the current paragraph with the suggestion’s intent shown in the card) and save.', value: conflict.cur, multiline: true, ok: 'Apply merged text' });
  if (merged == null) return;
  await api(`/api/projects/${p.id}/suggestions/${s.id}/accept`, { method: 'POST', body: { text: merged } });
  toast('Merged and applied', 'ok');
}
export async function decide(p, s, op) {
  try {
    if (op === 'reject') { const reason = await promptDialog({ title: 'Reject this suggestion?', body: 'Optionally say why — the author will see it.', ok: 'Reject', placeholder: 'Reason (optional)' }); if (reason === null) return; await api(`/api/projects/${p.id}/suggestions/${s.id}/reject`, { method: 'POST', body: { reason } }); return; }
    await api(`/api/projects/${p.id}/suggestions/${s.id}/${op}`, { method: 'POST', body: {} });
    if (op === 'accept') toast('Applied to the manuscript', 'ok');
  } catch (e) {
    if (e.status === 409 && e.body && e.body.conflict) return acceptWithMerge(p, s, e.body);
    toastError(e);
  }
}

export function SuggestionCard({ p, s, showBlock = false, onOpenBlock, compact = false }) {
  const [reply, setReply] = useState('');
  const [showReply, setShowReply] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.text || '');
  const b = p.blockById.get(s.bid);
  const mine = s.by === p.me.sub;
  const voted = (s.votes || []).includes(p.me.sub);
  const stale = s.kind === 'edit' && s.status === 'open' && b && (b.ver || 0) !== s.baseVer;
  const sendReply = async () => { if (!reply.trim()) return; try { await api(`/api/projects/${p.id}/suggestions/${s.id}/reply`, { method: 'POST', body: { text: reply } }); setReply(''); setShowReply(false); } catch (e) { toastError(e); } };
  const saveEdit = async () => { try { await api(`/api/projects/${p.id}/suggestions/${s.id}`, { method: 'PATCH', body: { text: draft } }); setEditing(false); } catch (e) { toastError(e); } };
  return html`<div class=${`sug ${s.kind} st-${s.status} ${compact ? 'compact' : ''}`}>
    <div class="sug-head">
      <${Avatar} name=${s.byName} sub=${s.by} size=${24} />
      <div class="grow"><b>${s.byName}${mine ? html` <span class="faint">(you)</span>` : ''}</b> <span class="faint small">· ${ago(s.at)}</span>${s.ai ? html` <span class="chip c-ai">${Icon('sparkle')} from AI</span>` : null}</div>
      ${s.kind === 'edit' ? html`<span class="chip">${catLabel(s.cat)}</span>` : s.kind === 'mark' ? html`<span class=${`chip mk mk-${s.color || 'yellow'}`}><i></i>Highlight</span>` : html`<span class="chip c-info">${Icon('comment')} Comment</span>`}
      <${StatusChip} s=${s} />
    </div>
    ${showBlock && b ? html`<button class="sug-where" onClick=${() => onOpenBlock && onOpenBlock(b.id)}>${Icon('pin')} ${blockLabel(p, b)}</button>` : null}
    ${s.kind === 'edit' ? (editing ? html`<div class="sug-edit"><textarea class="input mono-ish" rows="5" value=${draft} onInput=${e => setDraft(e.target.value)}></textarea><div class="diff-live"><${Diff} a=${s.base} b=${draft} /></div><div class="row"><button class="btn btn-primary btn-sm" onClick=${saveEdit}>Save</button><button class="btn btn-text btn-sm" onClick=${() => setEditing(false)}>Cancel</button></div></div>`
      : html`<div class="sug-diff text-view"><${Diff} a=${s.base} b=${s.text} compact=${compact || s.base.length > 600} /></div>`) : null}
    ${s.quote ? html`<div class=${`sug-quote ${s.kind === 'mark' ? `qm-${s.color || 'yellow'}` : ''}`}>${Icon('quote')} “${s.quote}”</div>` : null}
    ${s.kind === 'mark' && s.area ? html`<div class="sug-note faint">${Icon('crosshair')} Marked area on page ${s.area.p}</div>` : null}
    ${s.note ? html`<div class="sug-note">${s.note}</div>` : null}
    ${stale ? html`<div class="sug-stale">${Icon('info')} The paragraph changed after this was suggested; it will be merged on accept.</div>` : null}
    ${s.status === 'rejected' && s.reason ? html`<div class="sug-note faint">Rejected by ${s.decidedByName}: ${s.reason}</div>` : null}
    ${s.status === 'accepted' ? html`<div class="faint tiny">Accepted by ${s.decidedByName} · ${ago(s.decidedAt)}</div>` : null}
    ${(s.replies || []).length ? html`<div class="replies">${s.replies.map(r => html`<div class="reply"><${Avatar} name=${r.byName} sub=${r.by} size=${20} /><div><b>${r.byName}</b> <span class="faint tiny">${ago(r.at)}</span><div>${r.text}</div></div></div>`)}</div>` : null}
    ${showReply ? html`<div class="reply-box"><input class="input" placeholder="Reply…" value=${reply} onInput=${e => setReply(e.target.value)} onKeyDown=${e => e.key === 'Enter' && sendReply()} autofocus /><button class="btn btn-soft btn-sm" onClick=${sendReply}>${Icon('send')}</button></div>` : null}
    <div class="sug-actions">
      ${p.canDecide && s.kind === 'edit' && s.status === 'open' ? html`<button class="btn btn-ok btn-sm" onClick=${() => decide(p, s, 'accept')} title="Apply to the manuscript">${Icon('check')} Accept</button><button class="btn btn-ghost btn-sm" onClick=${() => decide(p, s, 'reject')}>${Icon('x')} Reject</button>` : null}
      ${p.canDecide && s.kind === 'edit' && s.status === 'rejected' ? html`<button class="btn btn-text btn-sm" onClick=${() => decide(p, s, 'reopen')}>Reopen</button>` : null}
      ${(s.kind === 'comment' || s.kind === 'mark') && (p.canDecide || mine) ? html`<button class="btn btn-ghost btn-sm" onClick=${() => decide(p, s, 'resolve')}>${s.status === 'resolved' ? 'Reopen' : html`${Icon('check')} Resolve`}</button>` : null}
      <button class=${`btn btn-text btn-sm ${voted ? 'on' : ''}`} onClick=${() => api(`/api/projects/${p.id}/suggestions/${s.id}/vote`, { method: 'POST', body: {} }).catch(toastError)} title="Agree">${Icon('thumb')} ${(s.votes || []).length || ''}</button>
      <button class="btn btn-text btn-sm" onClick=${() => setShowReply(v => !v)}>${Icon('comment')} Reply</button>
      ${mine && s.status === 'open' && s.kind === 'edit' && !editing ? html`<button class="btn btn-text btn-sm" onClick=${() => { setDraft(s.text); setEditing(true); }}>${Icon('edit')} Edit</button>` : null}
      ${mine && s.status === 'open' ? html`<button class="btn btn-text btn-sm" onClick=${() => decide(p, s, 'withdraw')}>Withdraw</button>` : null}
    </div>
  </div>`;
}

export function blockLabel(p, b) {
  const kinds = { title: 'Title', abstract: 'Abstract', para: '¶', list: 'List', caption: 'Caption', equation: 'Equation', footnote: 'Footnote', ref: 'Ref.', heading: 'Heading' };
  const n = p.reading.indexOf(b) + 1;
  const sec = p.secById.get(b.sec);
  return `${kinds[b.kind] || '¶'} ${n > 0 ? n : ''}${sec ? ` · ${sec.num ? sec.num + ' ' : ''}${sec.title}` : ''}${b.page ? ` · p. ${b.page}` : ''}`;
}

/** Apply a quote→fix to the paragraph: editors change the text directly, proofreaders make a suggestion. */
export async function applyIssue(p, b, issue, { cause = 'ai', direct = p.canDecide } = {}) {
  const next = tk.applyFix(b.cur, issue.quote, issue.fix);
  if (next == null) { toast('That text is no longer in the paragraph.', 'bad'); return false; }
  try {
    if (direct) await api(`/api/projects/${p.id}/blocks/${b.id}/edit`, { method: 'POST', body: { text: next, baseVer: b.ver || 0, cause, note: issue.why || issue.msg || '', issue: cause === 'ai' ? issue.id : undefined } });
    else await api(`/api/projects/${p.id}/suggestions`, { method: 'POST', body: { bid: b.id, kind: 'edit', text: next, note: issue.why || issue.msg || '', cat: issue.cat || 'grammar', ai: cause === 'ai' ? issue.id : undefined } });
    toast(direct ? 'Fixed' : 'Added as your suggestion', 'ok');
    return true;
  } catch (e) { toastError(e); return false; }
}

export function IssueCard({ p, b, issue, kind = 'ai', onDone }) {
  const [busy, setBusy] = useState(false);
  const sev = kind === 'ai' ? issue.sev : issue.sev === 'error' ? 'high' : issue.sev === 'warn' ? 'medium' : 'low';
  const canFix = b && issue.quote && issue.fix != null && tk.findQuote(b.cur, issue.quote);
  const dismiss = async () => { try { await api(`/api/projects/${p.id}/${kind === 'ai' ? 'ai/issues' : 'lint'}/${issue.id}/dismiss`, { method: 'POST', body: {} }); onDone && onDone(); } catch (e) { toastError(e); } };
  return html`<div class=${`issue sev-${sev}`}>
    <div class="issue-head"><span class=${`chip ${kind === 'ai' ? 'c-ai' : 'c-info'}`}>${kind === 'ai' ? html`${Icon('sparkle')} ${catLabel(issue.cat)}` : issue.code.replace(/-/g, ' ')}</span><span class=${`sev-dot s-${sev}`} title=${`Severity: ${sev}`}></span></div>
    ${issue.quote && issue.fix != null ? html`<div class="issue-fix text-view"><del>${issue.quote}</del> → <ins>${issue.fix || '∅'}</ins></div>` : issue.quote ? html`<div class="issue-fix text-view faint">“${issue.quote}”</div>` : null}
    <div class="issue-why">${issue.why || issue.msg}</div>
    <div class="row-wrap">
      ${canFix ? html`<button class="btn btn-soft btn-sm" disabled=${busy} onClick=${async () => { setBusy(true); const ok = await applyIssue(p, b, issue, { cause: kind === 'ai' ? 'ai' : 'lint' }); setBusy(false); if (ok) onDone && onDone(); }}>${Icon(p.canDecide ? 'check' : 'edit')} ${p.canDecide ? 'Apply fix' : 'Suggest this'}</button>` : null}
      ${p.canDecide ? html`<button class="btn btn-text btn-sm" onClick=${dismiss}>Dismiss</button>` : null}
    </div>
  </div>`;
}

// ── figures and tables ─────────────────────────────────────
export function TableGrid({ grid, max = 40, highlight }) {
  if (!grid || !grid.length) return html`<div class="faint small">No cells could be read from this table.</div>`;
  return html`<div class="tgrid-wrap"><table class="tgrid"><tbody>${grid.slice(0, max).map((r, i) => html`<tr class=${i === 0 ? 'th' : ''}>${r.map(c => html`<td class=${highlight && c && highlight(c) ? 'hl' : ''}>${c}</td>`)}</tr>`)}</tbody></table>${grid.length > max ? html`<div class="faint tiny">… ${grid.length - max} more rows</div>` : null}</div>`;
}
export function FigureImage({ p, f, cls = '' }) {
  if (!f.image) return f.data && f.data.series && f.data.series.length ? html`<${Chart} data=${f.data} />` : html`<div class=${`fig-missing ${cls}`}>${Icon('image')}<span>${f.kind === 'tikz' ? 'TikZ figure' : 'No image'}</span></div>`;
  return html`<img class=${`fig-img ${cls}`} src=${`/api/projects/${p.id}/files/${f.image}`} alt=${f.label} loading="lazy" />`;
}
const PALETTE = ['#3346c8', '#e0662b', '#12a58a', '#b33dc6', '#d4a017', '#2b8fd6', '#c2185b', '#6d8a0c'];
const usable = c => { const m = /^#([0-9a-f]{6})$/i.exec(c || ''); if (!m) return false; const n = parseInt(m[1], 16); return (n >> 16) + ((n >> 8) & 255) + (n & 255) < 640; };
const panelTitle = pn => (pn.title || '').replace(/^\([a-z]\)\s*/i, '');
/** Panels of a figure: [{ label, title, axes, series }]; a single-panel figure gives one entry. */
export function figurePanels(data) {
  const series = (data && data.series || []).filter(s => s.points && s.points.length);
  if (data && Array.isArray(data.panels) && data.panels.length > 1) return data.panels.map((pn, i) => ({ ...pn, series: series.filter(s => (s.panel || 0) === i) })).filter(pn => pn.series.length);
  return series.length ? [{ label: '', title: '', axes: data.axes, series }] : [];
}
/** Replot extracted figure data, so a person can compare it with the original figure (one small chart per panel). */
export function Chart({ data, height = 220 }) {
  const panels = figurePanels(data);
  if (!panels.length) return html`<div class="faint small">No data.</div>`;
  if (panels.length === 1) return html`<${PanelChart} panel=${panels[0]} height=${height} />`;
  return html`<div class="chart-panels">${panels.map(pn => html`<${PanelChart} panel=${pn} height=${Math.max(170, height - 40)} titled />`)}</div>`;
}
function PanelChart({ panel, height = 220, titled = false }) {
  const series = panel.series;
  const W = 520, H = height, m = { l: 46, r: 12, t: 12, b: 34 };
  const colOf = (s, si) => (usable(s.color) ? s.color : PALETTE[si % PALETTE.length]);
  const cat = series.some(s => s.points.some(pt => typeof pt.x !== 'number'));
  const cats = cat ? [...new Set(series.flatMap(s => s.points.map(pt => String(pt.x))))] : null;
  const xsRaw = cat ? [] : series.flatMap(s => s.points.map(pt => pt.x));
  const logX = !cat && panel.axes && panel.axes.x && panel.axes.x.type === 'log' && xsRaw.every(v => v > 0);
  const tx = v => (logX ? Math.log10(v) : v);
  const xs = cat ? cats.map((_, i) => i) : xsRaw.map(tx);
  const ys = series.flatMap(s => s.points.flatMap(pt => [pt.y, pt.lo, pt.hi, pt.q1, pt.q3])).filter(v => v != null && Number.isFinite(v));
  const bars = series.filter(s => s.kind === 'bar'), boxes = series.filter(s => s.kind === 'box');
  let y0 = Math.min(...ys, bars.length ? 0 : Infinity), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.06; y1 += pad; if (!bars.length) y0 -= pad;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const XT = t => m.l + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * (W - m.l - m.r);
  const X = v => (cat ? m.l + (cats.indexOf(String(v)) + 0.5) / cats.length * (W - m.l - m.r) : XT(tx(v)));
  const Y = v => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
  const ticks = 5, yt = Array.from({ length: ticks }, (_, i) => y0 + (y1 - y0) * i / (ticks - 1));
  const groups = Math.max(1, bars.length + boxes.length);
  const bw = cat ? (W - m.l - m.r) / cats.length * 0.8 / groups : 6;
  const fmt = v => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');
  const xTicks = cat ? [] : logX ? [...new Set(xsRaw)].sort((a, b) => a - b).filter((v, i, a) => a.length <= 8 || i % Math.ceil(a.length / 8) === 0).map(v => [XT(tx(v)), v]) : [0, 0.25, 0.5, 0.75, 1].map(f => { const t = x0 + (x1 - x0) * f; return [XT(t), t]; });
  const tip = (s, pt) => (pt.q1 != null ? `${s.name}: ${pt.x} → median ${pt.y}, IQR ${pt.q1}–${pt.q3}${pt.lo != null ? `, whiskers ${pt.lo}–${pt.hi}` : ''}` : `${s.name}: ${pt.x} → ${pt.y}`);
  const glyph = (s, si) => {
    const col = colOf(s, si);
    if (s.kind === 'bar' || s.kind === 'box') {
      const gi = [...bars, ...boxes].indexOf(s);
      const left = pt => X(pt.x) - (groups * bw) / 2 + gi * bw;
      if (s.kind === 'bar') return s.points.map(pt => (pt.y == null ? null : html`<rect x=${left(pt)} y=${Math.min(Y(pt.y), Y(Math.max(0, y0)))} width=${bw * 0.92} height=${Math.abs(Y(pt.y) - Y(Math.max(0, y0)))} fill=${col} opacity="0.85"><title>${tip(s, pt)}</title></rect>`));
      return s.points.map(pt => {
        if (pt.y == null) return null;
        const cx = left(pt) + bw * 0.46, w = bw * 0.8, q1 = pt.q1 ?? pt.y, q3 = pt.q3 ?? pt.y;
        return html`<g><title>${tip(s, pt)}</title>${pt.lo != null ? html`<line x1=${cx} x2=${cx} y1=${Y(pt.lo)} y2=${Y(q1)} stroke=${col} />` : null}${pt.hi != null ? html`<line x1=${cx} x2=${cx} y1=${Y(q3)} y2=${Y(pt.hi)} stroke=${col} />` : null}<rect x=${cx - w / 2} y=${Y(Math.max(q1, q3))} width=${w} height=${Math.max(1, Math.abs(Y(q1) - Y(q3)))} fill=${col} fill-opacity="0.35" stroke=${col} /><line x1=${cx - w / 2} x2=${cx + w / 2} y1=${Y(pt.y)} y2=${Y(pt.y)} stroke=${col} stroke-width="2" /></g>`;
      });
    }
    const pts = s.points.filter(pt => pt.y != null);
    return html`${s.kind !== 'scatter' ? html`<polyline points=${pts.map(pt => `${X(pt.x)},${Y(pt.y)}`).join(' ')} fill="none" stroke=${col} stroke-width="2" />` : null}${pts.length <= 60 || s.kind === 'scatter' ? pts.map(pt => html`<circle cx=${X(pt.x)} cy=${Y(pt.y)} r="2.8" fill=${col}><title>${tip(s, pt)}</title></circle>`) : null}`;
  };
  return html`<div class="chart">${titled ? html`<div class="chart-title"><b>${panel.label}</b> ${panelTitle(panel)}</div>` : null}<svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="Replotted figure data">
    ${yt.map(v => html`<line x1=${m.l} x2=${W - m.r} y1=${Y(v)} y2=${Y(v)} class="grid" /><text x=${m.l - 6} y=${Y(v) + 3} text-anchor="end" class="tick">${fmt(v)}</text>`)}
    ${cat ? cats.map(c => html`<text x=${X(c)} y=${H - m.b + 14} text-anchor="middle" class="tick">${c.length > 10 ? c.slice(0, 9) + '…' : c}</text>`) : xTicks.map(([px, v]) => html`<text x=${px} y=${H - m.b + 14} text-anchor="middle" class="tick">${fmt(v)}</text>`)}
    ${series.map(glyph)}
    <line x1=${m.l} x2=${m.l} y1=${m.t} y2=${H - m.b} class="axis" /><line x1=${m.l} x2=${W - m.r} y1=${H - m.b} y2=${H - m.b} class="axis" />
  </svg><div class="legend">${series.map((s, i) => html`<span><i style=${`background:${colOf(s, i)}`}></i>${s.name}</span>`)}</div></div>`;
}
const cellOf = pt => (pt && pt.y != null ? (pt.q1 != null ? `${pt.y} [${pt.q1}–${pt.q3}]` : pt.y) : '');
export function DataTable({ data }) {
  const panels = figurePanels(data);
  if (!panels.length) return null;
  const one = pn => {
    const xsAll = [...new Set(pn.series.flatMap(s => s.points.map(pt => String(pt.x))))];
    const xs = xsAll.slice(0, 60);
    return html`<div class="tgrid-wrap"><table class="tgrid"><tbody><tr class="th"><td>${pn.axes && pn.axes.x && pn.axes.x.title || 'x'}</td>${pn.series.map(s => html`<td>${s.name}</td>`)}</tr>${xs.map(x => html`<tr><td>${x}</td>${pn.series.map(s => html`<td>${cellOf(s.points.find(q => String(q.x) === x))}</td>`)}</tr>`)}</tbody></table>${xsAll.length > 60 ? html`<div class="faint tiny">… ${xsAll.length - 60} more x values</div>` : null}</div>`;
  };
  if (panels.length === 1) return one(panels[0]);
  return html`<div class="panel-tables">${panels.map(pn => html`<div><div class="chart-title"><b>${pn.label}</b> ${panelTitle(pn)}${pn.axes && pn.axes.y && pn.axes.y.title ? html` <span class="faint">· y: ${pn.axes.y.title}</span>` : null}</div>${one(pn)}</div>`)}</div>`;
}

/** Figures and tables a paragraph mentions (for side-by-side checking). */
export function referencedItems(p, b) {
  const t = blockPlain(p, b);
  const out = [];
  for (const m of t.matchAll(/\b(fig(?:ure)?s?\.?|tab(?:le)?s?\.?)\s*~?\s*(\d+|[IVXL]+)/gi)) {
    const isFig = /^fig/i.test(m[1]);
    const it = (isFig ? p.figures : p.tables).find(x => String(x.num) === m[2]);
    if (it && !out.some(o => o.item === it)) out.push({ kind: isFig ? 'figure' : 'table', item: it });
  }
  return out;
}
export function RefItem({ p, r }) {
  if (r.kind === 'table') return html`<div class="ref-item"><div class="ref-h">${Icon('table')} <b>${r.item.label}</b> <span class="faint small">${(r.item.caption || '').slice(0, 120)}</span></div><${TableGrid} grid=${r.item.grid} max=${16} /></div>`;
  const f = r.item;
  return html`<div class="ref-item"><div class="ref-h">${Icon('image')} <b>${f.label}</b> <span class="faint small">${(f.caption || '').slice(0, 120)}</span></div><${FigureImage} p=${p} f=${f} />${f.data && f.data.series && f.data.series.length ? html`<details class="mini-det"><summary>Data read from the figure (${f.data.source})</summary><${DataTable} data=${f.data} /></details>` : null}</div>`;
}
export { esc, Spinner };
