/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Project workspace: header, tabs, overview, people, settings, history, export. */
import { html, useState, useEffect, useMemo, api, getStore, useStore, navigate, useRoute, Icon, Avatar, Ring, Bar, Spinner, Empty, ago, fmtDate, fmtDay, fmtMin, plural, toast, toastError, confirmDialog, promptDialog, copyText, Diff, useKeys, me, openModal } from './lib.js';
import { Topbar } from './app.js';
import { blockLabel } from './blocks.js';

const lazyTabs = { manuscript: () => import('./manuscript.js'), suggestions: () => import('./manuscript.js'), checks: () => import('./checks.js'), evidence: () => import('./checks.js'), figures: () => import('./checks.js'), source: () => import('./source.js'), files: () => import('./source.js') };

export function Project({ id, tab, arg }) {
  const store = getStore(id);
  const p = useStore(store);
  const { query } = useRoute();
  if (store.error) return html`<${Topbar} /><main class="wrap page"><div class="card pad-lg center"><h2 class="serif">Can’t open this manuscript</h2><p class="muted">${store.error.message}</p><a class="btn btn-ghost" href="/app">Back to your manuscripts</a></div></main>`;
  if (!p) return html`<${Topbar} /><main class="wrap page"><div class="card pad center"><${Spinner} /></div></main>`;
  const decide = p.canDecide, owner = p.role === 'owner';
  const tabs = [
    ['overview', 'Overview', 'layout'], ['manuscript', 'Manuscript', 'doc'], ['suggestions', decide ? 'Suggestions' : 'My notes', 'comment'],
    ...(decide ? [['checks', 'Checks', 'target'], ['evidence', 'Evidence', 'graph']] : []), ['figures', 'Figures & tables', 'chart'],
    ...(p.source.kind === 'latex' ? [['source', 'LaTeX source', 'doc']] : []), ...(decide ? [['history', 'History', 'history']] : []), ...(owner ? [['people', 'People', 'users']] : []), ['files', 'Files', 'lock'], ['export', 'Export', 'download'], ...(owner ? [['settings', 'Settings', 'settings']] : []),
  ];
  const job = p.ai.job && p.ai.job.status === 'running' ? p.ai.job : null;
  const open = p.suggestions.filter(s => s.status === 'open' && s.kind === 'edit').length;
  const issues = (p.lint && p.lint.issues || []).filter(i => i.sev !== 'info').length;
  const others = (p.presence || []).filter(x => x.sub !== p.me.sub);
  return html`<${Topbar} /><main class="wrap page project">
    <div class="p-head">
      <div class="grow">
        <div class="eyebrow">${Icon('book')} ${p.source.kind === 'latex' ? 'LaTeX manuscript' : 'PDF manuscript'} · <span class=${`role r-${p.role}`}>${p.role}</span>${store.live ? html`<span class="live" title="Live updates"><i></i>live</span>` : null}</div>
        <h1>${p.title}</h1>
      </div>
      <div class="p-head-r">
        <div class="pres">${others.slice(0, 6).map(x => html`<${Avatar} name=${x.name} sub=${x.sub} size=${30} ring title=${`${x.name} is here${x.bid && p.blockById.get(x.bid) ? ` — reading ${blockLabel(p, p.blockById.get(x.bid))}` : ''}`} />`)}</div>
        <a class="btn btn-primary" href=${`/app/p/${p.id}/read`}>${Icon('book')} ${myProgress(p).read ? 'Continue reading' : 'Start reading'}</a>
      </div>
    </div>
    <nav class="tabs" role="tablist">${tabs.map(([k, l, ic]) => html`<a role="tab" href=${`/app/p/${p.id}${k === 'overview' ? '' : '/' + k}`} class=${tab === k ? 'on' : ''}>${Icon(ic)}<span>${l}</span>${k === 'suggestions' && open && decide ? html`<em>${open}</em>` : k === 'checks' && issues ? html`<em class="w">${issues}</em>` : null}</a>`)}</nav>
    ${job ? html`<div class="job-bar card"><${Spinner} small /><div class="grow"><b>${job.label || 'Checking'}</b> <span class="muted small">${job.total ? `${job.done || 0} / ${job.total}` : ''}</span><${Bar} value=${job.total ? (job.done || 0) / job.total : 0.05} /></div>${decide ? html`<button class="btn btn-text btn-sm" onClick=${() => api(`/api/projects/${p.id}/ai/cancel`, { method: 'POST', body: {} })}>Stop</button>` : null}</div>` : null}
    ${query.get('welcome') ? html`<${Welcome} p=${p} />` : null}
    <div class="tab-body">${tabBody(p, store, tab, arg)}</div>
  </main>`;
}
function tabBody(p, store, tab, arg) {
  if (tab === 'overview') return html`<${Overview} p=${p} />`;
  if (tab === 'people') return html`<${People} p=${p} />`;
  if (tab === 'settings') return html`<${Settings} p=${p} />`;
  if (tab === 'history') return html`<${History} p=${p} />`;
  if (tab === 'export') return html`<${Export} p=${p} />`;
  if (lazyTabs[tab]) return html`<${LazyTab} load=${lazyTabs[tab]} name=${{ manuscript: 'Manuscript', suggestions: 'Suggestions', checks: 'Checks', evidence: 'Evidence', figures: 'Figures', source: 'Source', files: 'Files' }[tab]} p=${p} arg=${arg} />`;
  return html`<${Empty} title="Unknown tab" />`;
}
function LazyTab({ load, name, p, arg }) {
  const [m, setM] = useState(null);
  useEffect(() => { load().then(setM, toastError); }, [load]);
  if (!m) return html`<div class="card pad center"><${Spinner} /></div>`;
  const C = m[name];
  return html`<${C} p=${p} arg=${arg} />`;
}
const myProgress = p => { const x = (p.progress || {})[p.me.sub]; return { read: x ? Object.keys(x.read || {}).length : 0, done: !!(x && x.done) }; };

