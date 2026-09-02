// Leaf module: shared singletons + pure utils used across core.js and the card modules.
// Kept dependency-free so it fully initializes before any card module evaluates (avoids the
// circular-import temporal-dead-zone that bites a shared `const` imported from core.js).

export const TOUCH = matchMedia('(pointer: coarse)').matches; // phone/tablet: tap-only, no hover previews

// Mac app view (?mode=mac): the landscape TV wall rendered INTERACTIVELY — chat as a docked VS-Code-style
// side panel, clickable cards, the phone's navbar + settings — instead of the display-only kiosk. Set the
// body class HERE (the first-loaded, dependency-free module) so voiceagent/core/wall all see `body.mac`
// before their import-time boot/mount checks run (they gate the same way the ≥1400 kiosk does).
export const MAC = new URLSearchParams(location.search).get('mode') === 'mac';
if (MAC && document.body) document.body.classList.add('mac');

// latest status frame — one writer (core's render). Held on an object so importers see updates
// (you can't reassign another module's exported binding, but you can mutate a shared object).
export const state = { last: null };

// ---------------------------------------------------------------- live streams
//
// An EventSource that notices when it has gone deaf.
//
// The failure this exists for: a stream can go HALF-OPEN — `readyState` stays OPEN, no `error` ever
// fires, and nothing arrives again. The browser only retries a connection it saw CLOSE, so a socket
// that merely stops delivering is never reconnected. On 2026-09-02 the TV wall sat on a ten-minute-old
// frame exactly that way while the server pushed every 30s, and it looked perfectly alive because the
// rest clock is a local interval. Nothing in the page could tell.
//
// So liveness is judged the only way it can be — by whether frames actually ARRIVE. Every stream is
// kept audible by a server-side `ping` event every 25s (see PING in server.js), so silence past three
// of those is a fault rather than a quiet house. That is what makes this work on the voice and list
// streams too, where hours can legitimately pass with no data of their own.
//
// On silence the socket is rebuilt. If the REBUILT one is deaf as well, the page itself is wedged and
// only a reload cures it.
//
// `listeners` is {eventName: fn}. `onOpen` fires on every (re)connect, including the first.
const SILENT_MS = 75000;          // 3 missed pings — the socket is not delivering
const streams = new Set();        // every stream on the page, for the staleness bar below

export function liveStream(url, listeners, { onOpen } = {}) {
  // TWO clocks, deliberately. `seenAt` is the last frame from anywhere and never resets on its own —
  // it is what the staleness bar and the kiosk watchdog read, so "nothing has arrived in five minutes"
  // stays true across a rebuild. `windowAt` restarts with each socket, giving a fresh one a full window
  // to prove itself. Sharing one clock would have let every rebuild wipe the evidence, so a page that
  // never recovers would have looked freshly connected forever.
  let es = null, seenAt = Date.now(), windowAt = Date.now(), rebuilt = false, reloading = false;
  const self = { age: () => Date.now() - seenAt, close(){ streams.delete(self); try{ es.close(); }catch(_){} } };
  const seen = () => { seenAt = windowAt = Date.now(); rebuilt = false; };
  function open(){
    es = new EventSource(url);
    es.addEventListener('ping', seen);
    es.addEventListener('open', () => { seen(); if (onOpen) onOpen(); });
    for (const [name, fn] of Object.entries(listeners))
      es.addEventListener(name, (e) => { seen(); fn(e); });
    windowAt = Date.now();
  }
  open();
  streams.add(self);
  setInterval(() => {
    if (Date.now() - windowAt < SILENT_MS) return;
    if (!rebuilt) { rebuilt = true; try{ es.close(); }catch(_){} open(); return; }
    // The rebuild is deaf too, so the page itself is the problem and only a reload clears it. Three
    // things have to hold first. A backgrounded tab is SUPPOSED to be suspended. Reloading out from
    // under something being typed throws the text away. And a reload into an unreachable hub lands on
    // the browser's error page, where there is no JS left to ever come back — the same trap .xinitrc
    // gates the kiosk launch against. Stale data under a red bar beats an error page, so reload only
    // once the server has answered.
    if (document.hidden || reloading) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    reloading = true;
    fetch('/healthz', { cache: 'no-store' })
      .then((r) => { if (r.ok) location.reload(); else reloading = false; })
      .catch(() => { reloading = false; });
  }, 5000);
  return self;
}

