// Nutrition Log card: combined dual-axis calorie+weight plot (weekly game) + calorie-adherence
// calendar (daily game), with inline day detail + click/drag-scrub selection. Every entry row
// expands to its ingredient breakdown + actions (log-again / change-quantity / delete).
import { esc, dualPlot, state, localNowNaive } from '../shared.js';

const CAL_COLOR='#3b82f6', W_COLOR='#a78bfa';
let nutSelDate=null, nutReq=0;
let lastDayEntries=null, lastDayDate=null; // last day-detail loaded (for add-popup lookups)
const expandedIds=new Set(); // entry ids whose ingredient breakdown is open — persists across SSE re-renders until closed by hand

export function render(s){
 // Shorter calendar on the home wall (it shares its column with the muscle map); see workouts.js.
 const N=s.nutrition_log&&Object.assign({},s.nutrition_log,
   document.body.classList.contains('homewall')&&s.nutrition_log_home||{});
 // Desktop renders heatmap+plot together into #nutwrap. The TV wall splits them so the food
 // list can sit BETWEEN them: heatmap → #nutheat (top), plot → #nutplot (bottom).
 const wrap=document.getElementById('nutwrap');
 const heatEl=document.getElementById('nutheat');
 const plotEl=document.getElementById('nutplot');
 if(!N){ if(wrap)wrap.innerHTML=''; if(heatEl)heatEl.innerHTML=''; if(plotEl)plotEl.innerHTML=''; return; }
 // COMBINED PLOT: smoothed 7d cal avg (left axis) + raw daily weight (right axis) + maintenance ref line.
 const calPts=(N.cal_series||[]).map(p=>({date:p.date,v:p.avg}));
 const wPts=(N.weight_series||[]).map(p=>({date:p.date,v:p.w}));
 const maint=isFinite(N.maintenance)?N.maintenance:undefined;
 const goal=isFinite(N.goal)?N.goal:undefined;
 const maintPts=(N.maint_series||[]).map(p=>({date:p.date,v:p.v}));
 const goalPts=(N.goal_series||[]).map(p=>({date:p.date,v:p.v}));
 const plot=dualPlot(calPts,wPts,maintPts,goalPts);
 // legend + current-value annotations at the right edge
 const calAnno=N.cal_avg7!=null?'<b style="color:'+CAL_COLOR+'">'+N.cal_avg7+'</b> kcal':'';
 let wAnno='';
 if(N.weight_now!=null){
  let sl=''; if(N.weight_slope_wk!=null)sl=' <span class=nplot-sl>('+(N.weight_slope_wk>0?'+':'')+N.weight_slope_wk+'/wk)</span>';
  wAnno='<b style="color:'+W_COLOR+'">'+N.weight_now+'</b>'+sl;
 }
 const legend='<div class=nplot-leg>'+
   '<span class=nplot-key><i style="background:'+CAL_COLOR+'"></i>kcal · 7d avg'+(calAnno?' '+calAnno:'')+'</span>'+
   (maint!==undefined?'<span class=nplot-key><i class=nplot-dash></i>maintenance '+Math.round(maint)+'</span>':'')+
   (goal!==undefined?'<span class=nplot-key><i class=nplot-dash style="border-top-color:#22c55e"></i>target '+Math.round(goal)+(maint!==undefined?' <span class=nplot-sl>(+'+Math.round(goal-maint)+')</span>':'')+'</span>':'')+
   '<span class=nplot-key><i style="background:'+W_COLOR+'"></i>weight'+(wAnno?' '+wAnno:'')+'</span>'+
   '</div>';
 const plotBlock='<div class=nplot-block>'+plot+legend+'</div>';
 // CALORIE-ADHERENCE CALENDAR (reuse heatmap layout/classes); color = intake/target ratio (diverging)
 const monthRow=(N.months||[]).map(m=>'<div class=hm>'+m+'</div>').join('');
 const grid=(N.weeks||[]).map(col=>'<div class=hcol>'+col.map(d=>{
   const bg=d.has?d.color:'#000';   // no intake logged that day → black
   const out=d.today?';outline:1.5px solid #e8eaed;outline-offset:-1px':'';
   const cur=d.has?';cursor:pointer':'';
   const data=d.has?' data-ndate="'+d.date+'"':'';
   const title=d.has?d.date+': '+Math.round(d.ratio*100)+'% of target':d.date;
   return '<div class=hcell'+data+' title="'+title+'" style="background:'+bg+out+cur+'"></div>';
 }).join('')+'</div>').join('');
 const dowLabels=['','Mon','','Wed','','Fri',''].map(x=>'<div class=hd>'+x+'</div>').join('');
 const heatHtml=
  '<div class=hmonths>'+monthRow+'</div>'+
  '<div class=hbody><div class=hdows>'+dowLabels+'</div><div class=heat>'+grid+'</div></div>';
 // Each panel paints if the page has it, so a surface can take the heatmap alone — the home wall
 // shows it with no plot and no food list. #nutwrap is the desktop's combined fallback.
 if(heatEl)heatEl.innerHTML=heatHtml;
 if(plotEl)plotEl.innerHTML=plotBlock;
 if(!heatEl&&!plotEl&&wrap)wrap.innerHTML=heatHtml+plotBlock;
 if(nutSelDate){ markNutCell(nutSelDate); if(nutSelDate===s.today)loadNutDay(nutSelDate); } // live-refresh today's log
 else if(s.today)selectNutDay(s.today); // default the detail panel to today's log on first load
}