function Welcome({ p }) {
  return html`<div class="welcome card"><div class="big-ic ok">${Icon('check')}</div><div class="grow"><h3>Your Proof Room is ready</h3><p class="muted">Next: invite your co-authors or colleagues. They’ll get an email, sign in with Rykhet, and read paragraph by paragraph. Meanwhile the automatic checks run in the background.</p></div><div class="row-wrap"><a class="btn btn-primary" href=${`/app/p/${p.id}/people`}>${Icon('users')} Invite proofreaders</a><a class="btn btn-ghost" href=${`/app/p/${p.id}/read`}>Read it yourself</a></div></div>`;
}

// ── Overview ───────────────────────────────────────────────
/** A reader's reading quality: score chip, with the evidence in its tooltip and beside it. */
function ReadingQuality({ q }) {
  if (!q) return html`<span class="faint">—</span>`;
  const cls = q.verdict === 'careful' ? 'c-ok' : q.verdict === 'mixed' ? 'c-warn' : 'c-bad';
  const label = q.verdict === 'careful' ? 'Careful' : q.verdict === 'mixed' ? 'Mixed' : 'Skimming';
  const tip = [`${q.paragraphs} paragraphs read`, q.wpm ? `median pace ${q.wpm} words/min` : null, `${q.fast} faster than 500 words/min`, `${q.unseen} with the end never on screen`, `left the tab ${q.away} times`].filter(Boolean).join(' · ');
  return html`<span class="rq" title=${tip}><span class=${`chip ${cls}`}>${label} ${q.score}</span>${q.fast ? html`<small>${q.fast} fast</small>` : null}${q.wpm ? html`<small>${q.wpm} wpm</small>` : null}</span>`;
}

