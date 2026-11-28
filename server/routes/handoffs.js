'use strict';
const express = require('express');
const { fail, logged } = require('../lib/httpfail');

// HANDOFFS: a session stuck on something only Jared can do hands him the screen (docs/HANDOFFS.md).
//
// data-layer's request_handoff inserts a `handoffs` row; the agent on the machine that owns the screen
// screenshots it and marks it open. From then on this is what the phone and the watch talk to:
//
//   GET  /api/handoffs/:id?after=<seq>&wait=<s>   the handoff, held until its screenshot is newer than
//                                                 `after` or it has ended (a held request answered by
//                                                 the agent's update, not a poll)
//   POST /api/handoffs/:id/act                    a tap (x, y as fractions of the screenshot, or of the
//                                                 whole screen with `full`), text, a
//                                                 key, refresh, view (crop ⇄ whole), done or cancel →
//                                                 a handoff_actions row
//   GET  /handoff/:id                             the tap page, for a browser or a notification tap
//
// An open handoff is also ON ITS SESSION (`openFor`, in the session payload), so the phone's and the
// watch's session views show it for as long as it waits, as a permission prompt is shown.
const COLS = 'id,session,target,note,status,image,seq,width,height,taps,typed,error,updated_at,region,selector,whole,full_image,focus,suggest,driver';
const view = (r) => r && {
  id: r.id, session: r.session, target: r.target, note: r.note, status: r.status, seq: r.seq,
  img: r.image ? `/img/${r.image}` : null, width: r.width, height: r.height, error: r.error,
  // `img` is cropped to the part that matters (a region or an element), for the watch; `whole` is his
  // toggle there to see it all. The phone shows `full`, the whole screen, framed on `focus` (fractions
  // of it), and pinches out to the rest.
  framed: !!(r.region || r.selector), whole: !!r.whole,
  full: r.full_image ? `/img/${r.full_image}` : null, focus: r.focus || null,
  // Values the session knows he will type (his email, a card number): buttons that fill his text box.
  suggest: Array.isArray(r.suggest) ? r.suggest : [],
};
const KINDS = ['tap', 'text', 'key', 'refresh', 'view', 'done', 'cancel'];
const KEYS = ['enter', 'tab', 'backspace', 'escape'];

