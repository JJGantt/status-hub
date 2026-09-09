// Muscle Map + Muscle Volume cards and the shared selection interaction binding them together:
// hover previews (desktop), click pins, muscles ⇄ exercises cross-link, variant YouTube links,
// and the #bodyinfo detail (a fixed bottom sheet on mobile).
import { state, TOUCH, esc } from '../shared.js';

// On the TV wall, abbreviate the qualifier word so labels read BIG without getting wider:
// "Lower back"→"L. back", "Side delts"→"S. delts", "Triceps (long)"→"Tri. long". Single words unchanged.
const TV = document.body.classList.contains('tv');

// Recovery tint on the muscle label by when it was last worked (server `recency`): TODAY = amber (freshly
// fatigued), YESTERDAY = gold (recovering), older/untouched → no tint = default gray (recovered, ready to
// train). A separate visual channel from the bar's volume color, so low-bar + plain-gray = behind and ready.
const RECENCY_TINT = { today: '#f2a13d', yesterday: '#c9a06a' };
function shortLabel(label) {
  const paren = label.match(/^(\w+)\s*\(([^)]+)\)$/);
  if (paren) return paren[1].slice(0, 3) + '. ' + paren[2];          // Triceps (long) → Tri. long
  const m = label.match(/^(\w+)[\s-](.+)$/);
  return m ? m[1][0].toUpperCase() + '. ' + m[2] : label;           // Lower back → L. back; Mid-back → M. back
}

const MUSCLE_NAMES={
 quads:['Quads','Quadriceps'],hamstrings:['Hamstrings','Hamstrings'],glutes:['Glutes','Gluteals'],
 adductors:['Inner thigh','Adductors'],hip_flexors:['Hip flexors','Iliopsoas'],gastrocnemius:['Calves','Gastrocnemius'],
 upper_chest:['Upper chest','Clavicular pec'],lower_chest:['Lower chest','Sternal pec'],
 front_delts:['Front shoulder','Anterior deltoid'],side_delts:['Side shoulder','Lateral deltoid'],
 triceps_long:['Triceps (long head)','Triceps long head'],triceps_lateral:['Triceps (outer head)','Triceps lateral head'],
 lats:['Lats','Latissimus dorsi'],upper_traps:['Traps','Upper trapezius'],mid_back:['Mid-back','Rhomboids & mid/lower traps'],
 rear_delts:['Rear shoulder','Posterior deltoid'],biceps:['Biceps','Biceps brachii'],forearms:['Forearms','Forearm flexors/extensors'],
 abs:['Abs','Rectus abdominis'],obliques:['Obliques','Obliques'],erectors:['Lower back','Erector spinae']};

// Map a vulovix body-map region id → one of our tracked muscles.
function muscleForId(id){
 if(id.indexOf('delt-front')===0)return'front_delts';   // inner lobe of the cap
 if(id.indexOf('delt-side')===0)return'side_delts';     // outer lobe of the cap
 if(id.indexOf('shoulder-front')===0)return'upper_traps'; // high sliver by the neck/clavicle
 if(id.indexOf('deltoid-rear')===0)return'side_delts'; // the tiny lateral-edge sliver on the back = side delt wrap
 if(id.indexOf('biceps')===0)return'biceps';
 if(id.indexOf('forearm')===0)return'forearms';
 if(id.indexOf('chest-upper')===0)return'upper_chest';
 if(id.indexOf('chest-lower')===0)return'lower_chest';
 if(id.indexOf('abs-upper')===0)return'obliques'; // asset's "abs-upper" is actually the side flanks = obliques
 if(id.indexOf('abs-')===0)return'abs';            // abs-lower = central lower rectus
 if(id.indexOf('obliques')===0)return'abs';        // asset's "obliques" id is the central six-pack = rectus abdominis
 if(id.indexOf('serratus')===0)return'abs';        // serratus lumped into abs (no dedicated exercise tracked)
 if(id.indexOf('traps-upper')===0)return'upper_traps';
 if(id.indexOf('traps-mid')===0||id.indexOf('traps-lower')===0)return'mid_back';
 if(id.indexOf('lats-upper')===0)return'rear_delts'; // the big upper-back chevron = rear delts
 if(id.indexOf('lats-')===0)return'lats';
 if(id.indexOf('triceps-long')===0)return'triceps_long';
 if(id.indexOf('triceps-lateral')===0)return'triceps_lateral';
 if(id.indexOf('triceps-front')===0)return'triceps_lateral'; // outer sliver of the front upper arm (split off biceps)
 if(id.indexOf('quads')===0)return'quads';
 if(id.indexOf('gluteus')===0)return'glutes';
 if(id.indexOf('calves')===0)return'gastrocnemius';
 if(id.indexOf('tibialis')===0)return'gastrocnemius';
 if(id.indexOf('hamstrings')===0)return'hamstrings';
 if(id.indexOf('lower-back')===0)return'erectors';
 if(id.indexOf('adductors')===0)return'adductors';
 if(id.indexOf('hip-flexor')===0)return'hip_flexors';
 return null;
}

