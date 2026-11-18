/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * LaTeX source (live, with every accepted change applied), write-back to the owner's local project folder
 * (File System Access API: Chrome/Edge), hand-off to Rykhet LaTeX, and the project's stored files.
 */
import { html, useState, useEffect, useMemo, useRef, api, getStore, navigate, Icon, Spinner, Empty, ago, plural, toast, toastError, confirmDialog, copyText } from './lib.js';
import { blockLabel } from './blocks.js';

// ── tiny IndexedDB key/value store (folder handles must be kept as structured clones) ──
const DB = () => new Promise((res, rej) => { const r = indexedDB.open('research-studio', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const kv = {
  async get(k) { const db = await DB(); return new Promise(res => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); }); },
  async set(k, v) { const db = await DB(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); },
  async del(k) { const db = await DB(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); }); },
};
export const folderSupported = () => typeof window.showDirectoryPicker === 'function';
async function fileAt(dir, path) {
  const parts = path.split('/').filter(Boolean);
  let d = dir;
  for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
  return d.getFileHandle(parts[parts.length - 1]);
}
const exists = async (dir, path) => { try { await fileAt(dir, path); return true; } catch { return false; } };

/** The connected folder for this project: { handle, state: 'granted'|'prompt'|'denied' } or null. */
export async function folderOf(pid) {
  const h = await kv.get(`dir:${pid}`);
  if (!h) return null;
  let state = 'prompt';
  try { state = await h.queryPermission({ mode: 'readwrite' }); } catch { /* old browser */ }
  return { handle: h, state };
}
async function connectFolder(p) {
  const h = await window.showDirectoryPicker({ id: `studio-${p.id}`.slice(0, 32), mode: 'readwrite' });
  const main = p.source.main || 'main.tex';
  if (!(await exists(h, main))) throw new Error(`This folder has no ${main}. Choose the project folder you uploaded (the one that contains ${main}).`);
  await kv.set(`dir:${p.id}`, h);
  return h;
}
/**
 * Fork: a copy of the whole project (with every change so far) in a new folder the user places, connected instead of
 * the original — later writes go to the copy and the original files are never touched.
 */
export async function forkToFolder(p, onProgress = () => {}) {
  const parent = await window.showDirectoryPicker({ id: 'studio-fork', mode: 'readwrite', startIn: 'documents' });
  // named after the uploaded .zip, else after the title ("SkipGate-revised")
  const stem = /\.zip$/i.test(p.source.filename || '') ? p.source.filename.replace(/\.zip$/i, '') : String(p.title || '').split(/[:—–]/)[0];
  const base = (stem.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'manuscript') + '-revised';
  let name = base;
  for (let k = 2; k < 100; k++) { try { await parent.getDirectoryHandle(name); name = `${base}-${k}`; } catch { break; } }
  onProgress('Preparing the project…');
  const src = await api(`/api/projects/${p.id}/export/compile.json?v=revised`);
  const dir = await parent.getDirectoryHandle(name, { create: true });
  let n = 0;
  for (const f of src.files) {
    const parts = f.path.split('/').filter(Boolean);
    let d = dir;
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(typeof f.text === 'string' ? f.text : b64ToU8(f.base64));
    await w.close();
    if (++n % 10 === 0) onProgress(`Writing files… ${n}/${src.files.length}`);
  }
  // the copy already holds every current paragraph
  const synced = {};
  for (const b of p.blocks || []) if (b.src) synced[b.id] = b.cur ?? b.text;
  await kv.set(`synced:${p.id}`, synced);
  await kv.set(`dir:${p.id}`, dir);
  await kv.set(`dirKind:${p.id}`, 'fork');
  await kv.set(`syncedAt:${p.id}`, new Date().toISOString());
  return { name, files: n, parent: parent.name };
}
async function ensurePermission(h) {
  let s = await h.queryPermission({ mode: 'readwrite' });
  if (s !== 'granted') s = await h.requestPermission({ mode: 'readwrite' });
  if (s !== 'granted') throw new Error('Permission to write to the folder was not given.');
}

/**
 * Write every paragraph whose current text differs from what the folder holds. The folder's text for a paragraph
 * is what we wrote last time (remembered per paragraph), or the uploaded original. It is found by content, nearest to
 * its original position, so edits you made elsewhere in the file are kept.
 */