// The staleness hairline: 3px along the top edge of the viewport, on every page that opens a stream.
//
// Painted from a LOCAL timer and never from a render, because a render is precisely what stops
// happening — anything drawn off the status frame can only ever report that things were fine when it
// was last drawn. Invisible while frames arrive (no pixels, no layout shift, nothing to tune out).
// Amber once a stream has been silent long enough that the watchdog is rebuilding it; red once the
// rebuild has failed too, which means the hub is genuinely unreachable rather than merely quiet.
(function staleBar(){
  const bar = document.createElement('div');
  bar.className = 'stalebar';
  const mount = () => document.body.appendChild(bar);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  // Also the number the Pi's kiosk watchdog reads over CDP. It can already see a renderer that won't
  // run JS; this is the case it cannot see — JS running fine over data that stopped arriving.
  const worstAge = () => { let w = 0; for (const s of streams) w = Math.max(w, s.age()); return w; };
  window.__hubStreamAge = () => (streams.size ? worstAge() : 0);
  setInterval(() => {
    const worst = worstAge();
    bar.classList.toggle('stale', streams.size > 0 && worst >= SILENT_MS);
    bar.classList.toggle('dead',  streams.size > 0 && worst >= SILENT_MS * 2);
  }, 1000);
})();

export function esc(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
// This device's own current wall clock, naive (no offset) — "YYYY-MM-DDTHH:MM:SS", matching exactly
// how sets/nutrition_entries.occurred_at is stored. Sent with every write so the logged time is
// whatever the clock reads on the device doing the logging, wherever that is — never converted to a
// fixed home zone. A stationary kiosk/TV has no "Jared" device to ask, so writes from there fall back
// to the server's own naive-local (see server.js nowNaiveLocal); this is only for phone/browser writes.
export function localNowNaive(){const d=new Date(),p=n=>String(n).padStart(2,'0');
 return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
export function ago(iso){if(!iso)return'—';const s=(Date.now()-new Date(iso))/1000;
 if(s<90)return Math.round(s)+'s ago';if(s<5400)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago';}
// hue gradient: t=0 green -> t=1 red, through real yellow at t=0.5
export function hueColor(t){const h=120*(1-Math.max(0,Math.min(1,t)));return 'hsl('+h+',85%,55%)';}

// Combined dual-axis time plot: shared x = date, left y = calories, right y = weight.
// calPts/wPts: [{date,v}]. maint: dashed reference value on the calorie (left) axis.
// Returns inline SVG sized via viewBox (full card width × ~120px). Null/sparse-safe.
const CAL_COLOR='#3b82f6', W_COLOR='#a78bfa';
export function dualPlot(calPts,wPts,maintPts,targetPts){
 const W=600,H=120,L=46,R=46,T=10,B=18; // margins leave room for axis tick labels
 const px0=L,px1=W-R,py0=T,py1=H-B;
 const cv=calPts.filter(p=>isFinite(p.v)),wv=wPts.filter(p=>isFinite(p.v));
 const mv=(maintPts||[]).filter(p=>isFinite(p.v)),tv=(targetPts||[]).filter(p=>isFinite(p.v));
 if(cv.length<1&&wv.length<1)return '<div class=nplot-empty>no data yet</div>';
 // shared x domain over all dates present (cal, weight, and the maintenance/target curves)
 const all=[...cv,...wv,...mv,...tv].map(p=>p.date).filter(Boolean).sort();
 const xMin=all[0],xMax=all[all.length-1];
 const dms=d=>Date.parse(d+'T12:00:00Z');
 const xspan=(dms(xMax)-dms(xMin))||1;
 const X=d=>cv.length+wv.length<2?(px0+px1)/2:px0+(px1-px0)*((dms(d)-dms(xMin))/xspan);
 // left (cal) axis domain — include the maintenance & target curves so they stay on-canvas
 const calVals=[...cv,...mv,...tv].map(p=>p.v);
 let cMin=calVals.length?Math.min(...calVals):0,cMax=calVals.length?Math.max(...calVals):1;
 const cspan=(cMax-cMin)||1; const YC=v=>py1-(py1-py0)*((v-cMin)/cspan);
 // right (weight) axis domain
 let wMin=wv.length?Math.min(...wv.map(p=>p.v)):0,wMax=wv.length?Math.max(...wv.map(p=>p.v)):1;
 const wspan=(wMax-wMin)||1; const YW=v=>py1-(py1-py0)*((v-wMin)/wspan);
 const path=(pts,Y)=>{let d='',started=false;pts.forEach(p=>{if(!isFinite(p.v))return;d+=(started?'L':'M')+X(p.date).toFixed(1)+' '+Y(p.v).toFixed(1)+' ';started=true;});return d.trim();};
 let s='<svg class=nplot viewBox="0 0 '+W+' '+H+'" preserveAspectRatio=none>';
 // axes frame
 s+='<line x1='+px0+' y1='+py0+' x2='+px0+' y2='+py1+' stroke="#2a313a" stroke-width=1 />';
 s+='<line x1='+px1+' y1='+py0+' x2='+px1+' y2='+py1+' stroke="#2a313a" stroke-width=1 />';
 s+='<line x1='+px0+' y1='+py1+' x2='+px1+' y2='+py1+' stroke="#2a313a" stroke-width=1 />';
 // dashed reference CURVES (left/cal axis): maintenance (neutral warm-gray — kept clear of the
 // violet weight line) and target/goal (green). Each is per-day, so they bend over time instead of
 // being flat — maintenance is the scientific truth, target is the actual daily goal that was set.
 if(mv.length>=2)s+='<path d="'+path(mv,YC)+'" fill=none stroke="#9a948a" stroke-width=1.2 stroke-dasharray="5 4" stroke-linejoin=round stroke-linecap=round />';
 else if(mv.length===1)s+='<circle cx='+X(mv[0].date).toFixed(1)+' cy='+YC(mv[0].v).toFixed(1)+' r=1.6 fill="#9a948a" />';
 if(tv.length>=2)s+='<path d="'+path(tv,YC)+'" fill=none stroke="#22c55e" stroke-width=1.2 stroke-dasharray="4 3" stroke-linejoin=round stroke-linecap=round />';
 else if(tv.length===1)s+='<circle cx='+X(tv[0].date).toFixed(1)+' cy='+YC(tv[0].v).toFixed(1)+' r=1.6 fill="#22c55e" />';
 // weight line first (behind), then cal line
 if(wv.length>=2)s+='<path d="'+path(wv,YW)+'" fill=none stroke="'+W_COLOR+'" stroke-width=1.6 stroke-linejoin=round stroke-linecap=round />';
 else if(wv.length===1)s+='<circle cx='+X(wv[0].date).toFixed(1)+' cy='+YW(wv[0].v).toFixed(1)+' r=2 fill="'+W_COLOR+'" />';
 if(cv.length>=2)s+='<path d="'+path(cv,YC)+'" fill=none stroke="'+CAL_COLOR+'" stroke-width=1.8 stroke-linejoin=round stroke-linecap=round />';
 else if(cv.length===1)s+='<circle cx='+X(cv[0].date).toFixed(1)+' cy='+YC(cv[0].v).toFixed(1)+' r=2 fill="'+CAL_COLOR+'" />';
 s+='</svg>';
 // axis tick min/max as HTML overlay (avoids preserveAspectRatio=none stretching text). Positioned
 // as a percentage of the plot box so it tracks the SVG's L/R/T/B margins.
 const pct=(v,a,b)=>(((v-a)/((b-a)||1))*100);
 const lblL=px0/W*100,lblR=R/W*100,lblT=py0/H*100,lblBpx=B; // bottom margin
 let ov='<div class=nplot-ov>';
 if(cv.length){
  ov+='<span class=nplot-t style="left:0;top:'+lblT+'%;color:'+CAL_COLOR+';text-align:right;width:'+(L-4)+'px">'+Math.round(cMax)+'</span>';
  ov+='<span class=nplot-t style="left:0;bottom:'+lblBpx+'px;color:'+CAL_COLOR+';text-align:right;width:'+(L-4)+'px">'+Math.round(cMin)+'</span>';
 }
 if(wv.length){
  ov+='<span class=nplot-t style="right:0;top:'+lblT+'%;color:'+W_COLOR+';text-align:left;width:'+(R-4)+'px">'+(Math.round(wMax*10)/10)+'</span>';
  ov+='<span class=nplot-t style="right:0;bottom:'+lblBpx+'px;color:'+W_COLOR+';text-align:left;width:'+(R-4)+'px">'+(Math.round(wMin*10)/10)+'</span>';
 }
 // X-AXIS time ticks along the bottom: month/date marks at min, max, and ~evenly spaced interior
 // dates so the period is obvious. Positioned as % of the plot box (tracks the L/R margins).
 if(all.length){
  const fmt=ms=>{const d=new Date(ms);return (d.getUTCMonth()+1)+'/'+d.getUTCDate();};
  const xPct=d=>(X(d)/W*100);
  const ticks=[xMin]; // always show the range ends
  const N=Math.min(3,Math.max(0,all.length-2)); // up to 3 interior ticks
  for(let i=1;i<=N;i++){const t=dms(xMin)+xspan*(i/(N+1));ticks.push(new Date(t).toISOString().slice(0,10));}
  if(xMax!==xMin)ticks.push(xMax);
  ticks.forEach((d,i)=>{
   const align=i===0?'left':(i===ticks.length-1?'right':'center');
   const tx=i===0?'translateX(0)':(i===ticks.length-1?'translateX(-100%)':'translateX(-50%)');
   ov+='<span class=nplot-t style="left:'+xPct(d).toFixed(1)+'%;bottom:1px;color:#8b96a5;text-align:'+align+';transform:'+tx+'">'+fmt(dms(d))+'</span>';
  });
  // tick marks on the bottom axis
 }
 ov+='</div>';
 return '<div class=nplot-wrap>'+s+ov+'</div>';
}
