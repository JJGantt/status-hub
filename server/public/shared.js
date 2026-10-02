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

// The big-screen kiosk: display-only, no input, its own voice layer (tv.js). Everything else — the page
// view, the PHONE wall, the Mac app's side panel — boots the interactive client in voiceagent.js instead.
// It lives here, in the first-loaded dependency-free module, because two modules decide opposite halves of
// the same question with it and they must not be able to disagree. body.phonewall is not set yet at import
// time (wall.js loads after core.js's import graph), so this is the viewport predicate wall.js uses;
// body.mac is set just above.
// `phonehome` is the phone's own home page. It carries `tv` for the wall cards' styling but it is
// never the kiosk, however wide the window it is opened in — it has a composer, a navbar and taps.
export const KIOSK = document.body.classList.contains('tv')
  && !document.body.classList.contains('mac') && !document.body.classList.contains('phonehome')
  && window.innerWidth >= 1400;

// WHICH HEAT WINDOW this surface draws. The frame carries the full span plus a trim for the surfaces
// that want a shorter one, rather than letting a surface slice its own: the weigh-in plot's columns
// are built to match, so a client-side slice would have to re-derive that too.
//
// A SCROLLING map asks for neither — the phone's home page takes the full window and lets its box
// decide what is on screen. It also cannot take a trim: `/api/heat-history` returns the weeks OLDER
// than the frame's own window, so prefixing that archive to a trim leaves the weeks between them
// missing out of the middle of the picture, silently and in the right colours.
export const heatPick = (s, key) =>
  (document.body.classList.contains('homewall') && s[key + '_home']) || {};

// CAN A DRAG STARTING HERE SCROLL SOMETHING? Scrubbing a heat map and scrolling one want the same
// gesture and the grid can only have one of them: where it scrolls, the drag belongs to the browser
// and the tap arrives afterwards as a click; where it cannot, the drag is a scrub and the handler
// preventDefaults so it does not become a card-drag instead.
//
// Asked of the DOM rather than of the page. It used to be `closest('.sectsheet.open')` — true only
// inside the expanded sheet, which was the only place a grid scrolled — and the moment another
// surface scrolled its maps, every drag on them was still being swallowed as a scrub.
//
// The walk STOPS AT THE HOST, and that bound is load-bearing: the phone's panes are themselves a
// horizontal scroller, so an unbounded walk finds one from anywhere and no grid would ever scrub.
export function scrollableX(el, host) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n !== el && n.scrollWidth > n.clientWidth + 1
        && getComputedStyle(n).overflowX !== 'visible') return true;
    if (n === host) break;
  }
  return false;
}

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

// Repaint a host whose content scrolls sideways, without throwing away where it is scrolled to.
// Cards rebuild their innerHTML on every SSE frame; without this, a frame arriving while he is
// reading back through June would snap him to whatever end the fresh markup starts at.
// `sel` finds the scroller inside the host when it isn't the host itself; `stick` keeps a view that
// was already at the newest edge pinned there as new days arrive.
export function paintScrolled(host, html, { sel = null, stick = false } = {}) {
  const find = (h) => (sel ? h.querySelector(sel) : h);
  const before = find(host);
  const left = before ? before.scrollLeft : 0;
  const wasAtEnd = before ? before.scrollWidth - left - before.clientWidth < 2 : true;
  host.innerHTML = html;
  const after = find(host);
  if (after) after.scrollLeft = (stick && wasAtEnd) ? after.scrollWidth : left;
  return after;
}

