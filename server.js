/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Research Studio — self-hosted edition. Paragraph-by-paragraph proofreading with invited readers, reading checks, live
 * suggestions, history with undo, evidence checks (numbers against tables and figures) and exports.
 * Built-in accounts (email + password); checks are rule-based, no AI service needed. Hosted demo: https://studio.rykhet.com
 * No npm dependencies (Node 18+). Heavy work (PDF reading, OCR, figure digitising, annotated PDF) runs in the browser.
 *   /              landing page, /login sign in or create an account
 *   /app           dashboard, /app/new, /app/p/<id>[/<tab>], /app/p/<id>/read[/<bid>], /app/invite/<token>
 *   /api/*         JSON API (session cookie), /api/projects/<id>/events (server-sent events)
 * Data: var/projects/<id>/ (encrypted), var/index.bin, var/accounts.json, var/users.json, var/usage.json
 */
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const U = require('./lib/util');
const { createStore } = require('./lib/store');
const { createMailer } = require('./lib/mail');
const { createAssist } = require('./lib/assist');
const { createAccounts } = require('./lib/accounts');
const { lint } = require('./lib/lint');
const { runEvidence } = require('./lib/evidence');
let EX = null; // revised LaTeX and change lists (shared ES module: exports are made in the browser, see exports.js)
const assist = require('./lib/assist');
const EXPO = require('./lib/exposure'); // rule-based reading questions (fallback when the AI fails)
const { readZip, writeZip } = require('./lib/zip');

