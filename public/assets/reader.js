/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** The Proof Room: read one paragraph at a time, suggest, comment, get AI help, answer reading checks. */
import { promptDialog } from './lib.js';
import { html, useState, useEffect, useRef, useMemo, useCallback, api, getStore, useStore, navigate, Icon, Avatar, Diff, Spinner, Bar, toast, toastError, openModal, closeModal, useKeys, CATS, catLabel, secLabel, blockPlain, tk, plural, fmtMin, KIND_LABEL, TexView, fmtDay, copyText } from './lib.js';
import { BlockBody, SuggestionCard, IssueCard, referencedItems, RefItem, blockLabel, MARK_COLORS } from './blocks.js';

/**
 * How a paragraph is being read: active ms (tab visible, the window in use, not idle for a minute), idle ms, how often
 * the reader left the tab, and how much of the paragraph has been scrolled into view (0-1, of its current height).
 * `get()` gives the numbers sent with "Mark as read"; `live` re-renders twice a second while the button waits.
 */
const IDLE_MS = 60000;
function useReading(key, elRef) {
  const st = useRef(null);
  const [live, setLive] = useState({ ms: 0, seen: 0 });
  useEffect(() => {
    const s = st.current = { ms: 0, idle: 0, hid: 0, seenPx: 0, lastAct: Date.now(), lastPtr: 0, tick: performance.now() };
    const seenNow = () => {
      const el = elRef.current, main = document.querySelector('.r-main');
      if (!el) return 0;
      const r = el.getBoundingClientRect(), vp = main ? main.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      if (r.height < 4) return 0;
      s.seenPx = Math.max(s.seenPx, Math.min(r.bottom, vp.bottom) - r.top);
      return Math.max(0, Math.min(1, s.seenPx / r.height));
    };
    const act = e => { s.lastAct = Date.now(); if (e && /mouse|pointer|wheel|touch/.test(e.type)) s.lastPtr = Date.now(); };
    const away = () => { if (document.visibilityState !== 'visible') s.hid++; };
    const blur = () => { s.hid++; };
    const evs = ['mousemove', 'pointerdown', 'wheel', 'keydown', 'touchstart', 'scroll'];
    for (const e of evs) window.addEventListener(e, act, { passive: true, capture: true });
    document.addEventListener('visibilitychange', away);
    window.addEventListener('blur', blur);
    const t = setInterval(() => {
      const now = performance.now(), dt = Math.min(2000, now - s.tick); s.tick = now;
      const inUse = document.hasFocus() || Date.now() - s.lastPtr < 15000;
      if (document.visibilityState === 'visible' && inUse && Date.now() - s.lastAct < IDLE_MS) s.ms += dt; else s.idle += dt;
      setLive({ ms: s.ms, seen: seenNow() });
    }, 500);
    return () => { clearInterval(t); for (const e of evs) window.removeEventListener(e, act, { capture: true }); document.removeEventListener('visibilitychange', away); window.removeEventListener('blur', blur); };
  }, [key]);
  const get = () => { const s = st.current || { ms: 0, idle: 0, hid: 0 }; return { ms: Math.round(s.ms), idle: Math.round(s.idle), hid: s.hid, seen: +live.seen.toFixed(3) }; };
  return { live, get };
}

export function Reader({ id, bid }) {
  const store = getStore(id);
  const p = useStore(store);
  if (store.error) return html`<div class="reader-err card pad-lg center"><h2 class="serif">Can’t open this manuscript</h2><p class="muted">${store.error.message}</p><a class="btn btn-ghost" href="/app">Back</a></div>`;
  if (!p) return html`<div class="boot"><${Spinner} /></div>`;
  return html`<${ReaderInner} p=${p} store=${store} bid=${bid} />`;
}