// ---- markdown -------------------------------------------------------------------------------
//
// Every reply is written in markdown, and every surface that shows one renders it here: the phone's
// conversation tail, the chat sheet, the session view. One renderer, so a reply reads the same on each
// (the watch's `Markdown.swift` covers the same blocks). Headings, lists (nested by indent), fenced
// code, quotes, rules, tables; inside them code, links, bare URLs, bold and italics.
//
// EVERY PATH ESCAPES FIRST. The text is a model's, rendered into an origin already authenticated as
// Jared, so no tag here ever comes from the input: the input is escaped and then OUR OWN patterns
// introduce tags around it. Code and links are lifted out before the emphasis rules run, or a `*`
// inside one would be read as emphasis.
//
// A link ALWAYS asks for a new window. Followed in place it would navigate the app's one web view away
// from the hub, with nothing on screen to come back by; `target=_blank` reaches the app's
// `createWebViewWith`, which hands the address to Safari. Only http(s) becomes a link, which keeps
// `javascript:` out of an href; anything else keeps its words and loses its target.
const MD_MARK = '';                                // a private-use character: where a lifted span goes back
const MD_HELD = new RegExp(MD_MARK + '(\\d+)' + MD_MARK, 'g');
export function mdInline(text) {
  const held = [];
  const lift = (html) => { held.push(html); return MD_MARK + (held.length - 1) + MD_MARK; };
  const link = (url, words) => lift(`<a href="${url}" target="_blank" rel="noopener noreferrer">${words}</a>`);
  return esc(String(text == null ? '' : text).split(MD_MARK).join(''))
    .replace(/`([^`\n]+)`/g, (_, c) => lift('<code>' + c + '</code>'))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, words, url) => link(url, words))
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
    // A bare address, as a model usually writes one. It stops at an escaped quote and gives back the
    // punctuation that ends its sentence; a closing `)` stays only when the URL opened one
    // (Wikipedia's `Foo_(bar)`).
    .replace(/https?:\/\/(?:(?!&quot;)[^\s<])+/g, (m) => {
      let url = m;
      for (;;) {
        const t = url.match(/[.,;:!?'\]]$|\)$/);
        if (!t || (t[0] === ')' && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length)) break;
        url = url.slice(0, -1);
      }
      return link(url, url) + m.slice(url.length);
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(MD_HELD, (_, i) => held[+i]);
}

const mdCells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const mdAlign = (row) => {
  const cells = mdCells(row);
  if (!cells.length || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
};

export function md(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  let html = '', para = [], quote = [], code = null;
  // Open lists, innermost last, each with the indent its items sit at.
  const lists = [];
  const closeLists = (to = 0) => { while (lists.length > to) html += `</li></${lists.pop().tag}>`; };
  const flush = () => {
    if (para.length) { html += `<p class=md-p>${para.map(mdInline).join('<br>')}</p>`; para = []; }
    if (quote.length) { html += `<blockquote class=md-q>${quote.map(mdInline).join('<br>')}</blockquote>`; quote = []; }
    closeLists();
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], line = raw.trim();
    if (/^```/.test(line)) {
      if (code === null) { flush(); code = []; } else { html += `<pre class=md-pre>${esc(code.join('\n'))}</pre>`; code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); html += `<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`; continue; }
    if (/^((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) { flush(); html += '<hr class=md-hr>'; continue; }
    // A table is a pipe row with a separator row under it; without the separator it is prose.
    const align = line.startsWith('|') && i + 1 < lines.length ? mdAlign(lines[i + 1]) : null;
    if (align) {
      flush();
      const row = (cells, tag) => '<tr>' + align.map((a, k) =>
        `<${tag}${a === 'left' ? '' : ` style="text-align:${a}"`}>${mdInline(cells[k] || '')}</${tag}>`).join('') + '</tr>';
      let t = `<div class=md-tbl><table><thead>${row(mdCells(line), 'th')}</thead><tbody>`;
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) t += row(mdCells(lines[i]), 'td');
      i--;
      html += t + '</tbody></table></div>';
      continue;
    }
    const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (para.length || quote.length) flush();
      const indent = li[1].length, tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      while (lists.length && lists[lists.length - 1].indent > indent) closeLists(lists.length - 1);
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.tag === tag) html += '</li><li>';
      else {
        if (top && top.indent === indent) closeLists(lists.length - 1);
        lists.push({ indent, tag });
        const n = parseInt(li[2], 10);
        html += `<${tag} class=md-l${tag === 'ol' && n !== 1 ? ` start="${n}"` : ''}><li>`;
      }
      html += mdInline(li[3]);
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { if (para.length || lists.length) flush(); quote.push(q[1]); continue; }
    // A line under a list item that is not itself an item continues it.
    if (lists.length && /^\s/.test(raw)) { html += '<br>' + mdInline(line); continue; }
    if (lists.length || quote.length) flush();
    para.push(line);
  }
  if (code !== null) html += `<pre class=md-pre>${esc(code.join('\n'))}</pre>`;
  flush();
  return html;
}

export function esc(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}

// The mark on a PINNED session — focus he set by name, which stays put while other sessions take
// turns — so it never reads as automatic focus, which follows whichever session is most recent. One
// glyph, drawn in the surrounding text colour, on every surface that shows focus.
export const PIN_SVG = '<svg class="pin-mark" viewBox="0 0 16 16" width="0.85em" height="0.85em" fill="currentColor"'
  + ' role="img" aria-label="pinned" style="vertical-align:-0.1em;margin-right:0.3em">'
  + '<path d="M5.5 1h5a1 1 0 0 1 0 2h-5a1 1 0 0 1 0-2z M5.6 3.4h4.8l.9 4.6H4.7z'
  + ' M3.8 8h8.4a.8.8 0 0 1 0 1.6H3.8a.8.8 0 0 1 0-1.6z M7.4 9.6h1.2v4.8a.6.6 0 0 1-1.2 0z"/></svg>';
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

// ---- pick up a new deploy without being asked ----
//
// Nothing reloaded a page when the server shipped a new version. The wall and the phone kept running
// whatever JS and CSS they loaded, sometimes for days, so a fix looked like it had not landed and the
// only cure was reloading by hand — which on the wall means a voice command and on the phone means
// force-quitting the app.
//
// `/healthz` already reports the commit the server is running, so the page remembers what it started
// against and reloads when that changes. It is a text response with no database behind it, so the
// poll is cheap enough to be boring.
//
// The guards are the same three the staleness recovery uses, for the same reasons: a hidden tab is
// supposed to be idle, reloading out from under something being typed throws the text away, and a
// reload is pointless if the answer never came. Failing all three just means waiting for the next
// pass — a stale page is always better than a lost one.
const BUILD_POLL_MS = 120000;
if (typeof window !== 'undefined' && typeof fetch === 'function') {
  let seen = null;
  const check = async () => {
    let now;
    try { now = (await (await fetch('/healthz', { cache: 'no-store' })).text()).trim(); }
    catch (_) { return; }
    if (!now.startsWith('ok ')) return;
    if (seen === null) { seen = now; return; }
    if (now === seen) return;
    if (document.hidden) return;                      // let a backgrounded tab stay asleep
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    location.reload();
  };
  setInterval(check, BUILD_POLL_MS);
  check();
}