// ── Config ─────────────────────────────────────────────────
const env = U.loadEnv(__dirname);
const PORT = Number(env.PORT || 4150);
const BASE = env.BASE_URL || 'http://localhost:4150';
const SECRET = env.SESSION_SECRET || '';
const DEV = (env.DEV_MODE === '1' || env.DEV_LOGIN === '1') && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
if (SECRET.length < 32) { console.error('[studio] SESSION_SECRET (32+ characters) is required in .env — see .env.example'); process.exit(1); }
const LIMITS = { aiDaily: Number(env.AI_DAILY_LIMIT || 150), prechecksDaily: Number(env.PRECHECK_DAILY || 8), invitesDaily: Number(env.INVITES_DAILY || 60), projects: Number(env.MAX_PROJECTS || 60), maxUploadMb: Number(env.MAX_UPLOAD_MB || 80) };
const OPEN_SIGNUP = env.OPEN_SIGNUP === '1'; // anyone may create an account (otherwise: the first account, and invited people)
const PUB = path.join(__dirname, 'public');
const VAR = path.join(__dirname, 'var');
fs.mkdirSync(VAR, { recursive: true });
const cipher = U.createCipher(env.DATA_KEY || `dev-only:${SECRET}`);
if (!env.DATA_KEY && !DEV) { console.error('[studio] DATA_KEY is required in .env'); process.exit(1); }
const store = createStore({ dir: VAR, cipher, maxCached: Number(env.MAX_CACHED || 8) });
const mailer = createMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, mode: env.MAIL_MODE || (DEV ? 'file' : 'smtp'), base: BASE, outbox: path.join(VAR, 'outbox'), fromAddr: env.MAIL_FROM_ADDR || `no-reply@${new URL(BASE).hostname}`, fromName: env.MAIL_FROM_NAME || 'Research Studio', brand: env.BRAND || 'Research Studio', accountName: 'Research Studio account' });
const ai = createAssist(); // rule-based reading checks and evidence checks (no AI service)
const CHECKS = () => (ai.checks ?? ai.enabled);
// PDFs compiled on the user's computer through Rykhet LaTeX (it accepts the hosted site and local development only)
const LATEX_SITE = env.LATEX_SITE || 'https://latex.rykhet.com';
const BRIDGE = env.COMPILE_BRIDGE ? env.COMPILE_BRIDGE === '1' : !!env.LATEX_KEY;
// Retraction Radar (rr.rykhet.com): authors' Retraction Exposure, server to server
const RR_ON = !!(env.RR_KEY && env.RR_URL);
async function rrCall(pathQ, body, timeout = 300000) {
  const r = await fetch(env.RR_URL + pathQ, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(timeout), headers: { 'X-Internal-Key': env.RR_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Retraction Radar ${r.status}`), { status: r.status === 400 ? 400 : 502 });
  return j;
}
const refcheck = { enabled: false, link: () => null, start: async () => { throw new Error('Reference checking runs on the hosted service.'); }, status: async () => { throw new Error('not available'); } };
const accounts = createAccounts({ dir: VAR });
let tk = null; // shared text toolkit (ES module)
const shared = name => import(path.join(PUB, 'assets', 'shared', name).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const tkReady = Promise.all([shared('textkit.mjs'), shared('exporter.mjs')]).then(([m, x]) => { tk = m; EX = x; });

// ── Sessions (signed cookies, revocable on sign-out) ──
const SESSION = 'studio-session', IDT = 'studio-idt', DAYS = 14;
const b64 = b => Buffer.from(b).toString('base64url');
const hmac = body => crypto.createHmac('sha256', SECRET).update(body).digest();
function signSession(p) { const n = Math.floor(Date.now() / 1000); const body = b64(JSON.stringify({ ...p, iat: n, exp: n + DAYS * 86400 })); return `${body}.${b64(hmac(body))}`; }
const revokedFile = path.join(VAR, 'revoked-sessions.json');
const revoked = new Map();
try { for (const [s, at] of JSON.parse(fs.readFileSync(revokedFile, 'utf8'))) if (Date.now() - at < (DAYS + 1) * 86400e3) revoked.set(s, at); } catch { /* none */ }
function revoke(s) { if (!s) return; revoked.set(s, Date.now()); fs.writeFile(revokedFile, JSON.stringify([...revoked]), e => e && console.error('[studio] revoke', e.message)); }
function verifySession(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = hmac(body), got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url'));
    if (!p.sub || p.exp < Date.now() / 1000 || (p.sid && revoked.has(p.sid))) return null;
    return p;
  } catch { return null; }
}

// ── Users, usage, activity ─────────────────────────────────
const timers = {};
function persist(file, obj, ms = 400) { clearTimeout(timers[file]); timers[file] = setTimeout(() => { delete timers[file]; U.writeAtomic(file, JSON.stringify(obj)).catch(e => console.error('[studio] save', file, e.message)); }, ms); }
const USERS = path.join(VAR, 'users.json'), USAGE = path.join(VAR, 'usage.json'), ACT = path.join(VAR, 'activity.jsonl');
const users = U.readJson(USERS, {});
const ADMINS = new Set(String(env.STUDIO_ADMINS || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
const isAdmin = s => !!s && (s.a === 1 || ADMINS.has(String(s.e || '').toLowerCase()));
function touchUser(s) { const u = users[s.sub] = users[s.sub] || { first: U.now() }; u.email = s.e; u.name = s.n; u.last = U.now(); persist(USERS, users); return u; }
const usage = U.readJson(USAGE, {});
const today = () => new Date().toISOString().slice(0, 10);
function day() { const t = today(); if (!usage[t]) { usage[t] = {}; for (const k of Object.keys(usage).sort().slice(0, -60)) delete usage[k]; } return usage[t]; }
const used = (key) => day()[key] || 0;
function count(key, n = 1) { const d = day(); d[key] = (d[key] || 0) + n; persist(USAGE, usage); }
const logActivity = row => fs.appendFile(ACT, JSON.stringify({ t: U.now(), ...row }) + '\n', e => e && console.error('[studio] activity', e.message));

// ── Roles ──────────────────────────────────────────────────
const RANK = { proofreader: 1, editor: 2, owner: 3 };
function roleOf(p, s) {
  if (!p || !s) return null;
  if (p.owner === s.sub) return 'owner';
  const m = (p.members || []).find(x => x.sub === s.sub && x.status === 'active');
  return m ? m.role : null;
}
const atLeast = (role, need) => (RANK[role] || 0) >= RANK[need];
const meName = s => s.n || s.e || 'Someone';
function act(p, s, kind, detail = {}) {
  p.activity = p.activity || [];
  p.activity.push({ at: U.now(), by: s ? s.sub : null, name: s ? meName(s) : 'Studio', kind, ...detail });
  if (p.activity.length > 3000) p.activity.splice(0, p.activity.length - 3000);
}

// ── Live updates (server-sent events) ──────────────────────
const streams = new Map(); // pid → Set<{ res, sub, role, name }>
const presence = new Map(); // pid → Map<sub, { name, bid, at }>
function emit(p, ev, filter = null) {
  const set = streams.get(p.id);
  if (!set) return;
  const data = `data: ${JSON.stringify({ ...ev, rev: p.rev })}\n\n`;
  for (const c of set) { if (filter && !filter(c)) continue; try { c.res.write(data); } catch { /* closed */ } }
}
function presenceList(pid) { const m = presence.get(pid); return m ? [...m.entries()].map(([sub, v]) => ({ sub, name: v.name, bid: v.bid, at: v.at })) : []; }
const presTimers = new Map();
function emitPresence(p) { if (presTimers.has(p.id)) return; presTimers.set(p.id, setTimeout(() => { presTimers.delete(p.id); emit(p, { t: 'presence', list: presenceList(p.id) }); }, 700)); }
setInterval(() => { for (const set of streams.values()) for (const c of set) { try { c.res.write(': hb\n\n'); } catch { /* closed */ } } }, 20000).unref();

// ── Defaults ───────────────────────────────────────────────
const DEFAULT_SETTINGS = { checks: { enabled: true, freq: 'sometimes', requirePass: true, owner: false, long: true, pace: true }, ai: { readers: true }, blind: false, refsInReading: false, allowDownload: false, watermark: true, deadline: null, instructions: '', order: 'sequential' };
const FREQ = { every: 1, often: 0.5, sometimes: 0.25, rare: 0.12 };
const READ_KINDS = new Set(['title', 'abstract', 'para', 'list', 'caption', 'equation', 'footnote']);
const QUIZ_KINDS = new Set(['abstract', 'para', 'list']);
// reading pace: faster than READ_WPM is skimming, not proofreading; paragraphs of LONG_WORDS or more always get a check
const READ_WPM = 500, LONG_WORDS = 100;
const REVIEW_KINDS = new Set(['title', 'abstract', 'para', 'list', 'caption', 'footnote']);
const readingSet = p => (p.blocks || []).filter(b => READ_KINDS.has(b.kind) || (b.kind === 'ref' && p.settings.refsInReading));
const plain = (p, b) => tk.blockText(b, p.latex || {});
const quizEligible = (p, b) => QUIZ_KINDS.has(b.kind) && tk.countWords(plain(p, b)) >= 30;

// ── Validation of an uploaded document model ───────────────
const ID = /^[a-zA-Z0-9_-]{1,24}$/;
const cleanBox = x => (x && typeof x === 'object' ? { p: U.int(x.p, 1, 5000, 1), x0: U.num(x.x0, -50, 5000, 0), y0: U.num(x.y0, -50, 5000, 0), x1: U.num(x.x1, -50, 5000, 0), y1: U.num(x.y1, -50, 5000, 0) } : null);
const cleanGrid = g => (Array.isArray(g) ? g.slice(0, 300).map(r => (Array.isArray(r) ? r.slice(0, 40).map(c => U.str(c, 400)) : [])) : []);
function cleanData(d) {
  if (!d || typeof d !== 'object') return null;
  const axis = a => (a && typeof a === 'object' ? { title: U.strT(a.title, 200), type: ['linear', 'log', 'category', 'time'].includes(a.type) ? a.type : 'linear', labels: Array.isArray(a.labels) ? a.labels.slice(0, 200).map(x => U.strT(x, 80)) : undefined, min: Number.isFinite(+a.min) ? +a.min : undefined, max: Number.isFinite(+a.max) ? +a.max : undefined } : null);
  return {
    source: ['vector', 'ocr', 'pgfplots', 'manual', 'table'].includes(d.source) ? d.source : 'manual',
    axes: d.axes ? { x: axis(d.axes.x), y: axis(d.axes.y) } : null,
    panels: Array.isArray(d.panels) && d.panels.length > 1 ? d.panels.slice(0, 16).map((pn, i) => ({ label: U.strT(pn && pn.label, 12) || `(${String.fromCharCode(97 + i)})`, title: U.strT(pn && pn.title, 200) || null, axes: pn && pn.axes ? { x: axis(pn.axes.x), y: axis(pn.axes.y) } : null, note: U.strT(pn && pn.note, 300), confidence: U.num(pn && pn.confidence, 0, 1, null) })) : undefined,
    series: Array.isArray(d.series) ? d.series.slice(0, 60).map(s => ({ name: U.strT(s && s.name, 120), kind: ['bar', 'line', 'scatter', 'area', 'box'].includes(s && s.kind) ? s.kind : 'line', color: U.strT(s && s.color, 20) || null, panel: Array.isArray(d.panels) && d.panels.length > 1 ? U.int(s && s.panel, 0, 15, 0) : undefined, points: Array.isArray(s && s.points) ? s.points.slice(0, 800).map(pt => {
      const q = { x: typeof pt.x === 'number' && Number.isFinite(pt.x) ? pt.x : U.strT(pt.x, 80), y: Number.isFinite(+pt.y) ? +pt.y : null, label: pt.label ? U.strT(pt.label, 80) : undefined };
      for (const k of ['q1', 'q3', 'lo', 'hi']) if (pt[k] != null && Number.isFinite(+pt[k])) q[k] = +pt[k];
      return q;
    }) : [] })) : [],
    note: U.strT(d.note, 500), confidence: U.num(d.confidence, 0, 1, null), calib: d.calib && typeof d.calib === 'object' ? JSON.parse(JSON.stringify(d.calib).slice(0, 4000)) : undefined,
  };
}
const cleanWords = w => (Array.isArray(w) ? w.slice(0, 400).map(x => ({ s: U.strT(x && x.s, 60), x0: U.num(x && x.x0, 0, 20000, 0), y0: U.num(x && x.y0, 0, 20000, 0), x1: U.num(x && x.x1, 0, 20000, 0), y1: U.num(x && x.y1, 0, 20000, 0) })).filter(x => x.s) : undefined);
function cleanDoc(b) {
  const sections = (Array.isArray(b.sections) ? b.sections : []).slice(0, 600).map((s, i) => ({ id: ID.test(s.id) ? s.id : `s${i}`, title: U.strT(s.title, 300), level: U.int(s.level, 0, 6, 1), num: U.strT(s.num, 20) }));
  const blocks = [];
  const seen = new Set();
  for (const [i, x] of (Array.isArray(b.blocks) ? b.blocks : []).slice(0, 5000).entries()) {
    const text = U.str(x.text, 40000);
    if (!text.trim()) continue;
    let id = ID.test(x.id) ? x.id : `b${i}`;
    if (seen.has(id)) id = `b${i}x`;
    seen.add(id);
    blocks.push({
      id, kind: ['title', 'front', 'abstract', 'heading', 'para', 'list', 'caption', 'equation', 'footnote', 'ref', 'table'].includes(x.kind) ? x.kind : 'para', sec: ID.test(x.sec) ? x.sec : null,
      text, cur: text, ver: 0, tex: !!x.tex, page: x.page ? U.int(x.page, 1, 5000, null) : null, boxes: Array.isArray(x.boxes) ? x.boxes.slice(0, 12).map(cleanBox).filter(Boolean) : [],
      src: x.src && typeof x.src === 'object' ? { file: U.strT(x.src.file, 300), start: U.int(x.src.start, 0, 1e8, 0), end: U.int(x.src.end, 0, 1e8, 0), line: U.int(x.src.line, 0, 1e7, 0) } : null,
      label: U.strT(x.label, 120) || null, ref: x.ref ? U.strT(x.ref, 40) : null,
    });
  }
  const tables = (Array.isArray(b.tables) ? b.tables : []).slice(0, 300).map((t, i) => ({ id: ID.test(t.id) ? t.id : `t${i}`, label: U.strT(t.label, 40) || `Table ${i + 1}`, num: U.strT(t.num, 12), caption: U.strT(t.caption, 2000), bid: ID.test(t.bid) ? t.bid : null, page: t.page ? U.int(t.page, 1, 5000, null) : null, box: cleanBox(t.box), grid: cleanGrid(t.grid), source: ['latex', 'pdf', 'ai', 'manual'].includes(t.source) ? t.source : 'pdf', rows: Array.isArray(t.rows) ? cleanGrid(t.rows) : undefined }));
  const figures = (Array.isArray(b.figures) ? b.figures : []).slice(0, 400).map((f, i) => ({ id: ID.test(f.id) ? f.id : `f${i}`, label: U.strT(f.label, 40) || `Fig. ${i + 1}`, num: U.strT(f.num, 12), caption: U.strT(f.caption, 3000), bid: ID.test(f.bid) ? f.bid : null, page: f.page ? U.int(f.page, 1, 5000, null) : null, box: cleanBox(f.box), image: f.image && store.validName(f.image) ? f.image : null, kind: ['vector', 'raster', 'mixed', 'tikz', 'none'].includes(f.kind) ? f.kind : 'none', data: cleanData(f.data), text: Array.isArray(f.text) ? f.text.slice(0, 400).map(t => U.strT(t, 120)) : [], ocr: U.strT(f.ocr, 8000), file: U.strT(f.file, 300) || null, words: cleanWords(f.words), wordsSize: Array.isArray(f.wordsSize) ? [U.int(f.wordsSize[0], 1, 20000, 1), U.int(f.wordsSize[1], 1, 20000, 1)] : undefined }));
  const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 1000).map((r, i) => ({ i, raw: U.strT(r.raw, 3000), key: U.strT(r.key, 120) || null, parsed: r.parsed && typeof r.parsed === 'object' ? JSON.parse(JSON.stringify(r.parsed).slice(0, 6000)) : null })).filter(r => r.raw.length > 8);
  const s = b.source || {};
  let texFiles = null;
  if (s.texFiles && typeof s.texFiles === 'object') {
    texFiles = {}; let total = 0;
    for (const [k, v] of Object.entries(s.texFiles).slice(0, 400)) { if (typeof v !== 'string') continue; total += v.length; if (total > 6e6) break; texFiles[U.strT(k, 300)] = v; }
  }
  const pages = Array.isArray(s.pages) ? s.pages.slice(0, 5000).map(x => ({ w: U.num(x && x.w, 1, 5000, 612), h: U.num(x && x.h, 1, 5000, 792) })) : [];
  const L = b.latex && typeof b.latex === 'object' ? b.latex : null;
  const latex = L ? { labels: Object.fromEntries(Object.entries(L.labels || {}).slice(0, 5000).map(([k, v]) => [U.strT(k, 200), { n: U.strT(v && v.n, 20), kind: U.strT(v && v.kind, 20) }])), cites: Object.fromEntries(Object.entries(L.cites || {}).slice(0, 3000).map(([k, v]) => [U.strT(k, 200), typeof v === 'number' ? v : U.strT(v, 200)])), macros: Object.fromEntries(Object.entries(L.macros || {}).slice(0, 500).map(([k, v]) => [U.strT(k, 60), U.strT(v, 400)])) } : null;
  return {
    title: U.strT(b.title, 300) || 'Untitled manuscript', sections, blocks, tables, figures, refs, latex,
    citations: b.citations && typeof b.citations === 'object' ? JSON.parse(JSON.stringify(b.citations).slice(0, 200000)) : null,
    source: { kind: s.kind === 'latex' ? 'latex' : 'pdf', filename: U.strT(s.filename, 200), main: U.strT(s.main, 300) || null, pages, files: Array.isArray(s.files) ? s.files.slice(0, 2000).map(f => ({ name: U.strT(f && f.name, 300), size: U.int(f && f.size, 0, 1e9, 0) })) : [], texFiles, size: U.int(s.size, 0, 1e10, 0), uploaded: false, pageImages: false, pdfPaired: !!s.pdfPaired, pdfName: U.strT(s.pdfName, 200) || null, notes: Array.isArray(s.notes) ? s.notes.slice(0, 30).map(n => U.strT(n, 300)) : [] },
  };
}

// ── Views ──────────────────────────────────────────────────
function memberSummary(p, m, full) {
  const pr = (p.progress || {})[m.sub] || null;
  const total = readingSet(p).length;
  const base = { sub: m.sub, name: m.name, email: full ? m.email : undefined, role: m.role, status: m.status, joined: m.joined };
  if (!full || !pr) return base;
  const read = Object.values(pr.read || {});
  return { ...base, progress: { read: read.length, total, time: pr.time || 0, checks: pr.checks || { asked: 0, passed: 0, failed: 0 }, fast: pr.fast || 0, done: !!pr.done, last: pr.last || null, cur: pr.cur || null, words: pr.words || 0, quality: readingQuality(p, pr) } };
}
/**
 * How carefully a reader read, from what they did on each paragraph of 30+ words: the pace (words per minute of active
 * reading; above READ_WPM is skimming), whether its end was scrolled into view, how often they left the tab, and the
 * reading checks they passed. Score 0-100: pace 50 %, seen 20 %, checks 30 % (pace stands in while no check was asked).
 */
function readingQuality(p, pr) {
  const byId = new Map(p.blocks.map(b => [b.id, b]));
  let n = 0, fast = 0, unseen = 0, away = 0;
  const wpms = [];
  for (const [bid, r] of Object.entries(pr.read || {})) {
    const b = byId.get(bid);
    if (!b || !QUIZ_KINDS.has(b.kind)) continue;
    const w = wordsOf(p, b);
    if (w < 30) continue;
    n++;
    const wpm = r.ms > 0 ? w / (r.ms / 60000) : Infinity;
    if (Number.isFinite(wpm)) wpms.push(wpm);
    if (wpm > READ_WPM) fast++;
    if (r.seen != null && r.seen < 0.9) unseen++;
    away += r.hid || 0;
  }
  if (!n) return null;
  wpms.sort((a, b) => a - b);
  const c = pr.checks || { asked: 0, passed: 0 };
  const pace = 1 - fast / n, seen = 1 - unseen / n, pass = c.asked ? c.passed / c.asked : pace;
  const score = Math.round(100 * (0.5 * pace + 0.2 * seen + 0.3 * pass));
  return { score, verdict: score >= 85 ? 'careful' : score >= 60 ? 'mixed' : 'skimming', paragraphs: n, fast, unseen, away, wpm: wpms.length ? Math.round(wpms[wpms.length >> 1]) : null };
}
function sugVisible(p, s, me, role) { return atLeast(role, 'editor') || !p.settings.blind || s.by === me || s.by === 'ai' || s.status === 'accepted'; }
function sugView(s) { const { base, ...rest } = s; return { ...rest, base }; }
function projectView(p, s) {
  const role = roleOf(p, s);
  const full = atLeast(role, 'editor');
  const owner = role === 'owner';
  const members = [{ sub: p.owner, name: p.ownerName, email: p.ownerEmail, role: 'owner', status: 'active', joined: p.created }, ...(p.members || []).filter(m => full || m.status === 'active')];
  const prog = {};
  for (const [sub, v] of Object.entries(p.progress || {})) if (full || sub === s.sub) prog[sub] = { read: v.read, cur: v.cur, time: v.time || 0, checks: v.checks, fast: v.fast || 0, done: !!v.done, last: v.last };
  const dismissed = (p.ai && p.ai.dismissed) || {};
  const reviews = {};
  if (full || p.settings.ai.readers) for (const [bid, r] of Object.entries((p.ai && p.ai.review) || {})) reviews[bid] = { ver: r.ver, at: r.at, issues: (r.issues || []).filter(i => !dismissed[i.id]) };
  const ldis = (p.lint && p.lint.dismissed) || {};
  return {
    id: p.id, title: p.title, owner: p.owner, created: p.created, updated: p.updated, rev: p.rev || 0, role,
    me: { sub: s.sub, name: meName(s), email: s.e, admin: isAdmin(s) },
    source: { kind: p.source.kind, filename: p.source.filename, pages: p.source.pages, main: p.source.main, files: (p.source.files || []).map(f => f.name), uploaded: !!p.source.uploaded, pageImages: !!p.source.pageImages, pageExt: p.source.pageExt || 'webp', layoutVer: p.source.layoutVer || 0, pdfPaired: !!p.source.pdfPaired, pdfName: p.source.pdfName || null, pdfFile: p.source.pdfFile || null, original: p.source.original || null, notes: p.source.notes || [], canDownload: full || !!p.settings.allowDownload },
    latexShare: full ? p.latexShare || null : undefined, latexEnabled: !!env.LATEX_KEY, compileBridge: BRIDGE, pace: { wpm: READ_WPM, long: LONG_WORDS }, rexpEnabled: full && RR_ON, rexp: full && RR_ON ? rexpView(p) : undefined, latexReturn: full ? p.latexReturn || null : undefined, imported: p.imported || null, removedCount: (p.removedBlocks || []).length,
    latex: p.latex, settings: p.settings,
    members: members.map(m => memberSummary(p, m, full)),
    invites: owner ? (p.invites || []).map(i => ({ id: i.id, email: i.email, role: i.role, status: i.status === 'pending' && Date.parse(i.expires) < Date.now() ? 'expired' : i.status, created: i.created, expires: i.expires, mail: i.mail, mailDetail: i.mailDetail, acceptedAt: i.acceptedAt })) : undefined,
    sections: p.sections, blocks: p.blocks, tables: p.tables, figures: p.figures, refs: p.refs, citations: p.citations,
    refcheck: p.refcheck ? { ...p.refcheck, link: p.refcheck.id ? refcheck.link(p.refcheck.id) : null } : null, refcheckEnabled: refcheck.enabled,
    suggestions: (p.suggestions || []).filter(x => sugVisible(p, x, s.sub, role)).map(sugView),
    changes: p.changes || [], milestones: p.milestones || [], progress: prog,
    ai: { enabled: ai.enabled, checks: CHECKS(), readers: !!p.settings.ai.readers, review: reviews, job: p.ai && p.ai.job || null, quizReady: Object.keys(p.quiz || {}).length },
    lint: p.lint ? { at: p.lint.at, issues: (p.lint.issues || []).filter(i => !ldis[i.id]) } : null,
    evidence: p.evidence || null,
    presence: presenceList(p.id),
    stats: projectStats(p),
  };
}
function projectStats(p) {
  const sugs = p.suggestions || [];
  return {
    blocks: readingSet(p).length, words: (p.blocks || []).reduce((n, b) => n + (READ_KINDS.has(b.kind) ? tk.countWords(plain(p, b)) : 0), 0),
    open: sugs.filter(x => x.status === 'open' && x.kind === 'edit').length, comments: sugs.filter(x => x.kind === 'comment' && x.status === 'open').length,
    accepted: sugs.filter(x => x.status === 'accepted').length, changed: (p.blocks || []).filter(b => b.cur !== b.text).length, changes: (p.changes || []).filter(c => !c.undone).length,
    readers: (p.members || []).filter(m => m.status === 'active').length,
  };
}

// ── Text changes, versions, undo ───────────────────────────
function versionText(p, b, v) {
  if (v === 0) return b.text;
  const list = (p.versions || {})[b.id] || [];
  const x = list.find(z => z.v === v);
  return x ? x.text : null;
}
/** Set a block's current text, record the version and the change. */
function applyText(p, b, text, { s, cause, sid = null, note = '', undoOf = null, batch = null }) {
  if (text === b.cur) return null;
  p.versions = p.versions || {};
  const list = p.versions[b.id] = p.versions[b.id] || [];
  const from = b.ver || 0;
  const to = Math.max(from, ...list.map(x => x.v)) + 1;
  const cid = U.shortId();
  list.push({ v: to, text, by: s ? s.sub : 'ai', at: U.now(), cid });
  if (list.length > 200) list.splice(0, list.length - 200);
  b.cur = text; b.ver = to;
  const ch = { id: cid, bid: b.id, from, to, by: s ? s.sub : 'ai', byName: s ? meName(s) : 'Studio AI', at: U.now(), cause, sid, note: U.strT(note, 500), undone: false, undoOf, batch };
  p.changes = p.changes || [];
  p.changes.push(ch);
  if (p.changes.length > 5000) p.changes.splice(0, p.changes.length - 5000);
  // stale AI review for this block
  return ch;
}
function emitBlock(p, b, ch) { emit(p, { t: 'block', bid: b.id, cur: b.cur, ver: b.ver, change: ch }); scheduleLint(p); }

// ── A new version of the source (edited in Rykhet LaTeX or elsewhere), merged without losing history ──
const normT = t => String(t || '').replace(/\s+/g, ' ').trim();
function similarity(a, b) {
  const W = t => new Set(normT(t).toLowerCase().split(' ').filter(w => w.length > 2));
  const A = W(a), B = W(b);
  if (!A.size || !B.size) return normT(a) === normT(b) ? 1 : 0;
  let k = 0;
  for (const w of A) if (B.has(w)) k++;
  return k / Math.max(A.size, B.size);
}
/**
 * Rebase the manuscript onto a newly read version. Paragraphs are matched in order (same text first, then similar text
 * in the gaps): unchanged ones keep everything, edited ones get the new text as a recorded change (history and undo
 * work), new ones are added, missing ones are kept in p.removedBlocks (for the change list and the diff PDF).
 */
function mergeDocument(p, doc, s, via, keepLayout = false) {
  const old = p.blocks || [], neu = doc.blocks;
  // a paragraph matches when the new text equals its current text or the source text it was last synced from
  const A = old.map(b => normT(b.cur ?? b.text)), A0 = old.map(b => normT(b.base ?? b.text)), B = neu.map(b => normT(b.text));
  const eq = (i, j) => A[i] === B[j] || A0[i] === B[j];
  const n = A.length, m = B.length;
  const pairOf = new Array(m).fill(null);
  if (n * m <= 16e6) {
    const W = m + 1, L = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = eq(i, j) ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) { if (eq(i, j)) { pairOf[j] = i; i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++; }
  } else {
    const at = new Map(); A.forEach((t, i) => { if (!at.has(t)) at.set(t, i); }); A0.forEach((t, i) => { if (!at.has(t)) at.set(t, i); });
    let last = -1; B.forEach((t, j) => { const i = at.get(t); if (i != null && i > last) { pairOf[j] = i; last = i; } });
  }
  // in each gap between matched paragraphs, pair edited paragraphs by similarity (in order)
  let j0 = 0, i0 = 0;
  for (let j = 0; j <= m; j++) {
    if (j < m && pairOf[j] == null) continue;
    const iEnd = j < m ? pairOf[j] : n;
    let iNext = i0;
    for (let jj = j0; jj < j; jj++) {
      let best = -1, bs = 0.45;
      for (let i = iNext; i < iEnd && i < iNext + 6; i++) { const sc = similarity(A[i], B[jj]) + (old[i].kind === neu[jj].kind ? 0.05 : 0); if (sc > bs) { bs = sc; best = i; } }
      if (best >= 0) { pairOf[jj] = best; iNext = best + 1; }
    }
    if (j < m) { i0 = pairOf[j] + 1; j0 = j + 1; }
  }
  const used = new Set(old.map(b => b.id)), idMap = new Map(), paired = new Set(pairOf.filter(i => i != null));
  const stats = { same: 0, changed: 0, added: 0, removed: 0 };
  const out = [];
  neu.forEach((nb, j) => {
    const i = pairOf[j];
    const layout = { kind: nb.kind, sec: nb.sec, tex: nb.tex, page: nb.page, boxes: nb.boxes, src: nb.src, label: nb.label, ref: nb.ref };
    // no PDF came with this version: paragraphs keep their place on the previous pages
    if (keepLayout && i != null && !(nb.boxes && nb.boxes.length)) { layout.boxes = old[i].boxes; layout.page = old[i].page; }
    if (i == null) {
      let id = nb.id;
      while (used.has(id)) id = `b${U.shortId()}`;
      used.add(id); idMap.set(nb.id, id);
      // a new paragraph: originally empty, so diffs, the change list and undo all treat it as an insertion
      const b = { ...nb, id, text: '', cur: '', ver: 0, base: nb.text, added: U.now() };
      applyText(p, b, nb.text, { s, cause: 'external', note: via });
      out.push(b);
      stats.added++;
      return;
    }
    const b = old[i];
    const base = b.base ?? b.text, cur = b.cur ?? b.text;
    if (normT(cur) === normT(nb.text)) {
      if (b.cur === b.text) b.text = nb.text; // only spacing differs
      b.cur = nb.text; stats.same++;
    } else if (normT(base) === normT(nb.text)) {
      stats.same++; // the source is unchanged here: the edit made in the Studio stays (and is still to be written)
    } else {
      // changed in the source: three-way merge with edits made in the Studio since the last sync
      const mr = normT(cur) === normT(base) ? { ok: true, text: nb.text } : tk.merge3(base, cur, nb.text);
      applyText(p, b, mr.ok ? mr.text : nb.text, { s, cause: 'external', note: mr.ok ? via : `${via} (overlapping edits: the new version was taken; the earlier text is in the history)` });
      stats.changed++; if (p.quiz) delete p.quiz[b.id];
    }
    Object.assign(b, layout, { base: nb.text });
    if (b.base === b.text) delete b.base;
    idMap.set(nb.id, b.id); out.push(b);
  });
  // paragraphs that are gone: remember them next to the paragraph that now follows
  p.removedBlocks = p.removedBlocks || [];
  old.forEach((b, i) => {
    if (paired.has(i)) return;
    let k = i + 1; while (k < n && !paired.has(k)) k++;
    p.removedBlocks.push({ id: b.id, kind: b.kind, text: b.cur ?? b.text, anchor: k < n ? old[k].id : null, at: U.now(), by: s.sub, via });
    for (const x of p.suggestions || []) if (x.bid === b.id && x.status === 'open') { x.status = 'withdrawn'; x.closedNote = `The paragraph was removed (${via}).`; }
    if (p.quiz) delete p.quiz[b.id];
    stats.removed++;
  });
  if (p.removedBlocks.length > 500) p.removedBlocks.splice(0, p.removedBlocks.length - 500);
  // figures and tables: the new reading, keeping data that was entered or corrected by hand
  const mapBid = x => (x.bid && idMap.has(x.bid) ? { ...x, bid: idMap.get(x.bid) } : x);
  const oldFig = new Map((p.figures || []).map(f => [f.label, f]));
  const oldTab = new Map((p.tables || []).map(t => [t.label, t]));
  p.figures = doc.figures.map(mapBid).map(f => { const o = oldFig.get(f.label); return o && o.data && (o.data.source === 'manual' || !f.data) ? { ...f, data: o.data } : f; });
  p.tables = doc.tables.map(mapBid).map(t => { const o = oldTab.get(t.label); return o && o.source === 'manual' ? { ...t, grid: o.grid, source: 'manual' } : t; });
  Object.assign(p, { blocks: out, sections: doc.sections, refs: doc.refs, latex: doc.latex, citations: doc.citations });
  const alive = new Set(out.map(b => b.id));
  if (p.evidence && Array.isArray(p.evidence.claims)) { p.evidence.claims = p.evidence.claims.filter(c => !c.bid || alive.has(c.bid)); p.evidence.outdated = U.now(); }
  return stats;
}

const lintTimers = new Map();
function scheduleLint(p, ms = 4000) {
  clearTimeout(lintTimers.get(p.id));
  lintTimers.set(p.id, setTimeout(() => {
    lintTimers.delete(p.id);
    try { const dis = (p.lint && p.lint.dismissed) || {}; p.lint = { at: U.now(), issues: lint(p, tk), dismissed: dis }; store.touch(p, { index: false }); emit(p, { t: 'lint' }); } catch (e) { console.error('[studio] lint', e); }
  }, ms));
}

// ── Attention checks ───────────────────────────────────────
const quizInflight = new Map(); // pid → Promise
function seeded(sub, bid) { const h = crypto.createHash('sha256').update(`${sub}|${bid}|${SECRET.slice(0, 8)}`).digest(); return h.readUInt32BE(0) / 0xffffffff; }
function shuffle(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function ensureQuiz(p, bids, { wait = true } = {}) {
  const need = bids.map(id => p.blocks.find(b => b.id === id)).filter(b => b && quizEligible(p, b) && !(p.quiz && p.quiz[b.id] && p.quiz[b.id].items.length));
  if (!need.length || !CHECKS()) return;
  const prev = quizInflight.get(p.id) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const still = need.filter(b => !(p.quiz && p.quiz[b.id] && p.quiz[b.id].items.length));
    if (!still.length) return;
    const batch = still.slice(0, 5);
    const items = batch.map((b, k) => ({ b: k + 1, text: plain(p, b).slice(0, 3500) }));
    let out = [];
    try { out = await ai.quiz({ title: p.title, items }); } catch (e) { console.error('[studio] quiz', e.message); }
    p.quiz = p.quiz || {};
    storeQuiz(p, batch, out, ai.enabled ? 'ai' : 'rules');
    // the AI failed or skipped a paragraph: questions made from the paragraph itself, so no check is ever missing
    ruleQuiz(p, batch);
    store.touch(p, { index: false });
  });
  quizInflight.set(p.id, run);
  run.finally(() => { if (quizInflight.get(p.id) === run) quizInflight.delete(p.id); });
  if (wait) await run;
}
/** Keep valid questions for paragraphs that have none yet (never replaces questions a reader may be answering). */
function storeQuiz(p, blocks, out, source) {
  p.quiz = p.quiz || {};
  for (const x of Array.isArray(out) ? out : []) {
    const b = blocks[Number(x.b) - 1];
    if (!b || (p.quiz[b.id] && p.quiz[b.id].items.length && p.quiz[b.id].ver === b.ver)) continue;
    const qs = (Array.isArray(x.questions) ? x.questions : []).filter(q => q && typeof q.q === 'string' && Array.isArray(q.options) && q.options.length === 4 && q.options.every(o => typeof o === 'string' && o.trim()) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4 && new Set(q.options.map(o => o.trim().toLowerCase())).size === 4)
      .slice(0, 3).map(q => ({ q: U.strT(q.q, 300), options: q.options.map(o => U.strT(o, 160)), a: q.answer, why: U.strT(q.why, 300) }));
    if (qs.length) p.quiz[b.id] = { ver: b.ver, items: qs, source };
  }
}
/** Fill-in-the-blank questions made from the paragraph itself (when the AI is unavailable or too slow). */
function ruleQuiz(p, blocks) {
  const todo = blocks.filter(b => !(p.quiz && p.quiz[b.id] && p.quiz[b.id].items.length));
  if (!todo.length) return;
  try { storeQuiz(p, todo, assist.quiz({ items: todo.map((b, k) => ({ b: k + 1, text: plain(p, b) })) }), 'rules'); }
  catch (e) { console.error('[studio] rule quiz', e.message); }
}
/** Words of a block's reading text (cached per text, blocks are read often). */
const wordCache = new WeakMap();
function wordsOf(p, b) {
  const k = b.cur ?? b.text;
  const c = wordCache.get(b);
  if (c && c.k === k) return c.n;
  const n = tk.countWords(plain(p, b));
  wordCache.set(b, { k, n });
  return n;
}
/**
 * Is a reading check due? Always when the paragraph was marked read faster than READ_WPM (active reading time, as
 * measured in the browser and capped by the server's own clock), when its end was never scrolled into view, or when it
 * is long; otherwise as often as the owner chose.
 */
function checkDue(p, s, b, pr, ms, sig = {}) {
  const st = p.settings.checks;
  if (!st.enabled || !quizEligible(p, b)) return { due: false };
  const role = roleOf(p, s);
  if (role === 'owner' && !st.owner) return { due: false };
  const words = wordsOf(p, b);
  if (ms < (words / READ_WPM) * 60000) return { due: true, fast: true, why: 'fast' };
  if (sig.seen != null && sig.seen < 0.9) return { due: true, why: 'unseen' };
  if (st.long !== false && words >= LONG_WORDS) return { due: true, why: 'long' };
  if (st.freq === 'every') return { due: true };
  const since = pr.sinceCheck || 0;
  if (since >= (st.freq === 'often' ? 3 : st.freq === 'rare' ? 14 : 7)) return { due: true };
  return { due: seeded(s.sub, b.id) < (FREQ[st.freq] || 0.25) };
}
function issueCheck(p, s, b, pr, tries = 0) {
  const q = p.quiz && p.quiz[b.id];
  if (!q || !q.items.length) return null;
  pr.asked = pr.asked || {};
  const askedHere = pr.asked[b.id] || [];
  let qi = q.items.findIndex((_, i) => !askedHere.includes(i));
  if (qi < 0) qi = askedHere.length % q.items.length;
  pr.asked[b.id] = [...askedHere, qi];
  const perm = shuffle(4);
  const cid = U.shortId();
  p.pending = p.pending || {};
  p.pending[s.sub] = { cid, bid: b.id, qi, perm, at: Date.now(), tries };
  pr.checks = pr.checks || { asked: 0, passed: 0, failed: 0 };
  pr.checks.asked++;
  return { cid, bid: b.id, q: q.items[qi].q, options: perm.map(i => q.items[qi].options[i]), attempt: tries + 1 };
}

// ── Jobs (AI pre-check, evidence, references) ──────────────
const jobs = new Map(); // pid → { cancelled }
function setJob(p, patch) {
  p.ai = p.ai || {};
  p.ai.job = { ...(p.ai.job || {}), ...patch, at: U.now() };
  emit(p, { t: 'job', job: p.ai.job });
}
function glossary(p) {
  const defs = new Map();
  for (const b of p.blocks || []) {
    if (!REVIEW_KINDS.has(b.kind)) continue;
    for (const m of plain(p, b).matchAll(/((?:[A-Za-z][\w-]+\s+){1,6}[A-Za-z][\w-]+)\s+\(([A-Z][A-Za-z0-9-]*[A-Z0-9]s?)\)/g)) if (!defs.has(m[2])) defs.set(m[2], m[1].split(/\s+/).slice(-Math.max(2, m[2].replace(/[^A-Z]/g, '').length)).join(' '));
  }
  return [...defs].slice(0, 80).map(([a, l]) => `${a} = ${l}`).join('; ');
}
function batchBlocks(list, maxChars = 7000, maxN = 8) {
  const out = []; let cur = [], size = 0;
  for (const x of list) { const n = x.text.length; if (cur.length && (size + n > maxChars || cur.length >= maxN)) { out.push(cur); cur = []; size = 0; } cur.push(x); size += n; }
  if (cur.length) out.push(cur);
  return out;
}
function validIssues(text, issues) {
  const out = [];
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!i || typeof i.quote !== 'string' || typeof i.fix !== 'string') continue;
    const quote = i.quote.slice(0, 400), fix = i.fix.slice(0, 600);
    if (!quote.trim() || quote === fix || !tk.findQuote(text, quote)) continue;
    const id = crypto.createHash('sha1').update(`${quote}|${fix}`).digest('hex').slice(0, 10);
    if (out.some(x => x.id === id)) continue;
    out.push({ id, cat: U.strT(i.cat, 20) || 'grammar', sev: ['high', 'medium', 'low'].includes(i.sev) ? i.sev : 'medium', quote, fix, why: U.strT(i.why, 240) });
    if (out.length >= 14) break;
  }
  return out;
}
async function reviewBlocks(p, blocks, onBatch = () => {}, cancelled = () => false) {
  const gl = glossary(p);
  const secTitle = new Map((p.sections || []).map(s => [s.id, s.title]));
  const items = blocks.map(b => ({ b, text: (b.cur ?? b.text).slice(0, 6000) }));
  for (const batch of batchBlocks(items)) {
    if (cancelled()) return;
    let out = [];
    try { out = await ai.review({ title: p.title, glossary: gl, items: batch.map((x, k) => ({ b: k + 1, text: x.text, kind: x.b.kind, section: secTitle.get(x.b.sec) || '', tex: x.b.tex })) }); } catch (e) { console.error('[studio] review', e.message); onBatch(batch.length, e); continue; }
    p.ai = p.ai || {}; p.ai.review = p.ai.review || {};
    batch.forEach((x, k) => {
      const r = out.find(z => Number(z.b) === k + 1);
      p.ai.review[x.b.id] = { ver: x.b.ver || 0, at: U.now(), issues: validIssues(x.b.cur ?? x.b.text, r && r.issues) };
    });
    store.touch(p, { index: false });
    emit(p, { t: 'review', bids: batch.map(x => x.b.id) });
    onBatch(batch.length);
  }
}
/** Authors (as chosen, or read from the LaTeX source the first time), years and results for the project view. */
function rexpView(p) {
  const r = p.rexp || {};
  const year = new Date().getUTCFullYear();
  const guess = !r.authors && p.source && p.source.kind === 'latex' ? EXPO.authorsFromLatex((p.source.texFiles || {})[p.source.main]).map(name => ({ name, ids: [], labels: [] })) : null;
  return { authors: r.authors || guess || [], guessed: !!guess, from: r.from || year - 2, to: r.to || year, results: r.results || {}, job: r.job || null, method: EXPO.METHOD };
}
/** Each chosen author's Retraction Radar report, summarized with Radar's default method (one author at a time). */
async function runExposure(p, s, todo) {
  const set = patch => { p.rexp.job = { ...(p.rexp.job || {}), ...patch, at: U.now() }; emit(p, { t: 'rexp' }); };
  set({ status: 'running', done: 0, total: todo.length, label: `Checking ${todo[0].name}…`, error: null, by: meName(s) });
  p.rexp.results = p.rexp.results || {};
  for (const [i, a] of todo.entries()) {
    set({ done: i, label: `Checking ${a.name} (${i + 1} of ${todo.length})…` });
    try {
      const report = await rrCall('/internal/report', { authors: a.ids, from: p.rexp.from, to: p.rexp.to });
      p.rexp.results[a.name] = { ...EXPO.summarize(report), ids: a.ids, at: U.now() };
    } catch (e) {
      p.rexp.results[a.name] = { error: e.message, ids: a.ids, at: U.now() };
    }
    store.touch(p, { index: false });
  }
  set({ status: 'done', done: todo.length, label: 'Finished' });
  act(p, s, 'rexp', { detail: `${todo.length} author(s), ${p.rexp.from}–${p.rexp.to}` });
  store.touch(p, { index: false });
}
async function runPrecheck(p, s, opts) {
  const job = { cancelled: false };
  jobs.set(p.id, job);
  store.pin(p.id);
  const cancelled = () => job.cancelled;
  try {
    setJob(p, { kind: 'precheck', status: 'running', step: 'checks', label: 'Consistency checks', done: 0, total: 1, started: U.now(), finished: null, error: null, by: meName(s) });
    const dis = (p.lint && p.lint.dismissed) || {};
    p.lint = { at: U.now(), issues: lint(p, tk), dismissed: dis };
    emit(p, { t: 'lint' });
    if (opts.refs && refcheck.enabled && (p.refs || []).length && !(p.refcheck && ['queued', 'running'].includes(p.refcheck.status))) await startRefCheck(p, s).catch(e => console.error('[studio] refcheck', e.message));
    if (opts.review && ai.enabled) {
      const todo = (p.blocks || []).filter(b => REVIEW_KINDS.has(b.kind) && tk.countWords(plain(p, b)) >= 3 && !(p.ai && p.ai.review && p.ai.review[b.id] && p.ai.review[b.id].ver === (b.ver || 0)));
      setJob(p, { step: 'review', label: 'AI proofreading', done: 0, total: todo.length });
      let done = 0;
      await reviewBlocks(p, todo, n => { done += n; setJob(p, { done }); }, cancelled);
    }
    if (opts.quiz && CHECKS() && p.settings.checks.enabled && !cancelled()) {
      const todo = (p.blocks || []).filter(b => quizEligible(p, b) && !(p.quiz && p.quiz[b.id]));
      setJob(p, { step: 'quiz', label: 'Writing reading checks', done: 0, total: todo.length });
      for (let k = 0; k < todo.length && !cancelled(); k += 5) { await ensureQuiz(p, todo.slice(k, k + 5).map(b => b.id)); setJob(p, { done: Math.min(todo.length, k + 5) }); }
    }
    if (opts.evidence && CHECKS() && !cancelled()) {
      setJob(p, { step: 'evidence', label: 'Cross-checking numbers with tables and figures', done: 0, total: 1 });
      const ev = await runEvidence(p, { ai, tk, cancelled, onProgress: (d, t, label) => setJob(p, { done: d, total: t, label }) });
      if (ev) { p.evidence = ev; emit(p, { t: 'evidence' }); }
    }
    setJob(p, { status: cancelled() ? 'cancelled' : 'done', step: 'done', label: cancelled() ? 'Stopped' : 'Finished', finished: U.now() });
    act(p, s, 'precheck', { detail: cancelled() ? 'stopped' : 'finished' });
  } catch (e) {
    console.error('[studio] precheck', e);
    setJob(p, { status: 'error', error: 'Something went wrong during the check. Try again.', finished: U.now() });
  } finally {
    jobs.delete(p.id);
    store.touch(p, { index: false });
    store.unpin(p.id);
  }
}
async function startRefCheck(p, s) {
  const owner = { sub: p.owner, email: p.ownerEmail, name: p.ownerName };
  const r = await refcheck.start(owner, { title: p.title, filename: p.source.filename, source: p.source.kind === 'latex' ? 'bib' : 'pdf', refs: p.refs.map(x => ({ raw: x.raw, parsed: x.parsed || undefined })), citations: p.citations || undefined });
  p.refcheck = { id: r.id, status: 'queued', at: U.now(), by: s ? s.sub : null, summary: null, refs: null };
  store.touch(p, { index: false });
  emit(p, { t: 'refcheck' });
  pollRefCheck(p.id);
  return p.refcheck;
}
const refPolls = new Set();
function pollRefCheck(pid) {
  if (refPolls.has(pid)) return;
  refPolls.add(pid);
  const tick = async () => {
    const p = await store.load(pid);
    if (!p || !p.refcheck || !p.refcheck.id) { refPolls.delete(pid); return; }
    try {
      const r = await refcheck.status({ sub: p.owner }, p.refcheck.id);
      p.refcheck = { ...p.refcheck, status: r.status, phase: r.phase, summary: r.summary, progress: r.progress, refs: r.refs, updated: U.now(), error: null };
      store.touch(p, { index: false });
      emit(p, { t: 'refcheck' });
      if (['done', 'cancelled', 'error'].includes(r.status)) { refPolls.delete(pid); return; }
    } catch (e) {
      p.refcheck.error = e.message; store.touch(p, { index: false });
      if (e.status === 404) { refPolls.delete(pid); return; }
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 3000);
}

// ── HTTP helpers ───────────────────────────────────────────
function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } } }
  return null;
}
const secureFlag = BASE.startsWith('https:') ? '; Secure' : '';
const setCookie = (n, v, age) => `${n}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secureFlag}`;
const clearAll = [setCookie(SESSION, '', 0), setCookie(IDT, '', 0)];
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src https://latex.rykhet.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=31536000', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin' };
const redirect = (res, to, cookies = []) => { res.writeHead(302, { ...SEC, Location: to, 'Cache-Control': 'no-store', 'Set-Cookie': cookies }); res.end(); };
function json(res, status, obj, cookies = []) {
  const body = JSON.stringify(obj);
  const headers = { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookies };
  if (body.length > 2048 && /\bgzip\b/.test(res.req.headers['accept-encoding'] || '')) {
    zlib.gzip(body, { level: 5 }, (e, z) => { if (e) { res.writeHead(status, headers); return res.end(body); } res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }); res.end(z); });
    return;
  }
  res.writeHead(status, headers); res.end(body);
}
function download(res, name, type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  res.writeHead(200, { ...SEC, 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
  res.end(buf);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };
const gzCache = new Map();
function sendFile(req, res, file, { cache = 'no-cache', status = 200 } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { ...SEC, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('Not found'); }
    const ext = path.extname(file);
    const headers = { ...SEC, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': status === 404 ? 'no-store' : cache, 'Last-Modified': st.mtime.toUTCString() };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString()) && status === 200) { res.writeHead(304, headers); return res.end(); }
    const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /\.(html|css|js|mjs|svg|json|txt|xml)$/.test(ext) && st.size > 1024;
    if (gzipOk) {
      const key = `${file}:${st.mtimeMs}`;
      const send = z => { res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': z.length }); res.end(z); };
      if (gzCache.has(key)) return send(gzCache.get(key));
      return fs.readFile(file, (e, buf) => { if (e) { res.writeHead(500); return res.end(); } zlib.gzip(buf, { level: 9 }, (e2, z) => { if (e2) { res.writeHead(500); return res.end(); } if (gzCache.size > 80) gzCache.clear(); if (z.length < 1.5e6) gzCache.set(key, z); send(z); }); });
    }
    res.writeHead(status, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}
async function readRaw(req, max) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('Upload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readBody(req, max = 200000) {
  const buf = await readRaw(req, max);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });

// ── "Proofread together" from Rykhet LaTeX ─────────────────
// The editor hands a project over server to server (loopback, shared key, never through the tunnel); the owner's
// browser then reads it on the new-manuscript page like a dropped folder. Kept in memory for a few hours.
const handoffs = new Map(); // id -> { owner, name, main, files, pdf, editor, at }
const HANDOFF_TTL = 6 * 3600e3;
function editorCaller(req) {
  const key = String(req.headers['x-internal-key'] || ''), want = String(env.LATEX_KEY || '');
  const ok = want.length >= 32 && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
  return ok && !req.headers['cf-connecting-ip'] && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
}
async function handoffIn(req, res) {
  if (!editorCaller(req)) return json(res, 403, { error: 'Forbidden' });
  let b;
  try { b = await readBody(req, 40_000_000); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  const o = b.owner || {};
  if (!/^[\w.:@-]{3,80}$/.test(String(o.sub || ''))) return json(res, 400, { error: 'owner.sub required' });
  const files = (Array.isArray(b.files) ? b.files : []).filter(f => f && typeof f.path === 'string' && !f.path.includes('..') && (typeof f.text === 'string' || typeof f.base64 === 'string')).slice(0, 2000)
    .map(f => ({ path: f.path.replace(/^\/+/, '').slice(0, 300), ...(typeof f.text === 'string' ? { text: f.text } : { base64: f.base64 }) }));
  if (!files.some(f => /\.tex$/i.test(f.path))) return json(res, 400, { error: 'The project has no .tex file' });
  const now = Date.now();
  for (const [k, h] of handoffs) if (now - h.at > HANDOFF_TTL) handoffs.delete(k);
  while (handoffs.size >= 30) handoffs.delete(handoffs.keys().next().value);
  const id = U.shortId() + U.shortId();
  const editor = b.editor && typeof b.editor.token === 'string' ? { token: b.editor.token.slice(0, 80), studio: typeof b.editor.studio === 'string' ? b.editor.studio.slice(0, 24) : null } : null;
  handoffs.set(id, { owner: { sub: String(o.sub), email: String(o.email || ''), name: String(o.name || '') }, name: U.strT(b.name, 200) || 'Untitled', main: U.strT(b.main, 300) || 'main.tex', files, pdf: typeof b.pdf === 'string' && b.pdf.length ? b.pdf : null, editor, at: now });
  return json(res, 200, { url: `${BASE}/app/new?handoff=${id}` });
}
/** Tell Rykhet LaTeX which Studio project its hand-off became, so "Send to Studio" and "Bring changes back" work. */
async function linkEditor(p, h) {
  if (!h.editor || !env.LATEX_KEY) return;
  try {
    const resp = await fetch(`${env.LATEX_URL || 'http://127.0.0.1:4130'}/internal/studio-link`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.LATEX_KEY }, body: JSON.stringify({ token: h.editor.token, studioId: p.id, owner: p.owner }) });
    if (!resp.ok) throw new Error(`Rykhet LaTeX ${resp.status}`);
    p.latexShare = { url: `${LATEX_SITE}/s/${h.editor.token}`, at: U.now(), by: p.ownerName, changed: 0, from: 'editor' };
  } catch (e) { console.error('[studio] link editor', e.message); }
}

// ── API ────────────────────────────────────────────────────
async function api(req, res, p_, s, url) {
  const M = req.method;
  if (M === 'GET' && p_ === '/api/me') {
    return json(res, 200, { user: { sub: s.sub, name: meName(s), email: s.e, admin: isAdmin(s) }, ai: ai.enabled, checks: CHECKS(), refcheck: refcheck.enabled, limits: { ai: isAdmin(s) ? null : LIMITS.aiDaily, aiUsed: used(`ai:${s.sub}`) }, account: '/login?mode=password', accountLabel: 'Change password' });
  }
  if (M === 'GET' && p_ === '/api/projects') {
    const r = store.forUser(s.sub, s.e);
    const enrich = async row => {
      const p = await store.load(row.id);
      if (!p) return null;
      const st = projectStats(p);
      const pr = (p.progress || {})[s.sub];
      const readers = (p.members || []).filter(m => m.status === 'active').map(m => { const x = (p.progress || {})[m.sub]; return { name: m.name, read: x ? Object.keys(x.read || {}).length : 0, done: !!(x && x.done) }; });
      return { id: p.id, title: p.title, role: row.role, kind: p.source.kind, created: p.created, updated: p.updated, deadline: p.settings.deadline, owner: p.ownerName, stats: st, mine: { read: pr ? Object.keys(pr.read || {}).length : 0, done: !!(pr && pr.done) }, readers, pages: (p.source.pages || []).length, job: p.ai && p.ai.job && p.ai.job.status === 'running' ? p.ai.job : null };
    };
    const mine = (await Promise.all(r.mine.map(enrich))).filter(Boolean);
    const shared = (await Promise.all(r.shared.map(enrich))).filter(Boolean);
    const invites = [];
    for (const x of r.invites) {
      const p = await store.load(x.pid); if (!p) continue;
      const inv = (p.invites || []).find(i => i.id === x.iid);
      if (inv && inv.status === 'pending' && Date.parse(inv.expires) > Date.now()) invites.push({ pid: p.id, iid: inv.id, title: p.title, from: p.ownerName, role: inv.role, expires: inv.expires });
    }
    return json(res, 200, { mine: mine.sort((a, b) => String(b.updated).localeCompare(String(a.updated))), shared, invites });
  }
  let hm;
  if (M === 'GET' && (hm = p_.match(/^\/api\/handoff\/([A-Za-z0-9_-]{8,64})$/))) {
    const h = handoffs.get(hm[1]);
    if (!h || Date.now() - h.at > HANDOFF_TTL) throw fail(404, 'This hand-off has expired. In Rykhet LaTeX, press “Proofread together” again.');
    if (h.owner.sub !== s.sub) throw fail(403, `Sign in with the Rykhet account you use in Rykhet LaTeX${h.owner.email ? ` (${h.owner.email})` : ''}.`);
    return json(res, 200, { name: h.name, main: h.main, files: h.files, pdf: h.pdf, linked: !!(h.editor && h.editor.studio) });
  }
  if (M === 'POST' && p_ === '/api/projects') {
    const owned = store.forUser(s.sub, s.e).mine.length;
    if (!isAdmin(s) && owned >= LIMITS.projects) throw fail(429, `You have ${owned} manuscripts. Delete some to add more.`);
    const b = await readBody(req, 16_000_000);
    const doc = cleanDoc(b);
    if (doc.blocks.length < 3) throw fail(400, 'Too little text was found in this file.');
    const p = {
      v: 1, id: U.newId(12), rev: 1, created: U.now(), updated: U.now(), owner: s.sub, ownerName: meName(s), ownerEmail: s.e,
      ...doc, settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), members: [], invites: [], suggestions: [], versions: {}, changes: [], progress: {}, quiz: {}, quizLog: [], pending: {},
      ai: { review: {}, dismissed: {}, job: null }, lint: null, evidence: null, refcheck: null, milestones: [], activity: [],
    };
    if (b.settings && typeof b.settings === 'object') applySettings(p, b.settings);
    p.lint = { at: U.now(), issues: lint(p, tk), dismissed: {} };
    act(p, s, 'created', { detail: `${doc.blocks.length} blocks from ${doc.source.filename || doc.source.kind}` });
    const h = typeof b.handoff === 'string' && handoffs.get(b.handoff);
    if (h && h.owner.sub === s.sub && p.source.kind === 'latex') { await linkEditor(p, h); handoffs.delete(b.handoff); if (p.latexShare) act(p, s, 'latex-share', { detail: 'from Rykhet LaTeX' }); }
    await store.create(p);
    touchUser(s);
    logActivity({ kind: 'project', sub: s.sub, id: p.id, blocks: doc.blocks.length, source: doc.source.kind });
    return json(res, 201, { id: p.id });
  }
  const m = p_.match(/^\/api\/projects\/([a-z0-9]{8,24})(?:\/(.*))?$/);
  const im = p_.match(/^\/api\/invite\/([A-Za-z0-9_-]{20,80})(?:\/(accept))?$/);
  if (im) return inviteApi(req, res, s, im[1], im[2]);
  if (M === 'GET' && p_ === '/api/admin/overview' && isAdmin(s)) {
    return json(res, 200, { users: Object.entries(users).map(([, u]) => ({ email: u.email, name: u.name, first: u.first, last: u.last })), store: store.stats(), ai: ai.status(), mem: Math.round(process.memoryUsage().rss / 1048576), streams: [...streams.values()].reduce((n, x) => n + x.size, 0), jobs: jobs.size, usage: Object.fromEntries(Object.entries(usage).slice(-14)) });
  }
  if (!m) throw fail(404, 'Not found');
  const p = await store.load(m[1]);
  const role = roleOf(p, s);
  if (!p || !role) throw fail(404, 'This manuscript does not exist or you do not have access to it.');
  return projectApi(req, res, p, s, role, m[2] || '', url);
}

function applySettings(p, x) {
  const st = p.settings;
  if (x.checks && typeof x.checks === 'object') {
    if (typeof x.checks.enabled === 'boolean') st.checks.enabled = x.checks.enabled;
    if (FREQ[x.checks.freq]) st.checks.freq = x.checks.freq;
    if (typeof x.checks.requirePass === 'boolean') st.checks.requirePass = x.checks.requirePass;
    if (typeof x.checks.owner === 'boolean') st.checks.owner = x.checks.owner;
    if (typeof x.checks.long === 'boolean') st.checks.long = x.checks.long;
    if (typeof x.checks.pace === 'boolean') st.checks.pace = x.checks.pace;
  }
  if (x.ai && typeof x.ai.readers === 'boolean') st.ai.readers = x.ai.readers;
  for (const k of ['blind', 'refsInReading', 'allowDownload', 'watermark']) if (typeof x[k] === 'boolean') st[k] = x[k];
  if ('deadline' in x) st.deadline = x.deadline && /^\d{4}-\d{2}-\d{2}$/.test(x.deadline) ? x.deadline : null;
  if (typeof x.instructions === 'string') st.instructions = U.strT(x.instructions, 4000);
  if (['sequential', 'free'].includes(x.order)) st.order = x.order;
}

/** The pending invitation behind a next=/app/invite/<token> link (for sign-up). */
async function inviteFor(next) {
  const m = /^\/app\/invite\/([A-Za-z0-9_-]{20,80})/.exec(String(next || ''));
  if (!m) return null;
  const hash = U.sha256(m[1]);
  const pid = (store.index.tokens || {})[hash];
  const p = pid ? await store.load(pid) : null;
  const inv = p && (p.invites || []).find(i => i.hash === hash || (i.hashes || []).includes(hash));
  return inv && inv.status === 'pending' && Date.parse(inv.expires) > Date.now() ? inv : null;
}
async function inviteApi(req, res, s, token, action) {
  const hash = U.sha256(token);
  let found = null;
  const pid = (store.index.tokens || {})[hash];
  const cand = pid ? [pid] : [];
  for (const id of cand) {
    const p = await store.load(id);
    const inv = p && (p.invites || []).find(i => i.hash === hash || (i.hashes || []).includes(hash));
    if (inv) { found = { p, inv }; break; }
  }
  if (!found) throw fail(404, 'This invitation link is no longer valid (it was withdrawn, or replaced by an older version of Research Studio). Ask the owner to press Resend: the link in the new email will work.');
  const { p, inv } = found;
  const expired = Date.parse(inv.expires) < Date.now();
  const emailOk = String(s.e || '').toLowerCase() === inv.email.toLowerCase();
  const already = roleOf(p, s);
  const info = { title: p.title, from: p.ownerName, role: inv.role, email: inv.email, status: expired && inv.status === 'pending' ? 'expired' : inv.status, emailOk, signedInAs: s.e, member: !!already, pid: p.id, deadline: p.settings.deadline, blocks: readingSet(p).length, pages: (p.source.pages || []).length, checks: p.settings.checks.enabled, instructions: p.settings.instructions, message: inv.message || '' };
  if (req.method === 'GET' && !action) return json(res, 200, info);
  if (req.method === 'POST' && action === 'accept') {
    if (already) return json(res, 200, { ok: true, pid: p.id });
    if (inv.status !== 'pending' || expired) throw fail(410, inv.status === 'revoked' ? 'This invitation was withdrawn.' : inv.status === 'accepted' ? 'This invitation was already used.' : 'This invitation has expired. Ask the owner to send a new one.');
    if (!emailOk) throw fail(403, `This invitation is for ${inv.email}. You are signed in as ${s.e}.`, { wrongEmail: true });
    p.members = (p.members || []).filter(x => x.sub !== s.sub);
    p.members.push({ sub: s.sub, email: s.e, name: meName(s), role: inv.role, status: 'active', joined: U.now(), invitedBy: inv.by });
    inv.status = 'accepted'; inv.acceptedAt = U.now(); inv.acceptedBy = s.sub;
    act(p, s, 'joined', { detail: inv.role });
    store.touch(p);
    touchUser(s);
    emit(p, { t: 'members' });
    return json(res, 200, { ok: true, pid: p.id });
  }
  throw fail(404, 'Not found');
}

async function projectApi(req, res, p, s, role, rest, url) {
  const M = req.method;
  const need = r => { if (!atLeast(role, r)) throw fail(403, r === 'owner' ? 'Only the owner can do this.' : 'Only the owner or an editor can do this.'); };
  const block = id => { const b = (p.blocks || []).find(x => x.id === id); if (!b) throw fail(404, 'No such paragraph.'); return b; };
  const save = (o) => store.touch(p, o);
  const aiQuota = () => { if (!ai.enabled) throw fail(503, 'The AI is not available right now.'); if (!isAdmin(s) && used(`ai:${s.sub}`) >= LIMITS.aiDaily) throw fail(429, `You have used today's ${LIMITS.aiDaily} AI requests. The limit resets at midnight UTC.`); count(`ai:${s.sub}`); };

  if (M === 'GET' && !rest) {
    const pr = (p.progress || {})[s.sub];
    if (!pr || !pr.seenToday || pr.seenToday !== today()) { p.progress = p.progress || {}; const x = p.progress[s.sub] = p.progress[s.sub] || { read: {}, started: U.now(), time: 0, checks: { asked: 0, passed: 0, failed: 0 } }; x.seenToday = today(); act(p, s, 'opened'); save({ index: false }); }
    return json(res, 200, projectView(p, s));
  }
  if (M === 'PATCH' && !rest) {
    need('owner');
    const b = await readBody(req);
    if (typeof b.title === 'string' && b.title.trim()) p.title = U.strT(b.title, 300);
    if (b.settings && typeof b.settings === 'object') applySettings(p, b.settings);
    act(p, s, 'settings');
    save(); emit(p, { t: 'settings', settings: p.settings, title: p.title });
    return json(res, 200, { ok: true, settings: p.settings, title: p.title });
  }
  // a proofreader or editor removes themselves (their suggestions and comments stay)
  if (M === 'POST' && rest === 'leave') {
    if (role === 'owner') throw fail(400, 'The owner cannot leave. Delete the manuscript instead, or keep it.');
    for (const m of p.members || []) if (m.sub === s.sub && m.status === 'active') { m.status = 'left'; m.left = U.now(); }
    act(p, s, 'left');
    save(); emit(p, { t: 'members' });
    return json(res, 200, { ok: true });
  }
  if (M === 'DELETE' && !rest) {
    need('owner');
    const j = jobs.get(p.id); if (j) j.cancelled = true;
    emit(p, { t: 'deleted' });
    for (const c of streams.get(p.id) || []) { try { c.res.end(); } catch { /* closed */ } }
    await store.remove(p.id);
    logActivity({ kind: 'delete', sub: s.sub, id: p.id });
    return json(res, 200, { ok: true });
  }
  // ── files ──
  let fm = rest.match(/^files\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,120})$/);
  if (fm) {
    const name = fm[1];
    const isSource = /^(source\.|pdf-)/.test(name); // the original upload, or a compiled PDF of a LaTeX project
    if (M === 'PUT') {
      need(/^source\./.test(name) ? 'owner' : 'editor');
      const max = isSource ? LIMITS.maxUploadMb * 1048576 : 12 * 1048576;
      const buf = await readRaw(req, max);
      if (!buf.length) throw fail(400, 'Empty upload.');
      if (/\.pdf$/.test(name) && buf.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'Not a PDF file.');
      if (/\.zip$/.test(name) && buf.readUInt32LE(0) !== 0x04034b50) throw fail(400, 'Not a zip file.');
      if (/\.(webp|png|jpg)$/.test(name) && !/^(RIFF|\x89PNG|\xff\xd8)/.test(buf.subarray(0, 4).toString('latin1'))) throw fail(400, 'Not an image.');
      await store.putFile(p.id, name, buf);
      if (/^source\./.test(name)) { p.source.uploaded = true; p.source.original = name; p.source.size = buf.length; }
      if (/^pdf-/.test(name)) { p.source.pdfFile = name; act(p, s, 'compiled-pdf', { detail: name.slice(4) }); }
      if (/^page-\d+\./.test(name)) { p.source.pageImages = true; p.source.pageExt = path.extname(name).slice(1); }
      if (/^fig-/.test(name)) { const f = (p.figures || []).find(x => `fig-${x.id}` === name.replace(/\.\w+$/, '')); if (f) { f.image = name; emit(p, { t: 'figure', id: f.id, figure: f }); } }
      save({ index: false });
      return json(res, 200, { ok: true });
    }
    if (M === 'GET') {
      if (isSource && !(atLeast(role, 'editor') || p.settings.allowDownload)) throw fail(403, 'The owner has not allowed downloading the original file.');
      const buf = await store.getFile(p.id, name);
      if (!buf) throw fail(404, 'File not found.');
      if (isSource) act(p, s, 'download', { detail: name });
      const ext = path.extname(name);
      res.writeHead(200, { ...SEC, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': isSource ? 'private, no-store' : 'private, max-age=3600', ...(isSource && url.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename="${(p.source.filename || name).replace(/[^\w.\- ]/g, '_')}"` } : {}) });
      return res.end(buf);
    }
  }
  // ── live updates ──
  if (M === 'GET' && rest === 'events') {
    res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 4000\n\ndata: ${JSON.stringify({ t: 'hello', rev: p.rev })}\n\n`);
    const c = { res, sub: s.sub, role, name: meName(s) };
    if (!streams.has(p.id)) streams.set(p.id, new Set());
    streams.get(p.id).add(c);
    store.pin(p.id);
    if (!presence.has(p.id)) presence.set(p.id, new Map());
    const pm = presence.get(p.id);
    pm.set(s.sub, { name: meName(s), bid: (pm.get(s.sub) || {}).bid || null, at: Date.now(), n: ((pm.get(s.sub) || {}).n || 0) + 1 });
    emitPresence(p);
    req.on('close', () => {
      const set = streams.get(p.id); if (set) { set.delete(c); if (!set.size) streams.delete(p.id); }
      store.unpin(p.id);
      const e = pm.get(s.sub); if (e) { e.n--; if (e.n <= 0) pm.delete(s.sub); }
      emitPresence(p);
    });
    return;
  }

  // ── reading progress and attention checks ──
  if (M === 'POST' && rest === 'read') {
    need('proofreader');
    const b0 = await readBody(req, 4000);
    const b = block(String(b0.bid));
    p.progress = p.progress || {};
    const pr = p.progress[s.sub] = p.progress[s.sub] || { read: {}, started: U.now(), time: 0, checks: { asked: 0, passed: 0, failed: 0 } };
    pr.last = U.now();
    const pm = presence.get(p.id);
    if (pm && pm.has(s.sub)) { pm.get(s.sub).bid = b.id; pm.get(s.sub).at = Date.now(); emitPresence(p); }
    if (b0.view) {
      pr.cur = b.id;
      pr.view = { bid: b.id, at: Date.now() }; // the server's own clock for how long this paragraph has been open
      // prepare reading checks for the next paragraphs in the background
      if (p.settings.checks.enabled && CHECKS()) {
        const set = readingSet(p); const i = set.indexOf(b);
        ensureQuiz(p, set.slice(i, i + 5).map(x => x.id), { wait: false }).catch(() => {});
      }
      save({ index: false, delay: 3000 });
      return json(res, 200, { ok: true });
    }
    // reading behaviour from the browser: active ms (tab visible, window in use, not idle), times the reader left the
    // tab, idle ms, and how much of the paragraph was scrolled into view; the active time can't exceed the open time
    const wall = pr.view && pr.view.bid === b.id ? Date.now() - pr.view.at : null;
    let ms = U.int(b0.ms, 0, 3_600_000, 0);
    if (wall != null) ms = Math.min(ms, wall + 2000);
    const sig = { hid: U.int(b0.hid, 0, 1000, 0), idle: U.int(b0.idle, 0, 3_600_000, 0), seen: b0.seen == null ? null : U.num(b0.seen, 0, 1, 1) };
    const beh = r0 => { const words = wordsOf(p, b); const tot = ((r0 && r0.ms) || 0) + ms; return { wpm: tot > 0 ? Math.round(words / (tot / 60000)) : null, seen: sig.seen == null ? (r0 && r0.seen) ?? null : Math.max(sig.seen, (r0 && r0.seen) || 0), hid: ((r0 && r0.hid) || 0) + sig.hid, idle: ((r0 && r0.idle) || 0) + sig.idle }; };
    pr.time = (pr.time || 0) + Math.min(ms, 20 * 60000);
    const pend = p.pending && p.pending[s.sub];
    if (pend && pend.bid === b.id) {
      // asking again after a wrong answer
      if (Date.now() - pend.at < 4000) throw fail(429, 'Take a moment to re-read the paragraph first.');
      const chk = issueCheck(p, s, b, pr, pend.tries);
      save({ index: false });
      return json(res, 200, { check: chk });
    }
    const prev = pr.read[b.id];
    if (!prev || prev.ok === false) {
      const due = prev ? { due: false } : checkDue(p, s, b, pr, ms + ((prev && prev.ms) || 0), sig);
      if (due.fast) pr.fast = (pr.fast || 0) + 1;
      if (due.why === 'unseen') pr.unseen = (pr.unseen || 0) + 1;
      if (due.due) {
        // a question is due: give the AI up to 20 s, then ask one made from the paragraph itself
        if (!(p.quiz && p.quiz[b.id] && p.quiz[b.id].items.length)) await Promise.race([ensureQuiz(p, [b.id]), new Promise(r => setTimeout(r, 20000))]).catch(() => {});
        if (!(p.quiz && p.quiz[b.id] && p.quiz[b.id].items.length)) ruleQuiz(p, [b]);
        const chk = issueCheck(p, s, b, pr, 0);
        if (chk) {
          pr.read[b.id] = { at: U.now(), ms: ms + ((prev && prev.ms) || 0), ok: null, fast: !!due.fast, ...beh(prev) };
          pr.sinceCheck = 0;
          save({ index: false });
          return json(res, 200, { check: { ...chk, fast: !!due.fast, why: due.why || null } });
        }
      }
      if (QUIZ_KINDS.has(b.kind)) pr.sinceCheck = (pr.sinceCheck || 0) + 1;
    }
    pr.read[b.id] = { ...(pr.read[b.id] || {}), ...beh(pr.read[b.id]), at: U.now(), ms: ((pr.read[b.id] && pr.read[b.id].ms) || 0) + ms, ok: pr.read[b.id] && pr.read[b.id].ok != null ? pr.read[b.id].ok : null };
    const fin = finishedNow(p, s, pr);
    save({ index: false });
    emit(p, { t: 'progress', sub: s.sub, read: Object.keys(pr.read).length, done: !!pr.done }, c => atLeast(c.role, 'editor') || c.sub === s.sub);
    return json(res, 200, { ok: true, finished: fin });
  }
  if (M === 'POST' && rest === 'check') {
    need('proofreader');
    const b0 = await readBody(req, 2000);
    const pend = p.pending && p.pending[s.sub];
    if (!pend || pend.cid !== b0.cid) throw fail(409, 'This question has expired. Continue reading.');
    const q = p.quiz[pend.bid] && p.quiz[pend.bid].items[pend.qi];
    const pr = p.progress[s.sub];
    const choice = U.int(b0.choice, -1, 3, -1);
    const correct = !!q && choice >= 0 && pend.perm[choice] === q.a;
    const ms = Date.now() - pend.at;
    p.quizLog = p.quizLog || [];
    p.quizLog.push({ sub: s.sub, bid: pend.bid, at: U.now(), ok: correct, ms, attempt: pend.tries + 1 });
    if (p.quizLog.length > 20000) p.quizLog.splice(0, p.quizLog.length - 20000);
    const r = pr.read[pend.bid] = pr.read[pend.bid] || { at: U.now(), ms: 0 };
    let out;
    if (correct) {
      pr.checks.passed++; r.ok = true; r.tries = pend.tries + 1; delete p.pending[s.sub];
      out = { correct: true, why: q.why };
    } else {
      const tries = pend.tries + 1;
      if (!p.settings.checks.requirePass || tries >= 3) {
        pr.checks.failed++; r.ok = false; r.tries = tries; r.final = true; delete p.pending[s.sub];
        out = { correct: false, final: true, answer: q ? q.options[q.a] : null, why: q ? q.why : null };
      } else {
        pend.tries = tries; pend.at = Date.now(); r.ok = false;
        out = { correct: false, retry: true, attemptsLeft: 3 - tries };
      }
    }
    const fin = out.correct || out.final ? finishedNow(p, s, pr) : false;
    save({ index: false });
    emit(p, { t: 'progress', sub: s.sub, read: Object.keys(pr.read).length, done: !!pr.done }, c => atLeast(c.role, 'editor') || c.sub === s.sub);
    return json(res, 200, { ...out, finished: fin });
  }
  if (M === 'POST' && rest === 'finish') {
    need('proofreader');
    const b0 = await readBody(req, 6000);
    const pr = (p.progress || {})[s.sub];
    if (!pr) throw fail(400, 'Nothing read yet.');
    pr.done = true; pr.doneAt = pr.doneAt || U.now();
    if (!pr.notified && p.owner !== s.sub && p.ownerEmail) {
      pr.notified = U.now();
      const mine = (p.suggestions || []).filter(x => x.by === s.sub);
      mailer.send(p.ownerEmail, 'finished', { who: meName(s), title: p.title, total: readingSet(p).length, suggestions: mine.filter(x => x.kind === 'edit').length, comments: mine.filter(x => x.kind === 'comment').length, checks: pr.checks.asked, passed: pr.checks.passed, message: U.strT(b0.message, 2000), link: `${BASE}/app/p/${p.id}` }).catch(() => {});
    }
    act(p, s, 'finished');
    save({ index: false });
    emit(p, { t: 'progress', sub: s.sub, done: true });
    return json(res, 200, { ok: true });
  }

  // ── suggestions and comments ──
  if (M === 'POST' && rest === 'suggestions') {
    need('proofreader');
    const b0 = await readBody(req, 120000);
    const b = block(String(b0.bid));
    const kind = ['comment', 'mark'].includes(b0.kind) ? b0.kind : 'edit';
    const text = kind === 'edit' ? U.str(b0.text, 40000) : null;
    if (kind === 'edit' && (!text || text === b.cur)) throw fail(400, 'The suggested text is the same as the current text.');
    const note = U.strT(b0.note, 4000);
    if (kind === 'comment' && !note) throw fail(400, 'Write a comment.');
    // marks: a highlighted phrase (quote) or a highlighted area of the typeset page (area, in page points)
    const area = kind === 'mark' && b0.area ? cleanBox(b0.area) : null;
    if (kind === 'mark' && !area && !U.strT(b0.quote, 600)) throw fail(400, 'Select some text or an area to mark.');
    const color = ['yellow', 'green', 'pink', 'blue'].includes(b0.color) ? b0.color : 'yellow';
    const sug = { id: U.shortId(), bid: b.id, kind, by: s.sub, byName: meName(s), at: U.now(), base: b.cur, baseVer: b.ver || 0, text, note, cat: U.strT(b0.cat, 24) || (kind === 'edit' ? 'wording' : kind), quote: U.strT(b0.quote, 600) || null, area, color: kind === 'mark' ? color : undefined, status: 'open', replies: [], votes: [], ai: b0.ai ? U.strT(b0.ai, 20) : null };
    p.suggestions.push(sug);
    act(p, s, kind === 'edit' ? 'suggested' : kind === 'mark' ? 'marked' : 'commented', { bid: b.id });
    save({ index: false });
    emit(p, { t: 'sug', s: sugView(sug) }, c => sugVisible(p, sug, c.sub, c.role));
    return json(res, 201, sugView(sug));
  }
  let sm = rest.match(/^suggestions\/([a-f0-9]{12})(?:\/(accept|reject|reopen|withdraw|reply|vote|resolve))?$/);
  if (sm) {
    const sug = (p.suggestions || []).find(x => x.id === sm[1]);
    if (!sug || !sugVisible(p, sug, s.sub, role)) throw fail(404, 'No such suggestion.');
    const b = block(sug.bid);
    const op = sm[2];
    const b0 = M === 'POST' || M === 'PATCH' ? await readBody(req, 120000) : {};
    const done = () => { save({ index: false }); emit(p, { t: 'sug', s: sugView(sug) }, c => sugVisible(p, sug, c.sub, c.role)); return json(res, 200, sugView(sug)); };
    if (M === 'PATCH' && !op) {
      if (sug.by !== s.sub || sug.status !== 'open') throw fail(403, 'Only the author can edit an open suggestion.');
      if (sug.kind === 'edit' && typeof b0.text === 'string') { if (b0.text === sug.base) throw fail(400, 'No change left.'); sug.text = U.str(b0.text, 40000); }
      if (typeof b0.note === 'string') sug.note = U.strT(b0.note, 4000);
      if (typeof b0.cat === 'string') sug.cat = U.strT(b0.cat, 24);
      sug.edited = U.now();
      return done();
    }
    if (op === 'accept') {
      need('editor');
      if (sug.kind !== 'edit') throw fail(400, 'Comments cannot be accepted; resolve them instead.');
      if (sug.status !== 'open') throw fail(409, 'This suggestion was already handled.');
      let text;
      if (typeof b0.text === 'string' && b0.text) text = U.str(b0.text, 40000); // the editor merged it by hand
      else if ((b.ver || 0) === sug.baseVer) text = sug.text;
      else {
        const mr = tk.merge3(sug.base, sug.text, b.cur);
        if (!mr.ok) throw fail(409, 'The paragraph changed since this suggestion was made and the changes overlap. Merge it by hand.', { conflict: true, base: sug.base, text: sug.text, cur: b.cur, ver: b.ver });
        text = mr.text;
      }
      const ch = applyText(p, b, text, { s, cause: 'suggestion', sid: sug.id, note: sug.note });
      sug.status = 'accepted'; sug.decidedBy = s.sub; sug.decidedByName = meName(s); sug.decidedAt = U.now(); sug.cid = ch ? ch.id : null;
      // other open suggestions on this block now need a merge; mark nothing, merge3 handles it on accept
      act(p, s, 'accepted', { bid: b.id, sid: sug.id });
      save({ index: false });
      emit(p, { t: 'sug', s: sugView(sug) }, c => sugVisible(p, sug, c.sub, c.role));
      if (ch) emitBlock(p, b, ch);
      return json(res, 200, { ok: true, suggestion: sugView(sug), change: ch, cur: b.cur, ver: b.ver });
    }
    if (op === 'reject') { need('editor'); if (sug.status !== 'open') throw fail(409, 'Already handled.'); sug.status = 'rejected'; sug.decidedBy = s.sub; sug.decidedByName = meName(s); sug.decidedAt = U.now(); sug.reason = U.strT(b0.reason, 1000); act(p, s, 'rejected', { bid: b.id, sid: sug.id }); return done(); }
    if (op === 'resolve') { if (!(atLeast(role, 'editor') || sug.by === s.sub)) throw fail(403, 'Not allowed.'); sug.status = sug.status === 'resolved' ? 'open' : 'resolved'; sug.decidedBy = s.sub; sug.decidedAt = U.now(); return done(); }
    if (op === 'reopen') {
      need('editor');
      if (sug.status === 'accepted' && sug.cid) { const ch = (p.changes || []).find(c => c.id === sug.cid); if (ch && !ch.undone) throw fail(409, 'Undo the change in the history first.'); }
      sug.status = 'open'; sug.decidedBy = null; sug.decidedAt = null; return done();
    }
    if (op === 'withdraw') { if (sug.by !== s.sub) throw fail(403, 'Only the author can withdraw it.'); if (sug.status !== 'open') throw fail(409, 'Already handled.'); sug.status = 'withdrawn'; return done(); }
    if (op === 'reply') {
      const t = U.strT(b0.text, 3000);
      if (!t) throw fail(400, 'Write a reply.');
      sug.replies.push({ id: U.shortId(), by: s.sub, byName: meName(s), at: U.now(), text: t });
      return done();
    }
    if (op === 'vote') { const i = sug.votes.indexOf(s.sub); if (i >= 0) sug.votes.splice(i, 1); else sug.votes.push(s.sub); return done(); }
    throw fail(404, 'Not found');
  }

  // ── direct edits, history, undo ──
  let bm = rest.match(/^blocks\/([a-zA-Z0-9_-]{1,24})\/(edit|restore|history)$/);
  if (bm) {
    const b = block(bm[1]);
    if (bm[2] === 'history' && M === 'GET') {
      const list = [{ v: 0, text: b.text, by: null, at: p.created, cause: 'original' }, ...((p.versions || {})[b.id] || [])];
      return json(res, 200, { versions: list, changes: (p.changes || []).filter(c => c.bid === b.id) });
    }
    need('editor');
    const b0 = await readBody(req, 120000);
    if (bm[2] === 'edit') {
      let text = U.str(b0.text, 40000);
      if (!text.trim()) throw fail(400, 'The paragraph cannot be empty.');
      const baseVer = Number.isInteger(b0.baseVer) ? b0.baseVer : b.ver;
      if (baseVer !== (b.ver || 0)) {
        const base = versionText(p, b, baseVer);
        const mr = base != null ? tk.merge3(base, text, b.cur) : { ok: false };
        if (!mr.ok) throw fail(409, 'Someone changed this paragraph while you were editing, and the edits overlap.', { conflict: true, cur: b.cur, ver: b.ver });
        text = mr.text;
      }
      const ch = applyText(p, b, text, { s, cause: b0.cause === 'ai' ? 'ai' : b0.cause === 'lint' ? 'lint' : b0.cause === 'evidence' ? 'evidence' : 'edit', note: U.strT(b0.note, 500) });
      if (!ch) return json(res, 200, { ok: true, unchanged: true });
      if (b0.issue && p.ai && p.ai.dismissed) p.ai.dismissed[U.strT(b0.issue, 20)] = { by: s.sub, at: U.now(), applied: true };
      act(p, s, 'edited', { bid: b.id });
      save({ index: false });
      emitBlock(p, b, ch);
      return json(res, 200, { ok: true, change: ch, cur: b.cur, ver: b.ver });
    }
    if (bm[2] === 'restore') {
      const v = U.int(b0.v, 0, 1e6, -1);
      const t = versionText(p, b, v);
      if (t == null) throw fail(404, 'No such version.');
      const ch = applyText(p, b, t, { s, cause: 'restore', note: `Restored version ${v}` });
      if (!ch) return json(res, 200, { ok: true, unchanged: true });
      act(p, s, 'restored', { bid: b.id, v });
      save({ index: false });
      emitBlock(p, b, ch);
      return json(res, 200, { ok: true, change: ch, cur: b.cur, ver: b.ver });
    }
  }
  let cm = rest.match(/^changes\/([a-f0-9]{12})\/undo$/);
  if (cm && M === 'POST') {
    need('editor');
    const ch = (p.changes || []).find(c => c.id === cm[1]);
    if (!ch) throw fail(404, 'No such change.');
    if (ch.undone) throw fail(409, 'This change was already undone.');
    const b = block(ch.bid);
    const before = versionText(p, b, ch.from), after = versionText(p, b, ch.to);
    if (before == null || after == null) throw fail(410, 'This change is too old to undo; restore a version instead.');
    let text;
    if ((b.ver || 0) === ch.to) text = before;
    else { const mr = tk.merge3(after, before, b.cur); if (!mr.ok) throw fail(409, 'Later edits overlap with this change. Restore an earlier version from the paragraph history instead.'); text = mr.text; }
    const nch = applyText(p, b, text, { s, cause: 'undo', undoOf: ch.id, note: `Undid: ${ch.note || ch.cause}` });
    ch.undone = true; ch.undoneBy = s.sub; ch.undoneAt = U.now(); ch.undoneIn = nch ? nch.id : null;
    if (ch.undoOf) { const orig = p.changes.find(c => c.id === ch.undoOf); if (orig) { orig.undone = false; } }
    if (ch.sid) { const sug = p.suggestions.find(x => x.id === ch.sid); if (sug && sug.status === 'accepted') { sug.status = 'open'; sug.decidedBy = null; sug.decidedAt = null; emit(p, { t: 'sug', s: sugView(sug) }, c => sugVisible(p, sug, c.sub, c.role)); } }
    act(p, s, 'undo', { bid: b.id, cid: ch.id });
    save({ index: false });
    emit(p, { t: 'change', change: ch });
    if (nch) emitBlock(p, b, nch);
    return json(res, 200, { ok: true, change: nch, undone: ch, cur: b.cur, ver: b.ver });
  }
  if (M === 'POST' && rest === 'milestones') {
    need('editor');
    const b0 = await readBody(req, 4000);
    const ms = { id: U.shortId(), name: U.strT(b0.name, 120) || `Milestone ${(p.milestones || []).length + 1}`, at: U.now(), by: s.sub, byName: meName(s), vers: Object.fromEntries((p.blocks || []).map(b => [b.id, b.ver || 0])) };
    p.milestones = p.milestones || []; p.milestones.push(ms);
    act(p, s, 'milestone', { detail: ms.name });
    save({ index: false }); emit(p, { t: 'milestones' });
    return json(res, 201, ms);
  }
  let mm = rest.match(/^milestones\/([a-f0-9]{12})\/restore$/);
  if (mm && M === 'POST') {
    need('editor');
    const ms = (p.milestones || []).find(x => x.id === mm[1]);
    if (!ms) throw fail(404, 'No such milestone.');
    const batch = U.shortId();
    let n = 0;
    for (const b of p.blocks) {
      const v = ms.vers[b.id] ?? 0;
      if ((b.ver || 0) === v) continue;
      const t = versionText(p, b, v);
      if (t == null || t === b.cur) continue;
      const ch = applyText(p, b, t, { s, cause: 'restore', note: `Restored milestone “${ms.name}”`, batch });
      if (ch) { n++; emitBlock(p, b, ch); }
    }
    act(p, s, 'restored', { detail: ms.name });
    save({ index: false });
    return json(res, 200, { ok: true, changed: n });
  }

  // ── AI ──
  if (M === 'POST' && rest === 'ai/precheck') {
    need('editor');
    if (!CHECKS()) throw fail(503, 'The checks are not available right now.');
    if (jobs.has(p.id)) throw fail(409, 'A check is already running.');
    if (!isAdmin(s) && used(`pre:${p.id}`) >= LIMITS.prechecksDaily) throw fail(429, `This manuscript was checked ${LIMITS.prechecksDaily} times today. Try again tomorrow.`);
    count(`pre:${p.id}`);
    const b0 = await readBody(req, 2000);
    const opts = { review: b0.review !== false, quiz: b0.quiz !== false, evidence: b0.evidence !== false, refs: b0.refs !== false };
    runPrecheck(p, s, opts);
    return json(res, 202, { ok: true });
  }
  if (M === 'POST' && rest === 'ai/cancel') { need('editor'); const j = jobs.get(p.id); if (j) j.cancelled = true; return json(res, 200, { ok: true }); }
  let am = rest.match(/^ai\/(review|rewrite)\/([a-zA-Z0-9_-]{1,24})$/);
  if (am && M === 'POST') {
    need('proofreader');
    if (!atLeast(role, 'editor') && !p.settings.ai.readers) throw fail(403, 'The owner turned AI help off for readers.');
    const b = block(am[2]);
    aiQuota();
    if (am[1] === 'review') {
      await reviewBlocks(p, [b]);
      const r = p.ai.review[b.id];
      if (!r) throw fail(502, 'The AI did not answer. Try again in a minute.');
      const dismissed = p.ai.dismissed || {};
      return json(res, 200, { ver: r.ver, at: r.at, issues: r.issues.filter(i => !dismissed[i.id]) });
    }
    const secTitle = ((p.sections || []).find(x => x.id === b.sec) || {}).title;
    let r;
    try { r = await ai.rewrite({ text: b.cur, tex: b.tex, section: secTitle, title: p.title }); } catch { r = null; }
    if (!r) throw fail(502, 'The AI did not answer. Try again in a minute.');
    return json(res, 200, r);
  }
  let aim = rest.match(/^ai\/issues\/([a-f0-9]{10})\/(dismiss|restore)$/);
  if (aim && M === 'POST') {
    need('editor');
    p.ai.dismissed = p.ai.dismissed || {};
    if (aim[2] === 'dismiss') p.ai.dismissed[aim[1]] = { by: s.sub, at: U.now() }; else delete p.ai.dismissed[aim[1]];
    save({ index: false }); emit(p, { t: 'review', bids: [] });
    return json(res, 200, { ok: true });
  }
  if (M === 'POST' && rest === 'ai/ask') {
    need('proofreader');
    if (!atLeast(role, 'editor') && !p.settings.ai.readers) throw fail(403, 'The owner turned AI help off for readers.');
    const b0 = await readBody(req, 60000);
    const q = U.strT(b0.question, 2000);
    if (!q) throw fail(400, 'Ask a question.');
    aiQuota();
    const ctx = askContext(p, b0.bid ? (p.blocks || []).find(x => x.id === b0.bid) : null);
    try { const answer = await ai.ask({ question: q, context: ctx, history: Array.isArray(b0.history) ? b0.history : [] }); return json(res, 200, { answer }); }
    catch (e) { console.error('[studio] ask', e.message); throw fail(502, 'The AI did not answer. Try again in a minute.'); }
  }

  // ── consistency checks, evidence, references ──
  if (M === 'POST' && rest === 'lint') { need('editor'); const dis = (p.lint && p.lint.dismissed) || {}; p.lint = { at: U.now(), issues: lint(p, tk), dismissed: dis }; save({ index: false }); emit(p, { t: 'lint' }); return json(res, 200, { ok: true, count: p.lint.issues.length }); }
  let lm = rest.match(/^lint\/([a-f0-9]{10})\/(dismiss|restore)$/);
  if (lm && M === 'POST') { need('editor'); p.lint = p.lint || { issues: [], dismissed: {} }; p.lint.dismissed = p.lint.dismissed || {}; if (lm[2] === 'dismiss') p.lint.dismissed[lm[1]] = { by: s.sub, at: U.now() }; else delete p.lint.dismissed[lm[1]]; save({ index: false }); emit(p, { t: 'lint' }); return json(res, 200, { ok: true }); }
  if (M === 'POST' && rest === 'evidence') {
    need('editor');
    if (!CHECKS()) throw fail(503, 'The checks are not available right now.');
    if (jobs.has(p.id)) throw fail(409, 'A check is already running.');
    if (!isAdmin(s) && used(`pre:${p.id}`) >= LIMITS.prechecksDaily) throw fail(429, 'Daily limit for checks on this manuscript reached.');
    count(`pre:${p.id}`);
    runPrecheck(p, s, { review: false, quiz: false, evidence: true, refs: false });
    return json(res, 202, { ok: true });
  }
  let em = rest.match(/^evidence\/claims\/([a-f0-9]{10})$/);
  if (em && M === 'PATCH') {
    need('editor');
    const c = p.evidence && p.evidence.claims.find(x => x.id === em[1]);
    if (!c) throw fail(404, 'No such claim.');
    const b0 = await readBody(req, 4000);
    if (['consistent', 'mismatch', 'partly', 'unverifiable', 'unlinked', 'dismissed'].includes(b0.verdict)) { c.override = b0.verdict === c.verdict ? null : b0.verdict; c.overrideBy = meName(s); }
    if (typeof b0.note === 'string') c.note = U.strT(b0.note, 1000);
    save({ index: false }); emit(p, { t: 'evidence' });
    return json(res, 200, c);
  }
  if (rest === 'refcheck') {
    if (M === 'POST') {
      need('editor');
      if (!refcheck.enabled) throw fail(503, 'The reference checker is not connected.');
      if (!(p.refs || []).length) throw fail(400, 'No reference list was found in this manuscript.');
      try { await startRefCheck(p, s); } catch (e) { throw fail(e.status === 429 ? 429 : 502, e.status === 429 ? e.message : `RefCheck: ${e.message}`); }
      return json(res, 202, p.refcheck);
    }
  }
  let fx = rest.match(/^(figures|tables)\/([a-zA-Z0-9_-]{1,24})$/);
  if (fx && (M === 'PUT' || M === 'PATCH')) {
    need('editor');
    const list = fx[1] === 'figures' ? p.figures : p.tables;
    const item = (list || []).find(x => x.id === fx[2]);
    if (!item) throw fail(404, 'Not found.');
    const b0 = await readBody(req, 600000);
    if (fx[1] === 'figures') { if ('data' in b0) item.data = cleanData(b0.data); if (typeof b0.ocr === 'string') item.ocr = U.strT(b0.ocr, 8000); if (Array.isArray(b0.text)) item.text = b0.text.slice(0, 400).map(t => U.strT(t, 120)); }
    else { if (Array.isArray(b0.grid)) { item.grid = cleanGrid(b0.grid); item.source = b0.source === 'ai' ? 'ai' : 'manual'; } }
    if (typeof b0.caption === 'string') item.caption = U.strT(b0.caption, 3000);
    item.editedBy = meName(s); item.editedAt = U.now();
    act(p, s, fx[1] === 'figures' ? 'figure-data' : 'table-data', { detail: item.label });
    save({ index: false }); emit(p, { t: fx[1] === 'figures' ? 'figure' : 'table', id: item.id, [fx[1] === 'figures' ? 'figure' : 'table']: item });
    return json(res, 200, item);
  }
  let tx = rest.match(/^tables\/([a-zA-Z0-9_-]{1,24})\/rebuild$/);
  if (tx && M === 'POST') {
    need('editor');
    const t = (p.tables || []).find(x => x.id === tx[1]);
    if (!t) throw fail(404, 'Not found.');
    aiQuota();
    const rows = (t.rows && t.rows.length ? t.rows : t.grid) || [];
    if (!rows.length) throw fail(400, 'No table text to rebuild from.');
    const grid = await ai.table({ caption: t.caption, rows }).catch(() => null);
    if (!grid) throw fail(502, 'The AI could not rebuild this table.');
    t.grid = cleanGrid(grid); t.source = 'ai';
    save({ index: false }); emit(p, { t: 'table', id: t.id, table: t });
    return json(res, 200, t);
  }

  // ── people ──
  if (M === 'POST' && rest === 'invites') {
    need('owner');
    const b0 = await readBody(req, 20000);
    const emails = [...new Set((Array.isArray(b0.emails) ? b0.emails : String(b0.emails || '').split(/[\s,;]+/)).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) throw fail(400, 'Add at least one email address.');
    const bad = emails.filter(e => !U.isEmail(e));
    if (bad.length) throw fail(400, `Not a valid email address: ${bad.slice(0, 3).join(', ')}`);
    if (emails.length > 30) throw fail(400, 'Invite at most 30 people at a time.');
    if (!isAdmin(s) && used(`inv:${s.sub}`) + emails.length > LIMITS.invitesDaily) throw fail(429, `You can send ${LIMITS.invitesDaily} invitations per day.`);
    const role = b0.role === 'editor' ? 'editor' : 'proofreader';
    const days = U.int(b0.days, 1, 60, 14);
    const message = U.strT(b0.message, 2000);
    const results = [];
    for (const email of emails) {
      if (email === String(p.ownerEmail || '').toLowerCase()) { results.push({ email, error: 'That is you (the owner).' }); continue; }
      const member = (p.members || []).find(x => x.email && x.email.toLowerCase() === email && x.status === 'active');
      if (member) { results.push({ email, error: 'Already a member.' }); continue; }
      for (const old of p.invites) if (old.email === email && old.status === 'pending') old.status = 'revoked';
      const token = crypto.randomBytes(32).toString('base64url');
      const inv = { id: U.shortId(), email, role, hash: U.sha256(token), hashes: [U.sha256(token)], created: U.now(), expires: new Date(Date.now() + days * 86400e3).toISOString(), by: s.sub, status: 'pending', message, mail: 'skipped' };
      p.invites.push(inv);
      const link = `${BASE}/app/invite/${token}`;
      if (b0.send !== false) {
        count(`inv:${s.sub}`);
        const r = await mailer.send(email, 'invite', { replyTo: s.e, from: meName(s), title: p.title, role, message, link, email, days, checks: p.settings.checks.enabled, deadline: p.settings.deadline });
        inv.mail = r.ok ? 'sent' : 'failed'; inv.mailDetail = r.detail;
      }
      act(p, s, 'invited', { detail: `${email} (${role})` });
      results.push({ email, id: inv.id, link, mail: inv.mail });
    }
    save(); emit(p, { t: 'members' }, c => c.role === 'owner');
    return json(res, 201, { results });
  }
  let iv = rest.match(/^invites\/([a-f0-9]{12})\/(resend|revoke|link)$/);
  if (iv && M === 'POST') {
    need('owner');
    const inv = (p.invites || []).find(x => x.id === iv[1]);
    if (!inv) throw fail(404, 'No such invitation.');
    if (iv[2] === 'revoke') { inv.status = 'revoked'; act(p, s, 'invite-revoked', { detail: inv.email }); save(); return json(res, 200, { ok: true }); }
    if (inv.status === 'accepted') throw fail(409, 'Already accepted.');
    // a new link; links sent earlier keep working (the invitation only works for the invited address)
    const token = crypto.randomBytes(32).toString('base64url');
    const h = U.sha256(token);
    inv.hashes = [...new Set([...(inv.hashes || [inv.hash]), h])].filter(Boolean).slice(-12);
    inv.hash = h; inv.status = 'pending';
    inv.expires = new Date(Math.max(Date.parse(inv.expires) || 0, Date.now() + 14 * 86400e3)).toISOString();
    const link = `${BASE}/app/invite/${token}`;
    if (iv[2] === 'resend') {
      if (!isAdmin(s) && used(`inv:${s.sub}`) >= LIMITS.invitesDaily) throw fail(429, 'Daily invitation limit reached.');
      count(`inv:${s.sub}`);
      const r = await mailer.send(inv.email, 'invite', { replyTo: s.e, from: meName(s), title: p.title, role: inv.role, message: inv.message, link, email: inv.email, days: 14, checks: p.settings.checks.enabled, deadline: p.settings.deadline });
      inv.mail = r.ok ? 'sent' : 'failed'; inv.mailDetail = r.detail;
    }
    save();
    return json(res, 200, { ok: true, link, mail: inv.mail });
  }
  let mb = rest.match(/^members\/([A-Za-z0-9_.@:-]{1,80})(?:\/(remind))?$/);
  if (mb) {
    need('owner');
    const mem = (p.members || []).find(x => x.sub === mb[1]);
    if (!mem) throw fail(404, 'No such member.');
    if (M === 'PATCH' && !mb[2]) { const b0 = await readBody(req, 2000); if (['editor', 'proofreader'].includes(b0.role)) mem.role = b0.role; act(p, s, 'role', { detail: `${mem.email}: ${mem.role}` }); save(); emit(p, { t: 'members' }); return json(res, 200, { ok: true }); }
    if (M === 'DELETE' && !mb[2]) {
      mem.status = 'revoked'; mem.revokedAt = U.now();
      act(p, s, 'access-revoked', { detail: mem.email });
      save();
      emit(p, { t: 'members' });
      for (const c of streams.get(p.id) || []) if (c.sub === mem.sub) { try { c.res.write(`data: ${JSON.stringify({ t: 'revoked' })}\n\n`); c.res.end(); } catch { /* closed */ } }
      return json(res, 200, { ok: true });
    }
    if (M === 'POST' && mb[2] === 'remind') {
      const b0 = await readBody(req, 4000);
      if (!isAdmin(s) && used(`inv:${s.sub}`) >= LIMITS.invitesDaily) throw fail(429, 'Daily email limit reached.');
      count(`inv:${s.sub}`);
      const pr = (p.progress || {})[mem.sub];
      const r = await mailer.send(mem.email, 'remind', { replyTo: s.e, from: meName(s), title: p.title, read: pr ? Object.keys(pr.read || {}).length : 0, total: readingSet(p).length, message: U.strT(b0.message, 2000), deadline: p.settings.deadline, link: `${BASE}/app/p/${p.id}/read` });
      act(p, s, 'reminded', { detail: mem.email });
      save({ index: false });
      return json(res, 200, { ok: r.ok, detail: r.ok ? 'sent' : r.detail });
    }
  }
  if (M === 'GET' && rest === 'activity') { need('owner'); return json(res, 200, { activity: (p.activity || []).slice(-1000).reverse(), quizLog: (p.quizLog || []).slice(-2000) }); }

  // ── files of the project ──
  if (M === 'GET' && rest === 'files') {
    const names = await store.listFiles(p.id);
    const full = atLeast(role, 'editor');
    const files = [];
    for (const n of names.sort()) {
      if (!full && /^source\./.test(n) && !p.settings.allowDownload) continue;
      const kind = /^source\./.test(n) ? 'original' : /^page-/.test(n) ? 'page' : /^fig-/.test(n) ? 'figure' : /^pdf-/.test(n) ? 'compiled' : 'other';
      if (kind === 'page' && !full) continue;
      files.push({ name: n, kind });
    }
    return json(res, 200, { files, source: { kind: p.source.kind, filename: p.source.filename, main: p.source.main, files: p.source.files || [], texFiles: p.source.texFiles ? Object.keys(p.source.texFiles) : [], pdfPaired: !!p.source.pdfPaired, pdfName: p.source.pdfName || null, layoutVer: p.source.layoutVer || 0 }, latexShare: p.latexShare || null });
  }
  // ── the stored LaTeX sources, as they are: the browser applies the changes, marks the diff and packs the files ──
  if (M === 'GET' && rest === 'source-files') {
    if (p.source.kind !== 'latex') throw fail(400, 'This manuscript was uploaded as a PDF.');
    const original = p.source.original && /\.zip$/i.test(p.source.original) && (atLeast(role, 'editor') || p.settings.allowDownload) ? p.source.original : null;
    return json(res, 200, { main: p.source.main, texFiles: p.source.texFiles || {}, removedBlocks: atLeast(role, 'editor') ? p.removedBlocks || [] : [], original });
  }
  // an export made in the browser, for the activity list
  if (M === 'POST' && rest === 'exported') {
    const b0 = await readBody(req, 2000);
    act(p, s, 'export', { detail: U.strT(b0.kind, 40) });
    save({ index: false, delay: 5000 });
    return json(res, 200, { ok: true });
  }
  // ── page layout from a (new) compiled PDF, paired in the browser ──
  if (M === 'PUT' && rest === 'layout') {
    need('editor');
    const b0 = await readBody(req, 4_000_000);
    const pages = Array.isArray(b0.pages) ? b0.pages.slice(0, 2000).map(x => ({ w: U.num(x && x.w, 1, 5000, 612), h: U.num(x && x.h, 1, 5000, 792) })) : null;
    if (!pages || !pages.length) throw fail(400, 'No pages.');
    p.source.pages = pages;
    p.source.pageImages = true;
    p.source.pageExt = ['webp', 'png'].includes(b0.ext) ? b0.ext : p.source.pageExt || 'webp';
    p.source.pdfPaired = p.source.kind === 'latex';
    p.source.pdfName = U.strT(b0.pdfName, 200) || p.source.pdfName || null;
    p.source.layoutVer = (p.source.layoutVer || 0) + 1;
    let n = 0;
    for (const b of p.blocks || []) {
      const x = b0.blocks && b0.blocks[b.id];
      if (x && Array.isArray(x.boxes)) { b.boxes = x.boxes.slice(0, 12).map(cleanBox).filter(Boolean); b.page = x.page ? U.int(x.page, 1, 5000, null) : (b.boxes[0] && b.boxes[0].p) || null; n++; }
      else if (b0.replace) { b.boxes = []; }
    }
    for (const [list, key] of [[p.figures, 'figures'], [p.tables, 'tables']]) for (const it of list || []) { const x = b0[key] && b0[key][it.id]; if (x && x.box) { it.box = cleanBox(x.box); it.page = it.box ? it.box.p : it.page; } }
    act(p, s, 'layout', { detail: `${n} paragraphs placed on ${pages.length} pages${p.source.pdfName ? ` (${p.source.pdfName})` : ''}` });
    save({ index: false }); emit(p, { t: 'layout' });
    return json(res, 200, { ok: true, placed: n, layoutVer: p.source.layoutVer });
  }
  // ── read the manuscript again (newer reader, or a new version of the file) ──
  if (M === 'PUT' && rest === 'document') {
    need('owner');
    const b0 = await readBody(req, 16_000_000);
    if (b0.merge) {
      // a new version of the source: keep history, notes and readers; record what changed
      const doc = cleanDoc(b0);
      if (doc.blocks.length < 3) throw fail(400, 'Too little text was found in this version.');
      const via = U.strT(b0.via, 120) || 'a new version of the source';
      const keepLayout = !(doc.source.pages && doc.source.pages.length) && !!(p.source.pages && p.source.pages.length);
      const stats = mergeDocument(p, doc, s, via, keepLayout);
      const prev = p.source;
      p.source = { ...doc.source, uploaded: prev.uploaded, original: prev.original, layoutVer: (prev.layoutVer || 0) + 1 };
      if (keepLayout) Object.assign(p.source, { pages: prev.pages, pageImages: prev.pageImages, pageExt: prev.pageExt, pdfPaired: prev.pdfPaired, pdfName: prev.pdfName, pdfFile: prev.pdfFile, layoutStale: true });
      else { if (prev.pdfFile) p.source.pdfFile = prev.pdfFile; if (prev.pageExt) p.source.pageExt = prev.pageExt; p.source.pageImages = prev.pageImages; }
      p.lint = { at: U.now(), issues: lint(p, tk), dismissed: (p.lint && p.lint.dismissed) || {} };
      p.imported = { at: U.now(), by: meName(s), via, ...stats };
      act(p, s, 'import', { detail: `${via}: ${stats.changed} changed, ${stats.added} added, ${stats.removed} removed` });
      save(); emit(p, { t: 'layout' });
      return json(res, 200, { ok: true, ...stats });
    }
    const busy = (p.suggestions || []).length || (p.changes || []).length;
    if (busy && !b0.force) throw fail(409,`This manuscript already has ${(p.suggestions || []).length} notes and ${(p.changes || []).length} changes. Re-reading replaces all paragraphs, so those would be lost.`, { busy: true });
    const doc = cleanDoc(b0);
    if (doc.blocks.length < 3) throw fail(400, 'Too little text was found in this file.');
    Object.assign(p, { sections: doc.sections, blocks: doc.blocks, tables: doc.tables, figures: doc.figures, refs: doc.refs, latex: doc.latex, citations: doc.citations });
    p.source = { ...doc.source, uploaded: p.source.uploaded, original: p.source.original, layoutVer: (p.source.layoutVer || 0) + 1 };
    Object.assign(p, { suggestions: [], versions: {}, changes: [], progress: {}, quiz: {}, quizLog: [], pending: {}, ai: { review: {}, dismissed: {}, job: null }, evidence: null, refcheck: null, milestones: [] });
    p.lint = { at: U.now(), issues: lint(p, tk), dismissed: {} };
    act(p, s, 'reread', { detail: `${doc.blocks.length} blocks` });
    save(); emit(p, { t: 'layout' });
    return json(res, 200, { ok: true, blocks: doc.blocks.length });
  }
  // ── the version sent back from Rykhet LaTeX ("Send to Studio" in the editor) ──
  if (M === 'POST' && rest === 'latex-pull') {
    need('owner');
    const peekOnly = !!(await readBody(req, 2000).catch(() => ({}))).peek;
    if (p.source.kind !== 'latex') throw fail(400, 'Only LaTeX uploads can be brought back from Rykhet LaTeX.');
    if (!env.LATEX_KEY) throw fail(503, 'Rykhet LaTeX is not connected.');
    let out;
    try {
      const resp = await fetch(`${env.LATEX_URL || 'http://127.0.0.1:4130'}/internal/studio-pull?studioId=${encodeURIComponent(p.id)}&owner=${encodeURIComponent(p.owner)}`, { signal: AbortSignal.timeout(30000), headers: { 'X-Internal-Key': env.LATEX_KEY } });
      out = await resp.json().catch(() => ({}));
      if (!resp.ok) throw fail(resp.status === 404 ? 404 : 502, out.error || `Rykhet LaTeX ${resp.status}`);
    } catch (e) { if (e.status) throw e; throw fail(502, `Could not reach Rykhet LaTeX: ${e.message}`); }
    if (!out.returned) return json(res, 200, { returned: null });
    const seen = p.latexReturn && p.latexReturn.at === out.returned.at;
    if (peekOnly) return json(res, 200, { returned: out.returned, imported: !!seen });
    return json(res, 200, { returned: out.returned, imported: !!seen, main: out.main, files: out.files, pdf: out.pdf || null });
  }
  // ── Retraction Exposure of the manuscript's authors (through Retraction Radar, rr.rykhet.com) ──
  if (rest === 'rexp' || rest.startsWith('rexp/')) {
    need('editor');
    if (!RR_ON) throw fail(503, 'Retraction Radar is not connected on this server.');
    p.rexp = p.rexp || { authors: null, from: null, to: null, results: {}, job: null };
    if (M === 'GET' && rest === 'rexp/search') {
      const q = U.strT(url.searchParams.get('q'), 120), country = U.strT(url.searchParams.get('country'), 2).toUpperCase();
      return json(res, 200, await rrCall(`/internal/authors?q=${encodeURIComponent(q)}${/^[A-Z]{2}$/.test(country) ? `&country=${country}` : ''}`, null, 40000));
    }
    if (M === 'PUT' && rest === 'rexp') {
      const b0 = await readBody(req, 20000);
      const year = new Date().getUTCFullYear();
      p.rexp.authors = (Array.isArray(b0.authors) ? b0.authors : []).slice(0, 12).map(a => ({ name: U.strT(a && a.name, 120), ids: [...new Set((Array.isArray(a && a.ids) ? a.ids : []).map(String).filter(id => /^A\d{4,12}$/.test(id)))].slice(0, 5), labels: (Array.isArray(a && a.labels) ? a.labels : []).slice(0, 5).map(x => U.strT(x, 200)) })).filter(a => a.name);
      p.rexp.from = U.int(b0.from, 1950, year, year - 2); p.rexp.to = U.int(b0.to, p.rexp.from, year + 1, year);
      save({ index: false });
      return json(res, 200, { ok: true });
    }
    if (M === 'POST' && rest === 'rexp/run') {
      if (p.rexp.job && p.rexp.job.status === 'running') throw fail(409, 'The exposure check is already running.');
      const todo = (p.rexp.authors || []).filter(a => a.ids.length);
      if (!todo.length) throw fail(400, 'Choose the OpenAlex profile of at least one author first.');
      if (!isAdmin(s) && used(`rexp:${p.id}`) >= 10) throw fail(429, 'The exposure check ran 10 times on this manuscript today. Try again tomorrow.');
      count(`rexp:${p.id}`);
      runExposure(p, s, todo).catch(e => console.error('[studio] rexp', e.message));
      return json(res, 202, { ok: true });
    }
  }
  if (M === 'POST' && rest === 'latex-pulled') {
    need('owner');
    const b0 = await readBody(req, 4000);
    p.latexReturn = { at: U.int(b0.at, 0, 1e15, 0), by: U.strT(b0.by, 120), imported: U.now() };
    save({ index: false });
    return json(res, 200, { ok: true });
  }
  // ── hand the revised project to Rykhet LaTeX (a share there, "Make my copy" to edit and compile) ──
  if (M === 'POST' && rest === 'latex-share') {
    need('editor');
    if (p.source.kind !== 'latex') throw fail(400, 'Only LaTeX uploads can be opened in Rykhet LaTeX.');
    if (!env.LATEX_KEY) throw fail(503, 'Rykhet LaTeX is not connected.');
    const r = EX.revisedTex(p);
    const map = new Map();
    const zipName = p.source.original && /\.zip$/.test(p.source.original) ? p.source.original : null;
    if (zipName) { const buf = await store.getFile(p.id, zipName); if (buf) { try { for (const e of readZip(buf)) map.set(e.name, e.data); } catch { /* ignore */ } } }
    for (const [f, t] of Object.entries(r.files)) map.set(f, Buffer.from(t, 'utf8'));
    const files = [];
    for (const [name, data] of map) {
      if (/(^|\/)(__MACOSX|\.git)\//.test(name) || /\.(aux|log|out|blg|synctex\.gz|fls|fdb_latexmk|toc|lof|lot)$/.test(name) || /^source\.pdf$/.test(name)) continue;
      if (/\.(tex|bib|bbl|sty|cls|bst|txt|csv|dat|cfg|def|clo)$/i.test(name)) files.push({ path: name, text: data.toString('utf8') }); else files.push({ path: name, base64: data.toString('base64') });
    }
    const people = [p.ownerEmail, ...(p.members || []).filter(m => m.status === 'active' && m.role === 'editor').map(m => m.email)].filter(Boolean);
    let out;
    try {
      const resp = await fetch((env.LATEX_URL || 'http://127.0.0.1:4130') + '/internal/studio-share', { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.LATEX_KEY }, body: JSON.stringify({ owner: { sub: p.owner, email: p.ownerEmail, name: p.ownerName }, studioId: p.id, name: p.title, main: p.source.main || 'main.tex', files, people }) });
      out = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(out.error || `Rykhet LaTeX ${resp.status}`);
    } catch (e) { throw fail(502, `Could not reach Rykhet LaTeX: ${e.message}`); }
    p.latexShare = { url: out.share.url, at: U.now(), by: meName(s), changed: (p.blocks || []).filter(b => b.cur !== b.text).length };
    act(p, s, 'latex-share', { detail: `${files.length} files` });
    save({ index: false });
    return json(res, 200, p.latexShare);
  }

  // ── exports ──
  let xm = rest.match(/^export\/([a-z.-]+)$/);
  if (xm && M === 'GET') {
    const kind = xm[1];
    const base = (p.title || 'manuscript').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'manuscript';
    // the revised and marked-up LaTeX projects, PDFs, change lists and diffs are made in the browser (exports.js)
    if (kind === 'data.json') { need('editor'); act(p, s, 'export', { detail: kind }); save({ index: false, delay: 5000 }); const { quiz, pending, ...rest2 } = p; return download(res, `${base}-studio.json`, 'application/json', JSON.stringify({ ...rest2, invites: (p.invites || []).map(({ hash, ...x }) => x) }, null, 1)); }
    if (/^(changes\.(md|txt)|diff\.(txt|zip)|revised\.(txt|tex|zip)|compile\.json)$/.test(kind)) throw fail(410, 'Exports are now made on your computer. Reload the page and try again.');
    throw fail(404, 'Unknown export.');
  }
  throw fail(404, 'Not found');
}

function askContext(p, b) {
  const ctx = p.latex || {};
  const lines = [`Paper: ${p.title}`];
  if (b) {
    const i = p.blocks.indexOf(b);
    const sec = (p.sections || []).find(x => x.id === b.sec);
    if (sec) lines.push(`Section: ${sec.num ? sec.num + ' ' : ''}${sec.title}`);
    const prev = p.blocks.slice(Math.max(0, i - 2), i).filter(x => READ_KINDS.has(x.kind));
    const next = p.blocks.slice(i + 1, i + 3).filter(x => READ_KINDS.has(x.kind));
    if (prev.length) lines.push(`Previous text: ${prev.map(x => tk.blockText(x, ctx)).join(' ').slice(-1500)}`);
    lines.push(`CURRENT PARAGRAPH${b.tex ? ' (LaTeX source)' : ''}:\n${b.cur}`);
    if (b.tex) lines.push(`Rendered: ${tk.blockText(b, ctx)}`);
    if (next.length) lines.push(`Next text: ${next.map(x => tk.blockText(x, ctx)).join(' ').slice(0, 1500)}`);
    const t = tk.blockText(b, ctx);
    const { evidenceText } = require('./lib/evidence');
    for (const m of t.matchAll(/(fig(?:ure)?s?\.?|tab(?:le)?s?\.?)\s*~?\s*(\d+|[IVXL]+)/gi)) {
      const kind = /^fig/i.test(m[1]) ? 'figure' : 'table';
      const it = (kind === 'figure' ? p.figures : p.tables || []).find(x => String(x.num) === m[2]);
      if (it) lines.push(evidenceText(it, kind, 40));
    }
  } else {
    lines.push('Abstract: ' + (p.blocks || []).filter(x => x.kind === 'abstract').map(x => tk.blockText(x, ctx)).join(' ').slice(0, 3000));
    lines.push('Sections: ' + (p.sections || []).map(x => `${x.num || ''} ${x.title}`.trim()).join('; '));
  }
  return lines.join('\n\n').slice(0, 40000);
}
function finishedNow(p, s, pr) {
  if (pr.done) return false;
  const set = readingSet(p);
  if (!set.length) return false;
  const all = set.every(b => pr.read[b.id]);
  if (all) { pr.done = true; pr.doneAt = U.now(); return true; }
  return false;
}

// ── Versioned assets ───────────────────────────────────────
// Cloudflare rewrites "no-cache" on scripts to a 4-hour browser cache, which mixed old and new modules after a deploy.
// Pages therefore reference /assets/<build>/…: every deploy gets new URLs, and those can be cached for a year.
let BUILD = 'v-0';
function computeBuild() {
  const h = crypto.createHash('sha1');
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const fp = path.join(d, f.name); if (f.isDirectory()) walk(fp); else { const st = fs.statSync(fp); h.update(`${fp}|${st.size}|${st.mtimeMs}`); } } };
  walk(path.join(PUB, 'assets'));
  BUILD = `v-${h.digest('hex').slice(0, 10)}`;
}
computeBuild();
if (DEV) setInterval(computeBuild, 3000).unref();
const htmlCache = new Map();
function sendHtml(req, res, file, { status = 200, cookies = [] } = {}) {
  const key = `${file}|${BUILD}`;
  let body = htmlCache.get(key);
  if (!body) {
    try { body = fs.readFileSync(file, 'utf8').replace(/(["'(])\/assets\//g, `$1/assets/${BUILD}/`); } catch { res.writeHead(404); return res.end('Not found'); }
    if (htmlCache.size > 20) htmlCache.clear();
    htmlCache.set(key, body);
  }
  const headers = { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'Set-Cookie': cookies };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return zlib.gzip(body, (e, z) => { if (e) { res.writeHead(status, headers); return res.end(body); } res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }); res.end(z); });
  res.writeHead(status, headers); res.end(body);
}
/** Sliding sessions: someone who keeps using the studio stays signed in. */
function renewed(s) {
  if (!s || !s.iat || Date.now() / 1000 - s.iat < 86400) return [];
  const { iat, exp, ...rest } = s;
  return [setCookie(SESSION, signSession(rest), DAYS * 86400)];
}

// ── Router ─────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, BASE);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const s = verifySession(cookie(req, SESSION));
  if (!tk) await tkReady;
  const GET = req.method === 'GET' || req.method === 'HEAD';

  if (p === '/internal/handoff' && req.method === 'POST') return handoffIn(req, res);
  if (p === '/healthz') return json(res, 200, { ok: true, build: BUILD, jobs: jobs.size, streams: [...streams.values()].reduce((n, x) => n + x.size, 0), mem: Math.round(process.memoryUsage().rss / 1048576) });
  if (GET && p === '/') return sendHtml(req, res, path.join(PUB, 'index.html'), { cookies: renewed(s) });
  if (GET && (p === '/license' || p === '/licence')) return sendHtml(req, res, path.join(PUB, 'license.html'), { cookies: renewed(s) });
  if (GET && ['/robots.txt', '/sitemap.xml', '/site.webmanifest', '/llms.txt'].includes(p)) return sendFile(req, res, path.join(PUB, p.slice(1)), { cache: 'public, max-age=86400' });
  if (GET && (p === '/favicon.ico' || p === '/favicon.svg')) return sendFile(req, res, path.join(PUB, 'assets', 'favicon.svg'), { cache: 'public, max-age=604800' });
  let am;
  if (GET && (am = p.match(/^\/assets\/(v-[a-f0-9]{1,12}\/)?([a-zA-Z0-9._/-]+)$/)) && !p.includes('..')) return sendFile(req, res, path.join(PUB, 'assets', am[2]), { cache: DEV ? 'no-cache' : am[1] ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (GET && /^\/vendor\/[a-zA-Z0-9._/-]+$/.test(p) && !p.includes('..')) return sendFile(req, res, path.join(PUB, p), { cache: DEV ? 'no-cache' : 'public, max-age=2592000, immutable' });

  // ── built-in accounts (email + password) ──
  const nextOf = v => (v && /^\/app(\/[A-Za-z0-9/_-]*)?$/.test(v) ? v : '/app');
  if (GET && (p === '/sso/login' || p === '/sso/signup')) return redirect(res, `/login?${new URLSearchParams({ next: nextOf(url.searchParams.get('next')), ...(p === '/sso/signup' ? { mode: 'signup' } : {}) })}`);
  if (GET && p === '/login') {
    if (s && !url.searchParams.get('switch') && url.searchParams.get('mode') !== 'password') return redirect(res, nextOf(url.searchParams.get('next')), renewed(s));
    return sendHtml(req, res, path.join(PUB, 'login.html'));
  }
  if (p === '/sso/logout' || p === '/logout') { if (s) revoke(s.sid); return redirect(res, '/', clearAll); }
  if (GET && p === '/auth/options') {
    const inv = await inviteFor(url.searchParams.get('next'));
    return json(res, 200, { openSignup: OPEN_SIGNUP || !accounts.count, first: !accounts.count, invitedEmail: inv ? inv.email : null, signedIn: s ? { name: s.n, email: s.e } : null });
  }
  if (req.method === 'POST' && /^\/auth\/(login|signup|password)$/.test(p)) {
    const origin = req.headers.origin || '';
    if (origin && origin !== new URL(BASE).origin) return json(res, 403, { error: 'Cross-site request refused.' });
    if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Unsupported content type.' });
    const b0 = await readBody(req, 8000);
    if (p === '/auth/password') {
      if (!s) return json(res, 401, { error: 'Please sign in again.' });
      await accounts.changePassword(s.sub, b0.current, b0.password);
      return json(res, 200, { ok: true });
    }
    let u;
    if (p === '/auth/login') u = await accounts.login(b0, req.socket.remoteAddress || '');
    else {
      const inv = await inviteFor(b0.next);
      const allowed = OPEN_SIGNUP || !!(inv && inv.email.toLowerCase() === String(b0.email || '').trim().toLowerCase());
      u = await accounts.signup(b0, { allowed });
    }
    const sess = { sub: u.id, sid: crypto.randomBytes(9).toString('base64url'), e: u.email, n: u.name, a: u.admin ? 1 : 0 };
    touchUser(sess);
    logActivity({ kind: p === '/auth/login' ? 'signin' : 'signup', sub: u.id });
    return json(res, 200, { ok: true, next: nextOf(b0.next) }, [setCookie(SESSION, signSession(sess), DAYS * 86400)]);
  }
  if (GET && (p === '/app' || /^\/app\/(new|p\/[a-z0-9]{8,24}(\/[A-Za-z0-9_-]+){0,2}|invite\/[A-Za-z0-9_-]{20,80})$/.test(p))) {
    if (!s) return redirect(res, `/sso/${/^\/app\/invite\//.test(p) && url.searchParams.get('signup') ? 'signup' : 'login'}?next=${encodeURIComponent(p === '/app/new' && /^[A-Za-z0-9_-]{8,64}$/.test(url.searchParams.get('handoff') || '') ? `${p}?handoff=${url.searchParams.get('handoff')}` : p)}`);
    return sendHtml(req, res, path.join(PUB, 'app.html'), { cookies: renewed(s) });
  }
  if (p.startsWith('/api/')) {
    if (!s) return json(res, 401, { error: 'Please sign in again.', signin: '/sso/login' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin || '';
      const site = req.headers['sec-fetch-site'];
      if ((origin && origin !== BASE && !(DEV && /^http:\/\/(localhost|127\.0\.0\.1)/.test(origin))) || (site && !['same-origin', 'none'].includes(site))) return json(res, 403, { error: 'Cross-site request refused.' });
      const ct = req.headers['content-type'] || '';
      if (req.method !== 'DELETE' && !/application\/json|application\/octet-stream|image\/|application\/pdf|application\/zip/.test(ct)) return json(res, 415, { error: 'Unsupported content type.' });
    }
    return api(req, res, p, s, url);
  }
  return sendHtml(req, res, path.join(PUB, '404.html'), { status: 404 });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error', ...(e.extra || {}) });
    if (!e.status) console.error('[studio]', req.method, req.url, e);
  });
});
server.requestTimeout = 300_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;
tkReady.then(() => server.listen(PORT, env.HOST || '127.0.0.1', () => console.log(`[studio] Research Studio on ${BASE} (listening on ${env.HOST || '127.0.0.1'}:${PORT})${DEV ? ' — development mode, emails go to var/outbox' : ''}`)));

// resume reference polling after a restart
tkReady.then(async () => { for (const id of Object.keys(store.index.projects)) { const p = await store.load(id); if (p && p.refcheck && ['queued', 'running'].includes(p.refcheck.status)) pollRefCheck(id); if (p && p.ai && p.ai.job && p.ai.job.status === 'running') { p.ai.job.status = 'error'; p.ai.job.error = 'The server restarted during the check. Run it again.'; store.touch(p, { index: false }); } } });

async function shutdown() {
  console.log('[studio] shutting down');
  server.close();
  for (const set of streams.values()) for (const c of set) { try { c.res.end(); } catch { /* closed */ } }
  for (const j of jobs.values()) j.cancelled = true;
  await store.flush();
  try { fs.writeFileSync(USERS, JSON.stringify(users)); fs.writeFileSync(USAGE, JSON.stringify(usage)); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
