// Claude usage: two hairline bars pinned across the very top of every wall (the TV walls and the phone
// home, all `body.tv`), filling left to right — the 5-hour window on top, the weekly one under it. Fixed
// and overlaid, so nothing on the page moves to make room. The server computes the fills
// (`claude_usage`, lib/usage.js buildUsage); this only paints them.
export function render(s) {
  if (!document.body.classList.contains('tv')) return;
  const u = s && s.claude_usage;
  let el = document.getElementById('usagebars');
  if (!u) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'usagebars';
    el.innerHTML = '<div class="ub-row"><div class="ub-fill" id="ub-five"></div></div>'
                 + '<div class="ub-row"><div class="ub-fill" id="ub-week"></div></div>';
    document.body.appendChild(el);
  }
  const paint = (id, w) => {
    const f = document.getElementById(id);
    f.style.width = `${w.pct}%`;
    f.classList.toggle('ub-hot', w.pct >= 90);
    f.classList.toggle('ub-warm', w.pct >= 75 && w.pct < 90);
  };
  paint('ub-five', u.five_hour);
  paint('ub-week', u.seven_day);
}
