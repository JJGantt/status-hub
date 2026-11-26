// THE TAP SCREEN for a handoff (routes/handoffs.js, docs/HANDOFFS.md): the screenshot of the screen a
// session is stuck on, where a tap is clicked on the real screen and the text box is typed there. In the
// phone app it lives in a TAB of its session's view (cards/repos.js, `mount`), so he can switch back to
// the conversation to read something off it and return; elsewhere it is a full-screen overlay, or its
// own page (/handoff/:id). It follows the handoff with a held request per screenshot, never a timer.

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
  const row1 = h('div', 'ho-row');
  const row2 = h('div', 'ho-row');
  const state = h('div', 'ho-state');
  bar.append(row1, row2, state);
  ov.append(top, stage, bar);
  (mount || document.body).append(ov);

  let cur = null, busy = false, alive = true, zoom = false;
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

  function paint(v) {
    cur = v;
    note.textContent = v.note || v.target;
    if (v.img && img.getAttribute('src') !== v.img) img.src = v.img;
    view.hidden = !v.framed;
    view.textContent = v.whole ? 'Crop' : 'Full';
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

  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    mark.style.left = `${x * 100}%`; mark.style.top = `${y * 100}%`; mark.classList.add('on');
    act({ kind: 'tap', x, y });
  });

  row1.append(input, btn('Type', () => {
    if (!input.value) return;
    const text = input.value; input.value = '';
    act({ kind: 'text', text });
  }, 'ho-go'));
  const view = btn('Full', () => act({ kind: 'view' }));
  view.hidden = true;
  row2.append(
    view,
    btn('Enter', () => act({ kind: 'key', key: 'enter' })),
    btn('Tab', () => act({ kind: 'key', key: 'tab' })),
    btn('Zoom', () => { zoom = !zoom; ov.classList.toggle('zoom', zoom); }),
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
