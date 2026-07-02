// Workout Volume card: GitHub-style heatmap with inline day detail + click/drag-scrub selection,
// defaulting to today; plus a rest timer (time since last set, hidden once past 5 min).
import { state, esc } from '../shared.js';
let heatSelDate=null, heatReq=0;
let lastHeatExercises=null; // exercises for the open day-detail (for the repeat-set popup)

export function render(s){
 const H=s.heatmap||{weeks:[],months:[]};
 const HC=['#2a313a','#0e4429','#006d32','#26a641','#39d353']; // [0]=empty (visible vs the card bg)
 const monthRow=(H.months||[]).map(m=>'<div class=hm>'+m+'</div>').join('');
 const grid=(H.weeks||[]).map(col=>'<div class=hcol>'+col.map(d=>{
   const bg=d.level<0?'transparent':HC[d.level];
   const out=d.today?';outline:1.5px solid #e8eaed;outline-offset:-1px':'';
   const click=d.level>=0?' data-date="'+d.date+'"':'';
   const cur=d.level>=0?';cursor:pointer':'';
   return '<div class=hcell'+click+' title="'+d.date+': '+d.count+' set'+(d.count===1?'':'s')+'" style="background:'+bg+out+cur+'"></div>';
 }).join('')+'</div>').join('');
 const dowLabels=['','Mon','','Wed','','Fri',''].map(x=>'<div class=hd>'+x+'</div>').join('');
 const hw=document.getElementById('heatwrap'); if(!hw)return;
 hw.innerHTML=
  '<div class=hmonths>'+monthRow+'</div>'+
  '<div class=hbody><div class=hdows>'+dowLabels+'</div><div class=heat>'+grid+'</div></div>';
 if(heatSelDate){ markHeatCell(heatSelDate); if(heatSelDate===s.today)loadHeatDay(heatSelDate); } // live-refresh today's sets
 else if(s.today)selectDay(s.today);      // default the day detail to today's sets
 tickRest();
}
// Two live clocks driven off the set log, both counting up:
//  - SINCE LAST SET (left, always): time since the LAST set. mm:ss when recent, then coarse (Hh Mm /
//    Dd Hh). Green while active, amber past 5 min, dimmed once the session is over.
//  - SESSION (right, only while active): total time since the FIRST set of the current session — a run
//    of sets each within 20min of the previous. Once 20min pass with no new set the session is over and
//    this side disappears (resets to zero); the next set starts a fresh session.
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
function tickRest(){
 const el=document.getElementById('resttimer'); if(!el)return;
 const d=state.last||{}, lastAt=d.last_set_at;
 if(!lastAt){el.innerHTML='';el.className='resttimer';return;}
 const now=Date.now();
 const rest=Math.max(0,(now-new Date(lastAt).getTime())/1000);   // seconds since the last set
 const active=rest<=SESSION_GAP_S;
 el.className='resttimer'+(!active?' stale':(rest>=300?' cool':''));
 // left — since last set (always)
 let html='<div class="rt-side rt-left"><div class=rt-label>Since last set</div>'+
   '<div class=rt-time>'+fmtSince(rest)+'</div></div>';
 // right — session total (only while a session is live)
 if(active){
   const startAt=d.session_start_at||lastAt;
   const sess=Math.max(0,(now-new Date(startAt).getTime())/1000);
   html+='<div class="rt-side rt-right"><div class=rt-label>Session</div>'+
     '<div class="rt-time rt-session">'+fmtSession(sess)+'</div></div>';
 }
 el.innerHTML=html;
}

function markHeatCell(date){
 document.querySelectorAll('#heatwrap .hcell').forEach(c=>c.classList.toggle('hsel',c.dataset.date===date));
}
async function loadHeatDay(date){
 const tok=++heatReq;
 let j; try{ j=await (await fetch('/api/workout-day?date='+date)).json(); }catch(_){ return; }
 if(tok!==heatReq)return; // a newer cell was selected mid-flight — drop this stale response
 const hi=document.getElementById('heatinfo');
 const sp=hi.closest('.detailpanel'), stick=sp&&(sp.scrollHeight-sp.scrollTop-sp.clientHeight<60); // keep pinned to newest if already at bottom
 if(!j.exercises||!j.exercises.length){ hi.innerHTML='<div class=heath>'+date+'</div><div class=bi-none>No sets logged</div>'; lastHeatExercises=null; return; }
 lastHeatExercises=j.exercises;
 let h='<div class=heath>'+date+' · '+j.total+' sets</div>';
 j.exercises.forEach((ex,i)=>{
  h+='<div class=dex><div class=wk-exhead><div class=dex-n>'+esc(ex.name)+'</div>'+
     '<button class="addbtn wk-rep" type=button data-rep="'+i+'" title="Log another set (same weight)">+</button></div>'+
     '<div class=dex-sets>'+ex.sets.map(st=>'<span class="dset wk-set" data-set="'+st.id+'" data-w="'+st.weight_lbs+'" data-r="'+st.reps+'" title="Tap to edit">'+(st.weight_lbs===0?'BW':(st.weight_lbs+' lb'))+' × '+st.reps+'</span>').join('')+'</div></div>';
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
   const r=await fetch('/api/log-set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exercise:ex.name,weight_lbs:w,reps})});
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

(function(){
 const wk=document.getElementById('workouts'); let scrub=false;
 if(!wk)return; // page without the workout card (e.g. /page after consolidation) — nothing to bind
 const cellAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.hcell'):null;};
 wk.addEventListener('pointerdown',e=>{const c=e.target.closest('.hcell');if(!c||!c.dataset.date)return;scrub=true;selectDay(c.dataset.date);e.preventDefault();e.stopPropagation();/* don't let it become a card-drag */});
 document.addEventListener('pointermove',e=>{if(!scrub)return;const c=cellAt(e.clientX,e.clientY);if(c&&c.dataset.date)selectDay(c.dataset.date);});
 document.addEventListener('pointerup',()=>{scrub=false;});
 // day detail: tap a set to edit it; "+ set" button to repeat the last set
 document.getElementById('heatinfo').addEventListener('click',e=>{
  const setEl=e.target.closest('[data-set]');
  if(setEl){ e.stopPropagation();
   const dex=setEl.closest('.dex'); const name=dex?dex.querySelector('.dex-n').textContent:'Set';
   openSetEditor(setEl.dataset.set,name,setEl.dataset.w,setEl.dataset.r); return; }
  const btn=e.target.closest('[data-rep]'); if(!btn)return;
  e.stopPropagation();
  const ex=lastHeatExercises&&lastHeatExercises[+btn.dataset.rep];
  if(ex)openRepModal(ex);
 });
 setInterval(tickRest,1000); // live rest clock
})();
