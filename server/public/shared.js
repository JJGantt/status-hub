// Leaf module: shared singletons + pure utils used across core.js and the card modules.
// Kept dependency-free so it fully initializes before any card module evaluates (avoids the
// circular-import temporal-dead-zone that bites a shared `const` imported from core.js).

export const TOUCH = matchMedia('(pointer: coarse)').matches; // phone/tablet: tap-only, no hover previews

// latest status frame — one writer (core's render). Held on an object so importers see updates
// (you can't reassign another module's exported binding, but you can mutate a shared object).
export const state = { last: null };

export function esc(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
export function ago(iso){if(!iso)return'—';const s=(Date.now()-new Date(iso))/1000;
 if(s<90)return Math.round(s)+'s ago';if(s<5400)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago';}
// hue gradient: t=0 green -> t=1 red, through real yellow at t=0.5
export function hueColor(t){const h=120*(1-Math.max(0,Math.min(1,t)));return 'hsl('+h+',85%,55%)';}

// Combined dual-axis time plot: shared x = date, left y = calories, right y = weight.
// calPts/wPts: [{date,v}]. maint: dashed reference value on the calorie (left) axis.
// Returns inline SVG sized via viewBox (full card width × ~120px). Null/sparse-safe.
const CAL_COLOR='#3b82f6', W_COLOR='#a78bfa';
export function dualPlot(calPts,wPts,maint,target){
 const W=600,H=120,L=46,R=46,T=10,B=18; // margins leave room for axis tick labels
 const px0=L,px1=W-R,py0=T,py1=H-B;
 const cv=calPts.filter(p=>isFinite(p.v)),wv=wPts.filter(p=>isFinite(p.v));
 if(cv.length<1&&wv.length<1)return '<div class=nplot-empty>no data yet</div>';
 // shared x domain over all dates present
 const all=[...cv,...wv].map(p=>p.date).filter(Boolean).sort();
 const xMin=all[0],xMax=all[all.length-1];
 const dms=d=>Date.parse(d+'T12:00:00Z');
 const xspan=(dms(xMax)-dms(xMin))||1;
 const X=d=>cv.length+wv.length<2?(px0+px1)/2:px0+(px1-px0)*((dms(d)-dms(xMin))/xspan);
 // left (cal) axis domain — include maintenance line so it stays on-canvas
 let cMin=cv.length?Math.min(...cv.map(p=>p.v)):0,cMax=cv.length?Math.max(...cv.map(p=>p.v)):1;
 if(isFinite(maint)){cMin=Math.min(cMin,maint);cMax=Math.max(cMax,maint);}
 if(isFinite(target)){cMin=Math.min(cMin,target);cMax=Math.max(cMax,target);}
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
 // dashed refs (left/cal axis): maintenance (grey) and target/goal (green)
 if(isFinite(maint)){const y=YC(maint).toFixed(1);s+='<line x1='+px0+' y1='+y+' x2='+px1+' y2='+y+' stroke="#6b7686" stroke-width=1 stroke-dasharray="4 3" />';}
 if(isFinite(target)){const y=YC(target).toFixed(1);s+='<line x1='+px0+' y1='+y+' x2='+px1+' y2='+y+' stroke="#22c55e" stroke-width=1 stroke-dasharray="4 3" />';}
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
