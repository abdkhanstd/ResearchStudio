/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/** The authors' Retraction Exposure (through Retraction Radar, rr.rykhet.com): choose each author's OpenAlex profile, check, read with care. */
import { html, useState, useEffect, api, getStore, Icon, Spinner, ago, toast, toastError } from './lib.js';

const pctTxt = v => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;
const fresh = p => ((p.rexp && p.rexp.authors) || []).map(a => ({ ...a, labels: a.labels || [] }));

export function AuthorsExposure({ p }) {
  const r = p.rexp || { authors: [], results: {}, job: null };
  const [authors, setAuthors] = useState(() => fresh(p));
  const [years, setYears] = useState({ from: r.from, to: r.to });
  const [found, setFound] = useState({}); // author index → candidates, or 'loading'
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setAuthors(fresh(p)); }, [p.rev]);
  const job = r.job, running = job && job.status === 'running';
  const edit = fn => { setDirty(true); setAuthors(fn); };
  const update = (i, patch) => edit(list => list.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  const search = async i => {
    const a = authors[i];
    if (!a.name || a.name.trim().length < 3) return toast('Type the author’s name first.', 'bad');
    setFound(f => ({ ...f, [i]: 'loading' }));
    try { const j = await api(`/api/projects/${p.id}/rexp/search?q=${encodeURIComponent(a.name.trim())}`); setFound(f => ({ ...f, [i]: j.results || [] })); }
    catch (e) { setFound(f => ({ ...f, [i]: null })); toastError(e); }
  };
  const toggle = (i, c) => {
    const a = authors[i];
    const k = a.ids.indexOf(c.id);
    if (k >= 0) return update(i, { ids: a.ids.filter((_, j) => j !== k), labels: a.labels.filter((_, j) => j !== k) });
    if (a.ids.length >= 5) return toast('At most 5 profiles per author.', 'bad');
    const label = `${c.name}${c.current && c.current[0] ? ` · ${c.current[0].name}` : ''} · ${c.works} works${c.orcid ? ` · ORCID ${c.orcid}` : ''}`;
    update(i, { ids: [...a.ids, c.id], labels: [...a.labels, label] });
  };
  const run = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}/rexp`, { method: 'PUT', body: { authors, from: years.from, to: years.to } });
      setDirty(false);
      await api(`/api/projects/${p.id}/rexp/run`, { method: 'POST', body: {} });
      toast('Checking the authors — about a minute per author', 'ok', 6000);
      getStore(p.id).refetch(300);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const res = r.results || {};
  const shown = authors.filter(a => res[a.name]);
  return html`<div class="rexp">
    <div class="card pad">
      <div class="row"><h3 class="card-h grow">${Icon('users')} The authors’ Retraction Exposure</h3><a class="btn btn-text btn-sm" href="https://rr.rykhet.com" target="_blank" rel="noopener">${Icon('external')} Retraction Radar</a></div>
      <p class="small muted">For each author, the share of their papers in the chosen years that an exposure screen flags (Retraction Radar’s default method, OpenAlex data). ${r.guessed ? 'The names were read from your LaTeX source — check them. ' : ''}Choose the right OpenAlex profile for each author: names are often shared.</p>
      <div class="rexp-authors">${authors.map((a, i) => html`<div class="rexp-author">
        <div class="row-wrap"><input class="input sm grow" value=${a.name} placeholder="Author name or ORCID" onInput=${e => update(i, { name: e.target.value, ids: [], labels: [] })} />
          <button class="btn btn-ghost btn-sm" disabled=${found[i] === 'loading'} onClick=${() => search(i)}>${found[i] === 'loading' ? html`<${Spinner} small />` : Icon('search')} Find profile</button>
          <button class="btn btn-text btn-sm" title="Remove this author" onClick=${() => edit(list => list.filter((_, k) => k !== i))}>${Icon('x')}</button></div>
        ${a.labels.length ? html`<div class="rexp-chosen">${a.labels.map(l => html`<span class="chip c-brand">${l}</span>`)}</div>` : html`<div class="tiny faint">No profile chosen yet.</div>`}
        ${Array.isArray(found[i]) ? html`<div class="rexp-cands">${found[i].length ? found[i].map(c => html`<label class="rexp-cand"><input type="checkbox" checked=${a.ids.includes(c.id)} onChange=${() => toggle(i, c)} /><div><b>${c.name}</b> <span class="faint small">${c.works} works · h ${c.h ?? '–'}${c.orcid ? ` · ORCID ${c.orcid}` : ''}</span><div class="small muted">${(c.current || []).map(x => `${x.name}${x.country ? ` (${x.country})` : ''}`).join('; ') || (c.affiliations || []).slice(0, 2).map(x => x.name).join('; ') || 'no affiliation listed'}${c.topics && c.topics.length ? ` · ${c.topics.slice(0, 2).join(', ')}` : ''}</div></div></label>`) : html`<div class="small faint">No OpenAlex profile found for this name. Try the ORCID.</div>`}<button class="btn btn-text btn-sm" onClick=${() => setFound(f => ({ ...f, [i]: undefined }))}>Done</button></div>` : null}
      </div>`)}</div>
      <div class="row-wrap" style="margin-top:10px">
        <button class="btn btn-text btn-sm" onClick=${() => edit(list => [...list, { name: '', ids: [], labels: [] }])}>${Icon('plus')} Add an author</button>
        <span class="grow"></span>
        <label class="small row">Years <input class="input sm yr" type="number" value=${years.from} onInput=${e => { setDirty(true); setYears(y => ({ ...y, from: +e.target.value })); }} /> – <input class="input sm yr" type="number" value=${years.to} onInput=${e => { setDirty(true); setYears(y => ({ ...y, to: +e.target.value })); }} /></label>
        <button class="btn btn-primary btn-sm" disabled=${busy || running || !authors.some(a => a.ids.length)} onClick=${run}>${busy || running ? html`<${Spinner} small />` : Icon('graph')} ${running ? job.label : 'Check exposure'}</button>
      </div>
      ${job && job.status === 'done' ? html`<p class="tiny faint">Last checked ${ago(job.at)} by ${job.by}.</p>` : null}
    </div>
    ${shown.length ? html`<div class="card pad">
      <div class="tgrid-wrap"><table class="rexp-table"><tr><th>Author</th><th>Papers ${r.from}–${r.to}</th><th>Exposure ratio</th><th>Score</th><th>Why papers are flagged</th></tr>
        ${shown.map(a => {
          const x = res[a.name];
          if (x.error) return html`<tr><td><b>${a.name}</b></td><td colspan="4" class="bad-text small">${x.error}</td></tr>`;
          return html`<tr><td><b>${a.name}</b><div class="tiny faint">${(x.profiles || []).map(pr => pr.institution).filter(Boolean)[0] || ''}</div></td><td>${x.papers}</td>
            <td><span class=${`rexp-ratio ${x.ratio >= 0.5 ? 'hi' : x.ratio >= 0.2 ? 'mid' : 'lo'}`}>${pctTxt(x.ratio)}</span><div class="tiny faint">${x.flagged} of ${x.papers} flagged</div></td><td>${x.score}</td>
            <td class="small">${x.own ? html`<div><b class="bad-text">${x.own} retracted</b></div>` : null}${x.co ? html`<div>${x.co} with a co-author who has a retraction${x.coauthors.length ? html` <span class="faint">(${x.coauthors.slice(0, 3).map(c => c.name).join(', ')}${x.coauthors.length > 3 ? ', …' : ''})</span>` : ''}</div>` : null}${x.journal ? html`<div>${x.journal} in journals above the retraction threshold${x.journals.length ? html` <span class="faint">(${x.journals.slice(0, 2).map(j => `${j.name} ${j.share}%`).join('; ')})</span>` : ''}</div>` : null}${!x.flagged ? html`<span class="faint">nothing flagged</span>` : null}</td></tr>`;
        })}
      </table></div>
      <p class="tiny faint" style="margin-top:12px"><b>Read with care.</b> This is a screen, not a finding about anyone: a paper is flagged when it is retracted, when any co-author has a retracted paper (in any year, on any topic), or when its journal has at least 3 retractions above 0.2% of its papers — most flagged papers are not retracted themselves. OpenAlex can also attach papers to the wrong profile. Open the author in Retraction Radar to see every paper and correct the list.</p>
    </div>` : null}
  </div>`;
}
