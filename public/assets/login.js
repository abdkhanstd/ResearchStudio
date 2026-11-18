/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
/* Sign in, create an account (first account, open sign-up, or an invitation), or change the password. */
(function () {
  var q = new URLSearchParams(location.search);
  var next = q.get('next') || '/app';
  var mode = q.get('mode') === 'signup' ? 'signup' : q.get('mode') === 'password' ? 'password' : 'signin';
  var opts = { openSignup: false, first: false, invitedEmail: null, signedIn: null };
  var form = document.getElementById('auth-form');
  var $ = function (id) { return document.getElementById(id); };
  var TITLES = { signin: 'Welcome back', signup: 'Create your account', password: 'Change your password' };
  var BUTTONS = { signin: 'Sign in', signup: 'Create account', password: 'Change password' };

  function show() {
    document.querySelectorAll('.auth-tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
    document.querySelector('.auth-tabs').hidden = mode === 'password';
    document.querySelectorAll('[data-for]').forEach(function (el) { el.hidden = el.dataset.for.split(' ').indexOf(mode) < 0; });
    $('auth-title').textContent = TITLES[mode];
    $('auth-submit').textContent = BUTTONS[mode];
    $('pw-label').textContent = mode === 'password' ? 'New password (8+ characters)' : mode === 'signup' ? 'Password (8+ characters)' : 'Password';
    form.password.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
    var note = '';
    if (mode === 'signup') {
      if (opts.first) note = 'This is the first account on this server: it becomes the administrator.';
      else if (opts.invitedEmail) note = 'You were invited as ' + opts.invitedEmail + '. Create your account with this address.';
      else if (!opts.openSignup) note = 'Sign-up on this server is by invitation. Open the link in your invitation email to create an account.';
    } else if (mode === 'password' && opts.signedIn) note = 'Signed in as ' + opts.signedIn.email + '.';
    $('auth-note').textContent = note;
    $('auth-submit').disabled = mode === 'signup' && !opts.first && !opts.openSignup && !opts.invitedEmail;
    if (opts.invitedEmail && mode !== 'password' && !form.email.value) form.email.value = opts.invitedEmail;
    $('auth-error').hidden = true;
  }
  document.querySelectorAll('.auth-tabs button').forEach(function (b) { b.addEventListener('click', function () { mode = b.dataset.mode; show(); }); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = mode === 'password' ? { current: form.current.value, password: form.password.value } : { email: form.email.value.trim(), password: form.password.value, name: form.name.value.trim(), next: next };
    $('auth-submit').disabled = true;
    fetch(mode === 'password' ? '/auth/password' : mode === 'signup' ? '/auth/signup' : '/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.j.error || 'Something went wrong.');
        if (mode === 'password') { $('auth-note').textContent = 'Your password was changed.'; form.reset(); $('auth-submit').disabled = false; return; }
        location.href = x.j.next || next;
      })
      .catch(function (err) { var box = $('auth-error'); box.textContent = err.message; box.hidden = false; $('auth-submit').disabled = false; });
  });

  fetch('/auth/options?next=' + encodeURIComponent(next), { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) { opts = j; if (mode === 'signin' && (j.first || (j.invitedEmail && q.get('mode') !== 'signin'))) mode = j.first ? 'signup' : mode; show(); })
    .catch(show);
  show();
})();
