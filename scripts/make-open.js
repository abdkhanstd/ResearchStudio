#!/usr/bin/env node
/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Maintainer tool: refreshes this open edition from the hosted code base (studio.rykhet.com).
 * Shared libraries and the web app are copied; server.js is rewritten for the open edition: built-in email + password
 * accounts instead of Rykhet ID, rule-based checks instead of the AI service, and no RefCheck.
 * Open-edition files are kept: lib/accounts.js, public/index.html, login.html, license.html,
 * public/assets/login.js, auth.css.            Usage:  node scripts/make-open.js <hosted repository folder>
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root || !fs.existsSync(path.join(root, 'server.js'))) { console.error('usage: node scripts/make-open.js <hosted repository folder>'); process.exit(1); }
const HERE = path.join(__dirname, '..');
const copy = (rel) => { const from = path.join(root, rel), to = path.join(HERE, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
for (const f of ['util', 'store', 'mail', 'lint', 'evidence', 'zip', 'assist', 'exposure']) copy(`lib/${f}.js`);
// the export and diff code moved to public/assets/shared (made in the browser): drop the old server copies
for (const f of ['lib/exporter.js', 'lib/texdiff.js']) fs.rmSync(path.join(HERE, f), { force: true });
for (const f of ['public/assets', 'public/vendor', 'public/app.html', 'public/404.html']) if (fs.existsSync(path.join(root, f))) copy(f);
// the hosted site names Rykhet as copyright holder (no personal names on rykhet.com); this edition names the author
const HOLDER = [['Copyright (c) 2026 Rykhet (info@rykhet.com).', 'Copyright (c) 2026 Abdullah Aman Khan.']];
const named = rel => { const f = path.join(HERE, rel); if (fs.statSync(f).isDirectory()) { for (const e of fs.readdirSync(f)) if (!(rel === 'public' && e === 'vendor')) named(`${rel}/${e}`); return; } if (!/\.(js|mjs|css|html)$/.test(rel)) return; let t = fs.readFileSync(f, 'utf8'); const o = t; for (const [a, b] of HOLDER) t = t.split(a).join(b); if (t !== o) fs.writeFileSync(f, t); };
for (const f of ['lib', 'public/assets', 'public/app.html', 'public/404.html']) if (fs.existsSync(path.join(HERE, f))) named(f);
// branding of the web app
const patchFile = (rel, pairs) => { const f = path.join(HERE, rel); let t = fs.readFileSync(f, 'utf8'); for (const [a, b] of pairs) t = t.split(a).join(b); fs.writeFileSync(f, t); };
patchFile('public/app.html', [['<title>Research Studio · Rykhet</title>', '<title>Research Studio</title>']]);
patchFile('public/assets/app.js', [['<span>Research Studio <small>Rykhet</small></span>', '<span>Research Studio</span>']]);
{ // only the studio itself in the tools list (the other entries are Rykhet's hosted tools)
  const f = path.join(HERE, 'public/assets/app.js');
  let t = fs.readFileSync(f, 'utf8');
  const a = t.indexOf('export const SUITE = ['), b = t.indexOf('];', a);
  const lines = t.slice(a, b).split('\n');
  t = t.slice(0, a) + [lines[0], lines.find(l => /key: 'studio'/.test(l))].join('\n') + '\n' + t.slice(b);
  fs.writeFileSync(f, t);
}
const unbrand = [['RYKHET RESEARCH STUDIO', 'RESEARCH STUDIO'], [' by Rykhet Research Studio (studio.rykhet.com)', ' by Research Studio'], ["setCreator('studio.rykhet.com')", "setCreator('Research Studio')"], ['Rykhet Research Studio', 'Research Studio']];
patchFile('public/assets/report.js', unbrand);
patchFile('public/assets/shared/exporter.mjs', unbrand);

let s = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error(`not found: ${a.slice(0, 80)}`); s = s.replace(a, b); };
const repRe = (re, b) => { if (!re.test(s)) throw new Error(`not found: ${re}`); s = s.replace(re, b); };

repRe(/\/\*\*\n \* studio\.rykhet\.com[\s\S]*?\*\/\n/, `/**
 * Research Studio — self-hosted edition. Paragraph-by-paragraph proofreading with invited readers, reading checks, live
 * suggestions, history with undo, evidence checks (numbers against tables and figures) and exports.
 * Built-in accounts (email + password); checks are rule-based, no AI service needed. Hosted demo: https://studio.rykhet.com
 * No npm dependencies (Node 18+). Heavy work (PDF reading, OCR, figure digitising, annotated PDF) runs in the browser.
 *   /              landing page, /login sign in or create an account
 *   /app           dashboard, /app/new, /app/p/<id>[/<tab>], /app/p/<id>/read[/<bid>], /app/invite/<token>
 *   /api/*         JSON API (session cookie), /api/projects/<id>/events (server-sent events)
 * Data: var/projects/<id>/ (encrypted), var/index.bin, var/accounts.json, var/users.json, var/usage.json
 */
`);
rep("const { createAi } = require('./lib/ai');", "const { createAssist } = require('./lib/assist');");
rep("const { createRefCheck } = require('./lib/refcheck');", "const { createAccounts } = require('./lib/accounts');");
rep("const BASE = env.BASE_URL || 'https://studio.rykhet.com';", "const BASE = env.BASE_URL || 'http://localhost:4150';");
repRe(/^if \(SECRET\.length < 32 \|\| \(!env\.RYKHET_CLIENT_SECRET && !DEV\)\).*$/m, "if (SECRET.length < 32) { console.error('[studio] SESSION_SECRET (32+ characters) is required in .env — see .env.example'); process.exit(1); }");
repRe(/^const RA = DEV \? null : require\('\.\/rykhet-auth'\).*$/m, "const OPEN_SIGNUP = env.OPEN_SIGNUP === '1'; // anyone may create an account (otherwise: the first account, and invited people)");
rep("fromAddr: env.MAIL_FROM_ADDR || 'no-reply@rykhet.com', fromName: env.MAIL_FROM_NAME || 'Rykhet Research Studio', brand: 'Rykhet Research Studio', accountName: 'Rykhet account' });",
  "fromAddr: env.MAIL_FROM_ADDR || `no-reply@${new URL(BASE).hostname}`, fromName: env.MAIL_FROM_NAME || 'Research Studio', brand: env.BRAND || 'Research Studio', accountName: 'Research Studio account' });");
repRe(/^const ai = createAi\(.*$/m, 'const ai = createAssist(); // rule-based reading checks and evidence checks (no AI service)');
repRe(/^const refcheck = createRefCheck\(.*$/m, "const refcheck = { enabled: false, link: () => null, start: async () => { throw new Error('Reference checking runs on the hosted service.'); }, status: async () => { throw new Error('not available'); } };\nconst accounts = createAccounts({ dir: VAR });");
rep('// ── Sessions (signed cookies, revocable through Rykhet ID back-channel logout) ──', '// ── Sessions (signed cookies, revocable on sign-out) ──');
rep("form-action 'self' https://auth.rykhet.com;", "form-action 'self';");
rep("account: 'https://auth.rykhet.com/account', accountLabel: 'Rykhet account' });", "account: '/login?mode=password', accountLabel: 'Change password' });");

// sign-in routes: built-in accounts replace the Rykhet ID flow and the development login
const a = s.indexOf("  if (DEV && req.method === 'GET' && /^\\/dev\\/test\\/");
const b = s.indexOf("  if (GET && (p === '/app' ||");
if (a < 0 || b < 0 || b < a) throw new Error('sign-in block not found');
s = s.slice(0, a) + `  // ── built-in accounts (email + password) ──
  const nextOf = v => (v && /^\\/app(\\/[A-Za-z0-9/_-]*)?$/.test(v) ? v : '/app');
  if (GET && (p === '/sso/login' || p === '/sso/signup')) return redirect(res, \`/login?\${new URLSearchParams({ next: nextOf(url.searchParams.get('next')), ...(p === '/sso/signup' ? { mode: 'signup' } : {}) })}\`);
  if (GET && p === '/login') {
    if (s && !url.searchParams.get('switch') && url.searchParams.get('mode') !== 'password') return redirect(res, nextOf(url.searchParams.get('next')), renewed(s));
    return sendHtml(req, res, path.join(PUB, 'login.html'));
  }
  if (p === '/sso/logout' || p === '/logout') { if (s) revoke(s.sid); return redirect(res, '/', clearAll); }
  if (GET && p === '/auth/options') {
    const inv = await inviteFor(url.searchParams.get('next'));
    return json(res, 200, { openSignup: OPEN_SIGNUP || !accounts.count, first: !accounts.count, invitedEmail: inv ? inv.email : null, signedIn: s ? { name: s.n, email: s.e } : null });
  }
  if (req.method === 'POST' && /^\\/auth\\/(login|signup|password)$/.test(p)) {
    const origin = req.headers.origin || '';
    if (origin && origin !== new URL(BASE).origin) return json(res, 403, { error: 'Cross-site request refused.' });
    if (!/application\\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Unsupported content type.' });
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
` + s.slice(b);

// invitations unlock sign-up for exactly the invited address
rep('async function inviteApi(req, res, s, token, action) {', `/** The pending invitation behind a next=/app/invite/<token> link (for sign-up). */
async function inviteFor(next) {
  const m = /^\\/app\\/invite\\/([A-Za-z0-9_-]{20,80})/.exec(String(next || ''));
  if (!m) return null;
  const hash = U.sha256(m[1]);
  const pid = (store.index.tokens || {})[hash];
  const p = pid ? await store.load(pid) : null;
  const inv = p && (p.invites || []).find(i => i.hash === hash || (i.hashes || []).includes(hash));
  return inv && inv.status === 'pending' && Date.parse(inv.expires) > Date.now() ? inv : null;
}
async function inviteApi(req, res, s, token, action) {`);

// development mode (no DATA_KEY needed, mail written to var/outbox) and a configurable listen address
repRe(/^const DEV = env\.DEV_LOGIN === '1' &&/m, "const DEV = (env.DEV_MODE === '1' || env.DEV_LOGIN === '1') &&");
rep("server.listen(PORT, '127.0.0.1', () => console.log(`[studio] listening on 127.0.0.1:${PORT}${DEV ? ' (DEV sign-in, mail to var/outbox)' : ''}`))",
  "server.listen(PORT, env.HOST || '127.0.0.1', () => console.log(`[studio] Research Studio on ${BASE} (listening on ${env.HOST || '127.0.0.1'}:${PORT})${DEV ? ' — development mode, emails go to var/outbox' : ''}`))");

for (const [a, b] of HOLDER) s = s.split(a).join(b);
if (/rykhet-auth|createAi|createRefCheck|RYKHET_CLIENT/.test(s)) throw new Error('hosted-only code left over');
fs.writeFileSync(path.join(__dirname, '..', 'server.js'), s);
console.log('server.js written (open edition)');
