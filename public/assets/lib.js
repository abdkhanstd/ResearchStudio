/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** Research Studio — shared UI library: Preact + htm, API client, router, project store with live updates, small components. */
import { h, render, Fragment, createContext } from '/vendor/preact.module.js';
import { useState, useEffect, useRef, useMemo, useCallback, useContext, useLayoutEffect } from '/vendor/preact-hooks.module.js';
import htm from '/vendor/htm.module.js';
import * as tk from './shared/textkit.mjs';

export const html = htm.bind(h);
export { h, render, Fragment, createContext, useState, useEffect, useRef, useMemo, useCallback, useContext, useLayoutEffect, tk };

// ── API ────────────────────────────────────────────────────
export class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body || {}; } }
export async function api(path, { method = 'GET', body, raw, type, signal } = {}) {
  const headers = {};
  let payload;
  if (raw !== undefined) { payload = raw; headers['Content-Type'] = type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal });
  let j = null;
  try { j = await r.json(); } catch { j = {}; }
  if (r.status === 401) { location.href = `/sso/login?next=${encodeURIComponent(location.pathname)}`; throw new ApiError('Signed out', 401, j); }
  if (!r.ok) throw new ApiError(j.error || `Request failed (${r.status})`, r.status, j);
  return j;
}

// ── Router ─────────────────────────────────────────────────
const routeListeners = new Set();
export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  routeListeners.forEach(f => f());
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => routeListeners.forEach(f => f()));
export function useRoute() {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set(x => x + 1); routeListeners.add(f); return () => routeListeners.delete(f); }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/app')) return;
  e.preventDefault();
  navigate(href);
});

// ── Global user ────────────────────────────────────────────
export const me = { user: null, ai: false, refcheck: false };
export async function loadMe() { const j = await api('/api/me'); Object.assign(me, j); return me; }

// ── Toasts ─────────────────────────────────────────────────
const toastListeners = new Set();
let toasts = [];
export function toast(msg, kind = 'info', ms = 4200) {
  const t = { id: Math.random().toString(36).slice(2), msg, kind };
  toasts = [...toasts, t];
  toastListeners.forEach(f => f(toasts));
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); toastListeners.forEach(f => f(toasts)); }, ms);
}
export const toastError = e => toast(e && e.message ? e.message : String(e), 'bad', 6500);
export function Toasts() {
  const [list, set] = useState(toasts);
  useEffect(() => { toastListeners.add(set); return () => toastListeners.delete(set); }, []);
  return html`<div class="toasts" role="status" aria-live="polite">${list.map(t => html`<div class=${`toast t-${t.kind}`} key=${t.id}>${t.kind === 'ok' ? Icon('check') : t.kind === 'bad' ? Icon('alert') : Icon('info')}<span>${t.msg}</span></div>`)}</div>`;
}

