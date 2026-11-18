/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
'use strict';
/**
 * Outgoing mail through the local Postfix (127.0.0.1:25, trusted via mynetworks, DKIM-signed on the way out),
 * with a minimal SMTP client (no dependencies). MAIL_MODE=file writes .eml files to var/outbox instead (development).
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Headers stay plain ASCII when they can (base64 for ASCII text is a spam signal); otherwise RFC 2047 encoded words.
const ascii = s => /^[\x20-\x7e]*$/.test(s);
const hdr = s => {
  s = String(s).replace(/[\r\n]+/g, ' ');
  if (ascii(s)) return s;
  const cps = [...s], words = [];
  for (let i = 0; i < cps.length; i += 14) words.push(`=?UTF-8?B?${Buffer.from(cps.slice(i, i + 14).join(''), 'utf8').toString('base64')}?=`);
  return words.join('\r\n '); // folded: one encoded word per line
};
const nameAddr = (name, addr) => { name = String(name || '').replace(/[\r\n"\\]+/g, ' ').trim(); return name ? `${ascii(name) ? `"${name}"` : hdr(name)} <${addr}>` : `<${addr}>`; };
/** Quoted-printable body (RFC 2045): 76-character lines, soft breaks, UTF-8 bytes as =XX. */
function qp(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    let cur = '';
    const bytes = Buffer.from(line, 'utf8');
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let tok = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (cur.length + tok.length > 75) { out.push(cur + '='); cur = ''; }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n');
}