export async function syncToFolder(p, handle) {
  await ensurePermission(handle);
  const synced = (await kv.get(`synced:${p.id}`)) || {};
  // what the folder holds for a paragraph: what we wrote last, else the version the project is based on
  const held = b => synced[b.id] ?? b.base ?? b.text;
  const todo = (p.blocks || []).filter(b => b.src && b.tex && held(b) !== b.cur);
  const byFile = new Map();
  for (const b of todo) (byFile.get(b.src.file) || byFile.set(b.src.file, []).get(b.src.file)).push(b);
  let written = 0;
  const conflicts = [], files = [];
  for (const [file, list] of byFile) {
    let fh;
    try { fh = await fileAt(handle, file); } catch { for (const b of list) conflicts.push({ bid: b.id, file, why: 'file missing in the folder' }); continue; }
    const raw = await (await fh.getFile()).text();
    const crlf = raw.includes('\r\n');
    let t = crlf ? raw.replace(/\r\n/g, '\n') : raw;
    let changed = 0;
    for (const b of list.sort((x, y) => x.src.start - y.src.start)) {
      const expected = held(b);
      if (t.includes(b.cur) && !t.includes(expected)) { synced[b.id] = b.cur; continue; } // already there
      const hits = [];
      for (let i = t.indexOf(expected); i >= 0 && hits.length < 50; i = t.indexOf(expected, i + 1)) hits.push(i);
      if (!hits.length) { conflicts.push({ bid: b.id, file, why: 'the paragraph was changed in the file as well' }); continue; }
      const at = hits.reduce((best, i) => (Math.abs(i - b.src.start) < Math.abs(best - b.src.start) ? i : best), hits[0]);
      t = t.slice(0, at) + b.cur + t.slice(at + expected.length);
      synced[b.id] = b.cur; changed++; written++;
    }
    if (changed) {
      const w = await fh.createWritable();
      await w.write(crlf ? t.replace(/\n/g, '\r\n') : t);
      await w.close();
      files.push(file);
    }
  }
  await kv.set(`synced:${p.id}`, synced);
  await kv.set(`syncedAt:${p.id}`, new Date().toISOString());
  return { written, files, conflicts, pending: todo.length };
}

/** Re-pair the paragraphs with a newly compiled PDF and upload its page images. */
export async function refreshLayout(p, pdfFile, onProgress = () => {}) {
  const { readPdf } = await import('./ingest/pdf.js');
  const { pairLatexWithPdf } = await import('./ingest/pair.js');
  onProgress('Reading the compiled PDF…');
  const pdoc = await readPdf(pdfFile, (v, m) => onProgress(m));
  const ldoc = { blocks: p.blocks.map(b => ({ ...b, text: b.cur ?? b.text, boxes: [] })), latex: p.latex, figures: p.figures.map(f => ({ ...f })), tables: p.tables.map(t => ({ ...t })), source: { ...p.source } };
  const r = pairLatexWithPdf(ldoc, pdoc);
  onProgress(`Uploading ${pdoc.assets.pageImages.length} page images…`);
  const ext = pdoc.assets.pageImages[0] && pdoc.assets.pageImages[0].blob.type === 'image/png' ? 'png' : 'webp';
  const queue = [...pdoc.assets.pageImages];
  await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) { const pg = queue.shift(); await api(`/api/projects/${p.id}/files/page-${pg.n}.${ext}`, { method: 'PUT', raw: pg.blob, type: pg.blob.type }); } }));
  await api(`/api/projects/${p.id}/files/pdf-${pdfFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`, { method: 'PUT', raw: pdfFile, type: 'application/pdf' });
  const blocks = {};
  for (const b of ldoc.blocks) if (b.boxes && b.boxes.length) blocks[b.id] = { page: b.page, boxes: b.boxes };
  const figures = Object.fromEntries(ldoc.figures.filter(f => f.box).map(f => [f.id, { box: f.box }]));
  const tables = Object.fromEntries(ldoc.tables.filter(t => t.box).map(t => [t.id, { box: t.box }]));
  await api(`/api/projects/${p.id}/layout`, { method: 'PUT', body: { pages: pdoc.source.pages, ext, blocks, figures, tables, pdfName: pdfFile.name, replace: true } });
  return r;
}

// ── New versions of the project, compiled on this computer ──
const b64ToU8 = b64 => { const s = atob(b64 || ''); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const saveBlob = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000); };
const fileBase = p => (p.title || 'manuscript').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manuscript';

/** Compile the revised project, or the one with change markup ("diff"), on this computer and download the PDF. */
export async function compilePdf(p, which, onProgress = () => {}) {
  onProgress('Preparing the project…');
  const src = await api(`/api/projects/${p.id}/export/compile.json?v=${which}`);
  const files = src.files.map(f => (typeof f.text === 'string' ? { path: f.path, text: f.text } : { path: f.path, data: b64ToU8(f.base64) }));
  const { compileLatex } = await import('./texbridge.js');
  const r = await compileLatex({ files, main: src.main, key: `${p.id}-${which}`, onProgress: m => onProgress(m) });
  saveBlob(new Blob([r.pdf], { type: 'application/pdf' }), `${fileBase(p)}-${which === 'diff' ? 'changes' : 'revised'}.pdf`);
  return { ...r, marked: src.marked, applied: src.applied, skipped: src.skipped };
}

