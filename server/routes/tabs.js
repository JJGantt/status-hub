'use strict';
const express = require('express');
const { WebSocketServer } = require('ws');
const upgrade = require('../lib/upgrade');
const { createRelay } = require('../lib/liverelay');
const { REPORT_CSP, REPORT_CSS } = require('../lib/untrusted');

// SESSION TABS (docs/SESSION-TABS.md): what a session shows beside its conversation in the phone's session
// view. A `session_tabs` row is one tab; the hub keeps every OPEN one in memory (loaded at start, kept by
// realtime) and puts a session's on its row in the session payload (`tabsFor`), as it does a handoff.
//
//   GET  /api/tabs/:id                 a content tab, with its body (the payload carries only the head)
//   GET  /tab/:id                      an HTML tab's page, sandboxed (lib/untrusted.js)
//   POST /api/tabs/chrome/claim        the chrome-tabs hook: { conversation, machine, targets: [tab ids] }
//   POST /api/tabs/chrome/release      the chrome-tabs hook at session end: { conversation, machine }
//   WS   /api/live/agent               a machine's browser extension (lib/liverelay.js); the first message
//                                      is `{ op: 'hello', machine, token }`, the device token
//   WS   /api/live/view?tab=<id>       a phone watching a live Chrome tab
const COLS = 'id,conversation,kind,title,format,image,machine,target,url,created_at,updated_at,closed_at';
const MACHINES = ['mac', 'pi'];
const HELLO_MS = 5000;
// Fly's proxy closes a socket idle for 60s, and an MV3 extension's service worker is stopped after 30s
// with no message: this keeps both open while the agent has nothing to send.
const AGENT_PING_MS = 20000;