function createMailer(cfg) {
  const host = cfg.host || '127.0.0.1', port = Number(cfg.port || 25);
  const fromAddr = cfg.fromAddr || 'no-reply@rykhet.com';
  const fromName = cfg.fromName || 'Research Studio';
  const brand = cfg.brand || 'Research Studio'; // shown in the email header
  const account = cfg.accountName || 'account'; // "Sign in with your … using"
  const mode = cfg.mode || 'smtp';
  const base = cfg.base || 'https://studio.rykhet.com';
  const outbox = cfg.outbox;
  if (mode === 'file' && outbox) fs.mkdirSync(outbox, { recursive: true });

  function smtpSend(to, raw) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
      let buf = '';
      const steps = [
        { send: null, expect: 220 },
        { send: `EHLO ${new URL(base).hostname}`, expect: 250 },
        { send: `MAIL FROM:<${fromAddr}>`, expect: 250 },
        { send: `RCPT TO:<${to}>`, expect: 250 },
        { send: 'DATA', expect: 354 },
        { send: raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.', expect: 250 },
        { send: 'QUIT', expect: 221 },
      ];
      let k = 0, result = '';
      const advance = () => { k++; if (k < steps.length) sock.write(steps[k].send + '\r\n'); };
      sock.on('data', d => {
        buf += d.toString('utf8');
        // a reply is complete when its last line has "NNN " (space, not dash)
        const lines = buf.split('\r\n');
        if (lines.length < 2) return;
        const last = lines[lines.length - 2];
        if (!/^\d{3} /.test(last)) return;
        const code = Number(last.slice(0, 3));
        buf = '';
        if (code !== steps[k].expect && !(k === 6)) { sock.end(); return reject(new Error(`SMTP ${code}: ${last.slice(4, 200)}`)); }
        if (k === 5) result = last;
        if (k === 6) { sock.end(); return resolve(result); }
        advance();
      });
      sock.on('error', reject);
    });
  }

  function shell(title, bodyHtml, foot) {
    return `<!doctype html><html><body style="margin:0;background:#f4f2ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#141a26">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e3dfd3;overflow:hidden">
<tr><td style="height:4px;background:#3346c8;background-image:linear-gradient(110deg,#1fc8a8,#3346c8 55%,#7a4dff)"></td></tr>
<tr><td style="padding:24px 32px 4px;font-size:15px;font-weight:700;letter-spacing:.2px;color:#141a26">${esc(brand).replace(/Research Studio$/, '<span style="color:#3346c8">Research Studio</span>')}</td></tr>
<tr><td style="padding:6px 32px 28px;font-size:15px;line-height:1.6">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:24px;line-height:1.25;margin:6px 0 14px;color:#141a26">${esc(title)}</h1>${bodyHtml}</td></tr></table>
<p style="font-size:12px;color:#6b7280;margin:16px 0 0;max-width:520px">${foot || `Sent by ${esc(brand)} · ${esc(new URL(base).hostname)}.`}</p>
</td></tr></table></body></html>`;
  }
  const button = (href, label) => `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#3346c8;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:700;display:inline-block">${esc(label)}</a></p>`;
  const quote = t => t ? `<div style="margin:16px 0;padding:12px 16px;border-left:3px solid #3346c8;background:#f5f6fd;border-radius:6px;color:#2b3242;font-size:14px;white-space:pre-wrap">${esc(t)}</div>` : '';

  const T = {
    invite: v => ({
      subject: `${v.from} invited you to proofread "${v.title}"`,
      html: shell('You are invited to proofread a manuscript', `<p><b>${esc(v.from)}</b> invited you to the Proof Room for <b>${esc(v.title)}</b> as ${v.role === 'editor' ? 'an <b>editor</b> (you can apply changes)' : 'a <b>proofreader</b>'}.</p>${quote(v.message)}
<p>You read the paper one paragraph at a time, suggest corrections and comment, with AI help where it is useful.${v.checks ? ' Short questions after some paragraphs confirm the reading.' : ''}${v.deadline ? ` The owner hopes to finish by <b>${esc(v.deadline)}</b>.` : ''}</p>${button(v.link, 'Open the invitation')}
<p style="font-size:13px;color:#5b6474">Sign in with your ${esc(account)} using <b>${esc(v.email)}</b> (or create one with this address). The invitation works for ${v.days} days and only for this email address. If you did not expect it, ignore this email.</p>`),
      text: `${v.from} invited you to proofread "${v.title}" as ${v.role}.\n${v.message ? `\n"${v.message}"\n` : ''}\nOpen the invitation: ${v.link}\n\nSign in with your ${account} using ${v.email}. The link works for ${v.days} days and only for this address.`,
    }),
    remind: v => ({
      subject: `Reminder: proofreading "${v.title}"`,
      html: shell('A friendly reminder', `<p>${esc(v.from)} sent you a reminder about <b>${esc(v.title)}</b>. You have read <b>${v.read} of ${v.total}</b> paragraphs so far.</p>${quote(v.message)}${v.deadline ? `<p>Target date: <b>${esc(v.deadline)}</b>.</p>` : ''}${button(v.link, 'Continue proofreading')}`),
      text: `${v.from} sent you a reminder about "${v.title}". You have read ${v.read} of ${v.total} paragraphs.\n${v.message ? `\n"${v.message}"\n` : ''}\nContinue: ${v.link}`,
    }),
    finished: v => ({
      subject: `${v.who} finished proofreading "${v.title}"`,
      html: shell('A proofreader finished', `<p><b>${esc(v.who)}</b> read all ${v.total} paragraphs of <b>${esc(v.title)}</b>: ${v.suggestions} suggestion${v.suggestions === 1 ? '' : 's'}, ${v.comments} comment${v.comments === 1 ? '' : 's'}${v.checks ? `, reading checks ${v.passed}/${v.checks} passed` : ''}.</p>${quote(v.message)}${button(v.link, 'Review the suggestions')}`),
      text: `${v.who} finished proofreading "${v.title}": ${v.suggestions} suggestions, ${v.comments} comments.\n${v.message ? `\n"${v.message}"\n` : ''}\nReview: ${v.link}`,
    }),
  };

  /** Send a templated email. Never throws; returns { ok, detail }. */
  async function send(to, template, vars) {
    const t = T[template](vars);
    const id = `<${crypto.randomBytes(12).toString('hex')}@${new URL(base).hostname}>`;
    const boundary = 'b_' + crypto.randomBytes(10).toString('hex');
    const replyTo = vars && typeof vars.replyTo === 'string' && /^[^\s@<>"]+@[^\s@<>"]+$/.test(vars.replyTo) ? vars.replyTo : null;
    const raw = [
      `From: ${nameAddr(fromName, fromAddr)}`, `To: <${to}>`, ...(replyTo ? [`Reply-To: ${nameAddr(vars.from, replyTo)}`] : []), `Subject: ${hdr(t.subject)}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${id}`,
      'MIME-Version: 1.0', 'Auto-Submitted: auto-generated', 'X-Auto-Response-Suppress: All', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(t.text),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(t.html), `--${boundary}--`, '',
    ].join('\r\n');
    if (mode === 'off') return { ok: false, detail: 'mail is switched off' };
    if (mode === 'file') {
      const f = path.join(outbox, `${Date.now()}-${template}-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`);
      fs.writeFileSync(f, raw);
      return { ok: true, detail: `written to ${path.basename(f)}` };
    }
    try { const r = await smtpSend(to, raw); return { ok: true, detail: String(r).slice(0, 200) }; }
    catch (e) { console.error('[mail]', template, to, e.message); return { ok: false, detail: e.message }; }
  }
  return { send };
}

module.exports = { createMailer };