function Overview({ p }) {
  const st = p.stats;
  const readers = p.members.filter(m => m.role !== 'owner' && m.status === 'active');
  const total = p.reading.length;
  const lint = p.lint ? p.lint.issues : [];
  const aiIssues = Object.values(p.ai.review || {}).reduce((n, r) => n + r.issues.length, 0);
  const ev = p.evidence;
  const mism = ev ? ev.claims.filter(c => ['mismatch', 'partly'].includes(c.override || c.verdict)).length : 0;
  const rc = p.refcheck && p.refcheck.summary;
  const mine = myProgress(p);
  const decide = p.canDecide;
  return html`<div class="ov-grid">
    <div class="col">
      ${!decide ? html`<div class="card pad"><h3 class="card-h">Your reading</h3><div class="row"><${Ring} value=${mine.read / total} size=${64} stroke=${6} label=${`${Math.round(mine.read / total * 100)}%`} /><div class="grow"><b>${mine.read} of ${total}</b> blocks read${mine.done ? html` · <span class="ok-text">finished</span>` : ''}<div class="muted small">${p.settings.deadline ? `Target date ${fmdDaySafe(p.settings.deadline)}` : 'No deadline set'}</div></div><a class="btn btn-primary" href=${`/app/p/${p.id}/read`}>${mine.read ? 'Continue' : 'Start'} ${Icon('arrowR')}</a></div>${p.settings.instructions ? html`<div class="note-box"><b>From the owner</b><p>${p.settings.instructions}</p></div>` : null}</div>` : null}
      <div class="stat-grid big">
        <div class="stat"><b>${total}</b><span>blocks · ${st.words.toLocaleString()} words</span></div>
        <div class="stat"><b>${st.open}</b><span>open suggestions</span></div>
        <div class="stat"><b>${st.comments}</b><span>open comments</span></div>
        <div class="stat"><b>${st.changed}</b><span>paragraphs changed</span></div>
      </div>
      ${decide ? html`<div class="card pad">
        <div class="row"><h3 class="card-h grow">Proofreaders</h3>${p.role === 'owner' ? html`<a class="btn btn-ghost btn-sm" href=${`/app/p/${p.id}/people`}>${Icon('plus')} Invite</a>` : null}</div>
        ${readers.length ? html`<table class="readers"><thead><tr><th>Reader</th><th>Progress</th><th title="Share of reading checks passed">Checks</th><th title="How carefully they read: pace, whether each paragraph's end was on screen, tab switches and checks passed">Reading</th><th>Time</th><th>Notes</th><th>Active</th></tr></thead><tbody>
          ${readers.map(m => { const pr = m.progress || { read: 0, total, checks: { asked: 0, passed: 0 }, fast: 0, time: 0 }; const notes = p.suggestions.filter(s => s.by === m.sub).length; const rate = pr.checks.asked ? pr.checks.passed / pr.checks.asked : null; return html`<tr>
            <td><div class="row"><${Avatar} name=${m.name} sub=${m.sub} size=${28} /><div><b>${m.name}</b><div class="faint tiny">${m.role}</div></div></div></td>
            <td style="min-width:140px"><div class="row"><${Bar} value=${pr.read / total} cls=${pr.done ? 'ok' : ''} /><span class="tiny nowrap">${pr.read}/${total}</span></div></td>
            <td>${rate == null ? html`<span class="faint">—</span>` : html`<span class=${`chip ${rate >= 0.8 ? 'c-ok' : rate >= 0.5 ? 'c-warn' : 'c-bad'}`}>${pr.checks.passed}/${pr.checks.asked}</span>`}</td>
            <td><${ReadingQuality} q=${pr.quality} /></td>
            <td class="nowrap">${fmtMin(pr.time)}</td><td>${notes}</td><td class="faint small nowrap">${pr.last ? ago(pr.last) : 'not started'}</td></tr>`; })}
        </tbody></table>` : html`<${Empty} icon="users" title="No proofreaders yet">${p.role === 'owner' ? html`Invite people by email from the <a href=${`/app/p/${p.id}/people`}>People</a> tab.` : 'The owner has not invited anyone yet.'}</${Empty}>`}
      </div>` : null}
      ${decide ? html`<${Activity} p=${p} />` : null}
    </div>
    <div class="col">
      ${decide ? html`<div class="card pad"><h3 class="card-h">Findings</h3>
        <a class="finding" href=${`/app/p/${p.id}/checks`}><span class="f-ic warn">${Icon('target')}</span><div class="grow"><b>Consistency checks</b><span>${lint.filter(i => i.sev === 'error').length} errors, ${lint.filter(i => i.sev === 'warn').length} warnings, ${lint.filter(i => i.sev === 'info').length} notes</span></div>${Icon('chevR')}</a>
        ${p.ai.enabled ? html`<a class="finding" href=${`/app/p/${p.id}/checks?f=ai`}><span class="f-ic ai">${Icon('sparkle')}</span><div class="grow"><b>AI proofreading</b><span>${Object.keys(p.ai.review || {}).length ? `${aiIssues} suggestions in ${Object.keys(p.ai.review).length} blocks` : 'not run yet'}</span></div>${Icon('chevR')}</a>` : null}
        <a class="finding" href=${`/app/p/${p.id}/evidence`}><span class="f-ic bad">${Icon('graph')}</span><div class="grow"><b>Numbers vs. tables & figures</b><span>${ev ? `${ev.claims.length} claims · ${mism} mismatch${mism === 1 ? '' : 'es'} · ${ev.consistency.length} inconsistent` : 'not run yet'}</span></div>${Icon('chevR')}</a>
        <a class="finding" href=${`/app/p/${p.id}/checks?f=refs`}><span class="f-ic info">${Icon('check')}</span><div class="grow"><b>References (RefCheck)</b><span>${p.refs.length ? (rc ? `${rc.verified || 0} verified · ${(rc.problem || 0) + (rc.notfound || 0) + (rc.retracted || 0)} problems of ${rc.total}` : p.refcheck ? 'checking…' : `${p.refs.length} references, not checked yet`) : 'no reference list found'}</span></div>${Icon('chevR')}</a>
        <${PrecheckButton} p=${p} />
      </div>` : null}
      <div class="card pad"><h3 class="card-h">Manuscript</h3>
        <dl class="facts-dl"><dt>Source</dt><dd>${p.source.filename || '—'}${p.source.canDownload && p.source.uploaded ? html` · <a href=${`/api/projects/${p.id}/files/${p.source.kind === 'pdf' ? 'source.pdf' : 'source.zip'}?dl=1`}>download</a>` : ''}</dd>
        <dt>Pages</dt><dd>${p.source.pages.length || '—'}</dd><dt>Sections</dt><dd>${p.sections.length}</dd><dt>Figures</dt><dd>${p.figures.length}</dd><dt>Tables</dt><dd>${p.tables.length}</dd><dt>References</dt><dd>${p.refs.length}</dd><dt>Owner</dt><dd>${(p.members.find(m => m.role === 'owner') || {}).name}</dd><dt>Created</dt><dd>${fmtDate(p.created)}</dd>
        ${p.settings.deadline ? html`<dt>Target date</dt><dd>${fmdDaySafe(p.settings.deadline)}</dd>` : null}</dl>
        ${(p.source.notes || []).length ? html`<ul class="notes small">${p.source.notes.map(n => html`<li>${Icon('info')} ${n}</li>`)}</ul>` : null}
      </div>
      <div class="card pad security"><h3 class="card-h">${Icon('shield')} Access</h3><ul class="plain small">
        <li>${Icon('lock')} Encrypted at rest; invitation-only, bound to each invitee’s email.</li>
        <li>${Icon(p.settings.allowDownload ? 'download' : 'eyeOff')} ${p.settings.allowDownload ? 'Readers may download the original file.' : 'Readers see page images only — no download of the original.'}</li>
        <li>${Icon(p.settings.watermark ? 'shield' : 'eye')} ${p.settings.watermark ? 'Pages are watermarked with each reader’s email.' : 'No watermark.'}</li>
        <li>${Icon(p.settings.blind ? 'eyeOff' : 'users')} ${p.settings.blind ? 'Independent review: readers don’t see each other’s notes.' : 'Readers see each other’s suggestions.'}</li>
      </ul></div>
    </div>
  </div>`;
}
const fmdDaySafe = d => fmtDay(d);
export function PrecheckButton({ p }) {
  const [busy, setBusy] = useState(false);
  const job = p.ai.job;
  const running = job && job.status === 'running';
  const run = async () => { setBusy(true); try { await api(`/api/projects/${p.id}/ai/precheck`, { method: 'POST', body: {} }); toast('Full check started — results appear as they come in.', 'ok'); } catch (e) { toastError(e); } setBusy(false); };
  return html`<div class="precheck">${running ? html`<span class="muted small"><${Spinner} small /> ${job.label}…</span>` : html`<button class="btn btn-ai" disabled=${busy || !(p.ai.checks ?? p.ai.enabled)} onClick=${run}>${Icon('sparkle')} ${job && job.finished ? 'Run the full check again' : 'Run the full check'}</button>`}${job && job.finished && !running ? html`<span class="faint tiny">Last run ${ago(job.finished)}${job.status === 'error' ? ` — ${job.error}` : ''}</span>` : null}</div>`;
}

