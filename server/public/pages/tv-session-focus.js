// Entry for tv-session-focus.html. The list and its ORDER are the contract: these modules run for their side
// effects, and each one's own imports are evaluated before it — exactly what a run of separate
// <script type=module> tags did, which is what this replaced. Twenty-six files arriving in three
// waterfall levels cost a round trip per level on a phone; build.js bundles this into
// public/dist/tv-session-focus.js, which is the one script the page actually loads.

import '../core.js';   // renders the REAL hub cards from /api/stream into the .rows
import '../tv.js';   // the kiosk's activity popup + heard-you pop (kiosk only; every other surface boots voiceagent)
import '../wall.js';   // on a phone-sized viewport, scale the whole 1920x1080 shell to fit (phone "wall mode")
import '../wallmode.js';   // follow the wall_mode setting, so the TV can be switched between walls by voice
import '../expand.js';   // phone-wall expand icons -> full-screen section sheets (nutrition / workouts)
import '../tv-focus.js';   // the session-focus wall