function markNutCell(date){
 document.querySelectorAll('#nutwrap .hcell, #nutheat .hcell').forEach(c=>c.classList.toggle('nsel',c.dataset.ndate===date));
}
// 12-hour wall-clock time from a naive-local occurred_at ("...T14:07..." → "2:07 PM").
function fmtTime(occurred){
 const m=String(occurred).match(/T(\d{2}):(\d{2})/); if(!m)return '';
 let h=+m[1]; const ap=h<12?'AM':'PM'; h=h%12||12;
 return h+':'+m[2]+' '+ap;
}
const mn=v=>Math.round(Number(v)||0); // macro number, rounded
// Macro chips for an entry/total: cal + P/C/F. `cls` lets the day header use a bolder style.
function macroChips(o){
 return '<span class=dset>'+mn(o.calories)+' kcal</span>'+
   '<span class=dset>'+mn(o.protein_g)+'g P</span>'+
   '<span class=dset>'+mn(o.carbs_g)+'g C</span>'+
   '<span class=dset>'+mn(o.fat_g)+'g F</span>';
}
async function loadNutDay(date){
 const tok=++nutReq;
 let j; try{ j=await (await fetch('/api/nutrition-day?date='+date)).json(); }catch(_){ return; }
 if(tok!==nutReq)return; // a newer cell was selected mid-flight — drop this stale response
 const ni=document.getElementById('nutinfo'); if(!ni)return;   // page without the nutrition log card
 const sp=ni.closest('.detailpanel'), atTop=!sp||sp.scrollTop<60; // newest entries render on top now
 // Selected-day summary band — compact one-liner: DOW + date, then measured/goal for cal + each
 // macro, using THIS day's own stored targets (each day has its own dynamic goal + bodyweight macros).
 const dt=new Date(date+'T12:00:00');
 const DOW=['SU','M','TU','W','TH','F','SA'][dt.getDay()];
 const dshort=(dt.getMonth()+1)+'/'+dt.getDate();
 const dayband=(inner)=>'<div class=nutday><span class=nd-date>'+DOW+' '+dshort+'</span>'+inner+'</div>';
 // `data-band` asks for the summary line ONLY — the wall wants the day's totals under its heatmap,
 // not an entry list it has no room for and nobody can tap.
 const bandOnly=ni.dataset.band!==undefined;
 if(!j.entries||!j.entries.length){ ni.innerHTML=dayband('')+(bandOnly?'':'<div class=bi-none>No food logged</div>'); return; }
 const tm=j.target_macros||{};
 const seg=(v,goal,lbl)=>'<span class=nd-seg><b>'+v+'</b>'+(goal!=null?'<span class=nd-goal>/'+goal+'</span>':'')+' '+lbl+'</span>';
 let h=dayband(
   seg(j.total_cal, j.target_cal>0?j.target_cal:null, 'cal')+
   seg(mn(j.total_protein), tm.protein_g!=null?tm.protein_g:null, 'P')+
   seg(mn(j.total_carbs), tm.carbs_g!=null?tm.carbs_g:null, 'C')+
   seg(mn(j.total_fat), tm.fat_g!=null?tm.fat_g:null, 'F'));
 if(bandOnly){
  ni.innerHTML=h;
  // The last thing ADDED to the log, into its own element when a surface has one — staged or eaten,
  // whichever row was written most recently. The server picks it (`recent`), because entries[0] is
  // not it either way round: staged rows sort above the committed ones regardless of age.
  const nr=document.getElementById('nutrecent');
  if(nr){
   const e=j.recent;
   // Not macroChips: those bake the value and its unit into one string inside a pill. Here they are
   // separate spans so a surface can weight the number and the unit differently, and the time is not
   // one of them — it says WHEN, not what, so it sits with the name rather than among the macros.
   // Wrapped as one span per reading: the row's gap separates READINGS, so leaving the value and its
   // unit as loose siblings put that same gap between "719" and "kcal" and broke the pair apart.
   const val=(v,u,cls)=>'<span class=rc-set><span class=rc-v>'+v+'</span><span class='+(cls||'rc-u')+'>'+u+'</span></span>';
   // P/C/F are marked differently from kcal on purpose. `kcal` is the UNIT of the number before it
   // and can be inferred; the letters say WHICH macro a number is, so they have to be read, and on a
   // wall that means they cannot be the faintest thing in the row. The grams are dropped — every one
   // of these three is in grams, so the g was three characters saying nothing.
   const macro=(v,l)=>val(v,l,'rc-m');
   // A staged row's occurred_at is when it was STAGED, not when it will be eaten, so the time slot
   // says STAGED instead — the same word the entry list marks those rows with. It takes the slot
   // rather than sitting beside a time, because a staged meal has no eating time to print.
   const when=e&&e.staged
    ?'<span class="rc-when rc-staged">STAGED</span>'
    :(e&&fmtTime(e.occurred_at)?'<span class=rc-when>'+fmtTime(e.occurred_at)+'</span>':'');
   nr.innerHTML=e
    ?'<div class=rc-top><span class=rc-name>'+esc(e.name||'—')+'</span>'+when+'</div>'+
     '<div class=rc-vals>'+val(mn(e.calories),'kcal')+macro(mn(e.protein_g),'P')+
       macro(mn(e.carbs_g),'C')+macro(mn(e.fat_g),'F')+'</div>'
    :'';
  }
  return;
 }
 j.entries.forEach((e,i)=>{
  const t=fmtTime(e.occurred_at);
  const ings=Array.isArray(e.ingredients)?e.ingredients:null;
  // EVERY entry expands — the expansion holds the ingredient breakdown (multi-ingredient meals only)
  // plus the row's actions (log-again / change-quantity / delete), so the collapsed rows stay clean.
  const open=expandedIds.has(e.id); // keep this entry expanded across re-renders if the user opened it
  const staged=!!e.staged;
  h+='<div class="dex dex-exp'+(staged?' dex-staged':'')+'" data-idx="'+i+'">'+
     '<div class="dex-head" data-toggle="'+i+'">'+
       '<div class=dex-n><span class=dex-caret>'+(open?'▾':'▸')+'</span>'+esc(e.name||'—')+(staged?' <span class=stagedbadge>STAGED</span>':'')+'</div>'+
       '<div class=dex-macros>'+macroChips(e)+((!staged&&t)?'<span class=dset>'+t+'</span>':'')+
         (staged?'<button class="addbtn commitbtn" type=button data-commit-entry="'+i+'" title="Commit — log as eaten now">commit</button>':'')+
       '</div>'+
     '</div>';
  h+='<div class="dex-ings'+(open?'':' hidden')+'" id="ding-'+i+'">'+
     (ings&&ings.length>1?ings.map((g,gi)=>
       '<div class=ding><span class=ding-n>'+esc(ingLabel(g))+'</span>'+macroChips(g)+
         (staged?'':'<button class=addbtn type=button data-add-ing="'+i+'.'+gi+'" title="Add at now">+ now</button>')+
       '</div>').join(''):'')+
     '<div class=dact>'+
       (staged?'':'<button class=dact-btn type=button data-add-entry="'+i+'" title="Log again now">+</button>')+
       '<button class=dact-btn type=button data-edit-entry="'+i+'" title="Change quantity">±</button>'+
       '<button class="dact-btn dact-del" type=button data-del-entry="'+i+'" title="Delete">✕</button>'+
     '</div>'+
   '</div>';
  h+='</div>';
 });
 ni.innerHTML=h;
 if(sp&&atTop)sp.scrollTop=0; // newest is on top — keep it in view
 lastDayEntries=j.entries; lastDayDate=date; // cache for the add-popup lookups
}
function selectNutDay(date){ if(date===nutSelDate)return; nutSelDate=date; markNutCell(date); loadNutDay(date); }

