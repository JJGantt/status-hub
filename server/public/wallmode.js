// Which wall the TV shows, switched by voice.
//
// The kiosk is a browser on the Pi and nothing can reach in to navigate it, so the page watches the
// setting and moves itself. Both walls load this; whichever one is up notices when `wall_mode` names
// the other and goes there.
//
// ONLY ON THE TV, and the path test is the guard rather than a body class. A spoken "switch the TV"
// must not yank the phone to another page, and the phone can be on a page that loads this — it was
// on `/` when that served a wall, and `/calendar` is the same shape as `/tv-calendar` still. `/` is
// its own file now and does not even import this, which makes the guard redundant there and no less
// necessary anywhere else.
import { liveStream } from './shared.js';

const PAGES = { standard: '/tv', health: '/tv-health', sessions: '/tv-session-focus', calendar: '/tv-calendar' };
const HERE = location.pathname;

if (Object.values(PAGES).includes(HERE)) {
  liveStream('/api/stream', { message: (e) => {
    let want;
    try { want = JSON.parse(e.data)?.routing?.wall; } catch { return; }
    const to = PAGES[want];
    // A reload of the page already showing is not a switch; it would restart the wall every frame.
    // The query string comes along (any mode flags). The kiosk's ?token= is already gone: the hub
    // trades it for a cookie and redirects to the URL without it.
    if (to && to !== HERE) location.replace(to + location.search);
  } });
}
