// THE TAP SCREEN for a handoff (routes/handoffs.js, docs/HANDOFFS.md): the screenshot of the screen a
// session is stuck on, where a tap is clicked on the real screen and the text box is typed there. In the
// phone app it lives in a TAB of its session's view (cards/repos.js, `mount`), so he can switch back to
// the conversation to read something off it and return; elsewhere it is a full-screen overlay, or its
// own page (/handoff/:id). It follows the handoff with a held request per screenshot, never a timer.
//
// The picture is the whole screen, framed at first on the part the session said matters (`focus`); he
// pans with one finger and pinches to zoom, and a tap that did not move is a click there. Values the
// session already knows he will type (`suggest`) are buttons that fill the text box; he presses Type.

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// `mount`: an element to draw into instead of over everything (a session tab); `onEnd` is called once
// the handoff has ended and its final state has shown. Returns `close`, which stops following it.
export function openHandoff(id, { page = false, mount = null, onEnd = null } = {}) {
  if (!mount && document.querySelector(`.ho[data-id="${id}"]`)) return () => {};
  const ov = h('div', mount ? 'ho ho-inline' : 'ho'); ov.dataset.id = id;
  const top = h('div', 'ho-top');
  const note = h('div', 'ho-note');
  const close = h('button', 'ho-btn ho-close', '×');
  top.append(note); if (!page && !mount) top.append(close);
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
  const row0 = h('div', 'ho-row ho-sugg');
  const row1 = h('div', 'ho-row');
  const row2 = h('div', 'ho-row');
  const state = h('div', 'ho-state');
  bar.append(row0, row1, row2, state);
  ov.append(top, stage, bar);
  (mount || document.body).append(ov);

  let cur = null, busy = false, alive = true, onFull = false, suggested = '';
  // When the keyboard closes the screen shifts under the finger, and the tap that closed it can land on
  // whatever slid beneath: a Done or Cancel nobody pressed. Those two ignore taps for a moment after the
  // box loses focus or the visible area resizes.
  let shiftedAt = 0;
  const shifted = () => { shiftedAt = Date.now(); };
  const settled = () => Date.now() - shiftedAt > 700;
  input.addEventListener('blur', shifted);
  if (window.visualViewport) visualViewport.addEventListener('resize', shifted);
  const setBusy = (b) => { busy = b; ov.classList.toggle('busy', b); };
  const shut = () => {
    alive = false; ov.remove();
    if (window.visualViewport) visualViewport.removeEventListener('resize', shifted);
  };
  close.onclick = shut;

  // ---- the picture: scale s and offset (tx, ty) of the screenshot's own pixels within the stage ----
  let s = 1, tx = 0, ty = 0, W = 0, H = 0, focus = null, fitted = '', unframed = false;
  const apply = () => {
    wrap.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    mark.style.transform = `translate(-50%,-50%) scale(${1 / s})`;
  };
  const fitScale = () => Math.min(stage.clientWidth / W, stage.clientHeight / H);
  const clampScale = (v) => Math.min(Math.max(v, fitScale() * 0.8), 4);
  // Frame the focus (or the whole screen) to fill the stage, centred.
  function fit() {
    unframed = !W || !stage.clientWidth || !stage.clientHeight;
    if (unframed) return;
    const f = focus || { x: 0, y: 0, w: 1, h: 1 };
    const fw = f.w * W, fh = f.h * H;
    s = Math.min(stage.clientWidth / fw, stage.clientHeight / fh);
    tx = (stage.clientWidth - fw * s) / 2 - f.x * W * s;
    ty = (stage.clientHeight - fh * s) / 2 - f.y * H * s;
    apply();
  }
  img.addEventListener('load', () => {
    W = img.naturalWidth; H = img.naturalHeight;
    wrap.style.width = `${W}px`; wrap.style.height = `${H}px`;
    // Framed once per picture size, then left where he put it: a new screenshot of the same screen
    // keeps his zoom and position.
    const key = `${W}x${H}`;
    if (fitted !== key) { fitted = key; fit(); }
  });
  // The tab can be hidden when the first picture lands (he is reading the session): frame it once it shows.
  new ResizeObserver(() => { if (unframed) fit(); }).observe(stage);

  const pts = new Map();
  let tapAt = null, pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) tapAt = { x: e.clientX, y: e.clientY };
    else { tapAt = null; startPinch(); }
  });
  function startPinch() {
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, tx, ty };
  }
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const r = stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      s = clampScale(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
      // The screen point that was under the fingers' midpoint stays under it.
      const px = (pinch.mx - r.left - pinch.tx) / pinch.s, py = (pinch.my - r.top - pinch.ty) / pinch.s;
      tx = mx - r.left - px * s; ty = my - r.top - py * s;
      apply();
    } else if (pts.size === 1) {
      if (tapAt && Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) > 8) tapAt = null;
      if (!tapAt) { tx += dx; ty += dy; apply(); }
    }
  });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size < 2) pinch = null;
    if (e.type === 'pointerup' && pts.size === 0 && tapAt) tap(e.clientX, e.clientY);
    if (pts.size === 0) tapAt = null;
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey) {
      const px = (e.clientX - r.left - tx) / s, py = (e.clientY - r.top - ty) / s;
      s = clampScale(s * Math.exp(-e.deltaY / 200));
      tx = e.clientX - r.left - px * s; ty = e.clientY - r.top - py * s;
    } else { tx -= e.deltaX; ty -= e.deltaY; }
    apply();
  }, { passive: false });

  function tap(cx, cy) {
    if (!W) return;
    const r = stage.getBoundingClientRect();
    const x = (cx - r.left - tx) / (s * W), y = (cy - r.top - ty) / (s * H);
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    mark.style.left = `${x * 100}%`; mark.style.top = `${y * 100}%`; mark.classList.add('on');
    act({ kind: 'tap', x, y, ...(onFull ? { full: true } : {}) });
  }

  function paint(v) {
    cur = v;
    note.textContent = v.note || v.target;
    // The whole screen when the hub has it; an older agent sends only the cropped picture.
    const src = v.full || v.img;
    onFull = !!v.full;
    focus = v.full ? v.focus : null;
    if (src && img.getAttribute('src') !== src) img.src = src;
    const sug = JSON.stringify(v.suggest || []);
    if (sug !== suggested) {
      suggested = sug;
      row0.replaceChildren(...(v.suggest || []).map((o) => btn(o.label, () => { input.value = o.text; }, 'ho-chip')));
      row0.hidden = !(v.suggest || []).length;
    }
    if (!['new', 'open'].includes(v.status)) {
      ov.classList.add('ended');
      state.textContent = v.status === 'done' ? 'Done' : v.status === 'cancelled' ? 'Cancelled' : `Failed: ${v.error || ''}`;
      if (mount) setTimeout(() => { shut(); if (onEnd) onEnd(); }, 1500);
      else if (!page) setTimeout(shut, 1500);
    }
  }

  async function act(body) {
    if (busy || !cur || cur.status !== 'open') return;
    setBusy(true);
    try {
      const r = await fetch(`/api/handoffs/${id}/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, seq: cur.seq }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (j.handoff) paint(j.handoff); state.textContent = j.error || `error ${r.status}`; setBusy(false); }
    } catch (e) { state.textContent = String(e.message || e); setBusy(false); }
  }

  row1.append(input, btn('Type', () => {
    if (!input.value) return;
    const text = input.value; input.value = '';
    act({ kind: 'text', text });
  }, 'ho-go'));
  row2.append(
    btn('Enter', () => act({ kind: 'key', key: 'enter' })),
    btn('Tab', () => act({ kind: 'key', key: 'tab' })),
    btn('Refresh', () => act({ kind: 'refresh' })),
    btn('Cancel', () => { if (settled()) act({ kind: 'cancel' }); }),
    btn('Done', () => { if (settled()) act({ kind: 'done' }); }, 'ho-done'),
  );

  (async () => {
    let after = -1;
    while (alive) {
      try {
        const r = await fetch(`/api/handoffs/${id}?after=${after}&wait=${after < 0 ? 0 : 40}`);
        if (!r.ok) { state.textContent = `error ${r.status}`; return; }
        const v = await r.json();
        if (v.seq > after) { after = v.seq; mark.classList.remove('on'); setBusy(false); }
        paint(v);
        if (!['new', 'open'].includes(v.status)) return;
      } catch (_) {
        // The connection dropped (the phone slept, or lost signal). Ask again once it is back.
        await new Promise((ok) => (navigator.onLine ? setTimeout(ok, 2000) : addEventListener('online', ok, { once: true })));
      }
    }
  })();
  return shut;
}