(function(){
 const nl=document.getElementById('nutritionlog'); let scrub=false;
 if(!nl)return; // page without the nutrition-log card (e.g. /page after consolidation) — nothing to bind
 const cellAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.hcell'):null;};
 nl.addEventListener('pointerdown',e=>{const c=e.target.closest('.hcell');if(!c||!c.dataset.ndate)return;scrub=true;selectNutDay(c.dataset.ndate);e.preventDefault();e.stopPropagation();});
 document.addEventListener('pointermove',e=>{if(!scrub)return;const c=cellAt(e.clientX,e.clientY);if(c&&c.dataset.ndate)selectNutDay(c.dataset.ndate);});
 document.addEventListener('pointerup',()=>{scrub=false;});
 // event-delegated clicks on the day-detail: expansion action row + ingredient expand/collapse
 document.getElementById('nutinfo').addEventListener('click',e=>{
  const editE=e.target.closest('[data-edit-entry]');
  if(editE){ e.stopPropagation(); const en=entryAt(+editE.dataset.editEntry); if(en)openAddPopup(en,{mode:'edit',id:en.id}); return; }
  const delE=e.target.closest('[data-del-entry]');
  if(delE){ e.stopPropagation(); confirmDelete(entryAt(+delE.dataset.delEntry)); return; }
  const commitE=e.target.closest('[data-commit-entry]');
  if(commitE){ e.stopPropagation(); const en=entryAt(+commitE.dataset.commitEntry); if(en&&en.id)commitStaged(en); return; }
  const addE=e.target.closest('[data-add-entry]');
  if(addE){ e.stopPropagation(); openAddPopup(entryAt(+addE.dataset.addEntry)); return; }
  const addI=e.target.closest('[data-add-ing]');
  if(addI){ e.stopPropagation(); const[ei,gi]=addI.dataset.addIng.split('.').map(Number);
   const en=entryAt(ei); const g=en&&en.ingredients&&en.ingredients[gi];
   if(g)openAddPopup({name:ingLabel(g),food:g.food,amount:g.amount,unit:g.unit,calories:g.calories,protein_g:g.protein_g,carbs_g:g.carbs_g,fat_g:g.fat_g});
   return; }
  const head=e.target.closest('.dex-head[data-toggle]'); if(!head)return;
  const i=head.dataset.toggle, box=document.getElementById('ding-'+i);
  if(!box)return; const nowHidden=box.classList.toggle('hidden');
  const en=entryAt(+i); if(en)nowHidden?expandedIds.delete(en.id):expandedIds.add(en.id); // remember so re-renders don't collapse it
  const car=head.querySelector('.dex-caret'); if(car)car.textContent=nowHidden?'▸':'▾';
 });
})();