let SEL=null; // {kind:'muscle'|'exercise', key}
let VOLSORT=localStorage.getItem('volsort')||'need';

// Slug → the muscle's row off the volume payload (label, weekly sets, target, colour). The groups
// are the shipped shape; this is the index into them.
function volIndex(){const ix={};((state.last&&state.last.volume&&state.last.volume.groups)||[]).forEach(g=>g.muscles.forEach(m=>ix[m.muscle]=m));return ix;}
// The muscles an exercise trains, each carrying its WEEKLY set count in that muscle's own volume
// colour — the home wall's stand-in for the volume bars it has no room for, drawn beside the last
// exercise logged. Primary movers read full-strength, synergists dimmed, in the payload's own
// contribution order. Colour is the server's `volColor` of sets/target, so a number here and the
// same muscle on the body map beside it are the same green.
export function exerciseVolumeChips(name){
 const ix=volIndex(), list=exMuscleList(name);
 if(!list.length)return '';
 return '<span class=rc-mus>'+list.map(e=>{const m=ix[e.muscle]; if(!m)return '';
  return '<span class="rc-m-i'+(e.contribution>=1?'':' sec')+'" style="color:'+m.color+'">'+
   '<span class=rc-m-lab>'+esc(TV?shortLabel(m.label):m.label)+'</span>'+
   '<span class=rc-m-n>'+m.sets+'</span></span>';}).join('')+'</span>';
}
function muscleExList(slug){return ((state.last&&state.last.volume&&state.last.volume.muscle_exercises)||{})[slug]||[];}
function exMuscleList(name){return ((state.last&&state.last.volume&&state.last.volume.exercise_muscles)||{})[name]||[];}
// highlight maps: slug -> 1 (primary) / 2 (secondary)
function muscleHmap(slug){const h={};h[slug]=1;return h;}
function exerciseHmap(name){const h={};for(const e of exMuscleList(name))h[e.muscle]=e.contribution>=1?1:2;return h;}
function applyHighlight(hmap){
 document.querySelectorAll('#body path[data-r]').forEach(p=>{const m=muscleForId(p.getAttribute('data-r'));const lv=m&&hmap&&hmap[m];p.classList.toggle('hl',lv===1);p.classList.toggle('hl2',lv===2);});
 document.querySelectorAll('#volume .vrow').forEach(r=>{const m=r.dataset.mus;const lv=m&&hmap&&hmap[m];r.classList.toggle('sel',lv===1);r.classList.toggle('sel2',lv===2);});
}
function panelMuscle(slug){
 const nm=MUSCLE_NAMES[slug]||[slug,'']; const list=muscleExList(slug);
 const ex=list.length?'<div class=bi-ex>'+list.map(e=>'<span class="bi-x ex'+(e.contribution>=1?'':' sec')+'" data-ex="'+esc(e.name)+'">'+esc(e.name)+'</span>').join('')+'</div>':'<div class=bi-none>No exercises mapped</div>';
 document.getElementById('bodyinfo').innerHTML='<div><span class=bi-plain>'+nm[0]+'</span><span class=bi-tech>'+nm[1]+'</span></div>'+ex;
}
function panelExercise(name){
 const muscles=exMuscleList(name);
 const variants=((state.last&&state.last.volume&&state.last.volume.exercise_variants)||{})[name]||[];
 // muscles worked: colloquial names, primary bright / secondary dim (labels, not navigation)
 const mhtml=muscles.length?'<div class=bi-mus>'+muscles.map(e=>{const nm=MUSCLE_NAMES[e.muscle]||[e.muscle,''];return '<span class="bi-m'+(e.contribution>=1?'':' sec')+'">'+nm[0]+'</span>';}).join('')+'</div>':'';
 // variants: tap to open a YouTube "how to" search in the browser
 const vhtml=variants.length?'<div class=bi-ex>'+variants.map(v=>'<span class="bi-x var" data-url="'+esc(v.url)+'">'+esc(v.name)+'</span>').join('')+'</div>':'';
 document.getElementById('bodyinfo').innerHTML='<div><span class=bi-plain>'+esc(name)+'</span></div>'+mhtml+vhtml;
}
function showSel(sel){
 if(!sel){document.getElementById('bodyinfo').innerHTML='';applyHighlight(null);return;}
 if(sel.kind==='muscle'){panelMuscle(sel.key);applyHighlight(muscleHmap(sel.key));}
 else{panelExercise(sel.key);applyHighlight(exerciseHmap(sel.key));}
 // phone wall: the panel floats as a sheet over the scaled canvas — give it an explicit ✕
 // (re-tapping the exact muscle to dismiss is fiddly at wall scale, and mis-taps should be cheap),
 // and pin its BOTTOM edge to the TOP of the muscle section so it never covers the map/bars
 // being tapped. getBoundingClientRect() is post-transform, so this lands right at any scale.
 if(document.body.classList.contains('phonewall')){
  const info=document.getElementById('bodyinfo');
  info.insertAdjacentHTML('afterbegin','<button class=bi-close type=button aria-label=Close>✕</button>');
  const row=document.querySelector('.musclerow');
  if(row)info.style.bottom=Math.max(66,Math.round(window.innerHeight-row.getBoundingClientRect().top)+6)+'px';
 }
}
function setSel(sel){SEL=sel;showSel(sel);}
function toggleSel(sel){ if(SEL&&SEL.kind===sel.kind&&SEL.key===sel.key)setSel(null); else setSel(sel); }