function Activity({ p }) {
  const [list, setList] = useState(null);
  useEffect(() => { if (p.role === 'owner') api(`/api/projects/${p.id}/activity`).then(r => setList(r.activity), () => setList([])); }, [p.rev]);
  if (p.role !== 'owner') return null;
  const label = { created: 'uploaded the manuscript', opened: 'opened it', suggested: 'suggested an edit', commented: 'commented', accepted: 'accepted a suggestion', rejected: 'rejected a suggestion', edited: 'edited a paragraph', undo: 'undid a change', restored: 'restored a version', invited: 'invited', joined: 'joined as', finished: 'finished reading', settings: 'changed the settings', precheck: 'ran the full check', export: 'exported', download: 'downloaded the original', reminded: 'sent a reminder to', 'access-revoked': 'removed access for', role: 'changed a role:', milestone: 'saved milestone', 'invite-revoked': 'withdrew the invitation for', 'figure-data': 'edited figure data:', 'table-data': 'edited table data:', import: 'merged a new version —', rexp: 'checked the authors’ retraction exposure —', left: 'left the manuscript', reread: 'read the manuscript again', 'latex-share': 'sent the project to Rykhet LaTeX', 'compiled-pdf': 'added a compiled PDF:' };
  return html`<div class="card pad"><h3 class="card-h">Activity</h3>${!list ? html`<${Spinner} small />` : !list.length ? html`<p class="faint small">Nothing yet.</p>` : html`<ul class="activity">${list.slice(0, 40).map(a => html`<li><${Avatar} name=${a.name} sub=${a.by} size=${22} /><div class="grow"><b>${a.name}</b> ${label[a.kind] || a.kind} ${a.detail ? html`<span class="muted">${a.detail}</span>` : ''}${a.bid && p.blockById.get(a.bid) ? html` <a href=${`/app/p/${p.id}/manuscript/${a.bid}`} class="small">${blockLabel(p, p.blockById.get(a.bid))}</a>` : ''}</div><span class="faint tiny nowrap">${ago(a.at)}</span></li>`)}</ul>`}</div>`;
}