// ── Modal / confirm ────────────────────────────────────────
let modalSet = null;
export function ModalHost() {
  const [m, set] = useState(null);
  modalSet = set;
  useEffect(() => {
    if (!m) return;
    const k = e => { if (e.key === 'Escape' && !m.locked) { e.stopPropagation(); m.onClose && m.onClose(); set(null); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [m]);
  if (!m) return null;
  return html`<div class="modal-back" onMouseDown=${e => { if (e.target === e.currentTarget && !m.locked) { m.onClose && m.onClose(); set(null); } }}>
    <div class=${`modal ${m.wide ? 'wide' : ''} ${m.cls || ''}`} role="dialog" aria-modal="true">${m.content(() => set(null))}</div></div>`;
}
export const openModal = (content, opts = {}) => modalSet && modalSet({ content, ...opts });
export const closeModal = () => modalSet && modalSet(null);
export function confirmDialog({ title, body, ok = 'Confirm', danger = false, cancel = 'Cancel' }) {
  return new Promise(res => openModal(close => html`<div class="modal-body"><h3>${title}</h3>${body ? html`<p class="muted">${body}</p>` : null}
    <div class="modal-actions"><button class="btn btn-ghost" onClick=${() => { close(); res(false); }}>${cancel}</button>
    <button class=${`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`} autofocus onClick=${() => { close(); res(true); }}>${ok}</button></div></div>`, { onClose: () => res(false) }));
}
export function promptDialog({ title, body, value = '', placeholder = '', ok = 'Save', multiline = false }) {
  return new Promise(res => openModal(close => {
    let v = value;
    return html`<form class="modal-body" onSubmit=${e => { e.preventDefault(); close(); res(v); }}><h3>${title}</h3>${body ? html`<p class="muted">${body}</p>` : null}
      ${multiline ? html`<textarea class="input" rows="5" placeholder=${placeholder} onInput=${e => (v = e.target.value)} autofocus>${value}</textarea>` : html`<input class="input" value=${value} placeholder=${placeholder} onInput=${e => (v = e.target.value)} autofocus />`}
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onClick=${() => { close(); res(null); }}>Cancel</button><button class="btn btn-primary">${ok}</button></div></form>`;
  }, { onClose: () => res(null) }));
}

// ── Icons (stroke icons, 24×24) ────────────────────────────
const I = {
  plus: 'M12 5v14M5 12h14', check: 'm5 12.5 4.5 4.5L19 7', x: 'M18 6 6 18M6 6l12 12', alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', info: 'M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h6', book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8', user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 2-10 7L2 6', sparkle: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3ZM19 3v4M21 5h-4', wand: 'm15 4 5 5M3 21 14.5 9.5M14 6l4 4M10.5 3.5v2M19.5 12.5v2M3.5 9.5h2',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z', comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z', history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2', undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11', redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  arrowL: 'M19 12H5M12 19l-7-7 7-7', arrowR: 'M5 12h14M12 5l7 7-7 7', chevL: 'm15 18-6-6 6-6', chevR: 'm9 18 6-6-6-6', chevD: 'm6 9 6 6 6-6', chevU: 'm18 15-6-6-6 6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12', link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', eyeOff: 'M17.9 17.9A10.1 10.1 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22',
  graph: 'M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6.5 5.5l11 1M6 6l1 12M8.5 20.5l7.5-.5M18.7 9l-.5 8',
  chart: 'M3 3v18h18M7 15l4-4 3 3 6-6', table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18', image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM21 15l-5-5L5 21',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1', send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  play: 'M6 4l14 8-14 8V4Z', flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7', target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  thumb: 'M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3', filter: 'M22 3H2l8 9.5V19l4 2v-8.5L22 3Z', layers: 'm12 2 10 5-10 5L2 7l10-5ZM2 17l10 5 10-5M2 12l10 5 10-5', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3', brain: 'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2ZM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z',
  quote: 'M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zM15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z', pin: 'M12 17v5M9 10.8V4h6v6.8l3 3.2H6l3-3.2Z',
  dots: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z', refresh: 'M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5', zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z', layout: 'M3 3h18v18H3zM3 9h18M9 21V9', ruler: 'M21.3 8.7 8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4ZM7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2M4.5 13.5l2 2', crosshair: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM22 12h-4M6 12H2M12 6V2M12 22v-4',
};
export function Icon(name, cls = '') { return html`<svg class=${`ic ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${I[name] || I.info} /></svg>`; }

// ── Formatting ─────────────────────────────────────────────
export const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export const fmtDate = iso => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const fmtDay = d => (d ? new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
export const fmtMin = ms => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
export const plural = (n, w, pl) => `${n} ${n === 1 ? w : pl || w + 's'}`;
export const initials = n => String(n || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('') || '?';
export function hue(s) { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
export function Avatar({ name, sub, size = 28, title, ring }) {
  const hh = hue(sub || name);
  return html`<span class=${`avatar-dot ${ring ? 'ring' : ''}`} title=${title || name} style=${`--h:${hh};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`}>${initials(name)}</span>`;
}
export function Ring({ value, size = 44, stroke = 5, label }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value || 0));
  return html`<svg class="ring" width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`}><circle cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${stroke} class="ring-bg" fill="none"/><circle cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${stroke} class="ring-fg" fill="none" stroke-dasharray=${c} stroke-dashoffset=${c * (1 - v)} transform=${`rotate(-90 ${size / 2} ${size / 2})`} stroke-linecap="round"/>${label != null ? html`<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" class="ring-t">${label}</text>` : null}</svg>`;
}
export const Spinner = ({ small } = {}) => html`<span class=${`spin ${small ? 'sm' : ''}`} aria-label="Working"></span>`;
export function Empty({ icon = 'doc', title, children }) { return html`<div class="empty">${Icon(icon)}<h3>${title}</h3>${children ? html`<div class="muted">${children}</div>` : null}</div>`; }
export function Bar({ value, cls = '' }) { return html`<div class=${`bar ${cls}`}><i style=${`width:${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%`}></i></div>`; }

// ── Word diff view ─────────────────────────────────────────
export function Diff({ a, b, compact }) {
  const ops = useMemo(() => tk.wordDiff(a || '', b || ''), [a, b]);
  if (compact) {
    // show only changed regions with a little context
    const out = [];
    ops.forEach((o, i) => {
      if (o.t !== '=') { out.push(html`<${o.t === '-' ? 'del' : 'ins'} key=${i}>${o.s}</${o.t === '-' ? 'del' : 'ins'}>`); return; }
      const words = o.s.split(/(\s+)/);
      const first = i === 0, last = i === ops.length - 1;
      if (words.length <= 14) { out.push(o.s); return; }
      const head = first ? '' : words.slice(0, 8).join('');
      const tail = last ? '' : words.slice(-8).join('');
      out.push(html`${head}<span class="gap">…</span>${tail}`);
    });
    return html`<span class="diff">${out}</span>`;
  }
  return html`<span class="diff">${ops.map((o, i) => (o.t === '=' ? o.s : o.t === '-' ? html`<del key=${i}>${o.s}</del>` : html`<ins key=${i}>${o.s}</ins>`))}</span>`;
}

// ── KaTeX (loaded on demand) ───────────────────────────────
let katexP = null;
export function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (!katexP) katexP = new Promise((res, rej) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/vendor/katex/katex.min.css'; document.head.appendChild(l);
    const s = document.createElement('script'); s.src = '/vendor/katex/katex.min.js'; s.onload = () => res(window.katex); s.onerror = rej; document.head.appendChild(s);
  });
  return katexP;
}
const mathCache = new Map();
export function texHtml(src, ctx) {
  const katex = window.katex;
  const macros = {};
  for (const [k, v] of Object.entries((ctx && ctx.macros) || {})) macros['\\' + k] = String(v);
  return tk.renderTex(src, ctx || {}, {
    html: true,
    math: (t, display) => {
      if (!katex) return `<code class="math">${esc(t)}</code>`;
      const key = (display ? 'D' : 'I') + t;
      if (mathCache.has(key)) return mathCache.get(key);
      let out;
      try { out = katex.renderToString(t, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, macros: { ...macros } }); } catch { out = `<code class="math">${esc(t)}</code>`; }
      if (mathCache.size > 3000) mathCache.clear();
      mathCache.set(key, out);
      return out;
    },
  });
}
export function TexView({ src, ctx, cls = '' }) {
  const [ready, setReady] = useState(!!window.katex);
  useEffect(() => { if (!ready) loadKatex().then(() => setReady(true)).catch(() => {}); }, []);
  const out = useMemo(() => texHtml(src, ctx), [src, ctx, ready]);
  return html`<div class=${`tex ${cls}`} dangerouslySetInnerHTML=${{ __html: out }}></div>`;
}

// ── Project store with live updates ────────────────────────
export class ProjectStore {
  constructor(id) { this.id = id; this.p = null; this.error = null; this.listeners = new Set(); this.es = null; this.refetchT = null; this.closed = false; this.live = false; }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { this.ver = (this.ver || 0) + 1; this.listeners.forEach(f => f(this.ver)); }
  async load() {
    try { this.p = await api(`/api/projects/${this.id}`); this.index(); this.error = null; } catch (e) { this.error = e; }
    this.emit();
    if (this.p && !this.es) this.connect();
    return this.p;
  }
  index() {
    const p = this.p;
    p.blockById = new Map(p.blocks.map((b, i) => { b.i = i; return [b.id, b]; }));
    p.secById = new Map((p.sections || []).map(s => [s.id, s]));
    p.figById = new Map((p.figures || []).map(f => [f.id, f]));
    p.tabById = new Map((p.tables || []).map(t => [t.id, t]));
    const reading = new Set(['title', 'abstract', 'para', 'list', 'caption', 'equation', 'footnote']);
    p.reading = p.blocks.filter(b => reading.has(b.kind) || (b.kind === 'ref' && p.settings.refsInReading));
    p.canDecide = p.role === 'owner' || p.role === 'editor';
  }
  refetch(ms = 600) { clearTimeout(this.refetchT); this.refetchT = setTimeout(() => this.load(), ms); }
  connect() {
    if (this.closed) return;
    const es = this.es = new EventSource(`/api/projects/${this.id}/events`);
    es.onopen = () => { if (!this.live) { this.live = true; this.emit(); } };
    es.onerror = () => { if (this.live) { this.live = false; this.emit(); } if (es.readyState === 2 && !this.closed) { this.es = null; setTimeout(() => { this.connect(); this.refetch(100); }, 5000); } };
    es.onmessage = e => { let ev; try { ev = JSON.parse(e.data); } catch { return; } this.onEvent(ev); };
  }
  onEvent(ev) {
    const p = this.p;
    if (!p) return;
    switch (ev.t) {
      case 'hello': if (ev.rev !== p.rev) this.refetch(50); return;
      case 'block': { const b = p.blockById.get(ev.bid); if (b) { b.cur = ev.cur; b.ver = ev.ver; } if (ev.change && !p.changes.some(c => c.id === ev.change.id)) p.changes.push(ev.change); break; }
      case 'change': { const i = p.changes.findIndex(c => c.id === ev.change.id); if (i >= 0) p.changes[i] = ev.change; break; }
      case 'sug': { const i = p.suggestions.findIndex(x => x.id === ev.s.id); if (i >= 0) p.suggestions[i] = ev.s; else p.suggestions.push(ev.s); break; }
      case 'presence': p.presence = ev.list; break;
      case 'job': p.ai.job = ev.job; if (ev.job && (ev.job.status === 'done' || ev.job.status === 'error' || ev.job.status === 'cancelled')) this.refetch(300); break;
      case 'figure': { const i = p.figures.findIndex(f => f.id === ev.id); if (i >= 0) { p.figures[i] = ev.figure; p.figById.set(ev.id, ev.figure); } break; }
      case 'table': { const i = p.tables.findIndex(f => f.id === ev.id); if (i >= 0) { p.tables[i] = ev.table; p.tabById.set(ev.id, ev.table); } break; }
      case 'settings': p.settings = ev.settings; p.title = ev.title; this.index(); break;
      case 'progress': this.refetch(2500); return;
      case 'revoked': toast('Your access to this manuscript was removed by the owner.', 'bad', 9000); this.close(); navigate('/app'); return;
      case 'deleted': toast('This manuscript was deleted by its owner.', 'bad', 9000); this.close(); navigate('/app'); return;
      default: this.refetch(400); return; // members, lint, review, evidence, refcheck, milestones
    }
    p.rev = ev.rev || p.rev;
    this.emit();
  }
  close() { this.closed = true; clearTimeout(this.refetchT); if (this.es) this.es.close(); this.es = null; }
}
const stores = new Map();
export function getStore(id) {
  let s = stores.get(id);
  if (!s || s.closed) { s = new ProjectStore(id); stores.set(id, s); s.load(); }
  return s;
}
export function useStore(store) {
  const [, set] = useState(0);
  useEffect(() => store.on(v => set(v)), [store]);
  return store.p;
}

// ── Keyboard helper ────────────────────────────────────────
export function useKeys(map, deps = []) {
  useEffect(() => {
    const f = e => {
      const t = e.target;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const key = (e.ctrlKey || e.metaKey ? 'mod+' : '') + (e.shiftKey && e.key.length > 1 ? 'shift+' : '') + e.key;
      const fn = map[key] || (!typing && map[e.key]);
      if (!fn) return;
      if (typing && !key.startsWith('mod+') && !(map[key] && key === 'Escape')) return;
      if (document.querySelector('.modal-back') && key !== 'Escape' && !map._inModal) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, deps);
}

// ── Page images and paragraph crops ────────────────────────
const imgCache = new Map();
export function pageImage(pid, page, ext = 'webp', ver = 0) {
  const key = `${pid}:${page}:${ver}`;
  if (!imgCache.has(key)) {
    imgCache.set(key, new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('page image')); im.src = `/api/projects/${pid}/files/page-${page}.${ext}${ver ? `?v=${ver}` : ''}`; }));
    if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
  }
  return imgCache.get(key);
}
/**
 * Draw the regions of a block (page boxes in PDF points) onto a canvas.
 * marks: [{ id, area: { p, x0, y0, x1, y1 }, color, title }] drawn on top; drawing: when true, drag to mark an area
 * (onArea receives the area in page points).
 */