// Muscle Volume card: sortable (Priority = least-trained first, default; or Grouped), rows clickable.
function volRowHtml(m){
 // Three slices, left→right: stable (solid) | drops the day after (faint stripes) | drops tomorrow
 // (bright stripes). Nothing drops *today* — the window only slides at the 4am rollover — so the
 // soonest-to-go slice (tomorrow) sits at the leading edge: at the rollover it falls off and the
 // "day after" slice escalates into its place. Graduated warning, not a silent vanish.
 const stable=Math.round((m.stable_fill||0)*100);
 const dAfter=Math.round((m.drop_day_after_fill||0)*100);
 const dTmrw=Math.round((m.drop_tomorrow_fill||0)*100);
 let dropTxt='';
 if(m.drop_tomorrow>0)dropTxt+=' <span style="color:#dfe5ee">(−'+m.drop_tomorrow+' tmrw)</span>';
 if(m.drop_day_after>0)dropTxt+=' <span style="color:#7c8694">(−'+m.drop_day_after+' in 2d)</span>';
 // Drop-off slices keep the bar's own colour (set inline); the white stripes that mark them as
 // at-risk — bright for "tomorrow", faint for "day after" — come from the .vdrop-* CSS overlay.
 const bars=(stable+dAfter+dTmrw===0)
  ? '<div class=vstable style="width:4%;background:'+m.color+'"></div>'
  : '<div class=vstable style="width:'+stable+'%;background:'+m.color+'"></div>'+
    (dAfter>0?'<div class="vdrop vdrop-2d" style="width:'+dAfter+'%;background-color:'+m.color+'"></div>':'')+
    (dTmrw>0?'<div class="vdrop vdrop-tmrw" style="width:'+dTmrw+'%;background-color:'+m.color+'"></div>':'');
 // Today's adjusted sets for this muscle (persists all day, resets at the 4am rollover); climbs as you
 // log, clamps + turns red at +11 (the per-bout cap). PHONE: an inline parenthetical in the value, in
 // step with the drop parens (10 / 14 (+5.5)). TV: a separate badge overlaid on the right of the bar.
 const todayN = m.today || 0;
 const capped = todayN >= 11;
 const todayVal = capped ? 11 : todayN;
 const todayParen = (!TV && todayN > 0) ? ' <span class="vbout'+(capped?' capped':'')+'">(+'+todayVal+')</span>' : '';
 const todayBadge = (TV && todayN > 0) ? '<span class="vbout'+(capped?' capped':'')+'">+'+todayVal+'</span>' : '';
 const rtint = RECENCY_TINT[m.recency];   // amber/gold if worked today/yesterday, else default gray
 const nm = '<span class=nm'+(rtint?' style="color:'+rtint+'"':'')+'>'+(TV?shortLabel(m.label):m.label)+'</span>';
 return '<div class="vrow tappable" data-mus="'+m.muscle+'"><div class=vrow-l>'+nm+'<span class=vl>'+m.sets+' / '+m.target+dropTxt+todayParen+'</span></div>'+
  '<div class=vtrack>'+bars+'</div>'+todayBadge+'</div>';
}
function renderVolume(){
 const V=(state.last&&state.last.volume)||{}; const groups=V.groups||[];
 const toggle='<div class=vsort><span class="vs-opt'+(VOLSORT==='need'?' on':'')+'" data-sort=need>Priority</span>'+
  '<span class="vs-opt'+(VOLSORT==='group'?' on':'')+'" data-sort=group>Grouped</span></div>';
 let body;
 if(VOLSORT==='group'){
  body=groups.map(g=>'<div class=vgrp><h3>'+g.group+'</h3>'+g.muscles.map(volRowHtml).join('')+'</div>').join('');
 }else{
  const all=[]; groups.forEach(g=>g.muscles.forEach(m=>all.push(m)));
  all.sort((a,b)=>(a.sets/a.target)-(b.sets/b.target)||a.sets-b.sets||a.label.localeCompare(b.label));
  body=all.map(volRowHtml).join('');
 }
 const volEl=document.getElementById('volume'); if(!volEl)return;
 volEl.innerHTML='<h2>Muscle Volume · 7-Day</h2>'+toggle+body;
 if(SEL)applyHighlight(SEL.kind==='muscle'?muscleHmap(SEL.key):exerciseHmap(SEL.key));
}