// ── People ─────────────────────────────────────────────────
function People({ p }) {
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState('proofreader');
  const [msg, setMsg] = useState('');
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const send = async () => {
    setBusy(true);
    try { const r = await api(`/api/projects/${p.id}/invites`, { method: 'POST', body: { emails, role, message: msg, days, send: true } }); setResults(r.results); setEmails(''); const ok = r.results.filter(x => x.mail === 'sent').length; if (ok) toast(`${plural(ok, 'invitation')} sent`, 'ok'); getStore(p.id).refetch(100); }
    catch (e) { toastError(e); }
    setBusy(false);
  };
  const act = async (iid, op) => {
    try { const r = await api(`/api/projects/${p.id}/invites/${iid}/${op}`, { method: 'POST', body: {} }); if (r.link) { copyText(r.link); } if (op === 'resend') toast(r.mail === 'sent' ? 'Sent again — earlier links keep working' : 'Could not send the email — a link is copied, share it yourself.', r.mail === 'sent' ? 'ok' : 'bad'); getStore(p.id).refetch(100); }
    catch (e) { toastError(e); }
  };
  const member = async (m, op, value) => {
    try {
      if (op === 'role') await api(`/api/projects/${p.id}/members/${m.sub}`, { method: 'PATCH', body: { role: value } });
      if (op === 'remove') { if (!(await confirmDialog({ title: `Remove ${m.name}?`, body: 'They lose access immediately. Their suggestions and comments stay.', ok: 'Remove access', danger: true }))) return; await api(`/api/projects/${p.id}/members/${m.sub}`, { method: 'DELETE' }); }
      if (op === 'remind') { const t = await promptDialog({ title: `Remind ${m.name}`, body: 'An email with their progress and a link back to the Proof Room.', placeholder: 'A short message (optional)', ok: 'Send reminder', multiline: true }); if (t === null) return; const r = await api(`/api/projects/${p.id}/members/${m.sub}/remind`, { method: 'POST', body: { message: t } }); toast(r.ok ? 'Reminder sent' : `Could not send: ${r.detail}`, r.ok ? 'ok' : 'bad'); }
      getStore(p.id).refetch(100);
    } catch (e) { toastError(e); }
  };
  const invites = (p.invites || []).filter(i => i.status !== 'accepted').sort((a, b) => b.created.localeCompare(a.created));
  const members = p.members.filter(m => m.role !== 'owner');
  return html`<div class="people-grid">
    <div class="card pad">
      <h3 class="card-h">${Icon('mail')} Invite proofreaders</h3>
      <label class="field"><span>Email addresses</span><textarea class="input" rows="3" placeholder="ana@university.edu, li@lab.org" value=${emails} onInput=${e => setEmails(e.target.value)}></textarea><small>Separate with commas or new lines. Each invitation works only for that address; invitees sign in, or create an account with that address.</small></label>
      <div class="row-wrap" style="margin-bottom:14px"><div class="seg">${[['proofreader', 'Proofreader'], ['editor', 'Editor']].map(([k, l]) => html`<button class=${role === k ? 'on' : ''} onClick=${() => setRole(k)}>${l}</button>`)}</div><span class="faint small">${role === 'editor' ? 'Can also accept suggestions and edit the text.' : 'Reads, suggests and comments.'}</span></div>
      <label class="field"><span>Personal message (optional)</span><textarea class="input" rows="3" placeholder="Thanks for helping! Please focus on Sections 3–5." value=${msg} onInput=${e => setMsg(e.target.value)}></textarea></label>
      <label class="field"><span>Link valid for</span><select class="input" value=${days} onChange=${e => setDays(+e.target.value)}>${[3, 7, 14, 30, 60].map(d => html`<option value=${d}>${d} days</option>`)}</select></label>
      <button class="btn btn-primary" disabled=${busy || !emails.trim()} onClick=${send}>${busy ? html`<${Spinner} small />` : Icon('send')} Send invitations</button>
      ${results ? html`<div class="inv-results">${results.map(r => html`<div class="row">${r.error ? html`<span class="chip c-bad">skipped</span>` : r.mail === 'sent' ? html`<span class="chip c-ok">sent</span>` : html`<span class="chip c-warn">email failed</span>`}<span class="grow">${r.email}${r.error ? html` <span class="faint">— ${r.error}</span>` : ''}</span>${r.link ? html`<button class="btn btn-text btn-sm" onClick=${() => copyText(r.link)}>${Icon('copy')} Copy link</button>` : null}</div>`)}</div>` : null}
    </div>
    <div class="col">
      <div class="card pad"><h3 class="card-h">${Icon('users')} People with access</h3>
        <div class="member"><${Avatar} name=${p.members[0].name} sub=${p.owner} size=${32} /><div class="grow"><b>${p.members[0].name}</b><div class="faint small">${p.members[0].email || ''}</div></div><span class="chip c-brand">owner</span></div>
        ${members.map(m => html`<div class=${`member ${m.status !== 'active' ? 'revoked' : ''}`}><${Avatar} name=${m.name} sub=${m.sub} size=${32} /><div class="grow"><b>${m.name}</b><div class="faint small">${m.email || ''} · joined ${ago(m.joined)}${m.progress ? ` · ${m.progress.read}/${m.progress.total} read` : ''}</div></div>
          ${m.status === 'active' ? html`<select class="input sm" value=${m.role} onChange=${e => member(m, 'role', e.target.value)}><option value="proofreader">proofreader</option><option value="editor">editor</option></select><button class="btn btn-text btn-sm" title="Send a reminder" onClick=${() => member(m, 'remind')}>${Icon('mail')}</button><button class="btn btn-text btn-sm" title="Remove access" onClick=${() => member(m, 'remove')}>${Icon('x')}</button>` : html`<span class="chip c-bad">removed</span>`}</div>`)}
        ${!members.length ? html`<p class="faint small">Only you so far.</p>` : null}
      </div>
      <div class="card pad"><h3 class="card-h">${Icon('clock')} Invitations</h3>
        ${invites.length ? invites.map(i => html`<div class="member"><div class="grow"><b>${i.email}</b><div class="faint small">${i.role} · ${i.status === 'pending' ? `expires ${fmtDay(i.expires.slice(0, 10))}` : i.status} · email ${i.mail}${i.mail === 'failed' && i.mailDetail ? html` <span title=${i.mailDetail}>(why?)</span>` : ''}</div></div>
          ${i.status === 'pending' || i.status === 'expired' ? html`<button class="btn btn-text btn-sm" onClick=${() => act(i.id, 'resend')} title="Send again with a fresh link">${Icon('refresh')} Resend</button><button class="btn btn-text btn-sm" onClick=${() => act(i.id, 'link')} title="Copy a link to share yourself (earlier links keep working)">${Icon('link')} Link</button>${i.status === 'pending' ? html`<button class="btn btn-text btn-sm" onClick=${() => act(i.id, 'revoke')}>${Icon('x')}</button>` : null}` : html`<span class="chip">${i.status}</span>`}</div>`) : html`<p class="faint small">No open invitations.</p>`}
      </div>
    </div>
  </div>`;
}

