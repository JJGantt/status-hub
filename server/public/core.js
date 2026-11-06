// Bootstrapping: SSE → render orchestrator, then the layout init.
import { TOUCH, KIOSK, state, liveStream, safeReload } from './shared.js';
import * as litter from './cards/litter.js';
import * as feeder from './cards/feeder.js';
import * as surf from './cards/surf.js';
import * as weather from './cards/weather.js';  // rain-chance grid beside surf (no-ops where there is no #weather)
import * as nutrition from './cards/nutrition.js';
import * as muscle from './cards/muscle.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';
import * as weightweeks from './cards/weightweeks.js'; // home-wall weekly weigh-in plot over the heat columns (no-ops elsewhere)
import * as routing from './cards/routing.js';   // TV voice-column routing panel (no-ops on phone)
import * as deskfoot from './cards/deskfoot.js';  // TV footer: which session takes a follow-up (no-ops on phone)
import * as score from './cards/score.js';       // TV overall-score health bar (no-ops on phone)
import * as usage from './cards/usage.js';       // Claude usage hairlines across the top of every wall
import * as watchbattery from './cards/watchbattery.js'; // the watch's battery, a hairline along the bottom of the walls
import * as mics from './cards/mics.js';         // page voice-liveness card (no-ops on the TV wall)
import * as maintviz from './cards/maintviz.js'; // phone-wall maintenance-window pane (no-ops elsewhere)
import './cards/dayline.js';                     // the day column, wherever one is on the page — self-driving
import * as todo from './cards/todo.js';         // phone-wall lists pane (no-ops elsewhere)
import * as repos from './cards/repos.js';       // phone-wall repo picker → Claude session on the Mac (no-ops elsewhere)
import * as guide from './cards/guide.js';       // phone TV Guide pane — the bedroom TV's shelves (no-ops elsewhere)
import * as reports from './cards/reports.js';   // phone-wall reports pane — what dispatched sessions hand back (no-ops elsewhere)
import './voiceagent.js';   // shared 'hub' conversation + activity popup (self-skips on the TV wall)
import './settings.js';     // gear → settings panel (routing mode + trailing-silence); self-skips on TV
import { mountNavbar } from './navbar.js';   // shared bottom bar (toggle · settings · brain · sparkle)

// The commit this page was LOADED from — see state.last below.
let builtAt = null, stale = false;

