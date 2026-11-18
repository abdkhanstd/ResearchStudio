/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/**
 * Compile LaTeX on the user's own machine through Rykhet LaTeX (a hidden frame of latex.rykhet.com/app/?embed=compile):
 * the desktop app's TeX when the user chose it there, otherwise TeX in the browser (WebAssembly) with Rykhet LaTeX's
 * engine files and package cache. Nothing is compiled on the Studio server.
 *   compileLatex({ files: [{ path, text } | { path, data: Uint8Array }], main, key, onProgress }) → { pdf: Uint8Array, log }
 */
export const LATEX_ORIGIN = 'https://latex.rykhet.com';

let frame = null, ready = null;
const pending = new Map();

function connect() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ready = null; reject(new Error('Rykhet LaTeX did not respond. Check your connection and try again.')); }, 30000);
    const onMsg = e => {
      if (e.origin !== LATEX_ORIGIN || !e.data || e.data.source !== 'rykhet-latex-bridge') return;
      const d = e.data;
      if (d.type === 'ready') { clearTimeout(timer); resolve(); return; }
      const job = d.id && pending.get(d.id);
      if (!job) return;
      if (d.type === 'progress') job.onProgress(d.stage, d.progress);
      else if (d.type === 'result') { pending.delete(d.id); job.resolve(d); }
      else if (d.type === 'error') { pending.delete(d.id); job.reject(new Error(d.message || 'Compiling failed')); }
    };
    window.addEventListener('message', onMsg);
    frame = document.createElement('iframe');
    frame.src = `${LATEX_ORIGIN}/app/?embed=compile`;
    frame.title = 'Rykhet LaTeX compiler';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
    document.body.appendChild(frame);
    // the frame announces itself on load; ask again in case that message came before the listener
    frame.addEventListener('load', () => { try { frame.contentWindow.postMessage({ source: 'rykhet-studio', type: 'ping' }, LATEX_ORIGIN); } catch { /* not yet */ } });
  });
  return ready;
}

export async function compileLatex({ files, main, key = 'doc', engine = 'pdftex', onProgress = () => {} }) {
  onProgress('Starting TeX on your computer (Rykhet LaTeX)…');
  await connect();
  const id = Math.random().toString(36).slice(2);
  const transfer = [];
  const list = files.map(f => {
    if (typeof f.text === 'string') return { path: f.path, text: f.text };
    const buf = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
    transfer.push(buf);
    return { path: f.path, data: buf };
  });
  const r = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    frame.contentWindow.postMessage({ source: 'rykhet-studio', type: 'compile', id, key, main, engine, files: list }, LATEX_ORIGIN, transfer);
  });
  if (!r.pdf) {
    const first = (r.errors || [])[0];
    const err = new Error(first ? `LaTeX error${first.file ? ` in ${first.file}${first.line ? `:${first.line}` : ''}` : ''}: ${first.message}` : 'LaTeX produced no PDF.');
    err.log = r.log; throw err;
  }
  return { pdf: new Uint8Array(r.pdf), log: r.log, engine: r.engine, ok: r.ok };
}