export function Crop({ p, boxes, pad = 6, padY = 1.2, maxWidth = 820, cls = '', onSize, watermark, marks = [], drawing = false, onArea, onMarkClick }) {
  const ref = useRef(null);
  const [err, setErr] = useState(false);
  const [lay, setLay] = useState(null); // { W, H, parts: [{ p, sc, ox, oy, y, w, h }] } canvas px; ox/oy page-px origin of the part
  const [drag, setDrag] = useState(null);
  const key = JSON.stringify(boxes);
  const [drawn, setDrawn] = useState(null); // the boxes the canvas shows now: never show one block's crop under another
  useEffect(() => {
    let dead = false;
    setErr(false);
    (async () => {
      if (!boxes || !boxes.length) return;
      try {
        const parts = [];
        for (const bx of boxes) {
          const pg = p.source.pages[bx.p - 1];
          if (!pg) continue;
          const im = await pageImage(p.id, bx.p, p.source.pageExt || 'webp', p.source.layoutVer || 0);
          const sc = im.naturalWidth / pg.w;
          const x0 = Math.max(0, (bx.x0 - pad) * sc), y0 = Math.max(0, (bx.y0 - padY) * sc), x1 = Math.min(im.naturalWidth, (bx.x1 + pad) * sc), y1 = Math.min(im.naturalHeight, (bx.y1 + padY) * sc);
          if (x1 - x0 < 4 || y1 - y0 < 4) continue;
          parts.push({ im, x0, y0, w: x1 - x0, h: y1 - y0, p: bx.p, sc });
        }
        if (dead || !parts.length) return;
        const W = Math.max(...parts.map(q => q.w));
        const gap = 14;
        const H = parts.reduce((n, q) => n + q.h, 0) + gap * (parts.length - 1);
        const c = ref.current; if (!c) return;
        c.width = Math.round(W); c.height = Math.round(H);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        let y = 0;
        const out = [];
        parts.forEach((q, k) => {
          g.drawImage(q.im, q.x0, q.y0, q.w, q.h, 0, y, q.w, q.h);
          out.push({ p: q.p, sc: q.sc, ox: q.x0, oy: q.y0, y, w: q.w, h: q.h });
          y += q.h;
          if (k < parts.length - 1) { g.fillStyle = '#eef0f6'; g.fillRect(0, y, W, gap); g.fillStyle = '#9aa3b5'; g.font = `${Math.round(gap * 0.75)}px Inter, sans-serif`; g.fillText('⋯ continues', 8, y + gap * 0.78); y += gap; }
        });
        c.style.maxWidth = `${Math.min(maxWidth, W * (window.devicePixelRatio > 1 ? 0.75 : 1))}px`;
        setLay({ W, H, parts: out });
        setDrawn(key);
        onSize && onSize(W, H);
      } catch { if (!dead) setErr(true); }
    })();
    return () => { dead = true; };
  }, [key, p.id, p.source.layoutVer]);
  // page points ↔ canvas pixels
  const toCanvas = a => { if (!lay) return null; const q = lay.parts.find(r => r.p === a.p && a.x1 * r.sc > r.ox && a.x0 * r.sc < r.ox + r.w && a.y1 * r.sc > r.oy && a.y0 * r.sc < r.oy + r.h); if (!q) return null; const x0 = Math.max(0, a.x0 * q.sc - q.ox), x1 = Math.min(q.w, a.x1 * q.sc - q.ox), y0 = Math.max(0, a.y0 * q.sc - q.oy) + q.y, y1 = Math.min(q.h, a.y1 * q.sc - q.oy) + q.y; return { x0, y0, x1, y1 }; };
  const pct = (v, tot) => `${(100 * v / tot).toFixed(3)}%`;
  const evPos = e => { const c = ref.current; const r = c.getBoundingClientRect(); const k = c.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
  const dragRef = useRef(null); // the live drag (state only drives the drawing)
  const down = e => { if (!drawing || !lay || drawn !== key) return; e.preventDefault(); const s = evPos(e); dragRef.current = { a: s, b: s }; setDrag(dragRef.current); };
  const move = e => { if (dragRef.current) { dragRef.current = { ...dragRef.current, b: evPos(e) }; setDrag(dragRef.current); } };
  const up = e => {
    const d = dragRef.current;
    if (!d) return;
    if (e && e.clientX != null) d.b = evPos(e);
    dragRef.current = null;
    const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y);
    setDrag(null);
    if (x1 - x0 < 6 || y1 - y0 < 4) return;
    const q = lay.parts.find(r => y0 + (y1 - y0) / 2 >= r.y && y0 + (y1 - y0) / 2 <= r.y + r.h) || lay.parts[0];
    const area = { p: q.p, x0: (x0 + q.ox) / q.sc, x1: (x1 + q.ox) / q.sc, y0: (Math.max(y0, q.y) - q.y + q.oy) / q.sc, y1: (Math.min(y1, q.y + q.h) - q.y + q.oy) / q.sc };
    onArea && onArea(area);
  };
  if (err) return html`<div class="crop-missing">Page image not available</div>`;
  const fresh = drawn === key;
  return html`<div class=${`crop ${cls} ${drawing ? 'drawing' : ''} ${fresh ? '' : 'loading'}`} onMouseDown=${down} onMouseMove=${move} onMouseUp=${up} onMouseLeave=${up}><canvas ref=${ref} role="img" aria-label="The paragraph as typeset in the PDF" style=${fresh ? '' : 'visibility:hidden'}></canvas>
    ${fresh ? null : html`<div class="crop-loading faint small">Loading the page…</div>`}
    ${lay && fresh ? html`<div class="crop-marks">${marks.map(m => { const r = m.area && toCanvas(m.area); return r ? html`<span class=${`amark hl-${m.color || 'yellow'}`} title=${m.title || ''} onClick=${e => { e.stopPropagation(); onMarkClick && onMarkClick(m); }} style=${`left:${pct(r.x0, lay.W)};top:${pct(r.y0, lay.H)};width:${pct(r.x1 - r.x0, lay.W)};height:${pct(r.y1 - r.y0, lay.H)}`}></span>` : null; })}
      ${drag ? html`<span class="amark drafting" style=${`left:${pct(Math.min(drag.a.x, drag.b.x), lay.W)};top:${pct(Math.min(drag.a.y, drag.b.y), lay.H)};width:${pct(Math.abs(drag.b.x - drag.a.x), lay.W)};height:${pct(Math.abs(drag.b.y - drag.a.y), lay.H)}`}></span>` : null}</div>` : null}
    ${watermark ? html`<div class="wm" aria-hidden="true">${Array.from({ length: 6 }, () => html`<span>${watermark}</span>`)}</div>` : null}</div>`;
}