export function render(s){
 // muscle volume gauges
 renderVolume();
 // body map: paint each fine region by its mapped muscle's color
 const MC=((s.volume||{}).muscle_colors)||{};
 document.querySelectorAll('#body path[data-r]').forEach(p=>{const m=muscleForId(p.getAttribute('data-r'));if(m&&MC[m])p.style.fill=MC[m];});
 sizeMap();
}
// Desktop only: size the body-map svg to the volume list's height (width by the 72:93 figure aspect),
// so map and volume are the same height and the volume takes the remaining width. (Pure CSS can't do
// "as tall as my sibling, as wide as height×ratio" without a flex circular-sizing trap.)
function sizeMap(){
 if(TOUCH)return;
 if(document.body.classList.contains('tv'))return; // TV grid sizes the map via CSS (width-fit)
 const fit=document.querySelector('.musright .musmap .fit');
 const svg=document.querySelector('.musmap #body svg');
 if(!fit||!svg)return;
 const h2=fit.querySelector('h2');
 const cs=getComputedStyle(fit);
 // map card's content height minus: the .fit top/bottom padding, the title (height + its bottom margin),
 // and the svg's 8px top margin. (clientHeight includes padding, so it must be subtracted back out —
 // omitting it left the svg ~50px too tall, clipping the feet under .musmap's overflow:hidden.)
 const h2h=h2?h2.offsetHeight+parseFloat(getComputedStyle(h2).marginBottom||0):0;
 const avail=fit.clientHeight-parseFloat(cs.paddingTop||0)-parseFloat(cs.paddingBottom||0)-h2h-8;
 if(avail<120)return;
 if(Math.abs(avail-(parseFloat(svg.style.height)||0))<3)return; // damp micro-oscillation (no runaway growth)
 const w=Math.round(avail*72/93);
 svg.style.height=avail+'px';
 svg.style.width=w+'px';
 // pin the right column to the map's width so a long breakdown wraps WITHIN it instead of widening the
 // column (which was shoving the cards around as you hovered muscles with many exercises).
 const right=document.querySelector('.musright'); if(right)right.style.width=(w+42)+'px';
}
if(typeof window!=='undefined')window.addEventListener('resize',sizeMap);