// ── Settings ───────────────────────────────────────────────
function Settings({ p }) {
  const [s, setS] = useState(() => JSON.parse(JSON.stringify(p.settings)));
  const [title, setTitle] = useState(p.title);
  const [busy, setBusy] = useState(false);
  const set = (path, v) => setS(o => { const n = JSON.parse(JSON.stringify(o)); const k = path.split('.'); let x = n; while (k.length > 1) x = x[k.shift()]; x[k[0]] = v; return n; });
  const save = async () => { setBusy(true); try { await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { title, settings: s } }); toast('Settings saved', 'ok'); getStore(p.id).refetch(50); } catch (e) { toastError(e); } setBusy(false); };
  const del = async () => {
    const t = await promptDialog({ title: 'Delete this manuscript?', body: `This permanently deletes the manuscript, all suggestions, history and files for everyone, and cannot be undone. Type DELETE to confirm.`, ok: 'Delete forever', placeholder: 'DELETE' });
    if (t !== 'DELETE') { if (t !== null) toast('Not deleted — type DELETE to confirm.', 'info'); return; }
    try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); getStore(p.id).close(); toast('Deleted', 'ok'); navigate('/app'); } catch (e) { toastError(e); }
  };
  const Sw = ({ path, title: t, desc }) => { const v = path.split('.').reduce((o, k) => o[k], s); return html`<div class="opt"><div><b>${t}</b><span>${desc}</span></div><label class="switch"><input type="checkbox" checked=${v} onChange=${e => set(path, e.target.checked)} /><span></span></label></div>`; };
  return html`<div class="settings-grid">
    <div class="card pad">
      <label class="field"><span>Title</span><input class="input" value=${title} onInput=${e => setTitle(e.target.value)} /></label>
      <label class="field"><span>Instructions for readers</span><textarea class="input" rows="4" placeholder="What should they focus on? Anything to ignore?" value=${s.instructions} onInput=${e => set('instructions', e.target.value)}></textarea><small>Shown when they open the Proof Room and in the invitation.</small></label>
      <label class="field"><span>Target date</span><input class="input" type="date" value=${s.deadline || ''} onInput=${e => set('deadline', e.target.value || null)} /></label>
      <h3 class="mini-h">Reading checks</h3>
      <${Sw} path="checks.enabled" title="Ask reading checks" desc=${p.ai.enabled ? 'AI-written multiple-choice questions about the paragraph just read.' : 'Fill-in-the-blank questions made from the paragraph just read.'} />
      ${s.checks.enabled ? html`<div class="opt sub"><div><b>How often</b><span>For shorter paragraphs. Always when a paragraph is marked read faster than 500 words a minute or its end was never on screen.</span></div><div class="seg">${[['every', 'Every'], ['often', 'Often'], ['sometimes', 'Sometimes'], ['rare', 'Rarely']].map(([k, l]) => html`<button class=${s.checks.freq === k ? 'on' : ''} onClick=${() => set('checks.freq', k)}>${l}</button>`)}</div></div>
      <${Sw} path="checks.long" title="Always check long paragraphs" desc="Every paragraph of 100 words or more ends with a question." />
      <${Sw} path="checks.pace" title="Make readers read" desc="“Mark as read” unlocks only after enough active reading time (tab visible, not idle) and once the end of the paragraph has been on screen." />
      <${Sw} path="checks.requirePass" title="Require a correct answer" desc="A wrong answer sends the reader back to the paragraph (up to 3 tries)." />
      <${Sw} path="checks.owner" title="Check me too" desc="Also ask the owner when they read." />` : null}
    </div>
    <div class="col"><div class="card pad">
      <h3 class="mini-h">Collaboration</h3>
      ${p.ai.enabled ? html`<${Sw} path="ai.readers" title="AI help for readers" desc="Readers can ask the AI to proofread a paragraph, improve wording, or answer questions." />` : null}
      <${Sw} path="blind" title="Independent review" desc="Readers see only their own suggestions (editors see all)." />
      <${Sw} path="refsInReading" title="Include the reference list" desc="Readers also step through every reference." />
      <h3 class="mini-h">Security</h3>
      <${Sw} path="watermark" title="Watermark pages" desc="Each reader sees their own email over the page images." />
      <${Sw} path="allowDownload" title="Allow downloading the original" desc="Off: readers only get page images and text, not your file." />
      <div class="row" style="margin-top:16px"><button class="btn btn-primary" disabled=${busy} onClick=${save}>${Icon('check')} Save settings</button></div>
    </div>
    <div class="card pad danger"><h3 class="mini-h">Danger zone</h3><p class="small muted">Deleting removes the manuscript, its history and files for everyone.</p><button class="btn btn-danger" onClick=${del}>${Icon('trash')} Delete manuscript</button></div></div>
  </div>`;
}

