// What a session's extra tabs draw (cards/repos.js, TAB_KINDS; docs/SESSION-TABS.md).
//
//   mountContent — something the session put up with the `session_tab` tool: markdown (rendered like a
//                  reply), an image, or an HTML page in a sandboxed frame (served by /tab/:id under the
//                  same CSP as a report, so its markup never runs as the hub).
//   mountLive    — a live view of a Chrome tab the session drives. Frames arrive over a websocket only
//                  while this tab is the one on screen and the app is in front; leaving either closes the
//                  socket, which is what stops the browser streaming (lib/liverelay.js).
//
// Each returns { close, update?, shown? }: `update` takes a newer head of the same tab, `shown` whether
// its pane is the one on screen.
import { md } from './shared.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function mountContent(pane, t) {
  const box = h('div', 'st-content');
  pane.append(box);
  let v = null, alive = true;
  async function paint(head) {
    if (!alive || head.v === v) return;
    v = head.v;
    if (head.format === 'image') {
      const img = h('img', 'st-img'); img.alt = '';
      img.src = head.img;
      box.replaceChildren(img);
    } else if (head.format === 'html') {
      const f = h('iframe', 'st-frame');
      // No allow-scripts: the CSP on /tab/:id says the same, and either alone keeps its markup inert.
      f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
      f.src = `/tab/${encodeURIComponent(head.id)}?v=${encodeURIComponent(head.v || '')}`;
      box.replaceChildren(f);
    } else {
      try {
        const r = await fetch(`/api/tabs/${encodeURIComponent(head.id)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!alive || d.v !== v) return;
        const div = h('div', 'st-md');
        div.innerHTML = md(d.body || '');
        box.replaceChildren(div);
      } catch (e) {
        console.error(`[tabs] reading tab ${head.id} failed: ${e.message || e}`);
        v = null;   // the next update tries again
      }
    }
  }
  paint(t);
  return { close: () => { alive = false; }, update: paint };
}

// A frame: 4-byte big-endian header length, header JSON { target, w, h } (w, h: the page in CSS pixels),
// then the JPEG.
function parseFrame(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  return { head, jpeg: new Blob([new Uint8Array(buf, 4 + n)], { type: 'image/jpeg' }) };
}

export function mountLive(pane, t) {
  const ov = h('div', 'ho ho-inline st-live');
  const top = h('div', 'ho-top');
  const where = h('div', 'ho-note st-where');
  const back = h('button', 'ho-btn st-small', '←');
  const reload = h('button', 'ho-btn st-small', '⟳');
  top.append(back, where, reload);
  const stage = h('div', 'ho-stage');
  const wrap = h('div', 'ho-wrap');
  const img = h('img', 'ho-img'); img.alt = '';
  const mark = h('div', 'ho-mark');
  wrap.append(img, mark); stage.append(wrap);
  const bar = h('div', 'ho-bar');
  const input = h('input', 'ho-input');
  Object.assign(input, { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  input.setAttribute('autocorrect', 'off');
  const btn = (label, fn, cls = '') => { const b = h('button', `ho-btn ${cls}`, label); b.onclick = fn; return b; };
  const row1 = h('div', 'ho-row');
  const row2 = h('div', 'ho-row');
  const state = h('div', 'ho-state');
  bar.append(row1, row2, state);
  ov.append(top, stage, bar);
  pane.append(ov);

  let ws = null, shownNow = false, alive = true, retry = 0, retryTimer = null;
  let page = { w: 0, h: 0 }, url = null;
  const setWhere = (head) => {
    let host = '';
    try { host = head.url ? new URL(head.url).hostname.replace(/^www\./, '') : ''; } catch (_) {}
    where.textContent = host || head.title || '';
  };
  setWhere(t);

  const send = (ev) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(ev)); };

  // ---- the socket: open only while this pane is on screen and the app is in front ----
  function want() { return alive && shownNow && document.visibilityState === 'visible'; }
  function connect() {
    if (ws || !want()) return;
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new WebSocket(`${proto}://${location.host}/api/live/view?tab=${encodeURIComponent(t.id)}`);
    s.binaryType = 'arraybuffer';
    ws = s;
    ov.classList.add('busy');
    s.onmessage = (e) => {
      if (typeof e.data !== 'string') { retry = 0; return frame(e.data); }
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.op === 'status') state.textContent = m.agent === false ? 'Offline' : m.error ? m.error : m.stalled ? '…' : '';
      else if (m.op === 'meta') setWhere(m);
      else if (m.op === 'closed') { alive = false; state.textContent = 'Closed'; }
    };
    s.onclose = () => {
      if (ws === s) ws = null;
      if (!want()) return;
      // Dropped while wanted (signal, a deploy): back with a growing wait, which resets on the next frame.
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    };
  }
  function disconnect() { clearTimeout(retryTimer); if (ws) { const s = ws; ws = null; s.close(); } }
  const sync = () => (want() ? connect() : disconnect());
  document.addEventListener('visibilitychange', sync);

  // ---- the picture: scale s and offset (tx, ty) of the frame's own pixels within the stage ----
  let s = 1, tx = 0, ty = 0, W = 0, H = 0, fitted = '';
  const apply = () => {
    wrap.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    mark.style.transform = `translate(-50%,-50%) scale(${1 / s})`;
  };
  const fitScale = () => stage.clientWidth / W;
  const clampScale = (v) => Math.min(Math.max(v, fitScale()), fitScale() * 5);
  // Kept inside the stage: a picture narrower than the stage is centred, a wider one cannot be dragged
  // past its edge. Returns how far a move was cut short, which is what scrolls the page instead.
  function clamp() {
    const sw = stage.clientWidth, sh = stage.clientHeight, pw = W * s, ph = H * s;
    let cutX = 0, cutY = 0;
    const lim = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    if (pw <= sw) tx = (sw - pw) / 2; else { const c = lim(tx, sw - pw, 0); cutX = tx - c; tx = c; }
    if (ph <= sh) { cutY = ty - 0; ty = 0; } else { const c = lim(ty, sh - ph, 0); cutY = ty - c; ty = c; }
    return { cutX, cutY };
  }
  function fit() {
    if (!W || !stage.clientWidth) return;
    s = fitScale(); tx = 0; ty = 0; clamp(); apply();
  }
  function frame(buf) {
    let f;
    try { f = parseFrame(buf); } catch (e) { console.error(`[live] bad frame: ${e.message || e}`); return; }
    page = { w: f.head.w || 0, h: f.head.h || 0 };
    const next = URL.createObjectURL(f.jpeg);
    img.onload = () => {
      if (url) URL.revokeObjectURL(url);
      url = next;
      ov.classList.remove('busy'); mark.classList.remove('on');
      W = img.naturalWidth; H = img.naturalHeight;
      wrap.style.width = `${W}px`; wrap.style.height = `${H}px`;
      // Framed once per picture size, then left where he put it.
      const key = `${W}x${H}`;
      if (fitted !== key) { fitted = key; fit(); }
    };
    img.src = next;
  }
  new ResizeObserver(() => { if (W) { clamp(); apply(); } }).observe(stage);

  // ---- touch: one finger pans the picture and, past its edge, scrolls the page; two pinch; a tap clicks ----
  let wheelDy = 0, wheelAt = null, wheelTimer = null;
  function wheel(cy, dyScreen, cx) {
    if (!H || !page.h) return;
    // Screen pixels → the page's CSS pixels: through the zoom, then the frame's own scale.
    wheelDy += (-dyScreen / s) * (page.h / H);
    const r = stage.getBoundingClientRect();
    wheelAt = { x: Math.min(Math.max((cx - r.left - tx) / (s * W), 0), 1), y: Math.min(Math.max((cy - r.top - ty) / (s * H), 0), 1) };
    if (!wheelTimer) wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (Math.abs(wheelDy) >= 1) send({ t: 'wheel', ...wheelAt, dy: Math.round(wheelDy) });
      wheelDy = 0;
    }, 50);
  }
  const pts = new Map();
  let tapAt = null, pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) tapAt = { x: e.clientX, y: e.clientY, t: Date.now() };
    else { tapAt = null; const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, tx, ty }; }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p || !W) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const r = stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      s = clampScale(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
      const px = (pinch.mx - r.left - pinch.tx) / pinch.s, py = (pinch.my - r.top - pinch.ty) / pinch.s;
      tx = mx - r.left - px * s; ty = my - r.top - py * s;
      clamp(); apply();
    } else if (pts.size === 1) {
      if (tapAt && Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) > 8) tapAt = null;
      if (tapAt) return;
      tx += dx; ty += dy;
      const { cutY } = clamp(); apply();
      if (cutY) wheel(e.clientY, cutY, e.clientX);
    }
  });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size < 2) pinch = null;
    if (e.type === 'pointerup' && pts.size === 0 && tapAt) tap(e.clientX, e.clientY);
    if (pts.size === 0) tapAt = null;
  };
  // A finger on the picture is his alone: the swipe panes around the session view do not get the drag.
  stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const r = stage.getBoundingClientRect();
      const px = (e.clientX - r.left - tx) / s, py = (e.clientY - r.top - ty) / s;
      s = clampScale(s * Math.exp(-e.deltaY / 200));
      tx = e.clientX - r.left - px * s; ty = e.clientY - r.top - py * s;
      clamp(); apply();
      return;
    }
    tx -= e.deltaX; ty -= e.deltaY;
    const { cutY } = clamp(); apply();
    if (cutY) wheel(e.clientY, cutY, e.clientX);
  }, { passive: false });

  function tap(cx, cy) {
    if (!W) return;
    const r = stage.getBoundingClientRect();
    const x = (cx - r.left - tx) / (s * W), y = (cy - r.top - ty) / (s * H);
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    mark.style.left = `${x * 100}%`; mark.style.top = `${y * 100}%`; mark.classList.add('on');
    send({ t: 'tap', x, y });
  }

  row1.append(input, btn('Type', () => {
    if (!input.value) return;
    send({ t: 'text', text: input.value });
    input.value = '';
  }, 'ho-go'));
  row2.append(
    btn('Enter', () => send({ t: 'key', key: 'enter' })),
    btn('Tab', () => send({ t: 'key', key: 'tab' })),
    btn('⌫', () => send({ t: 'key', key: 'backspace' })),
    btn('Esc', () => send({ t: 'key', key: 'escape' })),
  );
  back.onclick = () => send({ t: 'back' });
  reload.onclick = () => send({ t: 'reload' });

  return {
    close() {
      alive = false; disconnect();
      document.removeEventListener('visibilitychange', sync);
      if (url) URL.revokeObjectURL(url);
    },
    update(head) { setWhere(head); },
    shown(on) { shownNow = on; sync(); },
  };
}