function entryAt(i){ return lastDayEntries&&lastDayEntries[i]?lastDayEntries[i]:null; }

// Commit a staged meal — logs it as eaten now, after a confirmation step. Realtime re-pushes the
// dashboard; we also reload the open day so the change shows immediately.
async function commitStaged(en){
 if(!en||!en.id)return;
 const cal=en.calories!=null?' ('+Math.round(en.calories)+' cal)':'';
 if(!window.confirm('Commit "'+(en.name||'this meal')+'"'+cal+'?\nIt will be logged as eaten now and start counting toward today.'))return;
 try{
  const r=await fetch('/api/commit-staged',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:en.id,client_now:localNowNaive()})});
  if(!r.ok)throw new Error(r.status);
  if(lastDayDate)loadNutDay(lastDayDate);
 }catch(_){ /* realtime will reconcile */ }
}

async function confirmDelete(en){
 if(!en||!en.id)return;
 if(!window.confirm('Delete this entry?'))return;
 try{
  const r=await fetch('/api/log-entry?id='+encodeURIComponent(en.id),{method:'DELETE'});
  if(!r.ok)throw new Error(r.status);
  if(lastDayDate)loadNutDay(lastDayDate); // re-fetch the open day so the change shows
 }catch(_){ /* leave the row; realtime will reconcile if it did delete */ }
}