// A DEPLOY HAS TO REACH THE SCREEN. A page open for hours never re-requests its own bundle, and on
// iOS closing the app usually SUSPENDS it: reopening restores the same page with the same code, so
// "I closed and reopened it" is not a reload and a fix can look unfixed for an afternoon.
//
// Two moments, because the first is not reliable on a phone. Going HIDDEN is the invisible one, and
// it is tried first — but JS is suspended shortly after backgrounding and the navigation may never
// finish. Coming back VISIBLE is the one that always runs, and it is the least-bad time to
// interrupt: the user has just arrived and has typed nothing.
//
// A wall is never hidden, so it reloads at once, which is what a wall wants.
// A PHONE THAT NEVER GOES HIDDEN is the third case, and it holds the old bundle forever: a screen
// parked on this page has no visibilitychange coming, and since the page is now also the alarm clock
// that means a deploy can leave a phone holding code that cannot ring. So idleness is the other
// moment to take. Interrupting a page nobody has touched for two minutes costs nothing — the
// deferral above exists only to avoid reloading under someone's hands, not to wait forever.
const STALE_IDLE_MS = 120000;
function goStale() {
  if (stale) return;
  stale = true;
  if (KIOSK || document.hidden) return safeReload();
  document.addEventListener('visibilitychange', () => safeReload());
  let idleT = null;
  const arm = () => { clearTimeout(idleT); idleT = setTimeout(safeReload, STALE_IDLE_MS); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((e) => document.addEventListener(e, arm, { passive: true }));
  arm();
}

// A widget can't poll — it draws snapshots WidgetKit schedules, so it only learns about new food or
// a new set when something reloads its timeline. Inside the iOS app we know the moment the numbers
// move (this is the live stream that moved them), so nudge the native shell then. Throttled: a
// reload is cheap but not free, and the stream fires on things the widget doesn't show.
let lastWidgetSig = null, lastWidgetPush = 0;
function nudgeWidgets(s){
 const n = s && s.nutrition; if(!n) return;
 const sig = [n.calories,n.protein_g,n.carbs_g,n.fat_g].join('|');
 if(sig === lastWidgetSig) return;                       // nothing the widget shows has changed
 lastWidgetSig = sig;
 const now = Date.now();
 if(now - lastWidgetPush < 60000) return;                // at most once a minute
 lastWidgetPush = now;
 try{ window.webkit?.messageHandlers?.reloadWidgets?.postMessage(1); }catch(_){}
}

// ---- render orchestrator: set shared frame, then each card in order ----
function render(s){
 if(!s||s.error){return;}
 state.last=s;
 // A DEPLOY REACHES THE SCREEN. A page open for hours never re-requests its bundle, so without this
 // the server moves on and the surface keeps running whatever it loaded — which is how a phone spends
 // an afternoon on replaced code, and how a bug fixed twice looks unfixed. The first commit seen is
 // this page's build; a different one means the server has moved.
 //
 // Reloaded when the page is next HIDDEN, never under the user's hands: a surface that reloads mid-sentence
 // is worse than one a few minutes old. A wall is never hidden, so it takes the reload at once —
 // which is what a wall wants, since nobody is typing into it.
 if(s.commit){
  if(!builtAt) builtAt=s.commit;
  else if(s.commit!==builtAt) goStale();
 }
 nudgeWidgets(s);
 litter.render(s);
 feeder.render(s);    // cat feeder tile (no-ops on the TV wall, which omits #feeder)
 surf.render(s);
 weather.render(s);
 nutrition.render(s);
 workouts.render(s);
 nutritionlog.render(s);
 weightweeks.render(s);  // home-wall weekly weigh-in plot (no-ops where there is no #weightweeks)
 muscle.render(s);     // paints the body map from volume colors + re-applies volume sort/selection
 routing.render(s);    // TV-only routing panel (model/thinking/runner/voice + liveness chips)
 score.render(s);      // TV-only overall-score health bar (right column)
 usage.render(s);      // Claude usage hairlines (walls only)
 watchbattery.render(s); // watch battery hairline (TV walls only)
 mics.render(s);       // page-only voice-liveness card (TV shows the same data in the routing strip)
 maintviz.render(s);   // phone-wall maintenance-window pane (fourth swipe pane)
 todo.render(s);       // phone-wall lists pane (fifth swipe pane; self-fetches)
 repos.render(s);      // phone-wall repo picker (sixth swipe pane; self-fetches)
 deskfoot.render(s);   // TV footer follow-up target
 guide.render();
 reports.render(s);    // phone-wall reports pane (seventh swipe pane; self-fetches)
}

// liveStream, not a bare EventSource: this is the stream whose silent death froze the wall.
// `hub:stream` lets anything else on the page ride THIS stream instead of opening its own — two
// EventSources on one phone is a mistake already made here once. Dispatched after the render so a
// listener sees the same state the cards do, and outside its try so a card blowing up cannot also
// silence the alarm clock.
liveStream('/api/stream',{message:e=>{try{render(JSON.parse(e.data));}catch(_){}document.dispatchEvent(new CustomEvent('hub:stream'));}});

// ---- layout ----
// desktop = plain document-flow rows that scroll (defined in index.html / app.css; nothing to init).
// phone = fixed swipe-through pages, one per row group: [chat] [misc/status]. The main dashboard is
// the WALL ('/', scaled by wall.js) — /page holds only what the wall doesn't. The navbar deep-links
// here with #chat / #misc.
// On a TOUCH phone we swap to the swipe-page layout — UNLESS this is the TV/wall page (body.tv), which a
// phone can also load in "wall mode" to mirror the dashboard (wall.js scales it). There the TV grid must
// stay intact, so the swipe transform is skipped.
if(TOUCH && !document.body.classList.contains('tv')){
 document.body.classList.add('touch');
 const rows=[...document.querySelectorAll('.rows > .row-card')];
 const pages=document.createElement('div'); pages.className='pages';
 rows.forEach(rc=>{
  const pg=document.createElement('div');
  // The chat page locks to the viewport (pinned header/input, internal log scroll); others scroll normally.
  pg.className='page'+(rc.classList.contains('airow')?' page-ai':'');
  const pf=document.createElement('div');pf.className='pagefit';
  pf.appendChild(rc);            // move the whole row group into one swipe page
  pg.appendChild(pf);pages.appendChild(pg);
 });
 const container=document.querySelector('.rows'); container.replaceWith(pages);
 // Land on the page the navbar asked for: #misc → the status page; default (#chat or none) → chat.
 const startIdx=Math.max(0,rows.findIndex(rc=>rc.classList.contains(location.hash==='#misc'?'statusrow':'airow')));
 const dots=document.createElement('div'); dots.className='dots';
 rows.forEach((_,i)=>{const d=document.createElement('span');if(i===startIdx)d.className='on';dots.appendChild(d);});
 pages.after(dots);
 pages.addEventListener('scroll',()=>{const i=Math.round(pages.scrollLeft/pages.clientWidth);[...dots.children].forEach((d,k)=>d.classList.toggle('on',k===i));},{passive:true});
 if(startIdx>0)requestAnimationFrame(()=>{pages.scrollLeft=startIdx*pages.clientWidth;});
}else if(!document.body.classList.contains('tv') && location.hash==='#misc'){
 // desktop /page: document flow — honor the deep link by scrolling to the status row
 requestAnimationFrame(()=>{const el=document.querySelector('.statusrow'); if(el)el.scrollIntoView();});
}
// Shared bottom navbar on BOTH views (full page + phone wall) + the Mac app (body.mac); skip only the
// big-screen TV kiosk, which is display-only. KIOSK is that verdict, reached once in shared.js, so a
// surface that is not a kiosk cannot end up without a navbar because this restated the test.
if(!KIOSK) mountNavbar();
