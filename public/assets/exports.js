/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * Exports made on this computer: the server only hands over what it stores (the LaTeX sources and the uploaded .zip);
 * the changes are applied, the latexdiff-style markup is made and the files are packed here.
 *   projectFiles(p, 'revised' | 'diff')   the whole project as a Map path → text | bytes
 *   compileFiles(p, which)                 the same, ready for the compiler (aux files and the old PDF left out)
 *   downloadProject(p, which)              .zip of it
 *   downloadText(p, kind)                  changes.md | changes.txt | diff.txt | revised.txt | revised.tex
 *   revisedSources(p)                      { main, files: { path: text }, skipped, original: texFiles } for the source view
 */
import { api, tk } from './lib.js';
import * as EX from './shared/exporter.mjs';
import * as TD from './shared/texdiff.mjs';

const TEXT = /\.(tex|bib|bbl|sty|cls|bst|cfg|def|clo|txt|csv|dat|md)$/i;
const SKIP = /(^|\/)(__MACOSX|\.git)\//;
const AUX = /\.(aux|log|out|blg|synctex\.gz|fls|fdb_latexmk|toc|lof|lot|nav|snm)$/i;

export const fileBase = p => (p.title || 'manuscript').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manuscript';
export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
const logged = (p, kind) => api(`/api/projects/${p.id}/exported`, { method: 'POST', body: { kind } }).catch(() => {});

// the stored sources change only when a new version is brought in
const cache = new Map();
export function sourcesOf(p) {
  const key = `${p.id}:${(p.imported && p.imported.at) || ''}:${p.source.original || ''}`;
  if (!cache.has(key)) {
    for (const k of cache.keys()) if (k.startsWith(`${p.id}:`)) cache.delete(k);
    cache.set(key, api(`/api/projects/${p.id}/source-files`).catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}
const withSources = (p, src) => ({ ...p, source: { ...p.source, texFiles: src.texFiles || {}, main: src.main || p.source.main }, removedBlocks: src.removedBlocks || [] });

/** The LaTeX sources with every change applied (for the source view). */
export async function revisedSources(p) {
  const src = await sourcesOf(p);
  const full = withSources(p, src);
  const r = EX.revisedTex(full);
  return { main: full.source.main, files: r.files, skipped: r.skipped, original: full.source.texFiles, regions: file => EX.regions(full, file) };
}

async function originalEntries(p, src, onStage) {
  const map = new Map();
  if (!src.original) return map;
  onStage('Reading the uploaded project…');
  const r = await fetch(`/api/projects/${p.id}/files/${encodeURIComponent(src.original)}`, { credentials: 'same-origin' });
  if (!r.ok) return map;
  const { unzipSync } = await import('/vendor/fflate.mjs');
  const all = unzipSync(new Uint8Array(await r.arrayBuffer()), { filter: e => !SKIP.test(e.name) && !e.name.endsWith('/') });
  for (const [name, data] of Object.entries(all)) map.set(name, data);
  return map;
}

/** The whole project, revised or with the changes marked: { main, marked, applied, skipped, map: Map(path → text | Uint8Array) } */
export async function projectFiles(p, which, onStage = () => {}) {
  onStage('Fetching the stored sources…');
  const src = await sourcesOf(p);
  const full = withSources(p, src);
  const map = await originalEntries(p, src, onStage);
  onStage(which === 'diff' ? 'Marking the changes…' : 'Applying the changes…');
  await new Promise(r => setTimeout(r, 0)); // let the progress message paint before the diff runs
  const r = which === 'diff' ? TD.diffProject(full) : { ...EX.revisedTex(full), main: full.source.main };
  for (const [f, t] of Object.entries(r.files)) map.set(f, t);
  return { main: r.main, marked: r.marked || 0, applied: r.applied || 0, skipped: r.skipped || [], map };
}

/** Files for the compiler on this computer: [{ path, text } | { path, data }] */
export async function compileFiles(p, which, onStage) {
  const r = await projectFiles(p, which, onStage);
  const mainPdf = (r.main || '').replace(/\.tex$/, '.pdf');
  const dec = new TextDecoder();
  const files = [];
  for (const [name, data] of r.map) {
    if (SKIP.test(name) || AUX.test(name) || name === mainPdf) continue;
    files.push(typeof data === 'string' ? { path: name, text: data } : TEXT.test(name) ? { path: name, text: dec.decode(data) } : { path: name, data });
  }
  return { ...r, files };
}

export async function downloadProject(p, which, onStage = () => {}) {
  const r = await projectFiles(p, which, onStage);
  onStage('Packing the .zip…');
  const { zipSync } = await import('/vendor/fflate.mjs');
  const enc = new TextEncoder();
  const entries = {};
  for (const [name, data] of r.map) entries[name] = typeof data === 'string' ? enc.encode(data) : data;
  if (which === 'diff') entries['STUDIO-DIFF.txt'] = enc.encode(`Change markup (latexdiff style) for ${r.marked} paragraph(s). Compile ${r.main} as usual, e.g. latexmk -pdf ${r.main}\n`);
  else if (r.skipped.length) entries['STUDIO-NOTES.txt'] = enc.encode(`${r.skipped.length} changed paragraph(s) could not be placed automatically; see the change list.\n`);
  saveBlob(new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' }), `${fileBase(p)}-${which === 'diff' ? 'diff' : 'revised'}.zip`);
  logged(p, `${which}.zip`);
  return r;
}

/** Text exports: the change list, the unified diff, the revised text (PDF uploads) or the revised main .tex. */
export async function downloadText(p, kind, { rejected = false } = {}) {
  const base = fileBase(p);
  // readers export only their own suggestions and comments
  const view = p.canDecide ? p : { ...p, suggestions: (p.suggestions || []).filter(s => s.by === p.me.sub) };
  let text, name, type = 'text/plain;charset=utf-8';
  if (kind === 'changes.md' || kind === 'changes.txt') {
    const md = kind === 'changes.md';
    text = EX.changeList(p.source.kind === 'latex' && p.canDecide ? withSources(view, await sourcesOf(p)) : view, tk, { style: md ? 'md' : 'txt', include: { applied: true, open: true, comments: true, rejected } });
    name = `${base}-proofreading.${md ? 'md' : 'txt'}`; if (md) type = 'text/markdown;charset=utf-8';
  } else if (kind === 'diff.txt') { text = EX.unifiedDiff(p); name = `${base}.diff`; }
  else if (kind === 'revised.txt') { text = EX.revisedText(p, tk); name = `${base}-revised.txt`; }
  else if (kind === 'revised.tex') {
    const r = await revisedSources(p);
    const main = r.main && r.files[r.main] != null ? r.main : Object.keys(r.files).find(f => /\.tex$/.test(f));
    text = r.files[main] || ''; name = (main || 'main.tex').split('/').pop().replace(/\.tex$/, '') + '-revised.tex'; type = 'application/x-tex;charset=utf-8';
  } else throw new Error('Unknown export.');
  saveBlob(new Blob([text], { type }), name);
  logged(p, kind);
}
