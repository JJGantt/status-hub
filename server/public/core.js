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
import './voiceagent.js';   // mic FAB + shared 'hub' conversation (self-skips on the TV wall)
import './settings.js';     // gear → settings panel (routing mode + trailing-silence); self-skips on TV

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
 routing.render(s);    // TV-only routing panel (model/thinking/runner/voice)
 score.render(s);      // TV-only overall-score health bar (right column)
}

const es=new EventSource('/api/stream');
es.onmessage=e=>{try{render(JSON.parse(e.data));}catch(_){}};

// ---- layout ----
// desktop = plain document-flow rows that scroll (defined in index.html / app.css; nothing to init).
// phone = fixed swipe-through pages, one per row group. Each .row-card becomes a page, so the page
// grouping mirrors the desktop rows exactly: [status] [nutrition+log] [muscle map+volume] [workouts].
// On a TOUCH phone we swap to the swipe-page layout — UNLESS this is the TV/wall page (body.tv), which a
// phone can also load in "wall mode" to mirror the dashboard (wall.js scales it). There the TV grid must
// stay intact, so the swipe transform is skipped.
if(TOUCH && !document.body.classList.contains('tv')){
 document.body.classList.add('touch');
 const rows=[...document.querySelectorAll('.rows > .row-card')];
 const pages=document.createElement('div'); pages.className='pages';
 rows.forEach(rc=>{
  const pg=document.createElement('div');
  // The Raspy chat page locks to the viewport (pinned header/input, internal log scroll); others scroll normally.
  pg.className='page'+(rc.classList.contains('airow')?' page-ai':'');
  const pf=document.createElement('div');pf.className='pagefit';
  pf.appendChild(rc);            // move the whole row group into one swipe page
  pg.appendChild(pf);pages.appendChild(pg);
 });
 const container=document.querySelector('.rows'); container.replaceWith(pages);
 // Default to the nutrition page on load (not the first/leftmost page, which is Raspy).
 const startIdx=Math.max(0,rows.findIndex(rc=>rc.classList.contains('nutrow')));
 const dots=document.createElement('div'); dots.className='dots';
 rows.forEach((_,i)=>{const d=document.createElement('span');if(i===startIdx)d.className='on';dots.appendChild(d);});
 pages.after(dots);
 pages.addEventListener('scroll',()=>{const i=Math.round(pages.scrollLeft/pages.clientWidth);[...dots.children].forEach((d,k)=>d.classList.toggle('on',k===i));},{passive:true});
 if(startIdx>0)requestAnimationFrame(()=>{pages.scrollLeft=startIdx*pages.clientWidth;}); // land on nutrition without animation
 // Wall-mode entry: jump to the landscape TV dashboard (the same wall UI, scaled to fit the phone — wall.js).
 const wb=document.createElement('button'); wb.className='wallbtn'; wb.textContent='⊞';
 wb.title='Wall mode'; wb.setAttribute('aria-label','Wall mode'); wb.onclick=()=>{location.href='/tv';};
 document.body.appendChild(wb);
}
