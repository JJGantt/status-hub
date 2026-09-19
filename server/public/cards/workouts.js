// Workout Volume card: GitHub-style heatmap with inline day detail + click/drag-scrub selection,
// defaulting to today; plus a rest timer (time since last set, hidden once past 5 min).
import { state, esc, localNowNaive, paintScrolled, heatPick, scrollableX } from '../shared.js';
import { withHistory } from '../heathistory.js';
import { exerciseVolumeChips } from './muscle.js';
let heatSelDate=null, heatReq=0;
let lastHeatExercises=null; // exercises for the open day-detail (for the repeat-set popup)
// Back to now: the day detail returns to today, the same as a fresh load, where nothing has been
// picked yet and render() defaults it. The reset button is meant to leave the page as it opens.
addEventListener('hubreset',()=>{
 const today=state.last&&state.last.today;
 if(today&&today!==heatSelDate)selectDay(today);
});

export function render(s){
 // Shorter span on the home wall, where this runs beside the muscle column. Selection only — both
 // spans were computed server-side.
 const hw=document.getElementById('heatwrap'); if(!hw)return;
 // In the expanded sheet the grid carries its full history in front of the live window; everywhere
 // else it is the window the frame ships. See heathistory.js.
 const H=withHistory(Object.assign({weeks:[],months:[]},s.heatmap,heatPick(s,'heatmap')),'heatmap',hw,s.today);
 // Eight steps, one per level from lib/heatmap.js: [0]=a day with no sets, black; then 1-6, 7-12,
 // 13-18, 19-24, 25-30, 31-36, 37+ sets. The last two continue the greens at the same hue and
 // saturation, spaced like the steps before them, and stop short of white: the today outline is
 // near-white, so a top shade any paler would swallow it.
 const HC=['#000','#0e4429','#006d32','#158c3a','#26a641','#39d353','#43f461','#8cfc94'];
 const monthRow=(H.months||[]).map(m=>'<div class=hm>'+m+'</div>').join('');
 const grid=(H.weeks||[]).map(col=>'<div class=hcol>'+col.map(d=>{
   const bg=d.level<0?'transparent':HC[d.level];
   const out=d.today?';outline:1.5px solid #e8eaed;outline-offset:-1px':'';
   const click=d.level>=0?' data-date="'+d.date+'"':'';
   const cur=d.level>=0?';cursor:pointer':'';
   return '<div class=hcell'+click+' title="'+d.date+': '+d.count+' set'+(d.count===1?'':'s')+'" style="background:'+bg+out+cur+'"></div>';
 }).join('')+'</div>').join('');
 const dowLabels=['','Mon','','Wed','','Fri',''].map(x=>'<div class=hd>'+x+'</div>').join('');
 paintScrolled(hw,
  '<div class=hmonths>'+monthRow+'</div>'+
  '<div class=hbody><div class=hdows>'+dowLabels+'</div><div class=heat>'+grid+'</div></div>');
 if(heatSelDate){ markHeatCell(heatSelDate); if(heatSelDate===s.today)loadHeatDay(heatSelDate); } // live-refresh today's sets
 else if(s.today)selectDay(s.today);      // default the day detail to today's sets
 tickRest();
}
// Two live clocks driven off the set log, both counting up, plus today's tally:
//  - SINCE LAST SET (left, always): time since the LAST set. mm:ss when recent, then coarse (Hh Mm /
//    Dd Hh). Green while active, amber past 5 min, dimmed once the session is over.
//  - SESSION (middle, only while active): total time since the FIRST set of the current session — a run
//    of sets each within 20min of the previous. Once 20min pass with no new set the session is over and
//    this side disappears (resets to zero); the next set starts a fresh session.
//  - SETS (right, always): `sets_today` off the payload — sets in the current 4am day, small.
const SESSION_GAP_S=20*60;          // a >20min gap between sets ends the session
function fmtSince(s){
 if(s<3600) return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
 if(s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
 return Math.floor(s/86400)+'d '+Math.floor((s%86400)/3600)+'h';
}
function fmtSession(s){
 const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60), p=n=>String(n).padStart(2,'0');
 return h>0 ? h+':'+p(m)+':'+p(sec) : m+':'+p(sec);
}
// Pure wall-clock arithmetic — NO timezone conversion, ever. occurred_at is a naive reading (no
// offset) of whatever clock was doing the logging, wherever that was; "now" here is THIS device's
// own current wall clock. Both get reduced to digits and diffed with Date.UTC as a plain calendar
// calculator (never `new Date(str)`, which would silently reinterpret the naive string as being in
// THIS device's zone and go through a real UTC conversion — the bug that froze this timer at 0:00
// while traveling). A rest/session clock never spans an actual timezone change mid-use, so comparing
// raw wall-clock digits is exactly right, not an approximation.
function wallClockMs(naiveStr){
 const m=String(naiveStr).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
 if(!m)return NaN;
 return Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);
}
function nowWallClockMs(){
 const d=new Date();
 return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes(),d.getSeconds());
}
function tickRest(){
 const el=document.getElementById('resttimer'); if(!el)return;
 const d=state.last||{}, lastAt=d.last_set_at;
 if(!lastAt){el.innerHTML='';el.className='resttimer';return;}
 const now=nowWallClockMs();
 const rest=Math.max(0,(now-wallClockMs(lastAt))/1000);   // wall-clock seconds since the last set
 const active=rest<=SESSION_GAP_S;
 el.className='resttimer'+(!active?' stale':(rest>=300?' cool':''));
 // Label then value, on one line. Stacked they cost twice the height for the same two facts, and
 // the label is the small half — there is no arrangement where it needs its own row.
 // left — since last set (always)
 let html='<div class="rt-side rt-left"><div class=rt-label>Last set</div>'+
   '<div class=rt-time>'+fmtSince(rest)+'</div></div>';
 // middle — session total (only while a session is live)
 if(active){
   const startAt=d.session_start_at||lastAt;
   const sess=Math.max(0,(now-wallClockMs(startAt))/1000);
   html+='<div class="rt-side rt-mid"><div class=rt-label>Session</div>'+
     '<div class="rt-time rt-session">'+fmtSession(sess)+'</div></div>';
 }
 // right — sets logged so far today (server-counted, 4am day). Deliberately small: it is a tally,
 // not a clock, so it holds the far edge without competing with the digits beside it.
 html+='<div class="rt-side rt-right"><div class=rt-label>Sets</div>'+
   '<div class="rt-time rt-count">'+(d.sets_today||0)+'</div></div>';
 // The rep watcher, under the clocks: what the watch's counted sets are being logged
 // as right now. Only useful BEFORE a set, so it sits where the eye already goes.
 const rw=(state.last||{}).rep_watcher;
 if(rw&&rw.exercise){
   const wt=(rw.weight_lbs===0||rw.weight_lbs==null)?'bodyweight':fmtLbs(rw.weight_lbs)+' lb';
   html+='<div class=rt-watcher><span class=rt-wdot></span>'+
     '<span class=rt-wex>'+esc(rw.exercise)+'</span>'+
     '<span class=rt-wwt>'+wt+'</span></div>';
 }
 el.innerHTML=html;
}

