/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
// Landing: sign-in errors, and the signed-in state (no "Sign in" button for someone who already is)
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('error')) {
    var e = document.getElementById('err');
    if (e) { e.hidden = false; if (q.get('error') === 'denied') e.firstElementChild.textContent = 'Your Rykhet account does not have access to Research Studio.'; }
  }
  fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !j.user) return;
    var u = j.user;
    var first = String(u.name || u.email || '').split(/\s+/)[0];
    var initials = String(u.name || u.email || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(function (x) { return x[0].toUpperCase(); }).join('');
    var right = document.querySelector('.topbar .top-right');
    if (right) {
      right.innerHTML = '';
      var a1 = document.createElement('a'); a1.className = 'btn btn-ghost'; a1.href = '/app'; a1.textContent = 'My manuscripts';
      var a2 = document.createElement('a'); a2.className = 'btn btn-primary'; a2.href = '/app/new'; a2.textContent = 'Upload';
      var av = document.createElement('a'); av.className = 'avatar-dot'; av.href = '/app'; av.title = 'Signed in as ' + (u.email || u.name); av.textContent = initials; av.style.cssText = 'width:34px;height:34px;font-size:13px;text-decoration:none';
      right.appendChild(a1); right.appendChild(a2); right.appendChild(av);
    }
    var note = document.querySelector('.hero-note');
    if (note) { note.textContent = 'Signed in as ' + (u.email || u.name) + ' · '; var l = document.createElement('a'); l.href = '/app'; l.textContent = 'open your manuscripts'; note.appendChild(l); }
    var cta = document.querySelector('.hero .btn-primary');
    if (cta) { cta.href = '/app/new'; cta.textContent = 'Upload a manuscript, ' + first; }
    document.querySelectorAll('a[href^="/sso/login"]').forEach(function (a) { var n = new URLSearchParams(a.getAttribute('href').split('?')[1] || '').get('next'); a.href = n || '/app'; });
  }).catch(function () { /* signed out */ });
})();