/** Highlight marked phrases inside an element with the CSS Custom Highlight API (no DOM changes). */
export function useMarkHighlights(ref, marks, deps = []) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    const groups = { yellow: [], green: [], pink: [], blue: [] };
    const nodes = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let full = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.parentElement && n.parentElement.closest('.katex-mathml')) continue; nodes.push({ n, start: full.length }); full += n.nodeValue; }
    const flat = full.replace(/\s+/g, ' ');
    // map positions in the whitespace-squashed text back to the original
    const map = []; { let last = ''; for (let i = 0; i < full.length; i++) { const ch = /\s/.test(full[i]) ? ' ' : full[i]; if (ch === ' ' && last === ' ') continue; map.push(i); last = ch; } }
    const at = pos => { const node = nodes.findLast ? nodes.findLast(x => x.start <= pos) : [...nodes].reverse().find(x => x.start <= pos); return node ? [node.n, Math.min(node.n.nodeValue.length, pos - node.start)] : null; };
    for (const m of marks) {
      if (!m.quote) continue;
      const q = m.quote.replace(/\s+/g, ' ').trim();
      const i = flat.indexOf(q);
      if (i < 0) continue;
      const a = at(map[i]), b = at(map[i + q.length - 1] + 1);
      if (!a || !b) continue;
      const r = new Range();
      try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); (groups[m.color] || groups.yellow).push(r); } catch { /* ignore */ }
    }
    const owned = [];
    for (const [c, rs] of Object.entries(groups)) { const name = `mark-${c}`; const h = CSS.highlights.get(name) || new Highlight(); for (const r of rs) h.add(r); CSS.highlights.set(name, h); owned.push([h, rs]); }
    return () => { for (const [h, rs] of owned) for (const r of rs) h.delete(r); };
  }, deps);
}

