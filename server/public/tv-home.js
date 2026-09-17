// The home wall's own middle. Everything else on this page is a shared card that core.js already
// paints; only two things are this wall's: the day columns it mounts, and the session panel, and
// that panel is now a shared module too (cards/sessions.js) because the phone's home column draws
// the same list.
//
// DISPLAY ONLY, like every wall. Nothing here is interactive and nothing here writes — voice starts
// sessions, voice focuses them, and this is where the answer comes back.
import { mount } from './cards/dayline.js';
import { mountSessions } from './cards/sessions.js';

// The month grid is the calendar wall's; this column takes the day on its own. `full=1` for the
// whole clock rather than 7a-10p, because the dial centres on now and needs something to show in
// both directions — by evening the short range has nothing left below the line.
//
// `ahead=6` carries the six days after today in the SAME response, painted into the column beside
// it. One fetch and one reload for both: they answer one question between them, and two of them
// re-reading on their own clocks is two chances to be showing different days at the same moment.
mount(document.getElementById('cw-day'), {
  // SEVEN, not six. The first day back is TODAY and it feeds the dock at the bottom of the dial
  // (see paintEdges in cards/dayline.js); the look-ahead column draws the six after it.
  url: '/api/calendar?day=1&full=1&ahead=7',
  dial: true,
  ahead: document.getElementById('cw-week'),
  dock: true,
});

// Three rows, not five. The list is a glance at what is running; the room it was taking above the
// answer is worth more to the answer, which is the thing on this column actually read word by word.
mountSessions({
  list: document.getElementById('hw-sess-list'),
  head: document.getElementById('hw-sess-head'),
  reply: document.getElementById('hw-sess-reply'),
  max: 3,
});