// TV wall only: show the body map as two STACKED figures (front on top, back below) in a thin column
// instead of side-by-side. The asset is one 72×93 svg with the front figure in the left half (x 0–36)
// and the back in the right half (x 36–72), so we render the same paths twice with split viewBoxes and
// stack them. render()'s per-muscle fill painting still works — it queries '#body path[data-r]', which
// now matches the paths in BOTH copies.
function tvStackFigures(){
 if(!document.body.classList.contains('tv'))return;
 const host=document.getElementById('body'); if(!host)return;
 const svg=host.querySelector('svg.bodysvg'); if(!svg||host.dataset.split)return;
 host.dataset.split='1';
 const inner=svg.innerHTML;
 // The home wall gives this column whatever width its heat maps do not need, which is more than a
 // 36:93 figure can use at that height — and 'meet' then centres the figure and leaves the NEXT
 // half of the artwork showing beside it, since the viewBox window no longer fills the viewport.
 // 'none' fills it instead: the column is wider than the figure is, and the figure takes the width.
 const pa=document.body.classList.contains('homewall')?'none':'xMidYMid meet';
 const wrap=document.createElement('div'); wrap.className='figstack';
 wrap.innerHTML=
   '<svg viewBox="0 0 36 93" preserveAspectRatio="'+pa+'" class="bodysvg figfront">'+inner+'</svg>'+
   '<svg viewBox="36 0 36 93" preserveAspectRatio="'+pa+'" class="bodysvg figback">'+inner+'</svg>';
 svg.replaceWith(wrap);
}

// ---- handlers (bound on import; DOM ready because core.js is a deferred module) ----
(function(){
 tvStackFigures();   // TV wall: split front/back into a stacked column (no-op on phone/desktop)
 const bodyEl=document.getElementById('body');
 if(!bodyEl)return;  // page without the muscle card (e.g. /page after consolidation) — nothing to bind
 document.querySelectorAll('#body path[data-r]').forEach(p=>{if(muscleForId(p.getAttribute('data-r')))p.classList.add('tappable');});
 if(!TOUCH){
  bodyEl.addEventListener('mouseover',e=>{const p=e.target.closest('path[data-r]');if(!p)return;const m=muscleForId(p.getAttribute('data-r'));if(m)showSel({kind:'muscle',key:m});});
  bodyEl.addEventListener('mouseout',e=>{if(e.target.closest('path[data-r]'))showSel(SEL);});
 }
 bodyEl.addEventListener('click',e=>{const p=e.target.closest('path[data-r]');if(!p)return;const m=muscleForId(p.getAttribute('data-r'));if(m)toggleSel({kind:'muscle',key:m});});
 // PHONE WALL: move the detail panel OUT of the transform-scaled shell onto <body> — fixed positioning
 // inside a transformed ancestor is relative to that ancestor, not the viewport, so the bottom-sheet
 // styling can only work from outside. (Same viewport test wall.js uses; body.phonewall isn't set yet
 // at import time because wall.js loads after core.js's import graph.)
 const info=document.getElementById('bodyinfo');
 if(document.body.classList.contains('tv')&&window.innerWidth<1400&&info)document.body.appendChild(info);
 // panel chips: exercise chip -> select exercise; muscle chip -> select muscle; ✕ -> dismiss
 info.addEventListener('click',e=>{
  if(e.target.closest('.bi-close')){setSel(null);return;}
  const v=e.target.closest('.var'); if(v){window.open(v.dataset.url,'_blank');return;}
  const ex=e.target.closest('.ex'); if(ex){setSel({kind:'exercise',key:ex.dataset.ex});return;}
  // the box itself is not a dismiss target — re-tap the same muscle (or ✕ on the wall) to close it
 });
 // volume card: sort toggle + clickable/hoverable rows.
 // Guarded like bodyEl above, and for a reason that is easy to miss: a surface can carry the body map
 // WITHOUT the volume list — the home wall runs the map as a thin column and has no room for the list.
 // Unguarded, that combination walked past the bodyEl check straight into this null, and because this
 // is module-init the throw aborted the rest of core.js's import graph, blanking cards that have
 // nothing to do with muscle. It cost the live wall its components on 2026-09-07.
 const volEl=document.getElementById('volume');
 if(!volEl)return;
 volEl.addEventListener('click',e=>{
  const opt=e.target.closest('.vs-opt'); if(opt){VOLSORT=opt.dataset.sort;localStorage.setItem('volsort',VOLSORT);renderVolume();return;}
  const row=e.target.closest('.vrow'); if(row&&row.dataset.mus){toggleSel({kind:'muscle',key:row.dataset.mus});return;}
 });
 if(!TOUCH){
  volEl.addEventListener('mouseover',e=>{const row=e.target.closest('.vrow');if(row&&row.dataset.mus)showSel({kind:'muscle',key:row.dataset.mus});});
  volEl.addEventListener('mouseout',e=>{if(e.target.closest('.vrow'))showSel(SEL);});
 }
})();