// ── Misc ───────────────────────────────────────────────────
export function copyText(t) { return navigator.clipboard.writeText(t).then(() => toast('Copied to the clipboard', 'ok'), () => toast('Could not copy', 'bad')); }
export function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
export const KIND_LABEL = { title: 'Title', abstract: 'Abstract', para: 'Paragraph', list: 'List', caption: 'Caption', equation: 'Equation', footnote: 'Footnote', heading: 'Heading', ref: 'Reference', front: 'Front matter' };
export const CATS = [['grammar', 'Grammar'], ['spelling', 'Spelling'], ['punctuation', 'Punctuation'], ['wording', 'Wording'], ['clarity', 'Clarity'], ['consistency', 'Consistency'], ['terminology', 'Terminology'], ['number', 'Numbers & facts'], ['citation', 'Citations & refs'], ['logic', 'Logic'], ['other', 'Other']];
export const catLabel = c => (CATS.find(x => x[0] === c) || [c, c ? c[0].toUpperCase() + c.slice(1) : ''])[1];
export function secLabel(p, b) { const s = b && p.secById.get(b.sec); return s ? `${s.num ? s.num + ' ' : ''}${s.title}` : ''; }
export function blockPlain(p, b) { return tk.blockText(b, p.latex || {}); }
export function useInterval(fn, ms) { useEffect(() => { const t = setInterval(fn, ms); return () => clearInterval(t); }, [ms]); }
