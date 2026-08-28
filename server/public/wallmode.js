// Which wall the TV shows, switched by voice.
//
// The kiosk is a browser on the Pi and nothing can reach in to navigate it, so the page watches the
// setting and moves itself. Both walls load this; whichever one is up notices when `wall_mode` names
// the other and goes there.
//
// ONLY ON THE TV. `/` serves the same markup to the phone app, and a spoken "switch the TV" must not
// yank the phone to another page — so this acts only on the two kiosk paths.
const PAGES = { standard: '/tv', sessions: '/tv-session-focus' };
const HERE = location.pathname;

if (HERE === PAGES.standard || HERE === PAGES.sessions) {
  const es = new EventSource('/api/stream');
  es.addEventListener('message', (e) => {
    let want;
    try { want = JSON.parse(e.data)?.routing?.wall; } catch { return; }
    const to = PAGES[want];
    // A reload of the page already showing is not a switch; it would restart the wall every frame.
    // The query string comes along: the kiosk authenticates with ?token=, which seeds a cookie, and
    // carrying it means the switch still works on a browser whose cookie was cleared.
    if (to && to !== HERE) location.replace(to + location.search);
  });
}
