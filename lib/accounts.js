/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Built-in accounts for the self-hosted edition: email + password (scrypt), no external identity provider.
 *   - the first account becomes an administrator
 *   - OPEN_SIGNUP=1 lets anyone create an account; otherwise only invited people (their invitation unlocks sign-up
 *     for exactly the invited email address)
 * Data: var/accounts.json (password hashes only, never the passwords).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeAtomic, readJson, isEmail } = require('./util');

function createAccounts({ dir }) {
  const FILE = path.join(dir, 'accounts.json');
  const db = readJson(FILE, { users: {} });
  db.users = db.users || {};
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => writeAtomic(FILE, JSON.stringify(db)).catch(e => console.error('[accounts] save', e.message)), 200); };
  const byEmail = email => Object.values(db.users).find(u => u.email === String(email || '').toLowerCase());

  const hash = pw => new Promise((res, rej) => { const salt = crypto.randomBytes(16); crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(`scrypt$${salt.toString('base64')}$${k.toString('base64')}`))); });
  const check = (pw, stored) => new Promise(res => {
    const [alg, s, k] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !s || !k) return res(false);
    crypto.scrypt(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 }, (e, out) => res(!e && crypto.timingSafeEqual(out, Buffer.from(k, 'base64'))));
  });

  // simple attempt limiter: 10 tries per 10 minutes per email and per IP
  const tries = new Map();
  function limited(key) {
    const now = Date.now();
    const t = (tries.get(key) || []).filter(x => now - x < 600e3);
    tries.set(key, t);
    return t.length >= 10;
  }
  const note = key => { const t = tries.get(key) || []; t.push(Date.now()); tries.set(key, t); };

  async function signup({ email, name, password }, { allowed }) {
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim().slice(0, 80) || email.split('@')[0];
    if (!isEmail(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
    if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Use a password of at least 8 characters.'), { status: 400 });
    if (password.length > 200) throw Object.assign(new Error('That password is too long.'), { status: 400 });
    if (byEmail(email)) throw Object.assign(new Error('An account with this email already exists. Sign in instead.'), { status: 409 });
    const first = !Object.keys(db.users).length;
    if (!first && !allowed) throw Object.assign(new Error('Sign-up is by invitation on this server. Ask the owner of a manuscript to invite you.'), { status: 403 });
    const id = crypto.randomUUID();
    db.users[id] = { id, email, name, pass: await hash(password), admin: first, created: new Date().toISOString() };
    save();
    return db.users[id];
  }
  async function login({ email, password }, ip) {
    email = String(email || '').trim().toLowerCase();
    if (limited(`e:${email}`) || limited(`i:${ip}`)) throw Object.assign(new Error('Too many attempts. Wait a few minutes and try again.'), { status: 429 });
    const u = byEmail(email);
    const ok = u && await check(String(password || ''), u.pass);
    if (!ok) { note(`e:${email}`); note(`i:${ip}`); throw Object.assign(new Error('Wrong email or password.'), { status: 401 }); }
    u.last = new Date().toISOString(); save();
    return u;
  }
  async function changePassword(id, oldPw, newPw) {
    const u = db.users[id];
    if (!u || !(await check(String(oldPw || ''), u.pass))) throw Object.assign(new Error('The current password is wrong.'), { status: 401 });
    if (typeof newPw !== 'string' || newPw.length < 8) throw Object.assign(new Error('Use a password of at least 8 characters.'), { status: 400 });
    u.pass = await hash(newPw); u.passChanged = new Date().toISOString(); save();
  }
  return { signup, login, changePassword, byEmail, get count() { return Object.keys(db.users).length; } };
}

module.exports = { createAccounts };