// Shrink a row's type until it fits rather than letting it clip. Neither list here is bounded — a
// sixth working set, a five-muscle compound — and a list cut off mid-character reads as damage,
// where the same list a size smaller reads as a list. Everything on these rows is sized off `--rcfs`
// (tv-home.css), so one property carries the type, the gaps and the rules between sets together.
// Stepped rather than solved for: the padding either side of a set does not scale with the glyphs
// exactly, so the ratio of widths is not the ratio of sizes.
// The wall's short forms, for names long enough to crowd the muscle counts off the row beside them.
// Jared's words — an entry here is one he asked for, not one this file invented. Everything else
// draws its full name, and a long one that is not listed is handled by the name fit instead.
const EX_SHORT={ 'Romanian Deadlifts':'RDL' };

// The START and the FLOOR are the surface's, not this file's: `base` and `min` are wall sizes, and a
// phone reading the same row at arm's length in a half-width column wants both smaller. A surface
// says so with `--rc-base` / `--rc-min` on the row; everything else gets exactly what it had.
function fitRow(el,base,min){
 if(!el)return;
 const cs=getComputedStyle(el);
 const b=parseFloat(cs.getPropertyValue('--rc-base'))||base;
 const m=parseFloat(cs.getPropertyValue('--rc-min'))||min;
 let fs=b; el.style.setProperty('--rcfs',fs+'px');
 while(fs>m&&el.scrollWidth>el.clientWidth+0.5){ fs-=0.5; el.style.setProperty('--rcfs',fs+'px'); }
}