/**
 * Bring a new version of the LaTeX project in (sent back from Rykhet LaTeX, or chosen from the user's files): compile it
 * on this computer when it has no PDF yet, read it, and merge it — history, notes and readers are kept, every edited
 * paragraph becomes a recorded change, and the checks that need no AI run again at once.
 */
export async function importVersion(p, gathered, { via, onProgress = () => {} }) {
  const N = await import('./new.js');
  const latex = await import('./ingest/latex.js');
  const mains = latex.mainCandidates(gathered.files);
  const main = mains.includes(p.source.main) ? p.source.main : mains[0];
  if (!main) throw new Error('No main .tex file (with \\documentclass and \\begin{document}) was found in this version.');
  const pdfPath = main.replace(/\.tex$/i, '.pdf');
  let compileError = null;
  if (!gathered.files.has(pdfPath) && p.compileBridge) {
    try {
      const { compileLatex } = await import('./texbridge.js');
      const r = await compileLatex({ files: [...gathered.files].map(([path, v]) => (v.text != null ? { path, text: v.text } : { path, data: v.u8 })), main, key: p.id, onProgress });
      gathered.files.set(pdfPath, { u8: r.pdf });
    } catch (e) { compileError = e; }
  }
  const list = [...gathered.files].map(([path, v]) => { const f = new File([v.u8], path.split('/').pop()); f.relPath = path; return f; });
  const doc = await N.readAll(list, (v, m) => onProgress(m || 'Reading…'), { current: false }, { main, gathered });
  onProgress('Merging the changes…');
  const r = await api(`/api/projects/${p.id}/document`, { method: 'PUT', body: { ...N.payload(doc, p.title, undefined), merge: true, via } });
  await N.uploadAssets(p.id, doc, (v, m) => onProgress(m || 'Uploading…'), { originals: true });
  return { ...r, compileError, typeset: !!doc.compiledBlob };
}
/** Files from Rykhet LaTeX's "Send to Studio" as the reader's file map. */
function gatheredFrom(r) {
  const files = new Map(), enc = new TextEncoder();
  for (const f of r.files || []) {
    if (!f || typeof f.path !== 'string') continue;
    if (typeof f.text === 'string') { const text = f.text.replace(/\r\n?/g, '\n'); files.set(f.path, { u8: enc.encode(text), text }); }
    else files.set(f.path, { u8: b64ToU8(f.base64) });
  }
  if (r.pdf && r.main) files.set(r.main.replace(/\.tex$/i, '.pdf'), { u8: b64ToU8(r.pdf) });
  return { files, zipName: null };
}

/** What a merge did, with the next steps (review, re-check). */
function ImportResult({ p, r, onClose }) {
  return html`<div class="ok-box small">
    <div class="row"><b class="grow">${Icon('check')} New version merged${r.via ? ` from ${r.via}` : ''}</b><button class="btn btn-text btn-sm" onClick=${onClose}>${Icon('x')}</button></div>
    <p>${plural(r.changed, 'paragraph')} changed · ${r.added} added · ${r.removed} removed · ${r.same} unchanged. Every change is in the history and can be undone; notes on removed paragraphs were closed.</p>
    ${r.compileError ? html`<p class="warn-text">The typeset pages were not updated: ${r.compileError.message}</p>` : null}
    <div class="row-wrap"><button class="btn btn-ghost btn-sm" onClick=${() => navigate(`/app/p/${p.id}/history`)}>${Icon('refresh')} Review the changes</button>${p.ai && (p.ai.checks ?? p.ai.enabled) && p.canDecide ? html`<button class="btn btn-ghost btn-sm" onClick=${async () => { try { await api(`/api/projects/${p.id}/ai/precheck`, { method: 'POST', body: {} }); toast('Checks started — results appear under Checks and Evidence', 'ok'); } catch (e) { toastError(e); } }}>${Icon('sparkle')} Run the checks again</button>` : null}<button class="btn btn-text btn-sm" onClick=${() => navigate(`/app/p/${p.id}/checks`)}>Consistency checks</button></div>
  </div>`;
}