// ── History ────────────────────────────────────────────────
function History({ p }) {
  const [filter, setFilter] = useState('all');
  const changes = [...p.changes].reverse().filter(c => filter === 'all' || (filter === 'mine' ? c.by === p.me.sub : c.cause === filter));
  const undo = async c => { try { await api(`/api/projects/${p.id}/changes/${c.id}/undo`, { method: 'POST', body: {} }); toast('Undone', 'ok'); } catch (e) { toastError(e); } };
  const lastMine = [...p.changes].reverse().find(c => c.by === p.me.sub && !c.undone && c.cause !== 'undo');
  useKeys({ 'mod+z': () => lastMine && undo(lastMine) }, [lastMine && lastMine.id]);
  const mile = async () => { const n = await promptDialog({ title: 'Save a milestone', body: 'A named snapshot of the whole manuscript you can return to.', placeholder: 'e.g. Before co-author round 2', ok: 'Save' }); if (n === null) return; try { await api(`/api/projects/${p.id}/milestones`, { method: 'POST', body: { name: n } }); toast('Milestone saved', 'ok'); getStore(p.id).refetch(50); } catch (e) { toastError(e); } };
  const restore = async m => { if (!(await confirmDialog({ title: `Restore “${m.name}”?`, body: 'Every paragraph returns to its text at that moment. This is recorded as new changes, so you can undo it too.', ok: 'Restore' }))) return; try { const r = await api(`/api/projects/${p.id}/milestones/${m.id}/restore`, { method: 'POST', body: {} }); toast(`${plural(r.changed, 'paragraph')} restored`, 'ok'); } catch (e) { toastError(e); } };
  const cause = { suggestion: 'Accepted suggestion', edit: 'Direct edit', ai: 'AI fix', lint: 'Consistency fix', evidence: 'Evidence fix', restore: 'Restore', undo: 'Undo' };
  return html`<div class="hist-grid">
    <div class="card pad">
      <div class="row"><h3 class="card-h grow">${Icon('history')} Change history</h3>${lastMine ? html`<button class="btn btn-ghost btn-sm" onClick=${() => undo(lastMine)} title="Ctrl+Z">${Icon('undo')} Undo my last change</button>` : null}</div>
      <div class="seg" style="margin-bottom:14px">${[['all', 'All'], ['mine', 'Mine'], ['suggestion', 'Accepted'], ['edit', 'Edits'], ...(p.ai.enabled ? [['ai', 'AI']] : []), ['undo', 'Undos']].map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
      ${changes.length ? html`<ol class="timeline">${changes.slice(0, 200).map(c => { const b = p.blockById.get(c.bid); const before = c.from === 0 ? b.text : null; return html`<li class=${c.undone ? 'undone' : ''}>
        <div class="tl-dot ${c.cause}"></div>
        <div class="grow"><div class="row-wrap"><b>${cause[c.cause] || c.cause}</b><span class="muted small">by ${c.byName} · ${ago(c.at)}</span>${c.undone ? html`<span class="chip">undone</span>` : null}${b ? html`<a class="small" href=${`/app/p/${p.id}/manuscript/${b.id}`}>${blockLabel(p, b)}</a>` : null}</div>
          ${c.note ? html`<div class="faint small">${c.note}</div>` : null}
          <${ChangeDiff} p=${p} c=${c} /></div>
        ${!c.undone ? html`<button class="btn btn-text btn-sm" onClick=${() => undo(c)} title="Undo this change">${Icon('undo')}</button>` : null}
      </li>`; })}</ol>` : html`<${Empty} icon="history" title="No changes yet">Accepted suggestions and edits appear here; each can be undone.</${Empty}>`}
    </div>
    <div class="col"><div class="card pad"><div class="row"><h3 class="card-h grow">${Icon('flag')} Milestones</h3><button class="btn btn-ghost btn-sm" onClick=${mile}>${Icon('plus')} Save</button></div>
      ${(p.milestones || []).length ? [...p.milestones].reverse().map(m => html`<div class="member"><div class="grow"><b>${m.name}</b><div class="faint small">${m.byName} · ${fmtDate(m.at)}</div></div><button class="btn btn-text btn-sm" onClick=${() => restore(m)}>${Icon('refresh')} Restore</button></div>`) : html`<p class="faint small">Save a milestone before a big round of changes.</p>`}
      <p class="faint tiny" style="margin-top:12px">The original upload is always kept. Every change records who made it and why; undoing is itself recorded.</p></div></div>
  </div>`;
}
function ChangeDiff({ p, c }) {
  const [texts, setTexts] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!open || texts) return; api(`/api/projects/${p.id}/blocks/${c.bid}/history`).then(r => { const v = n => (r.versions.find(x => x.v === n) || {}).text; setTexts([v(c.from), v(c.to)]); }, toastError); }, [open]);
  return html`<div class="tl-diff">${open ? (texts ? html`<div class="text-view small"><${Diff} a=${texts[0] || ''} b=${texts[1] || ''} compact /></div>` : html`<${Spinner} small />`) : html`<button class="btn btn-text btn-sm" onClick=${() => setOpen(true)}>Show the change</button>`}</div>`;
}