// Where the exercise name starts before the three-stage shrink below brings it down, same reasoning.
function nameBase(el,dflt){
 if(!el)return dflt;
 const v=parseFloat(getComputedStyle(el).getPropertyValue('--rc-name-base'));
 return Number.isFinite(v)&&v>0?v:dflt;
}

function fmtLbs(n){ const v=Number(n)||0; return Number.isInteger(v)?String(v):v.toFixed(1); }

function markHeatCell(date){
 document.querySelectorAll('#heatwrap .hcell').forEach(c=>c.classList.toggle('hsel',c.dataset.date===date));
}
async function loadHeatDay(date){
 // A surface can take the heatmap without the day-detail panel. Bail before the fetch, not after it.
 if(!document.getElementById('heatinfo'))return;
 const tok=++heatReq;
 let j; try{ j=await (await fetch('/api/workout-day?date='+date)).json(); }catch(_){ return; }
 if(tok!==heatReq)return; // a newer cell was selected mid-flight — drop this stale response
 const hi=document.getElementById('heatinfo');
 // `data-recent` asks for ONE exercise: the one whose set was logged last, with its whole grouping,
 // exactly as the full panel draws it. The wall has room for a line, not a workout.
 if(hi.dataset.recent!==undefined){
  const ex=(j.exercises||[]).find(e=>e.name===j.recent);
  // Same shape as the nutrition row beside it — name, then values with the number carrying the
  // weight and everything around it muted. No pills: spacing separates the sets.
  // No `lb`: every set on this row is in pounds and the unit repeated five times is five times
  // nothing. Weight × reps — the weight carries its own class because it is drawn SMALLER than the
  // reps beside it (see tv-home.css), and the sets are ruled apart rather than spaced apart, which
  // is what lets five of them fit.
  const set=(st,carry)=>'<span class=rc-set>'+
    (carry?'':'<span class="rc-v rc-w">'+(st.weight_lbs===0?'BW':st.weight_lbs)+'</span>')+
    '<span class=rc-x>×</span><span class=rc-v>'+st.reps+'</span></span>';
  // `elide` is the last resort below: a set drops its weight when it matches the set before it, so a
  // long run at one load reads `BW × 12  × 10  × 8` instead of restating the load nine times.
  const setsHtml=(elide)=>ex.sets.map((st,i)=>set(st,elide&&i>0&&ex.sets[i-1].weight_lbs===st.weight_lbs)).join('');
  // Beside the name, what this exercise feeds: each muscle's WEEKLY sets in that muscle's volume
  // colour. The wall dropped the volume bars for the body map, which says WHERE but not HOW MUCH —
  // this puts the number back on the one exercise that is on screen. It rides the name's row rather
  // than adding one: the column's height is spent to the pixel (see tv-home.css).
  // The set COUNT closes the row, held off from the sets by a rule twice the weight of the ones
  // between them: five readings are hard to count at a glance and the tally is the thing being
  // counted, so it is stated rather than counted. It keeps its size while the sets shrink.
  hi.innerHTML=ex?'<div class=rc-top><span class=rc-name>'+esc(EX_SHORT[ex.name]||ex.name)+'</span>'+exerciseVolumeChips(ex.name)+'</div>'+
    '<div class="rc-vals rc-sets">'+setsHtml(false)+'<span class=rc-count>'+ex.sets.length+'</span></div>':'';
  const sr=hi.querySelector('.rc-sets');
  fitRow(sr,16,9);
  // Past ~9 sets the row is still over at the floor, and 8px on a wall is not a number anyone reads.
  // Repeated weights are what is left to spend: dropping them buys about a third of the width back,
  // and only then, so a normal five-set row is never written in the shorthand.
  if(sr&&sr.scrollWidth>sr.clientWidth+0.5){
   sr.innerHTML=setsHtml(true)+'<span class=rc-count>'+ex.sets.length+'</span>'; fitRow(sr,16,9);
  }
  // The name row gives way in three stages, cheapest first. Full muscle names shrink to 12px, which
  // is as small as a name on a wall is worth setting; below that the SAME list swaps to the short
  // forms and shrinks again; only then does the exercise name itself come down. Four or five
  // muscles is what forces it — Reverse Lunges has four, Ring-Assisted Squats five and a long name.
  const nameEl=hi.querySelector('.rc-name');
  const over=(el)=>el&&el.scrollWidth>el.clientWidth+0.5;
  let musEl=hi.querySelector('.rc-mus');
  fitRow(musEl,15,12);
  if(over(musEl)){
   musEl.outerHTML=exerciseVolumeChips(ex.name,true);
   musEl=hi.querySelector('.rc-mus'); fitRow(musEl,15,9);
  }
  for(let nfs=nameBase(nameEl,17); nfs>nameBase(nameEl,17)-4&&over(musEl); ){ nameEl.style.fontSize=(--nfs)+'px'; fitRow(musEl,15,9); }
  return;
 }
 const sp=hi.closest('.detailpanel'), stick=sp&&(sp.scrollHeight-sp.scrollTop-sp.clientHeight<60); // keep pinned to newest if already at bottom
 if(!j.exercises||!j.exercises.length){ hi.innerHTML='<div class=heath>'+date+'</div><div class=bi-none>No sets logged</div>'; lastHeatExercises=null; return; }
 lastHeatExercises=j.exercises;
 let h='<div class=heath>'+date+' · '+j.total+' sets</div>';
 j.exercises.forEach((ex,i)=>{
  // `lb` and the multiplication sign are their own elements for the same reason the macro units are:
  // a surface with no room for `100 lb × 13` can drop the unit and close the gaps, and `100×13` says
  // the same thing. The COUNT rides at the end of the row — right-aligned and outside whatever
  // scrolls the sets, so a long working set still leaves the total readable.
  h+='<div class=dex><div class=wk-exhead><div class=dex-n>'+esc(ex.name)+'</div>'+
     '<button class="addbtn wk-rep" type=button data-rep="'+i+'" title="Log another set (same weight)">+</button></div>'+
     '<div class=dex-sets>'+ex.sets.map(st=>'<span class="dset wk-set" data-set="'+st.id+'" data-w="'+st.weight_lbs+'" data-r="'+st.reps+'" title="Tap to edit">'+
       (st.weight_lbs===0?'BW':(st.weight_lbs+'<i class=du> lb</i>'))+'<i class=dx>×</i>'+st.reps+'</span>').join('')+'</div>'+
     '<span class=wk-n>'+ex.sets.length+'</span></div>';
 });
 hi.innerHTML=h;
 if(sp&&stick)sp.scrollTop=sp.scrollHeight; // scroll to the newest set
}
function selectDay(date){ if(date===heatSelDate)return; heatSelDate=date; markHeatCell(date); loadHeatDay(date); }