module.exports = function ({ gated, pushAll, pushSessions, sb, sbInsert }) {
  const open = new Map();      // id -> row, for every handoff not yet ended
  const waiters = new Map();   // id -> Set<fn>

  const wake = (id) => {
    const ws = waiters.get(id);
    if (!ws) return;
    waiters.delete(id);
    for (const w of ws) w();
  };

  // The newest open handoff a session row is waiting on, for the session payload.
  function openFor(sessionId) {
    let best = null;
    for (const r of open.values()) {
      if (r.session === sessionId && r.status === 'open' && (!best || r.updated_at > best.updated_at)) best = r;
    }
    return view(best);
  }

  async function sessionName(id) {
    if (!id) return null;
    try {
      const rows = await sb(`desk_sessions?id=eq.${encodeURIComponent(id)}&select=label,repo`);
      return rows[0] ? (rows[0].label || rows[0].repo) : null;
    } catch (e) { console.error(`[handoff] session ${id} name read failed:`, e); return null; }
  }

  // Every change to a handoffs row, from realtime. The first screenshot is when he is asked.
  function changed(row) {
    if (!row || !row.id) return;
    const before = open.get(row.id);
    if (['done', 'cancelled', 'failed'].includes(row.status)) open.delete(row.id);
    else open.set(row.id, row);
    wake(row.id);
    // A screen a session drives itself (driver 'session') is pushed too: he sees it is being worked and can
    // watch, though nothing is asked of him. Its note says what the session is doing there.
    // A drive handed over in place (data-layer requestHandoff) is pushed again: it is now his to act on.
    // That push is a second delivery of the same handoff, so it carries its own dedupe key.
    const handedOver = before && before.driver === 'session' && !row.driver;
    if (row.status === 'open' && (!before || before.status !== 'open' || handedOver)) {
      sessionName(row.session).then((name) => pushAll('handoff', name || 'Handoff', row.note || row.target,
        handedOver ? `handoff-${row.id}-handover-${row.updated_at}` : `handoff-${row.id}`, { payload: { handoff_id: row.id, ...(row.session ? { session_id: row.session } : {}) } }))
        .catch((e) => console.error(`[handoff] push for ${row.id} failed: ${e.message || e}`));
    }
    if (row.session && (row.status !== before?.status || row.seq !== before?.seq)) pushSessions();
  }

  async function load() {
    try {
      const rows = await sb(`handoffs?status=in.(new,open)&select=${COLS}`);
      for (const r of rows || []) open.set(r.id, r);
    } catch (e) { console.error(`[handoff] could not load open handoffs: ${e.message || e}`); }
  }
  load();

  async function read(id) {
    const rows = await sb(`handoffs?id=eq.${encodeURIComponent(id)}&select=${COLS}`);
    return rows && rows[0];
  }

  const uuidOk = (id) => /^[0-9a-f-]{36}$/i.test(id);

  gated.get('/api/handoffs/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).json({ error: 'bad id' });
    const after = Number(req.query.after ?? -1);
    const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 45) * 1000;
    const answer = async () => {
      const r = await read(id);
      if (!r) return res.status(404).json({ error: 'no such handoff' });
      res.json(view(r));
    };
    try {
      const r = await read(id);
      if (!r) return res.status(404).json({ error: 'no such handoff' });
      if (!wait || r.seq > after || !['new', 'open'].includes(r.status)) return res.json(view(r));
      // Held until the agent's next screenshot or the end; the timer only bounds the request, and the
      // client asks again with the same `after`.
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(t); answer().catch((e) => fail(res, e, 502, '')); };
      const t = setTimeout(done, wait);
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(done);
      req.on('close', () => { waiters.get(id)?.delete(done); settled = true; clearTimeout(t); });
    } catch (e) {
      console.error(`[handoff] read ${id} failed: ${e.message || e}`);
      logged(res).status(502).json({ error: 'could not read handoff' });
    }
  });

  gated.post('/api/handoffs/:id/act', express.json({ limit: '16kb' }), async (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).json({ error: 'bad id' });
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad kind' });
    // The device it came from (the phone's web view, the watch app, a browser), kept on the row so an
    // action nobody remembers sending can be traced.
    const row = { handoff: id, kind, seq: Number.isInteger(b.seq) ? b.seq : null,
      source: String(req.get('user-agent') || '').slice(0, 200) || null };
    if (kind === 'tap') {
      const x = Number(b.x), y = Number(b.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return res.status(400).json({ error: 'x and y are fractions 0-1' });
      // `full`: measured on the whole-screen picture (the phone), not the cropped one (the watch).
      Object.assign(row, { x, y, full: b.full === true });
    }
    if (kind === 'text') {
      if (typeof b.text !== 'string' || !b.text.length) return res.status(400).json({ error: 'text required' });
      row.text = b.text.slice(0, 2000);
    }
    if (kind === 'key') {
      if (!KEYS.includes(b.key)) return res.status(400).json({ error: 'bad key' });
      row.key = b.key;
    }
    try {
      const h = await read(id);
      if (!h) return res.status(404).json({ error: 'no such handoff' });
      if (h.status !== 'open') return res.status(409).json({ error: `handoff is ${h.status}`, handoff: view(h) });
      if (!(await sbInsert('handoff_actions', { ...row, target: h.target }))) throw new Error('insert into handoff_actions failed');
      res.json({ ok: true, seq: h.seq });
    } catch (e) {
      console.error(`[handoff] action on ${id} not recorded: ${e.message || e}`);
      logged(res).status(502).json({ error: 'could not record the action' });
    }
  });

  gated.get('/handoff/:id', (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).type('text').send('bad id');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(`<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Handoff</title><link rel=stylesheet href="/app.css"></head>
<body class=handoff-page><script type=module src="/dist/handoff.js"></script></body></html>`);
  });

  return { changed, openFor };
};
