// The Apple Watch's battery: one hairline pinned along the very bottom of the TV walls, the same
// weight as the usage bars at the top, filling left to right. The phone home page does not draw it.
// The server computes the fill and the colour (`watch_battery`, lib/watchbattery.js); this only paints.
export function render(s) {
  const b = document.body;
  if (!b.classList.contains('tv') || b.classList.contains('phonehome')) return;
  const w = s && s.watch_battery;
  let el = document.getElementById('watchbattery');
  if (!w) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'watchbattery';
    el.innerHTML = '<div class="wb-fill"></div>';
    document.body.appendChild(el);
  }
  const f = el.firstChild;
  f.style.width = `${w.pct}%`;
  f.style.background = w.color;
}