// Repeat-last-set popup: weight is fixed (the exercise's last set weight); only reps is prompted.
// On confirm it POSTs a new set at "now"; realtime on `sets` refreshes the heatmap + timer.
function openRepModal(ex){
 const last=ex.sets[ex.sets.length-1]; if(!last)return;
 const w=Number(last.weight_lbs)||0;
 let reps=parseInt(last.reps,10)||1;
 const back=document.createElement('div'); back.className='addmodal-back';
 back.innerHTML='<div class=addmodal role=dialog aria-modal=true>'+
   '<div class=addmodal-name>'+esc(ex.name)+'</div>'+
   '<div class=addmodal-mlabel>Reps</div>'+
   '<div class=addmodal-mult>'+
     '<button class=addmodal-step type=button data-step="-1">−</button>'+
     '<input class=addmodal-minput type=text inputmode=numeric value="'+reps+'">'+
     '<button class=addmodal-step type=button data-step="1">+</button>'+
   '</div>'+
   '<div class=addmodal-macros><span class=dset>'+(w===0?'Bodyweight':(w+' lb'))+'</span></div>'+
   '<div class=addmodal-btns>'+
     '<button class=addmodal-cancel type=button>Cancel</button>'+
     '<button class=addmodal-add type=button>Add set</button>'+
   '</div></div>';
 document.body.appendChild(back);
 const input=back.querySelector('.addmodal-minput');
 const sync=()=>{ input.value=String(reps); };
 back.querySelectorAll('.addmodal-step').forEach(b=>b.addEventListener('click',()=>{ reps=Math.max(1,reps+Number(b.dataset.step)); sync(); }));
 input.addEventListener('input',()=>{ const v=parseInt(input.value,10); reps=Number.isFinite(v)&&v>0?v:0; });
 const close=()=>back.remove();
 back.addEventListener('click',e=>{ if(e.target===back)close(); });
 back.querySelector('.addmodal-cancel').addEventListener('click',close);
 const addBtn=back.querySelector('.addmodal-add');
 addBtn.addEventListener('click',async()=>{
  if(!(reps>0)){ input.focus(); return; }
  addBtn.disabled=true; addBtn.textContent='Adding…';
  try{
   const r=await fetch('/api/log-set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exercise:ex.name,weight_lbs:w,reps,client_now:localNowNaive()})});
   if(!r.ok)throw new Error(r.status);
   close(); // realtime re-pushes the dashboard (heatmap, day detail, rest timer reset)
  }catch(_){ addBtn.disabled=false; addBtn.textContent='Retry'; }
 });
}

// Tap a logged set to edit its weight + reps. PATCHes /api/log-set by set id; realtime on `sets`
// re-pushes the heatmap + day detail. Weight steps by 5 lb (0 = bodyweight), reps by 1.
function openSetEditor(id,name,w0,r0){
 let w=Math.max(0,Number(w0)||0), reps=Math.max(1,parseInt(r0,10)||1);
 const back=document.createElement('div'); back.className='addmodal-back';
 back.innerHTML='<div class=addmodal role=dialog aria-modal=true>'+
   '<div class=addmodal-name>'+esc(name||'Set')+'</div>'+
   '<div class=addmodal-mlabel>Weight (lb)</div>'+
   '<div class=addmodal-mult>'+
     '<button class=addmodal-step type=button data-fld=w data-step="-1">−</button>'+
     '<input class="addmodal-minput wk-w" type=text inputmode=decimal value="'+w+'">'+
     '<button class=addmodal-step type=button data-fld=w data-step="1">+</button>'+
   '</div>'+
   '<div class=addmodal-mlabel>Reps</div>'+
   '<div class=addmodal-mult>'+
     '<button class=addmodal-step type=button data-fld=r data-step="-1">−</button>'+
     '<input class="addmodal-minput wk-r" type=text inputmode=numeric value="'+reps+'">'+
     '<button class=addmodal-step type=button data-fld=r data-step="1">+</button>'+
   '</div>'+
   '<div class=addmodal-btns>'+
     '<button class=addmodal-cancel type=button>Cancel</button>'+
     '<button class=addmodal-add type=button>Save</button>'+
   '</div></div>';
 document.body.appendChild(back);
 const wIn=back.querySelector('.wk-w'), rIn=back.querySelector('.wk-r');
 back.querySelectorAll('.addmodal-step').forEach(b=>b.addEventListener('click',()=>{
  const d=Number(b.dataset.step);
  if(b.dataset.fld==='w'){ w=Math.max(0,Math.round((w+d*5)*10)/10); wIn.value=String(w); }
  else { reps=Math.max(1,reps+d); rIn.value=String(reps); }
 }));
 wIn.addEventListener('input',()=>{ const v=parseFloat(wIn.value); w=Number.isFinite(v)&&v>=0?v:0; });
 rIn.addEventListener('input',()=>{ const v=parseInt(rIn.value,10); reps=Number.isFinite(v)&&v>0?v:0; });
 const close=()=>back.remove();
 back.addEventListener('click',e=>{ if(e.target===back)close(); });
 back.querySelector('.addmodal-cancel').addEventListener('click',close);
 const saveBtn=back.querySelector('.addmodal-add');
 saveBtn.addEventListener('click',async()=>{
  if(!(reps>0)){ rIn.focus(); return; }
  saveBtn.disabled=true; saveBtn.textContent='Saving…';
  try{
   const r=await fetch('/api/log-set',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(id),weight_lbs:w,reps})});
   if(!r.ok)throw new Error(r.status);
   close(); // realtime re-pushes the heatmap + day detail
  }catch(_){ saveBtn.disabled=false; saveBtn.textContent='Retry'; }
 });
}

