/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** New manuscript: read a PDF or LaTeX project in the browser, review what was found, then create the Proof Room. */
import { html, useState, useRef, useEffect, api, navigate, Icon, Spinner, toast, toastError, plural, Bar, me, tk } from './lib.js';
import { Topbar } from './app.js';

const ext = f => (f.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
const relPath = f => f.relPath || f.webkitRelativePath || f.name;

/** Files from a drop, including whole folders (each File gets .relPath = path inside the dropped folder). */
export async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!items.length) return [...dt.files];
  const out = [];
  const readDir = d => new Promise(res => { const r = d.createReader(); const all = []; const next = () => r.readEntries(es => { if (!es.length) return res(all); all.push(...es); next(); }, () => res(all)); next(); });
  const walk = async (entry, prefix) => {
    if (entry.isFile) { const f = await new Promise((res, rej) => entry.file(res, rej)); f.relPath = prefix + f.name; out.push(f); }
    else if (entry.isDirectory) { if (/^(\.git|node_modules|__MACOSX)$/.test(entry.name)) return; for (const e of await readDir(entry)) await walk(e, `${prefix}${entry.name}/`); }
  };
  for (const e of items) await walk(e, '');
  return out;
}

/** Read what was given: a PDF, or a LaTeX project (folder, .zip, or loose files) with an optional compiled PDF. */
export async function readAll(files, onProgress, skipOcr, choice = {}) {
  const list = [...files];
  const latex = await import('./ingest/latex.js');
  const isLatex = list.some(f => ['tex', 'zip'].includes(ext(f)));
  const pdfs = list.filter(f => ext(f) === 'pdf');
  if (!isLatex && !pdfs.length) throw new Error('Upload a PDF, or a LaTeX project: a folder, a .zip, or the .tex with its .bib and figures.');
  let doc;
  if (isLatex) {
    // a folder upload keeps paths relative to the folder (the first path segment is the folder itself)
    const named = list.filter(f => !latex.JUNK.test(relPath(f)));
    const gathered = choice.gathered || await latex.gatherFiles(named.map(f => { if (f.relPath && !f.webkitRelativePath) { try { Object.defineProperty(f, 'webkitRelativePath', { value: f.relPath }); } catch { /* read-only */ } } return f; }), onProgress);
    doc = await latex.readLatex(named, onProgress, { main: choice.main, gathered });
    doc.kind = 'latex'; doc.originals = named;
    // compiled PDF: next to the main file in the project, or given separately
    let pdfFile = null, pdfName = null;
    if (choice.pdf !== false) {
      const loose = pdfs.find(f => !/(^|\/)(fig|figs|figures|img|images|plots)\//i.test(relPath(f)) && (pdfs.length === 1 || relPath(f).replace(/^[^/]+\//, '') === doc.source.main.replace(/\.tex$/i, '.pdf')));
      if (doc.compiledPdf && gathered.files.get(doc.compiledPdf)) { pdfFile = new File([gathered.files.get(doc.compiledPdf).u8], doc.compiledPdf.split('/').pop(), { type: 'application/pdf' }); pdfName = doc.compiledPdf; }
      else if (loose && !gathered.files.has(relPath(loose).replace(/^[^/]+\//, ''))) { pdfFile = loose; pdfName = loose.name; }
    }
    if (pdfFile) {
      onProgress(0.6, `Reading the compiled PDF (${pdfName}) for the typeset view…`);
      const { readPdf } = await import('./ingest/pdf.js');
      const pdoc = await readPdf(pdfFile, (v, m) => onProgress(0.6 + v * 0.3, m));
      const { pairLatexWithPdf } = await import('./ingest/pair.js');
      doc.pair = pairLatexWithPdf(doc, pdoc);
      doc.source.pdfName = pdfName;
      doc.compiledBlob = pdfFile;
    }
  } else { const { readPdf } = await import('./ingest/pdf.js'); doc = await readPdf(pdfs[0], onProgress); doc.kind = 'pdf'; doc.originals = [pdfs[0]]; }
  // OCR for raster figures
  const raster = doc.kind === 'pdf' ? doc.figures.filter(f => f.ocrCanvas) : doc.figures.filter(f => (doc.assets.figImages.find(x => x.id === f.id) || {}).canvas && /raster|mixed/.test(f.kind));
  if (raster.length && !skipOcr.current) {
    const { ocr, stopOcr } = await import('./ingest/ocr.js');
    let k = 0;
    for (const f of raster) {
      if (skipOcr.current) break;
      onProgress(0.9 + 0.08 * (k++ / raster.length), `Recognising text in ${f.label} (${k}/${raster.length})…`, true);
      const canvas = f.ocrCanvas || doc.assets.figImages.find(x => x.id === f.id).canvas;
      try {
        const r = await ocr(canvas); f.ocr = r.text; f.words = r.words; f.wordsSize = [canvas.width, canvas.height];
        if (!f.data || !f.data.series || !f.data.series.length) { const { autoDigitize } = await import('./ingest/raster.js'); const d = autoDigitize(canvas, r.words); if (d) f.data = d; }
      } catch (e) { console.warn('ocr', e); }
    }
    stopOcr();
  }
  onProgress(1, 'Done');
  return doc;
}

export function payload(doc, title, settings) {
  const figs = doc.figures.map(f => ({ id: f.id, label: f.label, num: f.num, caption: f.caption, bid: f.bid, page: f.page, box: f.box, kind: f.kind, data: f.data, text: f.text, ocr: f.ocr || '', words: f.words, wordsSize: f.wordsSize, file: f.file || null }));
  return {
    title, settings, sections: doc.sections, blocks: doc.blocks, tables: doc.tables.map(t => ({ id: t.id, label: t.label, num: t.num, caption: t.caption, bid: t.bid, page: t.page, box: t.box, grid: t.grid, rows: t.rows, source: t.source || (doc.kind === 'latex' ? 'latex' : 'pdf') })),
    figures: figs, refs: doc.refs, citations: doc.citations, latex: doc.latex || null,
    source: { ...doc.source },
  };
}

export async function uploadAssets(id, doc, onProgress, { originals = true } = {}) {
  const jobs = [];
  for (const p of (doc.assets && doc.assets.pageImages) || []) { const e = p.blob.type === 'image/webp' ? 'webp' : 'png'; jobs.push({ name: `page-${p.n}.${e}`, blob: p.blob }); }
  const figBlobs = doc.kind === 'pdf' ? doc.figures.filter(f => f.blob).map(f => ({ id: f.id, blob: f.blob })) : doc.assets.figImages;
  for (const f of figBlobs) jobs.push({ name: `fig-${f.id}.png`, blob: f.blob });
  // the original: PDF, or the whole LaTeX project as a zip (paths kept), plus its compiled PDF
  if (!originals) { if (doc.compiledBlob) jobs.push({ name: `pdf-${(doc.source.pdfName || 'main.pdf').split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_')}`, blob: doc.compiledBlob }); }
  else if (doc.kind === 'pdf') jobs.push({ name: 'source.pdf', blob: doc.originals[0], big: true });
  else {
    const zip = doc.originals.length === 1 && ext(doc.originals[0]) === 'zip' ? doc.originals[0] : null;
    if (zip) jobs.push({ name: 'source.zip', blob: zip, big: true });
    else {
      const { zipSync } = await import('/vendor/fflate.mjs');
      const entries = {};
      for (const [p, v] of doc.gathered.files) if (p !== doc.compiledPdf) entries[p] = v.u8;
      jobs.push({ name: 'source.zip', blob: new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' }), big: true });
    }
    if (doc.compiledBlob) jobs.push({ name: `pdf-${(doc.source.pdfName || 'main.pdf').split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_')}`, blob: doc.compiledBlob, big: true });
  }
  let done = 0;
  const total = jobs.reduce((n, j) => n + j.blob.size, 0) || 1;
  let sent = 0;
  const run = async j => {
    const type = j.name.endsWith('.pdf') ? 'application/pdf' : j.name.endsWith('.zip') ? 'application/zip' : j.name.endsWith('.webp') ? 'image/webp' : 'image/png';
    await api(`/api/projects/${id}/files/${j.name}`, { method: 'PUT', raw: j.blob, type });
    sent += j.blob.size; done++;
    onProgress(sent / total, `Uploading securely… ${done}/${jobs.length}`);
  };
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await run(queue.shift()); }));
}

export function NewPage() {
  const [stage, setStage] = useState('pick'); // pick | reading | review | creating
  const [prog, setProg] = useState({ v: 0, msg: '' });
  const [doc, setDoc] = useState(null);
  const [title, setTitle] = useState('');
  const [over, setOver] = useState(false);
  const [canSkip, setCanSkip] = useState(false);
  const [opts, setOpts] = useState({ checks: true, freq: 'sometimes', aiReaders: true, blind: false, precheck: me.checks ?? me.ai });
  const skipOcr = useRef(false);
  const input = useRef(null);
  const folder = useRef(null);
  const pdfIn = useRef(null);
  const [given, setGiven] = useState(null);
  // "Proofread together" from Rykhet LaTeX: the project arrives here and is read like a dropped folder
  const handoff = useRef(new URLSearchParams(location.search).get('handoff'));
  const [from, setFrom] = useState(null);
  useEffect(() => {
    const hid = handoff.current;
    if (!hid || !/^[A-Za-z0-9_-]{8,64}$/.test(hid)) return;
    (async () => {
      setStage('reading'); setProg({ v: 0.02, msg: 'Fetching the paper from Rykhet LaTeX…' });
      try {
        const h = await api(`/api/handoff/${hid}`);
        const dir = (h.name || 'paper').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'paper';
        const b64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
        const files = h.files.map(f => { const x = new File([typeof f.text === 'string' ? f.text : b64(f.base64)], f.path.split('/').pop()); x.relPath = `${dir}/${f.path}`; return x; });
        const pdfName = (h.main || 'main.tex').replace(/\.tex$/i, '.pdf');
        if (h.pdf && !h.files.some(f => f.path === pdfName)) { const x = new File([b64(h.pdf)], pdfName.split('/').pop(), { type: 'application/pdf' }); x.relPath = `${dir}/${pdfName}`; files.push(x); }
        setFrom({ name: h.name, pdf: !!h.pdf });
        await start(files, { main: h.main });
        setTitle(t => t || h.name);
      } catch (e) { toastError(e); handoff.current = null; setStage('pick'); }
    })();
  }, []);
  const start = async (files, choice = {}) => {
    if (!files || !files.length) return;
    const all = [...files];
    const essential = f => /\.(pdf|tex|zip|bib|bbl)$/i.test(f.name);
    const big = all.filter(f => f.size > 80 * 1024 * 1024);
    if (big.some(essential) || (all.length === 1 && big.length)) return toast(`${big[0].name} is larger than 80 MB.`, 'bad');
    if (big.length) { toast(`Skipped ${big.length} large file${big.length === 1 ? '' : 's'} that ${big.length === 1 ? 'is' : 'are'} not part of the manuscript (${big.slice(0, 3).map(f => f.name).join(', ')}).`, 'info', 7000); files = all.filter(f => !big.includes(f)); }
    setStage('reading'); skipOcr.current = false; setCanSkip(false); setGiven([...files]);
    try {
      const d = await readAll(files, (v, msg, ocrStage) => { setProg({ v, msg }); if (ocrStage) setCanSkip(true); }, skipOcr, choice);
      setDoc(d); setTitle(d.title || ''); setStage('review');
    } catch (e) { console.error(e); toastError(e); setStage('pick'); }
  };
  const drop = async e => { e.preventDefault(); setOver(false); start(await filesFromDrop(e.dataTransfer)); };
  const rereadMain = main => start(given, { main, gathered: doc.gathered });
  const addPdf = f => { if (f) start([...given.filter(x => ext(x) !== 'pdf' || /(^|\/)(fig|figs|figures)\//i.test(relPath(x))), f], { main: doc.source.main, gathered: doc.gathered }); };
  const create = async () => {
    setStage('creating'); setProg({ v: 0, msg: 'Creating the Proof Room…' });
    try {
      const settings = { checks: { enabled: opts.checks, freq: opts.freq, requirePass: true }, ai: { readers: opts.aiReaders }, blind: opts.blind };
      const { id } = await api('/api/projects', { method: 'POST', body: { ...payload(doc, title.trim() || doc.title, settings), handoff: handoff.current || undefined } });
      await uploadAssets(id, doc, (v, msg) => setProg({ v, msg }));
      if (opts.precheck) await api(`/api/projects/${id}/ai/precheck`, { method: 'POST', body: {} }).catch(e => toast(e.message, 'bad'));
      if (from) { toast('Your Proof Room is ready and linked to Rykhet LaTeX. Invite the people who should proofread it.', 'ok', 8000); navigate(`/app/p/${id}/people`); return; }
      toast('Your Proof Room is ready.', 'ok');
      navigate(`/app/p/${id}?welcome=1`);
    } catch (e) { toastError(e); setStage('review'); }
  };
  const counts = doc ? {
    paras: doc.blocks.filter(b => ['para', 'abstract', 'list', 'title', 'caption', 'equation', 'footnote'].includes(b.kind)).length,
    words: doc.blocks.filter(b => ['para', 'abstract', 'list'].includes(b.kind)).reduce((n, b) => n + b.text.split(/\s+/).length, 0),
    figData: doc.figures.filter(f => f.data && f.data.series && f.data.series.length).length,
    figOcr: doc.figures.filter(f => f.ocr).length,
  } : null;
  return html`<${Topbar} active="new" /><main class="wrap page">
    <div class="page-head"><div><div class="eyebrow">${Icon('upload')} New manuscript</div><h1>Bring a finished paper to the Proof Room</h1><p class="muted">Your file is read in this browser: paragraphs, sections, tables, figures and references. You review what was found before anything is uploaded.</p></div></div>
    ${stage === 'pick' ? html`<div class="new-grid">
      <label class=${`drop ${over ? 'over' : ''}`} onDragOver=${e => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${drop}>
        <input ref=${input} type="file" class="sr" multiple accept=".pdf,.tex,.zip,.bib,.bbl,.png,.jpg,.jpeg,.dat,.csv,.sty,.cls" onChange=${e => start(e.target.files)} />
        <div class="drop-ill"><div class="sheet s1"></div><div class="sheet s2"></div><div class="sheet s3">${Icon('doc')}</div></div>
        <h2>Drop your manuscript here</h2>
        <p>A PDF exported from LaTeX or Word — or your whole LaTeX project: drop the folder (or a .zip). If the folder has the compiled PDF, readers also see each paragraph as typeset, and accepted changes go straight back into your .tex files.</p>
        <div class="row-wrap" style="justify-content:center"><span class="btn btn-primary">${Icon('upload')} Choose files</span><button type="button" class="btn btn-ghost" onClick=${e => { e.preventDefault(); e.stopPropagation(); folder.current.click(); }}>${Icon('layers')} Choose a LaTeX folder</button></div>
        <input ref=${folder} type="file" class="sr" webkitdirectory directory multiple onChange=${e => start(e.target.files)} onClick=${e => e.stopPropagation()} />
        <div class="types"><span>.pdf</span><span>.zip</span><span>.tex</span><span>.bib</span><span>.bbl</span><span>figures</span></div>
      </label>
      <div class="col">
        <div class="card side-card"><h3>What happens next</h3>
          <ol class="steps"><li><b>Read & split</b><span>into paragraphs, with figures, tables, equations and the reference list.</span></li><li><b>Check</b><span>consistency checks, ${me.ai ? 'AI proofreading, numbers vs. tables & figures, references via RefCheck.' : 'numbers vs. tables & figures.'}</span></li><li><b>Invite</b><span>proofreaders by email — they sign in and read paragraph by paragraph.</span></li><li><b>Fix & export</b><span>accept suggestions with full history and undo; export an annotated PDF, revised LaTeX or a change list.</span></li></ol>
        </div>
        <div class="privacy">${Icon('shield')}<div><b>Private by design.</b> Files are encrypted at rest on the server and only people you invite can open them. Proofreaders see page images, not your original file, unless you allow downloads.</div></div>
      </div>
    </div>` : null}
    ${stage === 'reading' || stage === 'creating' ? html`<div class="card reading"><div class="reading-ill"><${Spinner} /></div><h2 class="serif">${stage === 'reading' ? 'Reading your manuscript' : 'Setting up the Proof Room'}</h2><p class="muted">${prog.msg}</p><div class="reading-bar"><${Bar} value=${prog.v} /></div>
      ${stage === 'reading' && canSkip ? html`<button class="btn btn-text btn-sm" onClick=${() => { skipOcr.current = true; }}>Skip text recognition in images</button>` : null}</div>` : null}
    ${stage === 'review' && doc ? html`<div class="review">
      <div class="card review-main">
        ${from ? html`<div class="pair ok">${Icon('external')} <div><b>From Rykhet LaTeX:</b> ${from.name}${from.pdf ? ', with the PDF compiled there' : ', without a compiled PDF (compile in the editor and send again to show the paper as typeset)'}. The project stays linked: after you edit in the editor, “Send to Studio” brings the changes here to review and re-check.</div></div>` : null}
        <label class="field"><span>Title</span><input class="input title-input" value=${title} onInput=${e => setTitle(e.target.value)} /></label>
        ${doc.kind === 'latex' ? html`<div class="latex-box">
          <div class="row-wrap"><span class="chip c-brand">${Icon('doc')} LaTeX project</span><span class="small muted">${plural(doc.gathered.files.size, 'file')}</span>
            ${doc.mainCandidates.length > 1 ? html`<label class="small row">Main document <select class="input sm" value=${doc.source.main} onChange=${e => rereadMain(e.target.value)}>${doc.mainCandidates.map(m => html`<option value=${m}>${m}</option>`)}</select></label>` : html`<span class="small">main: <b class="mono">${doc.source.main}</b></span>`}</div>
          ${doc.pair ? html`<div class="pair ok">${Icon('check')} <div><b>Typeset view from ${doc.source.pdfName}</b>: ${doc.pair.placed} of ${doc.pair.total} blocks matched to the compiled PDF. Readers see paragraphs as typeset; edits change the .tex source.</div></div>`
            : html`<div class="pair">${Icon('info')} <div><b>No compiled PDF found.</b> Readers will see the rendered LaTeX. Add the PDF you built (e.g. ${doc.source.main.replace(/\.tex$/, '.pdf')}) to show paragraphs as typeset. <button class="btn btn-ghost btn-sm" onClick=${() => pdfIn.current.click()}>${Icon('upload')} Add compiled PDF</button><input ref=${pdfIn} type="file" class="sr" accept=".pdf" onChange=${e => addPdf(e.target.files[0])} /></div></div>`}
        </div>` : null}
        <div class="stat-grid">
          <div class="stat"><b>${counts.paras}</b><span>blocks to read</span></div>
          <div class="stat"><b>${doc.sections.filter(s => s.title !== 'Abstract').length}</b><span>sections</span></div>
          <div class="stat"><b>${counts.words.toLocaleString()}</b><span>words</span></div>
          <div class="stat"><b>${doc.figures.length}</b><span>figures${counts.figData ? html` · <em>${counts.figData} with data</em>` : ''}</span></div>
          <div class="stat"><b>${doc.tables.length}</b><span>tables</span></div>
          <div class="stat"><b>${doc.refs.length}</b><span>references</span></div>
        </div>
        ${(doc.source.notes || []).length ? html`<ul class="notes">${doc.source.notes.map(n => html`<li>${Icon('info')} ${n}</li>`)}</ul>` : null}
        <h3 class="mini-h">Outline</h3>
        <div class="outline-prev">${doc.sections.slice(0, 40).map(s => html`<div class=${`ol-l${s.level}`}>${s.num ? html`<span class="mono faint">${s.num}</span> ` : ''}${s.title}</div>`)}${doc.sections.length > 40 ? html`<div class="faint">… ${doc.sections.length - 40} more</div>` : ''}</div>
        <h3 class="mini-h">First paragraphs</h3>
        <div class="para-prev">${doc.blocks.filter(b => ['para', 'abstract'].includes(b.kind)).slice(0, 3).map(b => { const t = b.tex ? tk.renderTex(b.text, doc.latex) : b.text; return html`<p>${t.length > 420 ? t.slice(0, 420) + '…' : t}</p>`; })}</div>
      </div>
      <div class="col">
        <div class="card side-card"><h3>Proofreading settings</h3>
          <div class="opt"><div><b>Reading checks</b><span>${me.ai ? 'Short AI-written questions' : 'Short fill-in-the-blank questions'} after some paragraphs confirm the reader actually read them.</span></div><label class="switch"><input type="checkbox" checked=${opts.checks} onChange=${e => setOpts({ ...opts, checks: e.target.checked })} /><span></span></label></div>
          ${opts.checks ? html`<div class="opt sub"><div><b>How often</b></div><div class="seg">${[['every', 'Every'], ['often', 'Often'], ['sometimes', 'Sometimes'], ['rare', 'Rarely']].map(([k, l]) => html`<button class=${opts.freq === k ? 'on' : ''} onClick=${() => setOpts({ ...opts, freq: k })}>${l}</button>`)}</div></div>` : null}
          ${me.ai ? html`<div class="opt"><div><b>AI help for readers</b><span>Readers can ask the AI to review a paragraph or explain it.</span></div><label class="switch"><input type="checkbox" checked=${opts.aiReaders} onChange=${e => setOpts({ ...opts, aiReaders: e.target.checked })} /><span></span></label></div>` : null}
          <div class="opt"><div><b>Independent review</b><span>Readers don’t see each other’s suggestions (less herding).</span></div><label class="switch"><input type="checkbox" checked=${opts.blind} onChange=${e => setOpts({ ...opts, blind: e.target.checked })} /><span></span></label></div>
          <div class="opt"><div><b>Run the full check now</b><span>${me.ai ? 'Consistency, AI proofreading, numbers vs. tables & figures, references.' : 'Consistency, reading questions, numbers vs. tables & figures.'}</span></div><label class="switch"><input type="checkbox" disabled=${!(me.checks ?? me.ai)} checked=${opts.precheck} onChange=${e => setOpts({ ...opts, precheck: e.target.checked })} /><span></span></label></div>
        </div>
        <button class="btn btn-primary btn-lg" onClick=${create}>${Icon('check')} Create the Proof Room</button>
        <button class="btn btn-text" onClick=${() => { setStage('pick'); setDoc(null); }}>Choose another file</button>
      </div>
    </div>` : null}
  </main>`;
}
