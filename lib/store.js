/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Project storage. Everything at rest is encrypted (AES-256-GCM, see util.createCipher).
 *   var/projects/<id>/project.bin   the project (gzip JSON)
 *   var/projects/<id>/f/<name>.bin  files: original upload, page images, figure images
 *   var/index.bin                   who can see which project, pending invitations by email
 * Projects in use stay in memory (small LRU); every change is written back after a short delay.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { writeAtomic } = require('./util');

function createStore({ dir, cipher, maxCached = 8 }) {
  const PDIR = path.join(dir, 'projects');
  fs.mkdirSync(PDIR, { recursive: true });
  const INDEX = path.join(dir, 'index.bin');
  let index = { projects: {}, invites: {} };
  try { index = cipher.openJson(fs.readFileSync(INDEX)); } catch (e) { if (fs.existsSync(INDEX)) console.error('[store] index unreadable', e.message); }
  index.projects = index.projects || {}; index.invites = index.invites || {};

  const cache = new Map(); // id → { p, used }
  const pins = new Map();
  const timers = new Map();
  let indexTimer = null;
  const validId = id => /^[a-z0-9]{8,24}$/.test(String(id || ''));
  const pdir = id => path.join(PDIR, id);
  const validName = n => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(String(n || ''));

  function saveIndexSoon() {
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => { indexTimer = null; writeAtomic(INDEX, cipher.sealJson(index)).catch(e => console.error('[store] index save', e.message)); }, 300);
  }
  function indexRow(p) {
    const members = {};
    for (const m of p.members || []) if (m.status === 'active') members[m.sub] = m.role;
    return { owner: p.owner, title: p.title, created: p.created, updated: p.updated, kind: p.source && p.source.kind, members, blocks: (p.blocks || []).length, deadline: p.settings && p.settings.deadline || null };
  }
  function reindex(p) {
    index.projects[p.id] = indexRow(p);
    for (const [email, list] of Object.entries(index.invites)) {
      const keep = list.filter(x => x.pid !== p.id);
      if (keep.length) index.invites[email] = keep; else delete index.invites[email];
    }
    index.tokens = index.tokens || {};
    for (const [h, pid] of Object.entries(index.tokens)) if (pid === p.id) delete index.tokens[h];
    for (const inv of p.invites || []) if (inv.status !== 'revoked') for (const h of new Set([inv.hash, ...(inv.hashes || [])])) if (h) index.tokens[h] = p.id;
    for (const inv of p.invites || []) {
      if (inv.status !== 'pending' || Date.parse(inv.expires) < Date.now()) continue;
      const e = inv.email.toLowerCase();
      (index.invites[e] = index.invites[e] || []).push({ pid: p.id, iid: inv.id });
    }
    saveIndexSoon();
  }

  function evict() {
    if (cache.size <= maxCached) return;
    const rows = [...cache.entries()].filter(([id]) => !pins.get(id) && !timers.has(id)).sort((a, b) => a[1].used - b[1].used);
    for (const [id] of rows.slice(0, cache.size - maxCached)) cache.delete(id);
  }
  async function load(id) {
    if (!validId(id)) return null;
    const c = cache.get(id);
    if (c) { c.used = Date.now(); return c.p; }
    let p;
    try { p = cipher.openJson(await fsp.readFile(path.join(pdir(id), 'project.bin'))); } catch { return null; }
    const again = cache.get(id); // loaded concurrently
    if (again) { again.used = Date.now(); return again.p; }
    cache.set(id, { p, used: Date.now() });
    evict();
    return p;
  }
  async function writeNow(p) {
    clearTimeout(timers.get(p.id)); timers.delete(p.id);
    await fsp.mkdir(pdir(p.id), { recursive: true });
    await writeAtomic(path.join(pdir(p.id), 'project.bin'), cipher.sealJson(p));
  }
  /** Mark changed: bump rev, update index, write soon. */
  function touch(p, { index: idx = true, delay = 800 } = {}) {
    p.updated = new Date().toISOString();
    p.rev = (p.rev || 0) + 1;
    if (idx) reindex(p);
    if (timers.has(p.id)) return;
    timers.set(p.id, setTimeout(() => { timers.delete(p.id); writeNow(p).catch(e => console.error('[store] save', p.id, e.message)); }, delay));
  }
  async function create(p) {
    cache.set(p.id, { p, used: Date.now() });
    await writeNow(p);
    reindex(p);
    evict();
  }
  async function remove(id) {
    clearTimeout(timers.get(id)); timers.delete(id);
    cache.delete(id);
    delete index.projects[id];
    for (const [h, pid] of Object.entries(index.tokens || {})) if (pid === id) delete index.tokens[h];
    for (const [email, list] of Object.entries(index.invites)) { const keep = list.filter(x => x.pid !== id); if (keep.length) index.invites[email] = keep; else delete index.invites[email]; }
    saveIndexSoon();
    await fsp.rm(pdir(id), { recursive: true, force: true });
  }
  async function putFile(id, name, buf) {
    if (!validId(id) || !validName(name)) throw new Error('bad file name');
    await fsp.mkdir(path.join(pdir(id), 'f'), { recursive: true });
    await writeAtomic(path.join(pdir(id), 'f', `${name}.bin`), cipher.seal(buf));
  }
  async function getFile(id, name) {
    if (!validId(id) || !validName(name)) return null;
    try { return cipher.open(await fsp.readFile(path.join(pdir(id), 'f', `${name}.bin`))); } catch { return null; }
  }
  async function delFile(id, name) { if (validId(id) && validName(name)) await fsp.rm(path.join(pdir(id), 'f', `${name}.bin`), { force: true }); }
  async function listFiles(id) { try { return (await fsp.readdir(path.join(pdir(id), 'f'))).map(f => f.replace(/\.bin$/, '')); } catch { return []; } }

  function forUser(sub, email) {
    const mine = [], shared = [];
    for (const [id, r] of Object.entries(index.projects)) {
      if (r.owner === sub) mine.push({ id, ...r, role: 'owner' });
      else if (r.members && r.members[sub]) shared.push({ id, ...r, role: r.members[sub] });
    }
    const invites = (index.invites[String(email || '').toLowerCase()] || []).filter(x => index.projects[x.pid] && !(index.projects[x.pid].members || {})[sub]);
    return { mine, shared, invites };
  }
  const pin = id => pins.set(id, (pins.get(id) || 0) + 1);
  const unpin = id => { const n = (pins.get(id) || 1) - 1; if (n > 0) pins.set(id, n); else pins.delete(id); };

  async function flush() {
    clearTimeout(indexTimer);
    const ids = [...timers.keys()];
    await Promise.all(ids.map(id => { const c = cache.get(id); return c ? writeNow(c.p).catch(() => {}) : null; }));
    try { fs.writeFileSync(INDEX, cipher.sealJson(index)); } catch { /* ignore */ }
  }
  return { load, create, touch, remove, putFile, getFile, delFile, listFiles, forUser, pin, unpin, flush, reindex, validId, validName, get index() { return index; }, stats: () => ({ cached: cache.size, pending: timers.size, projects: Object.keys(index.projects).length }) };
}

module.exports = { createStore };
