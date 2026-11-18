/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Research Studio — app entry: shell, routes, dashboard, invitations. */
import { html, render, useState, useEffect, useRoute, navigate, api, me, loadMe, Toasts, ModalHost, Icon, Avatar, Ring, ago, fmtDay, plural, toast, toastError, Spinner, Empty, Bar, promptDialog, confirmDialog } from './lib.js';

const lazy = {
  newPage: () => import('./new.js'),
  project: () => import('./project.js'),
  reader: () => import('./reader.js'),
};

export const SUITE = [
  { key: 'studio', name: 'Proof Room', href: '/app', desc: 'Proofread together, paragraph by paragraph', color: 'linear-gradient(135deg,#3346c8,#7a4dff)', icon: 'book' },
];

function ThemeButton() {
  const flip = () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('studio-theme', next); } catch { /* blocked */ }
  };
  return html`<button class="btn btn-ghost btn-icon" onClick=${flip} title="Light / dark" aria-label="Switch light or dark theme">${Icon('moon')}</button>`;
}
function Pop({ button, children, cls = '' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = e => { if (!e.target.closest || !e.target.closest('.menu.open')) setOpen(false); };
    const key = e => e.key === 'Escape' && setOpen(false);
    setTimeout(() => document.addEventListener('click', close), 0);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return html`<div class=${`menu ${open ? 'open' : ''}`}>${button(() => setOpen(o => !o), open)}${open ? html`<div class=${`menu-pop ${cls}`} onClick=${e => e.target.closest('a') && setOpen(false)}>${children}</div>` : null}</div>`;
}
export function Topbar({ active }) {
  const u = me.user || {};
  return html`<header class="topbar"><div class="wrap">
    <div class="row" style="gap:18px">
      <a class="logo" href="/app"><span class="logo-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/></svg></span><span>Research Studio</span></a>
      <nav class="nav">
        <a href="/app" class=${active === 'home' ? 'on' : ''}>${Icon('layers')}<span>Manuscripts</span></a>
        <a href="/app/new" class=${active === 'new' ? 'on' : ''}>${Icon('plus')}<span>New</span></a>
      </nav>
    </div>
    <div class="top-right">
      ${SUITE.length > 1 ? html`<${Pop} cls="suite" button=${(t, o) => html`<button class=${`btn btn-ghost btn-icon ${o ? 'on' : ''}`} onClick=${t} title="Research Studio tools" aria-label="Research Studio tools">${Icon('grid')}</button>`}>
        ${SUITE.map(s => html`<a href=${s.href} class=${s.key === 'studio' ? 'cur' : ''} target=${s.key === 'studio' ? null : '_blank'} rel="noopener"><b><span class="s-ic" style=${`background:${s.color}`}>${Icon(s.icon)}</span>${s.name}${s.key !== 'studio' ? Icon('external', 'faint') : null}</b><span>${s.desc}</span></a>`)}
      </${Pop}>` : null}
      <${ThemeButton} />
      <${Pop} button=${t => html`<button class="avatar-btn" onClick=${t} aria-label="Account menu" style="border:0;background:none;padding:0;cursor:pointer"><${Avatar} name=${u.name} sub=${u.sub} size=${34} /></button>`}>
        <div class="who"><b>${u.name}</b><span>${u.email}</span></div>
        ${me.account ? html`<a href=${me.account} target="_blank" rel="noopener">${Icon('user')} ${me.accountLabel || 'Account'}</a>` : null}
        <a href="/" >${Icon('layout')} About Research Studio</a>
        <div class="sep"></div>
        <a href="/sso/logout" data-native>${Icon('logout')} Sign out</a>
      </${Pop}>
    </div>
  </div></header>`;
}

// ── Dashboard ──────────────────────────────────────────────
function Dashboard() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/api/projects').then(setD, setErr);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  const accept = async inv => {
    try { const r = await api(`/api/projects/${inv.pid}`).catch(() => null); if (r) return navigate(`/app/p/${inv.pid}`); } catch { /* not a member yet */ }
    toast('Open the invitation link from your email to join.', 'info');
  };
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return html`<${Topbar} active="home" /><main class="wrap page">
    <div class="page-head">
      <div><div class="eyebrow">${Icon('book')} Proof Room</div><h1>${greet}, ${(me.user.name || '').split(' ')[0]}.</h1><p class="muted">Upload a finished manuscript, invite proofreaders, and fix it together — one paragraph at a time.</p></div>
      <a class="btn btn-primary btn-lg" href="/app/new">${Icon('upload')} Upload a manuscript</a>
    </div>
    ${err ? html`<div class="card pad">${err.message}</div>` : !d ? html`<div class="card pad center"><${Spinner} /></div>` : html`
      ${d.invites.length ? html`<section class="sect"><h2 class="sect-h">Invitations for you</h2><div class="inv-list">${d.invites.map(i => html`<div class="card inv"><div>${Icon('mail')}</div><div class="grow"><b>${i.title}</b><div class="muted small">${i.from} invited you as ${i.role} · expires ${ago(i.expires).replace(' ago', '')}</div></div><button class="btn btn-ghost btn-sm" onClick=${() => accept(i)}>How to join</button></div>`)}</div></section>` : null}
      ${d.shared.length ? html`<section class="sect"><h2 class="sect-h">Shared with you <span class="count">${d.shared.length}</span></h2><div class="cards">${d.shared.map(x => html`<${ProjectCard} x=${x} key=${x.id} onChange=${load} />`)}</div></section>` : null}
      <section class="sect"><h2 class="sect-h">Your manuscripts <span class="count">${d.mine.length}</span></h2>
        ${d.mine.length ? html`<div class="cards">${d.mine.map(x => html`<${ProjectCard} x=${x} key=${x.id} onChange=${load} />`)}</div>` : html`<div class="card"><${Empty} icon="upload" title="No manuscripts yet">Upload a PDF or a LaTeX project (.tex, .zip with figures and .bib). You’ll see every paragraph, invite readers, and get AI and consistency checks.<div style="margin-top:16px"><a class="btn btn-primary" href="/app/new">${Icon('upload')} Upload a manuscript</a></div></${Empty}></div>`}
      </section>
      ${SUITE.length > 1 ? html`<section class="sect"><h2 class="sect-h">The studio</h2><div class="suite-row">${SUITE.slice(1).map(s => html`<a class="card suite-card" href=${s.href} target="_blank" rel="noopener"><span class="s-ic" style=${`background:${s.color}`}>${Icon(s.icon)}</span><div><b>${s.name} ${Icon('external', 'faint')}</b><span class="muted small">${s.desc}</span></div></a>`)}</div></section>` : null}
    `}
  </main>`;
}
/** Delete (owner) or leave (reader) a manuscript; true when something changed. */
export async function removeProject(x) {
  if (x.role === 'owner') {
    const t = await promptDialog({ title: `Delete “${x.title.length > 60 ? `${x.title.slice(0, 60)}…` : x.title}”?`, body: 'This permanently deletes the manuscript, all suggestions, history and files for everyone, and cannot be undone. Type DELETE to confirm.', ok: 'Delete forever', placeholder: 'DELETE' });
    if (t !== 'DELETE') { if (t !== null) toast('Not deleted — type DELETE to confirm.', 'info'); return false; }
    try { await api(`/api/projects/${x.id}`, { method: 'DELETE' }); toast('Manuscript deleted', 'ok'); return true; } catch (e) { toastError(e); return false; }
  }
  if (!(await confirmDialog({ title: 'Leave this manuscript?', body: `You lose access to “${x.title}”. Your suggestions and comments stay with the owner. You can only come back with a new invitation.`, ok: 'Leave', danger: true }))) return false;
  try { await api(`/api/projects/${x.id}/leave`, { method: 'POST', body: {} }); toast('You left the manuscript', 'ok'); return true; } catch (e) { toastError(e); return false; }
}
function ProjectCard({ x, onChange }) {
  const total = x.stats.blocks || 1;
  const readers = x.readers || [];
  const avg = readers.length ? readers.reduce((n, r) => n + r.read, 0) / readers.length / total : 0;
  const mine = x.role !== 'owner' ? x.mine.read / total : avg;
  const stop = fn => e => { e.preventDefault(); e.stopPropagation(); fn(); };
  return html`<div class="pcard-box"><div class="pcard-menu"><${Pop} cls="right" button=${(t, o) => html`<button class=${`btn btn-text btn-icon btn-sm ${o ? 'on' : ''}`} aria-label="Manuscript actions" title="More" onClick=${stop(t)}>${Icon('dots')}</button>`}>
      <a href=${`/app/p/${x.id}`}>${Icon('book')} Open</a>
      ${x.role === 'owner' ? html`<a href=${`/app/p/${x.id}/settings`}>${Icon('settings')} Settings</a>` : null}
      <div class="sep"></div>
      <button class="danger-item" onClick=${stop(async () => { document.body.click(); if (await removeProject(x)) onChange && onChange(); })}>${Icon(x.role === 'owner' ? 'trash' : 'logout')} ${x.role === 'owner' ? 'Delete…' : 'Leave'}</button>
    </${Pop}></div><a class="card pcard" href=${`/app/p/${x.id}`}>
    <div class="pcard-top"><span class=${`chip ${x.role === 'owner' ? 'c-brand' : x.role === 'editor' ? 'c-ai' : 'c-sug'}`}>${x.role}</span><span class="chip">${x.kind === 'latex' ? 'LaTeX' : 'PDF'}${x.pages ? ` · ${x.pages} p.` : ''}</span>${x.job ? html`<span class="chip c-ai"><${Spinner} small /> checking</span>` : null}</div>
    <h3>${x.title}</h3>
    <div class="muted small">${x.role === 'owner' ? `Updated ${ago(x.updated)}` : `By ${x.owner} · updated ${ago(x.updated)}`}${x.deadline ? html` · <span class="nowrap">due ${fmtDay(x.deadline)}</span>` : null}</div>
    <div class="pcard-stats">
      <div class="row"><${Ring} value=${mine} size=${40} stroke=${4} label=${`${Math.round(mine * 100)}%`} /><div class="small"><b>${x.role === 'owner' ? 'Readers' : 'Your reading'}</b><div class="muted">${x.role === 'owner' ? (readers.length ? `${readers.filter(r => r.done).length}/${readers.length} finished` : 'nobody invited yet') : `${x.mine.read} of ${total}`}</div></div></div>
      <div class="pstat"><b>${x.stats.open}</b><span>open</span></div><div class="pstat"><b>${x.stats.changed}</b><span>changed</span></div>
    </div>
    ${x.role === 'owner' && readers.length ? html`<div class="avatars">${readers.slice(0, 6).map(r => html`<${Avatar} name=${r.name} size=${24} ring=${r.done} title=${`${r.name}: ${r.read}/${total}${r.done ? ' — finished' : ''}`} />`)}</div>` : null}
  </a></div>`;
}