// ── Export ─────────────────────────────────────────────────
function Export({ p }) {
  const [busy, setBusy] = useState(null);
  const decide = p.canDecide;
  const dl = kind => { location.href = `/api/projects/${p.id}/export/${kind}`; };
  const annotated = async mode => { setBusy(mode); try { const m = await import('./report.js'); await m.annotatedPdf(p, mode); } catch (e) { console.error(e); toastError(e); } setBusy(null); };
  const report = async () => { const m = await import('./report.js'); m.printReport(p); };
  const [stage, setStage] = useState('');
  const run = async (key, fn) => { setBusy(key); setStage(''); try { await fn(); } catch (e) { console.error(e); toastError(e); } setBusy(null); setStage(''); };
  const reportPdf = () => run('report', async () => { const m = await import('./report.js'); await m.reportPdf(p); toast('Review report ready', 'ok'); });
  const diffPdf = () => run('diff', async () => {
    if (p.source.kind === 'latex') { const m = await import('./source.js'); const r = await m.compilePdf(p, 'diff', setStage); toast(`Diff PDF ready: ${r.marked} changed paragraph${r.marked === 1 ? '' : 's'} marked`, 'ok', 7000); }
    else { const m = await import('./report.js'); await m.diffPdf(p); toast('Diff PDF ready', 'ok'); }
  });
  // the whole revised project into Rykhet LaTeX (a share there: "Make my copy", edit, compile, "Send to Studio")
  const openLatex = () => run('latex', async () => {
    const r = await api(`/api/projects/${p.id}/latex-share`, { method: 'POST', body: {} });
    window.open(r.url, '_blank', 'noopener');
    toast('Opened in Rykhet LaTeX with the whole revised project. Choose “Make my copy”, edit and compile there, then press “Send to Studio” to review the edits here.', 'ok', 10000);
    getStore(p.id).refetch(100);
  });
  const revisedPdf = () => run('revised', async () => { const m = await import('./source.js'); await m.compilePdf(p, 'revised', setStage); toast('Revised PDF ready', 'ok'); });
  const spin = (key, ic) => (busy === key ? html`<${Spinner} small />` : ic ? Icon(ic) : null);
  const Card = ({ icon, title, desc, children, tag }) => html`<div class="card x-card"><div class="x-ic">${Icon(icon)}</div><div class="grow"><h3>${title} ${tag ? html`<span class="chip c-brand">${tag}</span>` : ''}</h3><p class="muted small">${desc}</p><div class="row-wrap">${children}</div></div></div>`;
  return html`<div class="x-grid">
    ${decide ? html`<${Card} icon="doc" title="Diff PDF" tag=${p.source.kind === 'latex' ? 'compiled on your computer' : 'PDF'} desc=${p.source.kind === 'latex' ? `Your manuscript typeset with every change marked, latexdiff style: deletions struck through in red, insertions underlined in blue. ${p.compileBridge ? 'Compiled on your computer by Rykhet LaTeX (TeX in the browser or the desktop app), never on the server.' : 'Download the marked-up project and compile it with your TeX.'}` : 'Every changed paragraph, original against current, in reading order: deletions struck through in red, insertions underlined in blue.'}>
      ${p.source.kind === 'latex' && !p.compileBridge ? html`<button class="btn btn-primary" onClick=${() => dl('diff.zip')}>${Icon('download')} Diff project (.zip)</button><span class="tiny faint">Compile it with your TeX (latexmk -pdf).</span>` : html`<button class="btn btn-primary" disabled=${!!busy} onClick=${diffPdf}>${spin('diff', 'download')} Diff PDF</button>${p.source.kind === 'latex' ? html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${revisedPdf}>${spin('revised', 'doc')} Revised PDF</button><button class="btn btn-text" onClick=${() => dl('diff.zip')}>Diff project (.zip)</button>` : null}`}
      ${stage ? html`<span class="tiny faint">${stage}</span>` : null}</${Card}>` : null}
    ${p.source.kind === 'pdf' && decide ? html`<${Card} icon="doc" title="Annotated PDF" tag="side notes" desc="Your original pages with a margin of numbered notes: applied changes, open suggestions and comments, each with its diff. Ready to work through or send to co-authors.">
      <button class="btn btn-primary" disabled=${!!busy} onClick=${() => annotated('all')}>${busy === 'all' ? html`<${Spinner} small />` : Icon('download')} Everything</button><button class="btn btn-ghost" disabled=${!!busy} onClick=${() => annotated('open')}>${busy === 'open' ? html`<${Spinner} small />` : null} Open items only</button></${Card}>` : null}
    ${p.source.kind === 'latex' && decide ? html`<${Card} icon="doc" title="Revised LaTeX project" tag="ready to compile" desc=${`The whole project: every .tex file with the accepted changes written in at their exact source positions, with the bibliography, figures and styles. ${p.latexEnabled ? 'Open it in Rykhet LaTeX to keep editing and compiling, then send it back here: the edits arrive as recorded changes and the checks run again.' : 'Download it and compile with your own TeX.'}`}>
      ${p.latexEnabled ? html`<button class="btn btn-primary" disabled=${!!busy} onClick=${openLatex}>${spin('latex', 'external')} Open in Rykhet LaTeX</button>` : null}
      <button class=${`btn ${p.latexEnabled ? 'btn-ghost' : 'btn-primary'}`} onClick=${() => dl('revised.zip')}>${Icon('download')} Project (.zip)</button>
      ${p.latexEnabled && p.latexShare ? html`<a class="btn btn-text" href=${`/app/p/${p.id}/source?pull=1`}>${Icon('download')} Bring changes back</a>` : null}</${Card}>` : null}
    <${Card} icon="layers" title="Change list" desc=${decide ? 'Every applied change, open suggestion and comment, grouped by section and paragraph, with who proposed it. Markdown keeps formatting; plain text works anywhere.' : 'Your own suggestions and comments, grouped by section.'}>
      <button class="btn btn-primary" onClick=${() => dl('changes.md')}>${Icon('download')} Markdown</button><button class="btn btn-ghost" onClick=${() => dl('changes.txt')}>Plain text</button>${decide ? html`<button class="btn btn-text" onClick=${() => dl('changes.md?rejected=1')}>With rejected</button>` : null}</${Card}>
    ${decide ? html`<${Card} icon="refresh" title="Diff" desc="Unified diff of every changed paragraph: original against current text, with section, page and source line.">
      <button class="btn btn-ghost" onClick=${() => dl('diff.txt')}>${Icon('download')} .diff</button>${p.source.kind === 'pdf' ? html`<button class="btn btn-ghost" onClick=${() => dl('revised.txt')}>Revised full text</button>` : null}</${Card}>` : null}
    ${decide ? html`<${Card} icon="chart" title="Review report" desc=${`Reading progress and integrity per reader, all findings (consistency, ${p.ai.enabled ? 'AI, ' : ''}evidence${p.refcheckEnabled ? ', references' : ''}) and every change with its diff. Made as a PDF in your browser.`}>
      <button class="btn btn-primary" disabled=${!!busy} onClick=${reportPdf}>${spin('report', 'download')} Report (PDF)</button><button class="btn btn-ghost" onClick=${report}>${Icon('doc')} Print view</button><button class="btn btn-text" onClick=${() => dl('data.json')}>All data (.json)</button></${Card}>` : null}
  </div>`;
}