// strip a trailing " (N×)" portion suffix → {base name, mult}. Names are kept plain now (a suffix is
// never added), but this still self-heals any legacy "(N×)" name on open: the stored macros/amounts
// are divided back to a 1× reference, and saving re-writes the name without the suffix.
function splitPortion(name){
 const m=String(name||'').match(/^(.*?)\s*\((\d+(?:\.\d+)?)×\)\s*$/);
 if(m&&+m[2]>0)return {base:m[1].trim(),mult:+m[2]};
 return {base:String(name||'').trim(),mult:1};
}
const fmtMult=v=>Number.isInteger(v)?String(v):String(Math.round(v*1000)/1000);
const round3=v=>Math.round((Number(v)||0)*1000)/1000;
function fmtAmt(n){ return String(round3(n)); }
const GRAM_UNITS={g:1,gram:1,grams:1,ml:1,milliliter:1,milliliters:1};
function stepFor(unit){ return GRAM_UNITS[String(unit||'').toLowerCase()]?5:0.25; }
function ingStructured(g){ return !!(g&&g.amount!=null&&isFinite(Number(g.amount))&&(g.unit!=null||g.food!=null)); }
// display label: structured → "1 cup rolled oats" / "0.5 banana"; legacy → its stored name text.
function ingLabel(g){ if(ingStructured(g)){ const un=String(g.unit||'').trim(); return fmtAmt(g.amount)+(un?' '+un:'')+' '+(g.food||g.name||''); } return g.name||g.ingredient||'—'; }

