// Claude logins in trouble — a red strip at the top of the page, one chip per machine whose login the
// weekly renewal has failed to keep up (`s.logins`, server lib/dashboard.js; health
// runbooks/claude-login.md). It stays until the login is renewed; an empty list removes it. Labels and
// values only. Paints #loginbanner; no-ops where absent.
export function render(s) {
  const el = document.getElementById('loginbanner');
  if (!el) return;
  const rows = (s && s.logins) || [];
  if (!rows.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = rows.map((r) =>
    '<span class="lb-chip"><span class="lb-l">Claude login · ' + r.machine + '</span>' +
    '<span class="lb-v">' + (r.days > 0 ? r.days + ' days' : 'Expired') + '</span></span>').join('');
}