// ── Invitation page ───────────────────────────────────────
function InvitePage({ token }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/invite/${token}`).then(setInfo, setErr); }, [token]);
  const accept = async () => {
    setBusy(true);
    try { const r = await api(`/api/invite/${token}/accept`, { method: 'POST', body: {} }); toast('Welcome to the Proof Room!', 'ok'); navigate(`/app/p/${r.pid}`); }
    catch (e) { setErr(e); setBusy(false); }
  };
  return html`<${Topbar} /><main class="wrap page narrow">
    ${err && !info ? html`<div class="card pad-lg center"><div class="big-ic bad">${Icon('alert')}</div><h1 class="serif">This invitation can’t be used</h1><p class="muted">${err.message}</p><a class="btn btn-ghost" href="/app">Go to your manuscripts</a></div>` : !info ? html`<div class="card pad center"><${Spinner} /></div>` : html`
    <div class="card invite-card">
      <div class="eyebrow">${Icon('mail')} Invitation</div>
      <h1 class="serif">${info.title}</h1>
      <p class="lead"><b>${info.from}</b> invited you to proofread this manuscript as ${info.role === 'editor' ? html`an <b>editor</b> — you can also apply changes` : html`a <b>proofreader</b>`}.</p>
      <div class="facts"><span>${Icon('doc')} ${plural(info.blocks, 'paragraph')}${info.pages ? ` · ${info.pages} pages` : ''}</span>${info.deadline ? html`<span>${Icon('clock')} due ${fmtDay(info.deadline)}</span>` : null}${info.checks ? html`<span>${Icon('target')} short reading checks</span>` : null}<span>${Icon('shield')} private, invitation only</span></div>
      ${info.message ? html`<div class="note-box"><b>Message from ${info.from}</b><p>${info.message}</p></div>` : null}
      ${info.instructions ? html`<div class="note-box"><b>Instructions</b><p>${info.instructions}</p></div>` : null}
      ${info.member ? html`<a class="btn btn-primary btn-lg" href=${`/app/p/${info.pid}`}>Open the manuscript ${Icon('arrowR')}</a>` :
        info.status !== 'pending' ? html`<div class="warn-box">${info.status === 'expired' ? 'This invitation has expired.' : info.status === 'revoked' ? 'This invitation was withdrawn.' : 'This invitation was already used.'} Ask ${info.from} for a new one.</div>` :
        !info.emailOk ? html`<div class="warn-box">This invitation is for <b>${info.email}</b>, but you are signed in as <b>${info.signedInAs}</b>. Sign out, then sign in or create an account with ${info.email}.<div style="margin-top:12px" class="row-wrap"><a class="btn btn-dark btn-sm" href="/sso/logout">Sign out</a></div></div>` :
        html`<button class="btn btn-primary btn-lg" disabled=${busy} onClick=${accept}>${busy ? html`<${Spinner} small />` : Icon('check')} Join and start reading</button>`}
      ${err && info ? html`<p class="bad-text">${err.message}</p>` : null}
      <p class="muted tiny" style="margin-top:18px">You read one paragraph at a time, suggest corrections and leave comments. Your suggestions are visible to the owner${info.role === 'editor' ? ' and editors' : ''}.</p>
    </div>`}
  </main>`;
}

// ── App ────────────────────────────────────────────────────
function useLazy(loader) {
  const [mod, setMod] = useState(null);
  useEffect(() => { let ok = true; loader().then(m => ok && setMod(m), e => toastError(e)); return () => { ok = false; }; }, [loader]);
  return mod;
}
function Lazy({ load, name, props }) {
  const mod = useLazy(load);
  if (!mod) return html`<${Topbar} /><main class="wrap page"><div class="card pad center"><${Spinner} /></div></main>`;
  const C = mod[name];
  return html`<${C} ...${props} />`;
}
function App() {
  const { path } = useRoute();
  const [ready, setReady] = useState(!!me.user);
  useEffect(() => { if (!ready) loadMe().then(() => setReady(true), () => {}); }, []);
  if (!ready) return html`<div class="boot"><${Spinner} /></div>`;
  let m;
  let page;
  if (path === '/app' || path === '/app/') page = html`<${Dashboard} />`;
  else if (path === '/app/new') page = html`<${Lazy} load=${lazy.newPage} name="NewPage" props=${{}} />`;
  else if ((m = path.match(/^\/app\/invite\/([A-Za-z0-9_-]+)$/))) page = html`<${InvitePage} token=${m[1]} />`;
  else if ((m = path.match(/^\/app\/p\/([a-z0-9]+)\/read(?:\/([A-Za-z0-9_-]+))?$/))) page = html`<${Lazy} load=${lazy.reader} name="Reader" props=${{ id: m[1], bid: m[2] || null, key: m[1] }} />`;
  else if ((m = path.match(/^\/app\/p\/([a-z0-9]+)(?:\/([a-z-]+))?(?:\/([A-Za-z0-9_-]+))?$/))) page = html`<${Lazy} load=${lazy.project} name="Project" props=${{ id: m[1], tab: m[2] || 'overview', arg: m[3] || null, key: m[1] }} />`;
  else page = html`<${Topbar} /><main class="wrap page"><${Empty} title="Page not found"><a href="/app">Back to your manuscripts</a></${Empty}></main>`;
  return html`${page}<${Toasts} /><${ModalHost} />`;
}
render(html`<${App} />`, document.getElementById('app'));