// ── Source tab ─────────────────────────────────────────────
export function Source({ p, arg }) {
  const [list, setList] = useState(null);
  const [cur, setCur] = useState(null);
  const [file, setFile] = useState(null);
  const [folder, setFolder] = useState(null);
  const [busy, setBusy] = useState(null);
  const [report, setReport] = useState(null);
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem(`studio-autosync-${p.id}`) === '1'; } catch { return false; } });
  const [last, setLast] = useState(null);
  const viewRef = useRef(null);
  const changedTotal = p.blocks.filter(b => b.src && b.cur !== b.text).length;
  useEffect(() => { api(`/api/projects/${p.id}/source`).then(r => { setList(r); setCur(c => c || r.main || (r.files[0] && r.files[0].path)); }, toastError); }, [p.rev]);
  useEffect(() => { if (cur) api(`/api/projects/${p.id}/source?path=${encodeURIComponent(cur)}`).then(setFile, toastError); }, [cur, p.rev]);
  const [kind, setKind] = useState(null); // 'fork' when the connected folder is a copy made here
  useEffect(() => { folderOf(p.id).then(setFolder); kv.get(`syncedAt:${p.id}`).then(setLast); kv.get(`dirKind:${p.id}`).then(setKind); }, []);
  // auto-write while this tab is open
  useEffect(() => {
    if (!auto || !folder || folder.state !== 'granted') return;
    const pending = p.blocks.some(b => b.src && b.cur !== b.text);
    if (!pending) return;
    const t = setTimeout(() => write(true), 1200);
    return () => clearTimeout(t);
  }, [p.rev, auto, folder && folder.state]);
  /** The first write into the original folder is confirmed (a fork needs no confirmation). */
  const okToWrite = async () => {
    if (kind === 'fork' || (await kv.get(`writeOk:${p.id}`))) return true;
    const ok = await confirmDialog({ title: `Write into “${folder.handle.name}”?`, body: `This edits the .tex files in your folder directly (only the changed paragraphs; anything you changed elsewhere in the files is kept). To keep your original files untouched, cancel and choose “Fork to a new folder” instead.`, ok: 'Write into my files' });
    if (ok) await kv.set(`writeOk:${p.id}`, true);
    return ok;
  };
  const write = async quiet => {
    if (!folder) return;
    if (!(await okToWrite())) { if (quiet) setAutoOn(false); return; }
    setBusy('write');
    try {
      const r = await syncToFolder(p, folder.handle);
      setReport(r); setLast(new Date().toISOString()); setFolder(await folderOf(p.id));
      if (!quiet || r.written || r.conflicts.length) toast(r.written ? `${plural(r.written, 'paragraph')} written to ${r.files.join(', ')}` : r.conflicts.length ? `${r.conflicts.length} paragraph(s) could not be placed` : 'Your folder is up to date', r.conflicts.length ? 'bad' : 'ok', 6000);
    } catch (e) { toastError(e); }
    setBusy(null);
  };
  const connect = async () => { try { await connectFolder(p); await kv.set(`dirKind:${p.id}`, 'original'); await kv.del(`writeOk:${p.id}`); setKind('original'); setFolder(await folderOf(p.id)); toast('Folder connected', 'ok'); } catch (e) { if (e.name !== 'AbortError') toastError(e); } };
  const disconnect = async () => { await kv.del(`dir:${p.id}`); await kv.del(`dirKind:${p.id}`); setKind(null); setFolder(null); };
  const fork = async () => {
    setBusy('fork:Choose where to put the copy…');
    try {
      const r = await forkToFolder(p, m => setBusy(`fork:${m}`));
      setKind('fork'); setFolder(await folderOf(p.id)); setLast(new Date().toISOString());
      toast(`Forked into ${r.parent}/${r.name} (${r.files} files) — changes now go to the copy`, 'ok', 8000);
    } catch (e) { if (e.name !== 'AbortError') toastError(e); }
    setBusy(null);
  };
  const refresh = async () => {
    setBusy('pdf');
    try {
      await ensurePermission(folder.handle);
      const want = (p.source.main || 'main.tex').replace(/\.tex$/i, '.pdf');
      const fh = await fileAt(folder.handle, want).catch(() => { throw new Error(`No ${want} in the folder. Compile the project first.`); });
      const f = await fh.getFile();
      const r = await refreshLayout(p, new File([f], want.split('/').pop(), { type: 'application/pdf' }), m => setBusy(`pdf:${m}`));
      toast(`Typeset view updated: ${r.placed} of ${r.total} blocks placed (PDF from ${new Date(f.lastModified).toLocaleTimeString()})`, 'ok', 7000);
      getStore(p.id).refetch(50);
    } catch (e) { toastError(e); }
    setBusy(null);
  };
  const toLatex = async () => {
    setBusy('latex');
    try { const r = await api(`/api/projects/${p.id}/latex-share`, { method: 'POST', body: {} }); window.open(r.url, '_blank', 'noopener'); toast('Opened in Rykhet LaTeX — choose “Make my copy”, edit, then press “Send to Studio” there.', 'ok', 9000); getStore(p.id).refetch(100); }
    catch (e) { toastError(e); }
    setBusy(null);
  };
  // ── the way back: a version sent from Rykhet LaTeX, or files chosen here ──
  const [waiting, setWaiting] = useState(null);
  const [result, setResult] = useState(null);
  const importIn = useRef(null);
  const owner = p.role === 'owner';
  const peek = () => (p.latexEnabled && p.latexShare && owner ? api(`/api/projects/${p.id}/latex-pull`, { method: 'POST', body: { peek: true } }).then(r => setWaiting(r.returned && !r.imported ? r.returned : null), () => {}) : null);
  useEffect(() => { peek(); }, [p.latexShare && p.latexShare.at]);
  const pull = async () => {
    setBusy('pull:Fetching the version from Rykhet LaTeX…');
    try {
      const r = await api(`/api/projects/${p.id}/latex-pull`, { method: 'POST', body: {} });
      if (!r.returned) { toast('Nothing has been sent back yet. In Rykhet LaTeX, open your copy and press “Send to Studio”.', 'bad', 9000); setBusy(null); return; }
      const who = r.returned.by.name || r.returned.by.email || 'someone';
      if (r.imported && !(await confirmDialog({ title: 'Bring this version in again?', body: `The version ${who} sent ${ago(new Date(r.returned.at).toISOString())} was already merged.`, ok: 'Merge again' }))) { setBusy(null); return; }
      const via = `Rykhet LaTeX (${who})`;
      const out = await importVersion(p, gatheredFrom(r), { via, onProgress: m => setBusy(`pull:${m}`) });
      await api(`/api/projects/${p.id}/latex-pulled`, { method: 'POST', body: { at: r.returned.at, by: who } });
      setResult({ ...out, via }); setWaiting(null);
      getStore(p.id).refetch(50);
    } catch (e) { toastError(e); }
    setBusy(null);
  };
  const importFiles = async fileList => {
    if (!fileList || !fileList.length) return;
    setBusy('pull:Reading your files…');
    try {
      const latex = await import('./ingest/latex.js');
      const gathered = await latex.gatherFiles([...fileList], (v, m) => setBusy(`pull:${m || 'Reading…'}`));
      const out = await importVersion(p, gathered, { via: 'an uploaded version', onProgress: m => setBusy(`pull:${m}`) });
      setResult({ ...out, via: 'your files' });
      getStore(p.id).refetch(50);
    } catch (e) { toastError(e); }
    setBusy(null);
  };
  useEffect(() => { if (/[?&]pull=1\b/.test(location.search) && owner && p.latexEnabled) { history.replaceState(null, '', location.pathname); pull(); } }, []);
  const pdfOut = async which => {
    setBusy(`pdf-${which}:Starting…`);
    try {
      const r = await compilePdf(p, which, m => setBusy(`pdf-${which}:${m}`));
      toast(which === 'diff' ? `Diff PDF ready: ${plural(r.marked, 'changed paragraph')} marked` : 'Revised PDF ready', 'ok', 7000);
    } catch (e) { toastError(e); }
    setBusy(null);
  };
  const setAutoOn = v => { setAuto(v); try { localStorage.setItem(`studio-autosync-${p.id}`, v ? '1' : '0'); } catch { /* blocked */ } };
  const rendered = useMemo(() => {
    if (!file) return null;
    const t = file.revised;
    const regs = file.regions || [];
    const parts = [];
    let pos = 0;
    for (const r of regs) {
      if (r.start > pos) parts.push(html`<span>${t.slice(pos, r.start)}</span>`);
      const b = p.blockById.get(r.bid);
      parts.push(html`<span class=${`src-reg ${r.changed ? 'changed' : ''}`} title=${b ? blockLabel(p, b) : ''} onClick=${() => r.changed && navigate(`/app/p/${p.id}/manuscript/${r.bid}`)}>${t.slice(r.start, r.end)}</span>`);
      pos = r.end;
    }
    parts.push(html`<span>${t.slice(pos)}</span>`);
    return parts;
  }, [file]);
  if (p.source.kind !== 'latex') return html`<div class="card"><${Empty} icon="doc" title="This manuscript was uploaded as a PDF">Upload the LaTeX project (folder or .zip) to have accepted changes written straight into the .tex source.</${Empty}></div>`;
  const decide = p.canDecide;
  return html`<div class="src">
    <div class="src-actions">
      <div class="card pad">
        <h3 class="card-h">${Icon('layers')} Your local project folder</h3>
        ${!folderSupported() ? html`<p class="small muted">Writing straight into a folder works in Chrome and Edge on a computer. Here you can download the revised project instead.</p>`
          : !folder ? html`${decide ? html`<p class="small muted"><b>Connect your folder</b> (the one with <b class="mono">${p.source.main}</b>): accepted changes are written straight into its .tex files — only the changed paragraphs.</p>
              <p class="small muted"><b>Or fork it:</b> a copy of the project with every change so far, in a new folder you place. Later changes go to the copy; your original files are never touched.</p>
              <div class="row-wrap"><button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${connect}>${Icon('link')} Connect folder</button><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${fork}>${busy && busy.startsWith('fork') ? html`<${Spinner} small />` : Icon('layers')} Fork to a new folder</button></div>` : html`<p class="small faint">Only the owner and editors can write changes.</p>`}`
          : html`<p class="small"><b>${folder.handle.name}</b> ${folder.state === 'granted' ? html`<span class="chip c-ok">connected</span>` : html`<span class="chip c-warn">needs permission</span>`} ${kind === 'fork' ? html`<span class="chip c-brand">fork</span>` : html`<span class="chip">your original</span>`}${last ? html` <span class="faint tiny">· last written ${ago(last)}</span>` : ''}</p>
            <p class="tiny faint">${kind === 'fork' ? 'A copy made here: changes are written into it; your original folder is untouched.' : 'Writing changes edits the .tex files in this folder (only changed paragraphs; edits you made elsewhere are kept).'}</p>
            <div class="row-wrap"><button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => write(false)}>${busy === 'write' ? html`<${Spinner} small />` : Icon('download')} Write changes to the folder</button>
            <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${refresh} title="Read the PDF you compiled and update the typeset view">${busy && busy.startsWith('pdf') ? html`<${Spinner} small />` : Icon('refresh')} Load my new PDF</button>
            ${decide && kind !== 'fork' ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${fork} title="Copy the project into a new folder and write there instead">${busy && busy.startsWith('fork') ? html`<${Spinner} small />` : Icon('layers')} Fork to a new folder</button>` : null}
            <button class="btn btn-text btn-sm" onClick=${disconnect}>Disconnect</button></div>
            <label class="row small" style="margin-top:10px"><label class="switch"><input type="checkbox" checked=${auto} onChange=${e => setAutoOn(e.target.checked)} /><span></span></label> Write automatically while this tab is open</label>
            ${busy && busy.startsWith('pdf:') ? html`<p class="tiny faint">${busy.slice(4)}</p>` : null}`}
        ${busy && busy.startsWith('fork:') ? html`<p class="tiny faint">${busy.slice(5)}</p>` : null}
        ${report && report.conflicts.length ? html`<div class="warn-box small"><b>${report.conflicts.length} paragraph(s) need a manual edit</b> — they were also changed in your file:<ul>${report.conflicts.slice(0, 8).map(c => { const b = p.blockById.get(c.bid); return html`<li><a href=${`/app/p/${p.id}/manuscript/${c.bid}`}>${b ? blockLabel(p, b) : c.bid}</a> (${c.file})</li>`; })}</ul></div>` : null}
      </div>
      <div class="card pad">
        <h3 class="card-h">${Icon('external')} ${p.latexEnabled ? 'Round trip with Rykhet LaTeX' : 'Bring in an edited version'}</h3>
        ${p.latexEnabled ? html`<ol class="src-steps small muted">
          <li><b>Send</b> the revised project (${plural(changedTotal, 'changed paragraph')}) to latex.rykhet.com — a private share for you${p.members.some(m => m.role === 'editor') ? ' and the editors' : ''}.</li>
          <li>There, choose <b>Make my copy</b>, edit and compile.</li>
          <li>Press <b>Send to Studio</b> in the editor, then <b>Bring changes back</b> here: every edit is merged as a recorded change and the checks run again.</li>
        </ol>` : null}
        ${p.latexEnabled ? html`<div class="row-wrap">
            <button class="btn btn-ghost btn-sm" disabled=${!!busy || !decide} onClick=${toLatex}>${busy === 'latex' ? html`<${Spinner} small />` : Icon('external')} ${p.latexShare ? 'Send again and open' : 'Send to Rykhet LaTeX'}</button>
            ${owner && p.latexShare ? html`<button class=${`btn btn-sm ${waiting ? 'btn-primary' : 'btn-ghost'}`} disabled=${!!busy} onClick=${pull}>${busy && busy.startsWith('pull') ? html`<${Spinner} small />` : Icon('download')} Bring changes back</button>` : null}
          </div>
          ${waiting ? html`<div class="tiny" style="margin-top:6px"><span class="chip c-brand">new version</span> sent by ${waiting.by.name || waiting.by.email} ${ago(new Date(waiting.at).toISOString())}</div>` : null}
          ${p.latexShare ? html`<div class="tiny faint" style="margin-top:6px">Last sent ${ago(p.latexShare.at)} by ${p.latexShare.by} · <a href=${p.latexShare.url} target="_blank" rel="noopener">open the share</a>${p.latexReturn ? html` · last brought back ${ago(p.latexReturn.imported)}` : null}</div>` : null}`
          : null}
        ${owner ? html`${p.latexEnabled ? html`<div class="divider-sm"></div>` : null}<p class="small muted">${p.latexEnabled ? 'Edited somewhere else (Overleaf, your own editor)? Bring that version in the same way:' : 'Edited the paper elsewhere (Overleaf, your own editor)? Import that version: every edit is merged into the history as a recorded change, and the checks run again.'}</p>
          <input type="file" ref=${importIn} multiple accept=".zip,.tex,.bib,.bbl,.cls,.sty,.bst,.pdf,.png,.jpg,.jpeg,.eps" style="display:none" onChange=${e => { importFiles(e.target.files); e.target.value = ''; }} />
          <div class="row-wrap"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => importIn.current.click()}>${Icon('upload')} Import a new version (.zip or files)</button></div>` : null}
        ${busy && busy.startsWith('pull:') ? html`<p class="tiny faint">${busy.slice(5)}</p>` : null}
        ${result ? html`<${ImportResult} p=${p} r=${result} onClose=${() => setResult(null)} />` : null}
      </div>
      <div class="card pad">
        <h3 class="card-h">${Icon('download')} Download</h3>
        <div class="row-wrap">
          ${p.compileBridge ? html`<button class="btn btn-primary btn-sm" disabled=${!!busy || !decide} onClick=${() => pdfOut('diff')} title="The manuscript with deletions struck through in red and insertions in blue">${busy && busy.startsWith('pdf-diff') ? html`<${Spinner} small />` : Icon('doc')} Diff PDF</button>
          <button class="btn btn-ghost btn-sm" disabled=${!!busy || !decide} onClick=${() => pdfOut('revised')}>${busy && busy.startsWith('pdf-revised') ? html`<${Spinner} small />` : Icon('doc')} Revised PDF</button>` : null}
          <a class="btn btn-ghost btn-sm" href=${`/api/projects/${p.id}/export/diff.zip`}>${Icon('download')} Diff project (.zip)</a>
          <a class="btn btn-ghost btn-sm" href=${`/api/projects/${p.id}/export/revised.zip`}>${Icon('download')} Revised project (.zip)</a><a class="btn btn-text btn-sm" href=${`/api/projects/${p.id}/export/diff.txt`}>Diff (.txt)</a></div>
        ${busy && busy.startsWith('pdf-') ? html`<p class="tiny faint">${busy.slice(busy.indexOf(':') + 1)}</p>` : p.compileBridge ? html`<p class="tiny faint">PDFs are compiled on your computer by Rykhet LaTeX (the desktop app's TeX if you use it, otherwise TeX in the browser). The first time, the browser downloads the TeX engine once.</p>` : html`<p class="tiny faint">The diff project has the changes marked latexdiff style; compile it with your own TeX (latexmk -pdf).</p>`}
      </div>
    </div>
    <div class="card src-view">
      <div class="src-files">${!list ? html`<${Spinner} small />` : list.files.map(f => html`<button class=${`src-file ${cur === f.path ? 'on' : ''}`} onClick=${() => setCur(f.path)}><span class="mono">${f.path}</span>${f.changed ? html`<em>${f.changed}</em>` : null}</button>`)}</div>
      <div class="src-body" ref=${viewRef}>${!file ? html`<div class="pad"><${Spinner} small /></div>` : html`<div class="src-head"><b class="mono">${file.path}</b><span class="faint tiny">${(file.regions || []).filter(r => r.changed).length} changed · green = changed paragraph (click to review)</span></div><pre class="src-pre">${rendered}</pre>`}</div>
    </div>
  </div>`;
}

// ── Files tab ──────────────────────────────────────────────
export function Files({ p }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const pdfIn = useRef(null);
  const newIn = useRef(null);
  const load = () => api(`/api/projects/${p.id}/files`).then(setD, toastError);
  useEffect(() => { load(); }, [p.rev]);
  const addPdf = async f => {
    if (!f) return;
    setBusy('Pairing the compiled PDF…');
    try { const r = await refreshLayout(p, f, m => setBusy(m)); toast(`Typeset view ready: ${r.placed} of ${r.total} blocks placed`, 'ok', 7000); getStore(p.id).refetch(50); load(); } catch (e) { toastError(e); }
    setBusy(null);
  };
  /** Read the manuscript again with the current reader (from the stored original, or a new version of the file). */
  const reread = async (files, label, stored = false) => {
    const busyNotes = p.suggestions.length + p.changes.length;
    if (!(await confirmDialog({ title: 'Read the manuscript again?', body: busyNotes ? `All paragraphs are rebuilt from ${label}. The ${p.suggestions.length} notes and ${p.changes.length} changes made so far will be removed. Export the change list first if you need it.` : `All paragraphs, figures and tables are rebuilt from ${label} with the current reader.`, ok: 'Read again', danger: !!busyNotes }))) return;
    setBusy('Reading…');
    try {
      const N = await import('./new.js');
      const doc = await N.readAll(files, (v, m) => setBusy(m || 'Reading…'), { current: false }, { main: p.source.main });
      setBusy('Saving…');
      await api(`/api/projects/${p.id}/document`, { method: 'PUT', body: { ...N.payload(doc, doc.title, undefined), force: true } });
      await N.uploadAssets(p.id, doc, (v, m) => setBusy(m), { originals: !stored });
      toast('The manuscript was read again', 'ok');
      getStore(p.id).refetch(50); load();
    } catch (e) { toastError(e); }
    setBusy(null);
  };
  const rereadStored = async () => {
    try {
      setBusy('Fetching the original…');
      const name = p.source.original || (p.source.kind === 'pdf' ? 'source.pdf' : 'source.zip');
      const blob = await (await fetch(`/api/projects/${p.id}/files/${name}`)).blob();
      const files = [new File([blob], name === 'source.pdf' ? (p.source.filename || 'manuscript.pdf') : 'project.zip', { type: blob.type })];
      if (p.source.kind === 'latex' && p.source.pdfFile) { const pb = await (await fetch(`/api/projects/${p.id}/files/${p.source.pdfFile}`)).blob(); files.push(new File([pb], p.source.pdfFile.replace(/^pdf-/, ''), { type: 'application/pdf' })); }
      if (p.source.kind === 'latex') {
        // LaTeX: read again with the latest reader and merge — notes, changes and readers are kept
        setBusy('Reading the stored project again…');
        const latex = await import('./ingest/latex.js');
        const gathered = await latex.gatherFiles(files, (v, m) => setBusy(m || 'Reading…'));
        const out = await importVersion(p, gathered, { via: 'a fresh reading of the stored project', onProgress: m => setBusy(m) });
        toast(`Read again: ${out.changed} paragraph(s) changed, ${out.added} added, ${out.removed} removed — notes and history kept`, 'ok', 8000);
        getStore(p.id).refetch(50); load(); setBusy(null);
        return;
      }
      setBusy(null);
      await reread(files, 'the stored original', true);
    } catch (e) { toastError(e); setBusy(null); }
  };
  const label = { original: 'Original upload', page: 'Page image', figure: 'Figure image', compiled: 'Compiled PDF', other: 'File' };
  const owner = p.role === 'owner';
  return html`<div class="files-grid">
    <div class="card pad">
      <h3 class="card-h">${Icon('lock')} Stored for this manuscript</h3>
      <p class="small muted">Everything is encrypted on Rykhet servers and only visible to people with access${p.settings.allowDownload ? '' : ' (proofreaders cannot download originals)'}.</p>
      ${!d ? html`<${Spinner} small />` : html`
        ${p.source.kind === 'latex' && d.source.files.length ? html`<details class="mini-det" open><summary>LaTeX project — ${plural(d.source.files.length, 'file')}${d.source.main ? ` · main ${d.source.main}` : ''}</summary><ul class="file-list">${d.source.files.slice(0, 200).map(f => html`<li><span class="mono small">${f.name}</span><span class="faint tiny">${Math.max(1, Math.round(f.size / 1024))} KB</span></li>`)}</ul></details>` : null}
        <ul class="file-list">${d.files.filter(f => f.kind !== 'page').map(f => html`<li><span class=${`chip ${f.kind === 'original' ? 'c-brand' : f.kind === 'compiled' ? 'c-ok' : ''}`}>${label[f.kind]}</span><span class="mono small grow">${f.name}</span><a class="btn btn-text btn-sm" href=${`/api/projects/${p.id}/files/${f.name}?dl=1`} download>${Icon('download')}</a></li>`)}
          ${d.files.some(f => f.kind === 'page') ? html`<li><span class="chip">Page images</span><span class="small grow">${d.files.filter(f => f.kind === 'page').length} pages (what readers see)</span></li>` : null}</ul>`}
    </div>
    <div class="col">
      ${p.source.kind === 'latex' && p.canDecide ? html`<div class="card pad"><h3 class="card-h">${Icon('doc')} Compiled PDF</h3>
        <p class="small muted">${p.source.pdfPaired ? html`Paragraphs are shown as typeset from <b>${p.source.pdfName || 'the compiled PDF'}</b>. After you compile again, add the new PDF to refresh the view.` : 'Add the PDF you compiled from this project so readers see each paragraph as typeset (edits still go into the .tex source).'}</p>
        <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => pdfIn.current.click()}>${Icon('upload')} ${p.source.pdfPaired ? 'Replace compiled PDF' : 'Add compiled PDF'}</button><input ref=${pdfIn} type="file" class="sr" accept=".pdf" onChange=${e => addPdf(e.target.files[0])} />
      </div>` : null}
      ${owner ? html`<div class="card pad"><h3 class="card-h">${Icon('refresh')} Read the manuscript again</h3>
        <p class="small muted">Rebuild paragraphs, figures and tables with the latest reader (it keeps improving), or from a new version of your file.${p.source.kind === 'latex' ? ' Reading the stored project again keeps all notes, changes and readers.' : ''}</p>
        <div class="row-wrap"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${rereadStored}>${Icon('refresh')} Read the stored original again</button>
        <button class="btn btn-text btn-sm" disabled=${!!busy} onClick=${() => newIn.current.click()}>${Icon('upload')} Upload a new version</button><input ref=${newIn} type="file" class="sr" multiple accept=".pdf,.zip,.tex,.bib,.bbl" onChange=${e => e.target.files.length && reread([...e.target.files], 'the new version')} /></div>
      </div>` : null}
      ${busy ? html`<div class="card pad row"><${Spinner} small /><span class="small">${busy}</span></div>` : null}
    </div>
  </div>`;
}
