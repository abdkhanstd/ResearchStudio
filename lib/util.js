/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/** Small shared helpers: .env loading, encryption at rest, atomic writes, ids, input cleaning. */
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const zlib = require('zlib');

function loadEnv(dir) {
  const env = { ...process.env };
  const file = `${dir}/.env`;
  for (const line of (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// ── Encryption at rest (AES-256-GCM). Format: "RS1" | iv(12) | tag(16) | ciphertext ──
function createCipher(keyMaterial) {
  const key = crypto.createHash('sha256').update(String(keyMaterial)).digest();
  const MAGIC = Buffer.from('RS1');
  function seal(buf) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
  }
  function open(buf) {
    if (!buf || buf.length < 31 || !buf.subarray(0, 3).equals(MAGIC)) throw new Error('Not an encrypted file');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(15, 31));
    return Buffer.concat([d.update(buf.subarray(31)), d.final()]);
  }
  const sealJson = obj => seal(zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 }));
  const openJson = buf => JSON.parse(zlib.gunzipSync(open(buf)).toString('utf8'));
  return { seal, open, sealJson, openJson };
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

const newId = (n = 12) => crypto.randomBytes(n).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n).toLowerCase().padEnd(n, '0');
const shortId = () => crypto.randomBytes(6).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v, max = 1000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\u0000/g, '').slice(0, max);
const strT = (v, max = 1000) => str(v, max * 2).trim().slice(0, max);
const int = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const bool = (v, dflt = false) => (typeof v === 'boolean' ? v : dflt);
const isEmail = e => typeof e === 'string' && e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e);
const now = () => new Date().toISOString();

function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const { fn, res, rej } = q.shift(); Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); }); };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

module.exports = { loadEnv, createCipher, writeAtomic, readJson, newId, shortId, sha256, str, strT, int, num, bool, isEmail, now, limiter };
