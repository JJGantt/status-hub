// Entry for tv-calendar.html. The list and its ORDER are the contract: these modules run for their side
// effects, and each one's own imports are evaluated before it — exactly what a run of separate
// <script type=module> tags did, which is what this replaced. Served raw, this graph costs a round
// trip per import LEVEL before any of it runs; build.js bundles this into
// public/dist/tv-calendar.js, which is the one script the page actually loads.

import '../core.js';   // renders the REAL hub cards from /api/stream into the .rows
import '../tv.js';   // the kiosk's activity popup + heard-you pop (kiosk only; every other surface boots voiceagent)
import '../wall.js';   // on a phone-sized viewport, scale the whole 1920x1080 shell to fit (phone "wall mode")
import '../wallmode.js';   // follow the wall_mode setting, so the TV can be switched between walls by voice
import '../expand.js';   // phone-wall expand icons -> full-screen section sheets (nutrition / workouts)
import '../tv-calendar.js';   // the calendar wall's month grid