function ReaderInner({ p, store, bid }) {
  const reading = p.reading;
  const myProg = (p.progress || {})[p.me.sub] || { read: {} };
  const firstUnread = reading.findIndex(b => !(myProg.read || {})[b.id]);
  const initial = Math.max(0, bid ? reading.findIndex(b => b.id === bid) : myProg.cur ? reading.findIndex(b => b.id === myProg.cur) : firstUnread);
  const [idx, setIdx] = useState(initial < 0 ? 0 : initial);
  const [panel, setPanel] = useState(null); // 'edit' | 'comment' | null
  const [side, setSide] = useState('sugs');
  const [view, setView] = useState('page');
  const [drawing, setDrawing] = useState(false);
  const [markColor, setMarkColor] = useState(() => { try { return localStorage.getItem('studio-mark') || 'yellow'; } catch { return 'yellow'; } });
  const pickColor = c => { setMarkColor(c); try { localStorage.setItem('studio-mark', c); } catch { /* blocked */ } };
  const mark = async (body, askNote = false) => {
    let note = '';
    if (askNote) { const t = await promptDialog({ title: 'Mark this area', body: 'Add a note for the author (optional).', placeholder: 'e.g. this symbol is not defined', ok: 'Mark' }); if (t === null) return; note = t; }
    try { await api(`/api/projects/${p.id}/suggestions`, { method: 'POST', body: { bid: b.id, kind: 'mark', color: markColor, note, ...body } }); toast('Marked', 'ok', 2000); setSide('sugs'); } catch (e) { toastError(e); }
  };
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [cat, setCat] = useState('wording');
  const [quote, setQuote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reread, setReread] = useState(false);
  const [readLocal, setReadLocal] = useState(() => new Set(Object.keys(myProg.read || {})));
  const [outline, setOutline] = useState(() => window.innerWidth > 1280);
  const b = reading[idx];
  const paperRef = useRef(null);
  const rd = useReading(b && b.id, paperRef);
  // pace: a paragraph can be marked read once it has had time to be read (at most READ_WPM words a minute of active
  // reading, the same rule the server applies) and its end has been on screen; the owner is exempt unless checked too
  const words = b ? tk.countWords(blockPlain(p, b)) : 0;
  const paced = !!b && p.settings.checks.enabled && p.settings.checks.pace !== false && (p.role !== 'owner' || p.settings.checks.owner) && ['abstract', 'para', 'list'].includes(b.kind) && words >= 30 && !readLocal.has(b.id) && !reread;
  const needMs = paced ? Math.min(120000, words / ((p.pace && p.pace.wpm) || 500) * 60000) : 0;
  const waitMs = Math.max(0, needMs - rd.live.ms);
  const unseen = paced && rd.live.seen < 0.9;
  const held = paced && (waitMs > 0 || unseen);
  const total = reading.length;
  const readCount = readLocal.size;
  const sugs = p.suggestions.filter(s => s.bid === (b && b.id) && s.status !== 'withdrawn');
  const watermark = p.settings.watermark && p.role !== 'owner' ? p.me.email : null;

  useEffect(() => {
    if (!b) return;
    history.replaceState({}, '', `/app/p/${p.id}/read/${b.id}`);
    api(`/api/projects/${p.id}/read`, { method: 'POST', body: { bid: b.id, view: true } }).catch(() => {});
    setPanel(null); setReread(false); setQuote('');
    const el = document.querySelector('.r-main'); if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    const o = document.querySelector(`.r-outline [data-bid="${b.id}"]`); if (o) o.scrollIntoView({ block: 'nearest' });
  }, [b && b.id]);
  useEffect(() => { if (!sessionStorage.getItem(`studio-intro-${p.id}`)) { sessionStorage.setItem(`studio-intro-${p.id}`, '1'); showIntro(p); } }, []);

  const go = i => { if (i >= 0 && i < total) setIdx(i); };
  const startEdit = (text = null, q = '') => { setDraft(text ?? b.cur); setNote(''); setCat(q ? 'grammar' : 'wording'); setQuote(q); setPanel('edit'); setTimeout(() => { const t = document.querySelector('.r-editor textarea'); if (t) { t.focus(); if (q) { const at = t.value.indexOf(q); if (at >= 0) t.setSelectionRange(at, at + q.length); } } }, 30); };
  const startComment = (q = '') => { setNote(''); setQuote(q); setPanel('comment'); setTimeout(() => { const t = document.querySelector('.r-comment textarea'); if (t) t.focus(); }, 30); };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (panel === 'edit') { if (draft === b.cur) { toast('Nothing changed yet.', 'info'); setBusy(false); return; } await api(`/api/projects/${p.id}/suggestions`, { method: 'POST', body: { bid: b.id, kind: 'edit', text: draft, note, cat, quote: quote || undefined } }); toast('Suggestion saved', 'ok'); }
      else { if (!note.trim()) { setBusy(false); return; } await api(`/api/projects/${p.id}/suggestions`, { method: 'POST', body: { bid: b.id, kind: 'comment', note, quote: quote || undefined, cat: 'comment' } }); toast('Comment saved', 'ok'); }
      setPanel(null); setSide('sugs');
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const next = async () => {
    if (!b || busy) return;
    if (held) { toast(waitMs > 0 ? `Keep reading: ${Math.ceil(waitMs / 1000)} s more for this paragraph.` : 'Scroll to the end of the paragraph first.', 'info', 2500); return; }
    setBusy(true);
    try {
      const r = await api(`/api/projects/${p.id}/read`, { method: 'POST', body: { bid: b.id, ...rd.get() } });
      if (r.check) { setBusy(false); return runCheck(r.check); }
      markRead(r);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const markRead = r => {
    setReadLocal(s => new Set([...s, b.id]));
    setReread(false);
    if (r && r.finished) return finished();
    const n = reading.findIndex((x, i) => i > idx && !readLocal.has(x.id));
    if (n >= 0) go(n); else if (idx < total - 1) go(idx + 1); else if (readLocal.size + 1 >= total) finished();
  };
  const runCheck = chk => {
    openModal(close => html`<${CheckModal} p=${p} chk=${chk} onDone=${res => { close(); if (res.correct || res.final) markRead(res); else { setReread(true); toast('Take another look at the paragraph, then continue.', 'info', 5000); } }} />`, { locked: true, cls: 'check-modal' });
  };
  const finished = () => openModal(close => html`<${Finished} p=${p} close=${close} />`);

  useKeys({
    ArrowRight: () => go(idx + 1), ArrowLeft: () => go(idx - 1), Enter: () => !panel && next(),
    e: () => startEdit(), c: () => startComment(), m: () => { if (view === 'page') setDrawing(d => !d); }, a: () => setSide('ai'), t: () => setView(v => (v === 'page' ? 'text' : 'page')), '?': () => showKeys(),
    'mod+Enter': () => panel && submit(), Escape: () => setPanel(null),
  }, [idx, panel, draft, note, cat, busy, b && b.id, readLocal, held]);

  // selection → comment / suggest
  const [sel, setSel] = useState(null);
  const onMouseUp = () => {
    const s = window.getSelection();
    const t = s && s.toString().trim();
    if (!t || t.length > 400) { setSel(null); return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    setSel({ text: t, x: r.left + r.width / 2, y: r.top });
  };
  useEffect(() => { const f = () => setSel(null); window.addEventListener('scroll', f, true); return () => window.removeEventListener('scroll', f, true); }, []);

  if (!b) return html`<div class="reader-err card pad-lg center"><h2 class="serif">Nothing to read</h2><a class="btn btn-ghost" href=${`/app/p/${p.id}`}>Back</a></div>`;
  const others = (p.presence || []).filter(x => x.sub !== p.me.sub);
  const review = p.ai.review[b.id];
  const lint = (p.lint && p.lint.issues || []).filter(i => i.bid === b.id);
  const claims = (p.evidence && p.evidence.claims || []).filter(c => c.bid === b.id);
  const refItems = referencedItems(p, b);
  const isRead = readLocal.has(b.id);
  const myRead = (myProg.read || {})[b.id];
  const secs = p.sections || [];
  return html`<div class="reader">
    <header class="r-top">
      <a class="btn btn-text btn-sm" href=${`/app/p/${p.id}`} title="Back to the manuscript">${Icon('arrowL')}</a>
      <button class="btn btn-text btn-sm hide-sm" onClick=${() => setOutline(o => !o)} title="Outline">${Icon('layout')}</button>
      <div class="r-title"><b>${p.title}</b><span class="faint small">Proof Room · ${p.role}</span></div>
      <div class="r-prog"><span class="small"><b>${readCount}</b> / ${total} read</span><${Bar} value=${readCount / total} /></div>
      <div class="r-pres">${others.slice(0, 5).map(x => html`<${Avatar} name=${x.name} sub=${x.sub} size=${26} ring title=${`${x.name}${x.bid && p.blockById.get(x.bid) ? ` — on ${blockLabel(p, p.blockById.get(x.bid))}` : ''}`} />`)}</div>
      <button class="btn btn-text btn-sm" onClick=${() => showIntro(p)} title="How it works">${Icon('info')}</button>
      <button class="btn btn-text btn-sm hide-sm" onClick=${showKeys} title="Keyboard shortcuts"><span class="kbd">?</span></button>
    </header>
    <div class=${`r-body ${outline ? '' : 'no-outline'}`}>
      ${outline ? html`<aside class="r-outline">${outlineItems(p, reading, readLocal, idx, go, secs)}</aside>` : null}
      <main class="r-main" onMouseUp=${onMouseUp}>
        <div class="r-col">
          <div class="r-meta"><span class="chip">${KIND_LABEL[b.kind] || 'Paragraph'}</span><span>${secLabel(p, b) || 'Front matter'}</span>${b.page ? html`<span class="faint">page ${b.page}</span>` : null}<span class="grow"></span>
            ${p.source.pageImages && b.boxes && b.boxes.length ? html`<div class="paper-tabs seg" role="tablist" aria-label="View"><button class=${view === 'page' ? 'on' : ''} onClick=${() => setView('page')}>As typeset</button><button class=${view === 'text' ? 'on' : ''} onClick=${() => setView('text')}>Text</button></div>` : null}
            <span class="faint nowrap">${idx + 1} of ${total}</span></div>
          ${reread ? html`<div class="reread">${Icon('eye')} <div><b>Read this paragraph again carefully.</b> When you’re ready, press <span class="kbd">Enter</span> for another question.</div></div>` : null}
          <article ref=${paperRef} class=${`paper ${isRead ? 'is-read' : ''}`}>
            <${BlockBody} p=${p} b=${b} mode=${view === 'text' ? 'text' : 'auto'} showChanges=${true} big watermark=${watermark} drawing=${drawing && view === 'page'} onArea=${area => { setDrawing(false); mark({ area }, true); }} onMarkClick=${() => setSide('sugs')} />
            ${drawing && view === 'page' ? html`<div class="draw-hint">${Icon('crosshair')} Drag over the page to mark an area · <button class="btn btn-text btn-sm" onClick=${() => setDrawing(false)}>Cancel</button></div>` : null}
            ${p.source.kind === 'pdf' && view === 'page' && b.cur !== b.text ? null : null}
            ${isRead ? html`<div class="read-stamp">${Icon('check')} Read${myRead && myRead.ok === true ? ' · check passed' : ''}</div>` : null}
          </article>
          ${panel === 'edit' ? html`<div class="card r-editor">
            <div class="row"><b class="grow">${Icon('edit')} Suggest a correction</b><span class="faint tiny">${b.tex ? 'LaTeX source' : p.source.kind === 'pdf' ? 'text extracted from the PDF' : ''}</span></div>
            <textarea class="input" rows=${Math.min(16, Math.max(5, Math.ceil(draft.length / 90)))} value=${draft} onInput=${e => setDraft(e.target.value)} spellcheck="true"></textarea>
            <div class="diff-live text-view">${draft === b.cur ? html`<span class="faint">Edit the text above — your changes appear here.</span>` : html`<${Diff} a=${b.cur} b=${draft} />`}</div>
            <div class="cats">${CATS.filter(c => c[0] !== 'other').map(([k, l]) => html`<button class=${`chip-btn ${cat === k ? 'on' : ''}`} onClick=${() => setCat(k)}>${l}</button>`)}</div>
            <input class="input" placeholder="Why? (optional, helps the author)" value=${note} onInput=${e => setNote(e.target.value)} />
            <div class="row"><button class="btn btn-primary" disabled=${busy || draft === b.cur} onClick=${submit}>${Icon('check')} Save suggestion <span class="kbd light">Ctrl ↵</span></button><button class="btn btn-text" onClick=${() => setPanel(null)}>Cancel</button></div>
          </div>` : null}
          ${panel === 'comment' ? html`<div class="card r-comment">
            <b>${Icon('comment')} Comment${quote ? ' on a selection' : ''}</b>
            ${quote ? html`<div class="sug-quote">“${quote}”</div>` : null}
            <textarea class="input" rows="4" placeholder="A question, a doubt, a remark for the author…" value=${note} onInput=${e => setNote(e.target.value)}></textarea>
            <div class="row"><button class="btn btn-primary" disabled=${busy || !note.trim()} onClick=${submit}>${Icon('send')} Post comment</button><button class="btn btn-text" onClick=${() => setPanel(null)}>Cancel</button></div>
          </div>` : null}
          ${!panel ? html`<div class="r-tools">
            <button class="btn btn-ghost" onClick=${() => startEdit()}>${Icon('edit')} Suggest edit <span class="kbd">E</span></button>
            <button class="btn btn-ghost" onClick=${() => startComment()}>${Icon('comment')} Comment <span class="kbd">C</span></button>
            ${p.source.pageImages && b.boxes && b.boxes.length && view === 'page' ? html`<button class=${`btn btn-ghost ${drawing ? 'on' : ''}`} onClick=${() => setDrawing(d => !d)} title="Mark an area of the typeset paragraph">${Icon('crosshair')} Mark area <span class="kbd">M</span></button>` : html`<span class="tip-inline faint small">${Icon('pin')} Select text to highlight it</span>`}
            <span class="swatches" title="Highlight colour">${MARK_COLORS.map(([c, l]) => html`<button class=${`sw sw-${c} ${markColor === c ? 'on' : ''}`} aria-label=${l} onClick=${() => pickColor(c)}></button>`)}</span>
            ${p.ai.enabled && (p.ai.readers || p.canDecide) ? html`<button class="btn btn-ai" onClick=${() => setSide('ai')}>${Icon('sparkle')} AI help <span class="kbd">A</span></button>` : null}
          </div>` : null}
          <div class="r-nav">
            <button class="btn btn-ghost" disabled=${idx === 0} onClick=${() => go(idx - 1)}>${Icon('chevL')} Previous</button>
            <button class=${`btn btn-primary btn-lg grow-sm ${held ? 'held' : ''}`} style=${held ? `--fill:${Math.round(100 * Math.min(1, needMs ? rd.live.ms / needMs : 1))}%` : ''} disabled=${busy} onClick=${next} title=${held ? 'Each paragraph needs a moment of reading, and its end must be on screen, before you continue' : ''}>${busy ? html`<${Spinner} small />` : null} ${held ? (waitMs > 0 ? html`${Icon('clock')} Keep reading · ${Math.ceil(waitMs / 1000)} s` : html`${Icon('chevD')} Scroll to the end`) : html`${reread ? 'Ask me again' : isRead ? 'Next' : 'Mark as read & continue'} ${Icon('arrowR')} <span class="kbd light">↵</span>`}</button>
          </div>
          ${p.settings.checks.enabled && p.role === 'owner' && !p.settings.checks.owner ? html`<p class="faint tiny owner-checks">${Icon('target')} Reading checks go to your proofreaders; as the owner you are not asked. <button class="btn btn-text btn-sm" onClick=${() => askOwnerToo(p)}>Ask me too</button></p>` : null}
          ${p.settings.instructions && idx === 0 ? html`<div class="note-box"><b>From the owner</b><p>${p.settings.instructions}</p></div>` : null}
        </div>
      </main>
      <aside class="r-side">
        <div class="side-tabs">
          <button class=${side === 'sugs' ? 'on' : ''} onClick=${() => setSide('sugs')}>${Icon('comment')} Notes ${sugs.length ? html`<span class="count">${sugs.length}</span>` : ''}</button>
          ${p.ai.enabled && (p.ai.readers || p.canDecide) ? html`<button class=${side === 'ai' ? 'on' : ''} onClick=${() => setSide('ai')}>${Icon('sparkle')} AI ${review && review.issues.length ? html`<span class="count ai">${review.issues.length}</span>` : ''}</button>` : null}
          <button class=${side === 'checks' ? 'on' : ''} onClick=${() => setSide('checks')}>${Icon('target')} Checks ${lint.length + claims.filter(c => ['mismatch', 'partly'].includes(c.override || c.verdict)).length ? html`<span class="count warn">${lint.length + claims.filter(c => ['mismatch', 'partly'].includes(c.override || c.verdict)).length}</span>` : ''}</button>
          <button class=${side === 'ctx' ? 'on' : ''} onClick=${() => setSide('ctx')}>${Icon('layers')} Context ${refItems.length ? html`<span class="count">${refItems.length}</span>` : ''}</button>
        </div>
        <div class="side-body">
          ${side === 'sugs' ? html`${sugs.length ? sugs.map(s => html`<${SuggestionCard} p=${p} s=${s} key=${s.id} />`) : html`<div class="side-empty">${Icon('edit')}<p>No suggestions on this ${b.kind === 'para' ? 'paragraph' : 'block'} yet.${p.settings.blind && !p.canDecide ? ' (Independent review: you see only your own.)' : ''}</p><button class="btn btn-soft btn-sm" onClick=${() => startEdit()}>Suggest an edit</button></div>`}` : null}
          ${side === 'ai' ? html`<${AiPanel} p=${p} b=${b} review=${review} onUse=${t => startEdit(t)} />` : null}
          ${side === 'checks' ? html`<div class="col">${lint.length ? lint.map(i => html`<${IssueCard} p=${p} b=${b} issue=${i} kind="lint" key=${i.id} />`) : null}
            ${claims.map(c => html`<${ClaimMini} c=${c} />`)}
            ${!lint.length && !claims.length ? html`<div class="side-empty">${Icon('check')}<p>No automatic findings for this paragraph.</p></div>` : null}</div>` : null}
          ${side === 'ctx' ? html`<div class="col">${refItems.length ? refItems.map(r => html`<${RefItem} p=${p} r=${r} />`) : html`<div class="side-empty">${Icon('layers')}<p>This paragraph doesn’t mention a figure or table.</p></div>`}
            ${idx > 0 ? html`<div class="ctx-near"><span class="faint tiny">Previous</span><div class="text-view small">${blockPlain(p, reading[idx - 1]).slice(-300)}</div></div>` : null}
            ${idx < total - 1 ? html`<div class="ctx-near"><span class="faint tiny">Next</span><div class="text-view small">${blockPlain(p, reading[idx + 1]).slice(0, 300)}…</div></div>` : null}</div>` : null}
        </div>
      </aside>
    </div>
    ${sel ? html`<div class="sel-pop" style=${`left:${sel.x}px;top:${sel.y}px`} onMouseDown=${e => e.preventDefault()}>
      ${MARK_COLORS.map(([c, l]) => html`<button class=${`sel-sw sw-${c}`} title=${`Highlight ${l.toLowerCase()}`} aria-label=${`Highlight ${l}`} onClick=${() => { pickColor(c); mark({ quote: sel.text }); setSel(null); window.getSelection().removeAllRanges(); }}></button>`)}
      <button onClick=${() => { startComment(sel.text); setSel(null); }}>${Icon('comment')} Comment</button>
      <button onClick=${() => { startEdit(null, sel.text); setSel(null); }}>${Icon('edit')} Suggest change</button>
      ${p.ai.enabled && (p.ai.readers || p.canDecide) ? html`<button onClick=${() => { copyText(sel.text); setSel(null); }}>${Icon('copy')}</button>` : null}
    </div>` : null}
  </div>`;
}

function outlineItems(p, reading, readLocal, idx, go) {
  const out = [];
  let lastSec = undefined;
  reading.forEach((b, i) => {
    if (b.sec !== lastSec) { const s = p.secById.get(b.sec); out.push(html`<div class=${`ro-sec l${s ? s.level : 1}`}>${s ? `${s.num ? s.num + ' ' : ''}${s.title}` : 'Front matter'}</div>`); lastSec = b.sec; }
    const open = p.suggestions.filter(s => s.bid === b.id && s.status === 'open').length;
    out.push(html`<button data-bid=${b.id} class=${`ro-item ${i === idx ? 'cur' : ''} ${readLocal.has(b.id) ? 'read' : ''}`} onClick=${() => go(i)} title=${blockPlain(p, b).slice(0, 140)}><i></i><span>${b.kind === 'para' ? blockPlain(p, b).slice(0, 46) : `${KIND_LABEL[b.kind]}${b.kind === 'caption' ? ' · ' + blockPlain(p, b).slice(0, 30) : ''}`}</span>${open ? html`<em>${open}</em>` : null}</button>`);
  });
  return out;
}

function ClaimMini({ c }) {
  const v = c.override || c.verdict;
  const map = { consistent: ['c-ok', 'Matches the evidence'], mismatch: ['c-bad', 'Does not match'], partly: ['c-warn', 'Partly matches'], unverifiable: ['', 'Cannot verify'], unlinked: ['', 'No evidence linked'], dismissed: ['', 'Dismissed'] };
  const [cls, l] = map[v] || ['', v || 'not checked'];
  return html`<div class=${`issue claim v-${v}`}><div class="issue-head"><span class=${`chip ${cls}`}>${Icon('graph')} ${l}</span>${c.refers.map(r => html`<span class="chip">${r.label}</span>`)}</div><div class="text-view small">“${c.quote}”</div>${c.explain ? html`<div class="issue-why">${c.explain}</div>` : null}${c.expected ? html`<div class="issue-why"><b>Evidence shows:</b> ${c.expected}${c.where ? ` (${c.where})` : ''}</div>` : null}</div>`;
}

function AiPanel({ p, b, review, onUse }) {
  const [busy, setBusy] = useState(null);
  const [rw, setRw] = useState(null);
  const [q, setQ] = useState('');
  const [chat, setChat] = useState([]);
  useEffect(() => { setRw(null); setChat([]); }, [b.id]);
  const stale = review && review.ver !== (b.ver || 0);
  const run = async () => { setBusy('review'); try { await api(`/api/projects/${p.id}/ai/review/${b.id}`, { method: 'POST', body: {} }); } catch (e) { toastError(e); } setBusy(null); };
  const rewrite = async () => { setBusy('rewrite'); try { setRw(await api(`/api/projects/${p.id}/ai/rewrite/${b.id}`, { method: 'POST', body: {} })); } catch (e) { toastError(e); } setBusy(null); };
  const ask = async () => {
    const question = q.trim(); if (!question) return;
    const hist = chat.slice(); setChat([...hist, { role: 'user', content: question }]); setQ(''); setBusy('ask');
    try { const r = await api(`/api/projects/${p.id}/ai/ask`, { method: 'POST', body: { bid: b.id, question, history: hist } }); setChat(c => [...c, { role: 'assistant', content: r.answer }]); } catch (e) { toastError(e); setChat(hist); }
    setBusy(null);
  };
  const issues = review ? review.issues.filter(i => tk.findQuote(b.cur, i.quote)) : [];
  return html`<div class="col">
    <div class="row-wrap">
      <button class="btn btn-ai btn-sm" disabled=${!!busy} onClick=${run}>${busy === 'review' ? html`<${Spinner} small />` : Icon('sparkle')} ${review ? (stale ? 'Review again (text changed)' : 'Review again') : 'Proofread with AI'}</button>
      <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${rewrite}>${busy === 'rewrite' ? html`<${Spinner} small />` : Icon('wand')} Improve wording</button>
    </div>
    ${review ? (issues.length ? issues.map(i => html`<${IssueCard} p=${p} b=${b} issue=${i} key=${i.id} />`) : html`<div class="side-empty small">${Icon('check')}<p>The AI found no problems in this paragraph${stale ? ' (before the last change)' : ''}.</p></div>`) : html`<p class="faint small">The AI checks spelling, grammar, clarity, consistency with the rest of the paper, and number slips. It suggests; you decide.</p>`}
    ${rw ? html`<div class="card rw"><div class="row"><b class="grow">${Icon('wand')} Suggested wording</b><button class="btn btn-text btn-sm" onClick=${() => setRw(null)}>${Icon('x')}</button></div><div class="text-view small"><${Diff} a=${b.cur} b=${rw.text} /></div>${rw.summary ? html`<div class="faint tiny">${rw.summary}</div>` : null}<button class="btn btn-soft btn-sm" onClick=${() => onUse(rw.text)}>${Icon('edit')} Use as my suggestion</button></div>` : null}
    <div class="ask">
      ${chat.map(m => html`<div class=${`msg ${m.role}`}>${m.content}</div>`)}
      ${busy === 'ask' ? html`<div class="msg assistant"><${Spinner} small /></div>` : null}
      <div class="ask-row"><input class="input" placeholder="Ask about this paragraph…" value=${q} onInput=${e => setQ(e.target.value)} onKeyDown=${e => e.key === 'Enter' && ask()} /><button class="btn btn-soft" disabled=${!q.trim() || busy === 'ask'} onClick=${ask}>${Icon('send')}</button></div>
    </div>
  </div>`;
}

function CheckModal({ p, chk, onDone }) {
  const [state, setState] = useState({ chk, res: null, picked: null, busy: false });
  const answer = async i => {
    if (state.busy || state.res) return;
    setState(s => ({ ...s, picked: i, busy: true }));
    try {
      const res = await api(`/api/projects/${p.id}/check`, { method: 'POST', body: { cid: state.chk.cid, choice: i } });
      setState(s => ({ ...s, res, busy: false }));
      if (res.correct) setTimeout(() => onDone(res), 1300);
    } catch (e) { toastError(e); onDone({ correct: true }); }
  };
  useKeys({ 1: () => answer(0), 2: () => answer(1), 3: () => answer(2), 4: () => answer(3), _inModal: true, Enter: () => state.res && !state.res.correct && onDone(state.res) }, [state]);
  const { res } = state;
  return html`<div class="modal-body check">
    <div class="check-top"><span class="chip c-brand">${Icon('target')} Reading check${state.chk.attempt > 1 ? ` · attempt ${state.chk.attempt}` : ''}</span>${state.chk.fast ? html`<span class="chip c-warn">That was quick</span>` : state.chk.why === 'unseen' ? html`<span class="chip c-warn">The end wasn’t on screen</span>` : state.chk.why === 'long' ? html`<span class="chip">Long paragraph</span>` : null}</div>
    <h3>${state.chk.q}</h3>
    <div class="opts">${state.chk.options.map((o, i) => html`<button class=${`optn ${state.picked === i ? (res ? (res.correct ? 'ok' : 'bad') : 'sel') : ''}`} disabled=${!!res || state.busy} onClick=${() => answer(i)}><span class="kbd">${i + 1}</span><span>${o}</span></button>`)}</div>
    ${res && res.correct ? html`<div class="check-res ok">${Icon('check')} <div><b>Correct.</b> ${res.why || ''}</div></div>` : null}
    ${res && !res.correct && res.retry ? html`<div class="check-res bad">${Icon('eye')} <div><b>Not quite.</b> Read the paragraph again — you’ll get another question. (${res.attemptsLeft} ${res.attemptsLeft === 1 ? 'try' : 'tries'} left)</div></div><div class="modal-actions"><button class="btn btn-primary" onClick=${() => onDone(res)}>Re-read the paragraph</button></div>` : null}
    ${res && !res.correct && res.final ? html`<div class="check-res bad">${Icon('info')} <div><b>The answer was:</b> ${res.answer}. ${res.why || ''}</div></div><div class="modal-actions"><button class="btn btn-primary" onClick=${() => onDone(res)}>Continue</button></div>` : null}
    ${!res ? html`<p class="faint tiny">Answer from the paragraph you just read. The owner sees how many checks each reader passes.</p>` : null}
  </div>`;
}

function Finished({ p, close }) {
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const mine = p.suggestions.filter(s => s.by === p.me.sub);
  const pr = (p.progress || {})[p.me.sub] || {};
  const send = async () => { try { await api(`/api/projects/${p.id}/finish`, { method: 'POST', body: { message: msg } }); setSent(true); toast('The owner was notified. Thank you!', 'ok'); } catch (e) { toastError(e); } };
  return html`<div class="modal-body finished">
    <div class="confetti">${Array.from({ length: 18 }, (_, i) => html`<i style=${`--i:${i}`}></i>`)}</div>
    <div class="big-ic ok">${Icon('check')}</div>
    <h3>You’ve read the whole manuscript</h3>
    <p class="muted">${plural(mine.filter(s => s.kind === 'edit').length, 'suggestion')}, ${plural(mine.filter(s => s.kind === 'comment').length, 'comment')}${pr.checks && pr.checks.asked ? `, reading checks ${pr.checks.passed}/${pr.checks.asked}` : ''}${pr.time ? ` · ${fmtMin(pr.time)} of reading` : ''}.</p>
    ${p.role !== 'owner' ? (sent ? html`<p class="ok-text">${Icon('check')} Sent.</p>` : html`<textarea class="input" rows="3" placeholder="A note for the owner (optional)" value=${msg} onInput=${e => setMsg(e.target.value)}></textarea>`) : null}
    <div class="modal-actions">${p.role !== 'owner' && !sent ? html`<button class="btn btn-primary" onClick=${send}>${Icon('send')} Tell the owner I’m done</button>` : null}<button class="btn btn-ghost" onClick=${() => { close(); navigate(`/app/p/${p.id}`); }}>Back to the manuscript</button></div>
  </div>`;
}

/** Owners are not asked reading checks unless they turn it on (Settings → "Check me too"). */
async function askOwnerToo(p) {
  try { await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { settings: { checks: { owner: true } } } }); toast('Reading checks are on for you too', 'ok'); getStore(p.id).refetch(50); }
  catch (e) { toastError(e); }
}

function showIntro(p) {
  openModal(close => html`<div class="modal-body intro">
    <div class="eyebrow">${Icon('book')} Proof Room</div>
    <h3>${p.title}</h3>
    ${p.settings.instructions ? html`<div class="note-box"><b>From the owner</b><p>${p.settings.instructions}</p></div>` : null}
    <ul class="intro-list">
      <li>${Icon('eye')}<div><b>One paragraph at a time.</b> Read it as typeset; switch to Text to see what you’ll edit.</div></li>
      <li>${Icon('edit')}<div><b>Suggest edits or comment.</b> Select words to comment on them. ${p.canDecide ? 'As ' + p.role + ' you can also accept suggestions.' : 'The owner decides what goes in.'}</div></li>
      ${p.ai.enabled && (p.ai.readers || p.canDecide) ? html`<li>${Icon('sparkle')}<div><b>AI help.</b> Ask the AI to proofread a paragraph or improve the wording — it suggests, you judge.</div></li>` : null}
      <li>${Icon('layers')}<div><b>Check numbers.</b> The Context tab shows the tables and figures a paragraph mentions.</div></li>
      ${p.settings.checks.enabled && !(p.role === 'owner' && !p.settings.checks.owner) ? html`<li>${Icon('target')}<div><b>Read, then continue.</b> ${p.settings.checks.pace !== false ? 'Each paragraph needs a moment of reading, with its end on screen, before you can mark it read. ' : ''}${p.settings.checks.long !== false ? 'Long paragraphs end with a short question; others now and then' : 'Now and then a short question confirms you read the paragraph'}, and always when a paragraph is marked read too quickly.</div></li>` : null}
      ${p.settings.checks.enabled && p.role === 'owner' && !p.settings.checks.owner ? html`<li>${Icon('target')}<div><b>Reading checks</b> go to your proofreaders; as the owner you are not asked. <button class="btn btn-text btn-sm" onClick=${() => askOwnerToo(p)}>Ask me too</button></div></li>` : null}
      ${p.settings.deadline ? html`<li>${Icon('clock')}<div><b>Target date:</b> ${fmtDay(p.settings.deadline)}</div></li>` : null}
    </ul>
    <div class="modal-actions"><button class="btn btn-primary" onClick=${close}>Start reading ${Icon('arrowR')}</button></div>
  </div>`);
}
function showKeys() {
  openModal(close => html`<div class="modal-body"><h3>Keyboard shortcuts</h3><div class="keys">
    ${[['↵', 'Mark as read and continue'], ['→ / ←', 'Next / previous'], ['E', 'Suggest an edit'], ['C', 'Comment'], ['A', 'AI help'], ['T', 'Typeset / text view'], ['Ctrl ↵', 'Save suggestion'], ['1–4', 'Answer a reading check'], ['Esc', 'Close']].map(([k, l]) => html`<div><span class="kbd">${k}</span><span>${l}</span></div>`)}
  </div><div class="modal-actions"><button class="btn btn-primary" onClick=${close}>Got it</button></div></div>`);
}
