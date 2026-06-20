// Workout Volume card: GitHub-style heatmap with inline day detail + click/drag-scrub selection,
// defaulting to today; plus a rest timer (time since last set, hidden once past 5 min).
import { state } from '../shared.js';
let heatSelDate=null, heatReq=0;

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
// rest timer: minutes:seconds since the last logged set; only shown while < 5 min (i.e. mid-workout)
function tickRest(){
 const el=document.getElementById('resttimer'); if(!el)return;
 const t=state.last&&state.last.last_set_at;
 if(!t){el.textContent='';return;}
 const elapsed=(Date.now()-new Date(t).getTime())/1000;
 if(!(elapsed>=0&&elapsed<300)){el.textContent='';return;}
 el.textContent='rest '+Math.floor(elapsed/60)+':'+String(Math.floor(elapsed%60)).padStart(2,'0');
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
 if(!j.exercises||!j.exercises.length){ hi.innerHTML='<div class=heath>'+date+'</div><div class=bi-none>No sets logged</div>'; return; }
 let h='<div class=heath>'+date+' · '+j.total+' sets</div>';
 for(const ex of j.exercises){ h+='<div class=dex><div class=dex-n>'+ex.name+'</div>'+ex.sets.map(st=>'<span class=dset>'+(st.weight_lbs===0?'BW':(st.weight_lbs+' lb'))+' × '+st.reps+'</span>').join('')+'</div>'; }
 hi.innerHTML=h;
 if(sp&&stick)sp.scrollTop=sp.scrollHeight; // scroll to the newest set
}
function selectDay(date){ if(date===heatSelDate)return; heatSelDate=date; markHeatCell(date); loadHeatDay(date); }

(function(){
 const wk=document.getElementById('workouts'); let scrub=false;
 const cellAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.hcell'):null;};
 wk.addEventListener('pointerdown',e=>{const c=e.target.closest('.hcell');if(!c||!c.dataset.date)return;scrub=true;selectDay(c.dataset.date);e.preventDefault();e.stopPropagation();/* don't let it become a card-drag */});
 document.addEventListener('pointermove',e=>{if(!scrub)return;const c=cellAt(e.clientX,e.clientY);if(c&&c.dataset.date)selectDay(c.dataset.date);});
 document.addEventListener('pointerup',()=>{scrub=false;});
 setInterval(tickRest,1000); // live rest clock
})();