// The rest clock ticks wherever the strip is. It is a clock, not an interaction, so it does not
// belong behind the binding guard below — the home wall has the strip and none of the handlers, and
// hanging the interval off them froze it at whatever the last status frame happened to compute.
if(document.getElementById('resttimer'))setInterval(tickRest,1000);

(function(){
 const wk=document.getElementById('workouts'), hi=document.getElementById('heatinfo'); let scrub=false;
 if(!wk||!hi)return; // surface without the interactive heatmap + day detail — nothing to bind
 const cellAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.hcell'):null;};
 // Scrubbing and scrolling both want a horizontal drag. Outside the sheet the grid can't scroll, so
 // the drag is a scrub and preventDefault keeps it from becoming a card-drag. Inside the sheet the
 // grid scrolls, so a touch drag belongs to the browser and the tap arrives as a click instead.
 const scrollable=(c)=>scrollableX(c,wk);
 wk.addEventListener('pointerdown',e=>{const c=e.target.closest('.hcell');if(!c||!c.dataset.date)return;
  if(e.pointerType!=='mouse'&&scrollable(c))return;
  scrub=true;selectDay(c.dataset.date);e.preventDefault();e.stopPropagation();/* don't let it become a card-drag */});
 // Idempotent — selectDay no-ops on the day pointerdown already picked, so this only ever fires for
 // the taps the branch above hands back to the browser.
 wk.addEventListener('click',e=>{const c=e.target.closest('.hcell');if(c&&c.dataset.date)selectDay(c.dataset.date);});
 document.addEventListener('pointermove',e=>{if(!scrub)return;const c=cellAt(e.clientX,e.clientY);if(c&&c.dataset.date)selectDay(c.dataset.date);});
 document.addEventListener('pointerup',()=>{scrub=false;});
 // day detail: tap a set to edit it; "+ set" button to repeat the last set
 hi.addEventListener('click',e=>{
  const setEl=e.target.closest('[data-set]');
  if(setEl){ e.stopPropagation();
   const dex=setEl.closest('.dex'); const name=dex?dex.querySelector('.dex-n').textContent:'Set';
   openSetEditor(setEl.dataset.set,name,setEl.dataset.w,setEl.dataset.r); return; }
  const btn=e.target.closest('[data-rep]'); if(!btn)return;
  e.stopPropagation();
  const ex=lastHeatExercises&&lastHeatExercises[+btn.dataset.rep];
  if(ex)openRepModal(ex);
 });
})();
