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
 document.getElementById('heatwrap').innerHTML=
  '<div class=hmonths>'+monthRow+'</div>'+
  '<div class=hbody><div class=hdows>'+dowLabels+'</div><div class=heat>'+grid+'</div></div>';
 if(heatSelDate){ markHeatCell(heatSelDate); if(heatSelDate===s.today)loadHeatDay(heatSelDate); } // live-refresh today's sets
 else if(s.today)selectDay(s.today);      // default the day detail to today's sets
 tickRest();
}
// rest timer — a prominent live clock counting up from the last logged set. While resting it ticks
// mm:ss in big green digits (the between-sets feature); once it's clearly not an active rest it
// shows a coarse "since last set" readout, dimmed. Always visible.
function tickRest(){
 const el=document.getElementById('resttimer'); if(!el)return;
 const t=state.last&&state.last.last_set_at;
 if(!t){el.innerHTML='';el.className='resttimer';return;}
 const s=Math.max(0,(Date.now()-new Date(t).getTime())/1000);
 let label,time,cls='resttimer';
 if(s<3600){
   label='Rest'; time=Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
   if(s>=300)cls+=' cool';          // past 5 min: amber, likely between exercises / winding down
 } else if(s<86400){
   label='Since last set'; time=Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; cls+=' stale';
 } else {
   label='Since last set'; time=Math.floor(s/86400)+'d '+Math.floor((s%86400)/3600)+'h'; cls+=' stale';
 }
 el.className=cls;
 el.innerHTML='<div class=rt-label>'+label+'</div><div class=rt-time>'+time+'</div>';
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
     '<button class="addbtn wk-rep" type=button data-rep="'+i+'" title="Repeat last set (same weight)">+ set</button></div>'+
     '<div class=dex-sets>'+ex.sets.map(st=>'<span class=dset>'+(st.weight_lbs===0?'BW':(st.weight_lbs+' lb'))+' × '+st.reps+'</span>').join('')+'</div></div>';
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

(function(){
 const wk=document.getElementById('workouts'); let scrub=false;
 const cellAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.hcell'):null;};
 wk.addEventListener('pointerdown',e=>{const c=e.target.closest('.hcell');if(!c||!c.dataset.date)return;scrub=true;selectDay(c.dataset.date);e.preventDefault();e.stopPropagation();/* don't let it become a card-drag */});
 document.addEventListener('pointermove',e=>{if(!scrub)return;const c=cellAt(e.clientX,e.clientY);if(c&&c.dataset.date)selectDay(c.dataset.date);});
 document.addEventListener('pointerup',()=>{scrub=false;});
 // repeat-set button in the day detail
 document.getElementById('heatinfo').addEventListener('click',e=>{
  const btn=e.target.closest('[data-rep]'); if(!btn)return;
  e.stopPropagation();
  const ex=lastHeatExercises&&lastHeatExercises[+btn.dataset.rep];
  if(ex)openRepModal(ex);
 });
 setInterval(tickRest,1000); // live rest clock
})();