// ---- portion-multiplier popup ----
// Both modes show an overall Portion stepper PLUS, when the dish has ingredients, a per-ingredient
// stepper + ✕ toggle. Add mode (default) POSTs a NEW row at now (✕ = leave it out of the new row);
// edit mode (opts={mode:'edit',id}) PATCHes the existing row in place (✕ = remove it from the meal).
// The meal total is always the sum of the included, scaled ingredients when ingredients exist.
// `base` = {name,calories,protein_g,carbs_g,fat_g, ingredients?}.
function openAddPopup(base,opts){
 if(!base)return;
 const edit=opts&&opts.mode==='edit';
 const editId=edit?opts.id:null;
 const sp=splitPortion(base.name); const cleanName=sp.base, baseMult=sp.mult;
 const u=v=>(Number(v)||0)/baseMult;
 const unitBase={calories:u(base.calories),protein_g:u(base.protein_g),carbs_g:u(base.carbs_g),fat_g:u(base.fat_g)};
 const rawIngs=Array.isArray(base.ingredients)?base.ingredients:null;
 // 1× reference for each ingredient (divide out any meal-level suffix). Structured rows carry
 // food/amount/unit and are edited by AMOUNT; legacy rows (name only) keep a unitless multiplier.
 const ings=rawIngs?rawIngs.map(g=>({
   structured:ingStructured(g), food:g.food||'', unit:g.unit||'', name:g.name||g.ingredient||'—',
   A:ingStructured(g)?u(g.amount):0,
   calories:u(g.calories),protein_g:u(g.protein_g),carbs_g:u(g.carbs_g),fat_g:u(g.fat_g),
   // Produce rides along and scales with the portion exactly like the macros do. Dropping it here
   // would silently zero the day's produce totals on any portion edit or log-again.
   produce_type:g.produce_type||'', produce_g:u(g.produce_g)
 })):null;
 const perIng=!!ings&&ings.length>1;   // per-ingredient steppers only for true multi-ingredient meals; a single-ingredient food uses the simple Portion stepper
 // state: structured → amt (default = A×baseMult = the stored amount); legacy → imult; plus off.
 const st=ings?ings.map(g=>({ amt:g.structured?round3(g.A*baseMult):0, imult:1, off:false })):null;
 let mult=baseMult;
 const factor=i=>{ const g=ings[i],s=st[i]; if(g.structured)return g.A>0?s.amt/g.A:0; return mult*s.imult; };
 const ingOn=i=>!(st&&st[i].off);

 const back=document.createElement('div'); back.className='addmodal-back';
 back.innerHTML=
   '<div class=addmodal role=dialog aria-modal=true>'+
     '<div class=addmodal-name>'+esc(cleanName||'—')+'</div>'+
     '<div class=addmodal-mlabel>Portion</div>'+
     '<div class=addmodal-mult>'+
       '<button class=addmodal-step type=button data-step="-1">−</button>'+
       '<input class=addmodal-minput type=text inputmode=decimal value="1">'+
       '<button class=addmodal-step type=button data-step="1">+</button>'+
     '</div>'+
     '<div class=addmodal-macros></div>'+
     (ings&&ings.length>1?'<div class=addmodal-ings></div>':'')+
     '<div class=addmodal-btns>'+
       '<button class=addmodal-cancel type=button>Cancel</button>'+
       '<button class=addmodal-add type=button>'+(edit?'Save':'Add')+'</button>'+
     '</div>'+
   '</div>';
 document.body.appendChild(back);
 const input=back.querySelector('.addmodal-minput');
 const macrosEl=back.querySelector('.addmodal-macros');
 const ingsEl=back.querySelector('.addmodal-ings');
 const sc=v=>Math.round(Number(v)||0);
 const r1=v=>Math.round((Number(v)||0)*10)/10;

 if(ingsEl){
  ingsEl.innerHTML=ings.map((g,i)=>
   '<div class=aing data-i="'+i+'">'+
     '<div class=aing-top><span class=aing-n></span>'+
       (perIng?'<button class=aing-x type=button title="Don\'t add this">✕</button>':'')+'</div>'+
     '<div class=aing-ctl>'+
       (perIng?'<button class=aing-step type=button data-step="-1">−</button>'+
         '<input class=aing-input type=text inputmode=decimal>'+
         '<button class=aing-step type=button data-step="1">+</button>':'')+
       '<span class=aing-macros></span></div>'+
   '</div>').join('');
 }
 function rowLabel(i){ const g=ings[i],s=st[i];
   if(g.structured){ const un=String(g.unit||'').trim(); return fmtAmt(s.amt)+(un?' '+un:'')+' '+(g.food||g.name); }
   return g.name; }
 function paint(){
  let t;
  if(ings){ t={calories:0,protein_g:0,carbs_g:0,fat_g:0};
   ings.forEach((g,i)=>{ if(!ingOn(i))return; const f=factor(i); t.calories+=g.calories*f;t.protein_g+=g.protein_g*f;t.carbs_g+=g.carbs_g*f;t.fat_g+=g.fat_g*f; });
  } else t={calories:unitBase.calories*mult,protein_g:unitBase.protein_g*mult,carbs_g:unitBase.carbs_g*mult,fat_g:unitBase.fat_g*mult};
  macrosEl.innerHTML='<span class=dset>'+sc(t.calories)+' kcal</span>'+
    '<span class=dset>'+r1(t.protein_g)+'g P</span>'+
    '<span class=dset>'+r1(t.carbs_g)+'g C</span>'+
    '<span class=dset>'+r1(t.fat_g)+'g F</span>';
  if(ingsEl)ings.forEach((g,i)=>{ const row=ingsEl.querySelector('.aing[data-i="'+i+'"]'); if(!row)return;
   const on=ingOn(i), f=factor(i);
   row.classList.toggle('aing-off',!on);
   row.querySelector('.aing-n').textContent=rowLabel(i);
   row.querySelector('.aing-macros').textContent=sc(g.calories*f)+' kcal · '+r1(g.protein_g*f)+'P '+r1(g.carbs_g*f)+'C '+r1(g.fat_g*f)+'F';
   const x=row.querySelector('.aing-x'); if(x)x.textContent=on?'✕':'＋';
  });
 }
 function syncIngInputs(){ if(!perIng||!ingsEl)return; ings.forEach((g,i)=>{ const inp=ingsEl.querySelector('.aing[data-i="'+i+'"] .aing-input'); if(inp)inp.value=g.structured?fmtAmt(st[i].amt):fmtMult(st[i].imult); }); }
 function setMult(v){ mult=v>0?v:0; input.value=fmtMult(mult);
   if(st)ings.forEach((g,i)=>{ if(g.structured)st[i].amt=round3(g.A*mult); });
   syncIngInputs(); paint(); }
 setMult(baseMult);

 back.querySelectorAll('.addmodal-mult .addmodal-step').forEach(b=>b.addEventListener('click',()=>{
  const next=round3(mult+0.25*Number(b.dataset.step)); setMult(next<0?0:next);
 }));
 input.addEventListener('input',()=>{ const v=parseFloat(input.value); mult=isFinite(v)&&v>0?v:0;
   if(st)ings.forEach((g,i)=>{ if(g.structured)st[i].amt=round3(g.A*mult); }); syncIngInputs(); paint(); });

 if(perIng&&ingsEl){
  ingsEl.addEventListener('click',e=>{
   const row=e.target.closest('.aing'); if(!row)return; const i=+row.dataset.i; const g=ings[i];
   if(e.target.closest('.aing-x')){ st[i].off=!st[i].off; const inp=row.querySelector('.aing-input'); if(inp)inp.disabled=st[i].off; paint(); return; }
   const step=e.target.closest('.aing-step'); if(step){ const d=Number(step.dataset.step);
     if(g.structured){ const s=stepFor(g.unit); st[i].amt=round3(Math.max(0,st[i].amt+d*s)); }
     else { st[i].imult=round3(Math.max(0,st[i].imult+0.25*d)); }
     const inp=row.querySelector('.aing-input'); if(inp)inp.value=g.structured?fmtAmt(st[i].amt):fmtMult(st[i].imult); paint(); }
  });
  ingsEl.addEventListener('input',e=>{ const inp=e.target.closest('.aing-input'); if(!inp)return;
   const row=inp.closest('.aing'); const i=+row.dataset.i; const g=ings[i]; const v=parseFloat(inp.value);
   if(g.structured)st[i].amt=isFinite(v)&&v>=0?v:0; else st[i].imult=isFinite(v)&&v>=0?v:0; paint(); });
 }

 const close=()=>back.remove();
 back.addEventListener('click',e=>{ if(e.target===back)close(); });
 back.querySelector('.addmodal-cancel').addEventListener('click',close);
 const addBtn=back.querySelector('.addmodal-add');
 addBtn.addEventListener('click',async()=>{
  if(!(mult>0)){ input.focus(); return; }
  let t; if(ings){ t={calories:0,protein_g:0,carbs_g:0,fat_g:0}; ings.forEach((g,i)=>{ if(!ingOn(i))return; const f=factor(i); t.calories+=g.calories*f;t.protein_g+=g.protein_g*f;t.carbs_g+=g.carbs_g*f;t.fat_g+=g.fat_g*f; }); }
  else t={calories:unitBase.calories*mult,protein_g:unitBase.protein_g*mult,carbs_g:unitBase.carbs_g*mult,fat_g:unitBase.fat_g*mult};
  // Names stay plain — portion is reflected in the scaled macros/ingredients, never a "(N×)" suffix.
  const body={ name:cleanName||'—', calories:sc(t.calories), protein_g:r1(t.protein_g), carbs_g:r1(t.carbs_g), fat_g:r1(t.fat_g) };
  if(ings){ body.ingredients=ings.map((g,i)=>({g:g,i:i})).filter(o=>ingOn(o.i)).map(function(o){ const g=o.g,i=o.i,f=factor(i);
    const ob={ calories:sc(g.calories*f), protein_g:r1(g.protein_g*f), carbs_g:r1(g.carbs_g*f), fat_g:r1(g.fat_g*f) };
    if(g.produce_type&&g.produce_g>0){ ob.produce_type=g.produce_type; ob.produce_g=r1(g.produce_g*f); }
    if(g.structured){ ob.food=g.food; ob.unit=g.unit; ob.amount=round3(st[i].amt); ob.name=rowLabel(i); }
    else ob.name=g.name;
    return ob; }); }
  addBtn.disabled=true; addBtn.textContent=edit?'Saving…':'Adding…';
  try{
   let r;
   if(edit) r=await fetch('/api/log-entry',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({id:editId},body))});
   else r=await fetch('/api/log-entry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({client_now:localNowNaive()},body))});
   if(!r.ok)throw new Error(r.status);
   close();
   const today=state.last&&state.last.today;
   if(edit){ if(lastDayDate)loadNutDay(lastDayDate); }
   else if(today&&lastDayDate===today)loadNutDay(today);
  }catch(_){ addBtn.disabled=false; addBtn.textContent='Retry'; }
 });
}
