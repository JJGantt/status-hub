// Bootstrapping: SSE → render orchestrator, then the layout init.
import { TOUCH, state } from './shared.js';
import * as litter from './cards/litter.js';
import * as feeder from './cards/feeder.js';
import * as surf from './cards/surf.js';
import * as nutrition from './cards/nutrition.js';
import * as muscle from './cards/muscle.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';
import * as routing from './cards/routing.js';   // TV voice-column routing panel (no-ops on phone)
import * as score from './cards/score.js';       // TV overall-score health bar (no-ops on phone)
import * as mics from './cards/mics.js';         // page voice-liveness card (no-ops on the TV wall)
import './voiceagent.js';   // shared 'hub' conversation + activity popup (self-skips on the TV wall)
import './settings.js';     // gear → settings panel (routing mode + trailing-silence); self-skips on TV
import { mountNavbar } from './navbar.js';   // shared bottom bar (toggle · settings · brain · sparkle)

// ---- render orchestrator: set shared frame, then each card in order ----
function render(s){
 if(!s||s.error){return;}
 state.last=s;
 litter.render(s);
 feeder.render(s);    // cat feeder tile (no-ops on the TV wall, which omits #feeder)
 surf.render(s);
 nutrition.render(s);
 workouts.render(s);
 nutritionlog.render(s);
 muscle.render(s);     // paints the body map from volume colors + re-applies volume sort/selection
 routing.render(s);    // TV-only routing panel (model/thinking/runner/voice + liveness chips)
 score.render(s);      // TV-only overall-score health bar (right column)
 mics.render(s);       // page-only voice-liveness card (TV shows the same data in the routing strip)
}

const es=new EventSource('/api/stream');
es.onmessage=e=>{try{render(JSON.parse(e.data));}catch(_){}};

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
// Shared bottom navbar on BOTH views (full page + phone wall); skip only the TV kiosk (wall on a big screen).
if(!document.body.classList.contains('tv') || window.innerWidth < 1400) mountNavbar();