module.exports = function ({ auth, gated, pushSessions, sb, sbWrite }) {
  const open = new Map();   // id -> row, every open tab

  const head = (r) => ({
    id: r.id, kind: r.kind, title: r.title, v: r.updated_at,
    ...(r.kind === 'content' ? { format: r.format, img: r.image ? `/img/${r.image}` : null } : { machine: r.machine, url: r.url }),
  });

  /** A conversation's open tabs, oldest first, for its row in the session payload. */
  function tabsFor(conversation) {
    const out = [];
    for (const r of open.values()) if (r.conversation === conversation) out.push(r);
    return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(head);
  }

  const chromeRows = () => [...open.values()].filter((r) => r.kind === 'chrome');

  async function closeChrome(machine, target) {
    const hit = chromeRows().filter((r) => r.machine === machine && String(r.target) === String(target));
    if (!hit.length) return;
    await sbWrite(`session_tabs?id=in.(${hit.map((r) => r.id).join(',')})`, 'PATCH', { closed_at: new Date().toISOString() });
  }

  async function metaChrome(machine, target, { title, url }) {
    const row = chromeRows().find((r) => r.machine === machine && String(r.target) === String(target));
    if (!row) return;
    const t = String(title || '').slice(0, 200) || null, u = String(url || '').slice(0, 2000) || null;
    if (row.title === t && row.url === u) return;
    await sbWrite(`session_tabs?id=eq.${row.id}`, 'PATCH', { title: t, url: u, updated_at: new Date().toISOString() });
  }

  const relay = createRelay({ rows: chromeRows, closeTab: closeChrome, meta: metaChrome });

  // Every change to a session_tabs row, from realtime.
  function changed(row) {
    if (!row || !row.id) return;
    const before = open.get(row.id);
    if (row.closed_at) open.delete(row.id); else open.set(row.id, row);
    if (!before && row.closed_at) return;
    if (row.kind === 'chrome') relay.tabsChanged();
    pushSessions();
  }

  async function load() {
    try {
      const rows = await sb(`session_tabs?closed_at=is.null&select=${COLS}`);
      for (const r of rows || []) open.set(r.id, r);
      relay.tabsChanged();
    } catch (e) { console.error(`[tabs] could not load open tabs: ${e.message || e}`); }
  }
  load();

  const uuidOk = (id) => /^[0-9a-f-]{36}$/i.test(id);

  async function readTab(id) {
    const rows = await sb(`session_tabs?id=eq.${encodeURIComponent(id)}&select=${COLS},body`);
    return rows && rows[0];
  }

  gated.get('/api/tabs/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).json({ error: 'bad id' });
    try {
      const r = await readTab(id);
      if (!r) return res.status(404).json({ error: 'no such tab' });
      res.json({ ...head(r), closed: !!r.closed_at, body: r.format === 'markdown' ? r.body : null });
    } catch (e) {
      console.error(`[tabs] read ${id} failed: ${e.message || e}`);
      res.status(502).json({ error: 'could not read the tab' });
    }
  });

  gated.get('/tab/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).type('text').send('bad id');
    let r;
    try { r = await readTab(id); } catch (e) { return res.status(502).type('text').send('could not read the tab'); }
    if (!r || r.format !== 'html') return res.status(404).type('text').send('no such page');
    res.setHeader('Content-Security-Policy', REPORT_CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(`<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><style>${REPORT_CSS}</style></head><body>
${r.body || ''}
</body></html>`);
  });

  const claimBody = (b) => {
    const conversation = String(b.conversation || '').trim();
    const machine = String(b.machine || '');
    if (!conversation || conversation.length > 100) return null;
    if (!MACHINES.includes(machine)) return null;
    return { conversation, machine };
  };

  gated.post('/api/tabs/chrome/claim', express.json({ limit: '16kb' }), async (req, res) => {
    const c = claimBody(req.body || {});
    const targets = [...new Set((req.body?.targets || []).map(String).filter((t) => /^\d{1,12}$/.test(t)))];
    if (!c || !targets.length) return res.status(400).json({ error: 'conversation, machine and targets required' });
    const have = new Set(chromeRows().filter((r) => r.machine === c.machine).map((r) => String(r.target)));
    const fresh = targets.filter((t) => !have.has(t));
    try {
      // The unique index on open (machine, target) turns a claim racing another into a 409, which is fine:
      // the tab is claimed either way.
      for (const target of fresh) {
        await sbWrite('session_tabs', 'POST', { conversation: c.conversation, kind: 'chrome', machine: c.machine, target })
          .catch((e) => { if (!/-> 409/.test(e.message)) throw e; });
      }
      res.json({ ok: true, claimed: fresh.length });
    } catch (e) {
      console.error(`[tabs] chrome claim failed: ${e.message || e}`);
      res.status(502).json({ error: 'could not claim' });
    }
  });

  gated.post('/api/tabs/chrome/release', express.json({ limit: '4kb' }), async (req, res) => {
    const c = claimBody(req.body || {});
    if (!c) return res.status(400).json({ error: 'conversation and machine required' });
    const ids = chromeRows().filter((r) => r.conversation === c.conversation && r.machine === c.machine).map((r) => r.id);
    try {
      if (ids.length) await sbWrite(`session_tabs?id=in.(${ids.join(',')})`, 'PATCH', { closed_at: new Date().toISOString() });
      res.json({ ok: true, closed: ids.length });
    } catch (e) {
      console.error(`[tabs] chrome release failed: ${e.message || e}`);
      res.status(502).json({ error: 'could not release' });
    }
  });

  // ---- the live relay's sockets ------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  // An extension cannot set a header on a WebSocket, so the agent authenticates in its first message,
  // never in the URL (a token there ends up in proxy logs).
  upgrade.register('/api/live/agent', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      let machine = null;
      const hello = setTimeout(() => { if (!machine) ws.close(4001, 'no hello'); }, HELLO_MS);
      const ping = setInterval(() => { try { ws.send('{"op":"ping"}'); } catch (_) {} }, AGENT_PING_MS);
      ws.on('message', (data, isBinary) => {
        if (machine) return relay.agentMessage(machine, data, isBinary);
        let m;
        try { m = JSON.parse(String(data)); } catch (_) { return ws.close(4001, 'bad hello'); }
        if (m.op !== 'hello' || !MACHINES.includes(m.machine) || !auth.isDeviceToken(String(m.token || ''))) {
          console.error(`[live] refused a browser extension's hello (machine ${String(m.machine).slice(0, 20)})`);
          return ws.close(4001, 'refused');
        }
        machine = m.machine;
        clearTimeout(hello);
        console.log(`[live] the ${machine}'s browser extension connected`);
        relay.addAgent(machine, ws);
      });
      ws.on('close', () => {
        clearTimeout(hello); clearInterval(ping);
        if (machine) { console.log(`[live] the ${machine}'s browser extension disconnected`); relay.dropAgent(machine, ws); }
      });
      ws.on('error', () => {});
    });
  });

  upgrade.register('/api/live/view', (req, socket, head) => {
    if (!auth.authed(req)) return upgrade.refuse(socket);
    const id = new URL(req.url, 'http://x').searchParams.get('tab') || '';
    if (!uuidOk(id)) return upgrade.refuse(socket, 400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!relay.addViewer(id, ws)) return;
      // A page that is not changing sends no frames, and Fly's proxy closes a socket idle for 60s.
      const ping = setInterval(() => { try { ws.ping(); } catch (_) {} }, AGENT_PING_MS);
      ws.on('message', (data, isBinary) => { if (!isBinary) relay.viewerMessage(id, data); });
      ws.on('close', () => { clearInterval(ping); relay.dropViewer(id, ws); });
      ws.on('error', () => {});
    });
  });

  return { changed, tabsFor };
};
