'use strict';
const crypto = require('crypto');
const express = require('express');
const { fail, logged } = require('../lib/httpfail');

// LIVE SCREEN SHARE (docs/SCREEN.md): the Mac's whole screen streamed to the phone over WebRTC, his taps
// and typing sent back on a data channel. The hub only signals: the media goes peer to peer, or through
// the TURN relay on Fly (`jared-turn`, status-hub turn/) when the two cannot reach each other.
//
//   GET  /api/screen/ice                     the ICE servers, with short-lived TURN credentials
//   POST /api/screen                         {offer, session?, handoff?} → {id}: a screen_shares row,
//                                            which the Mac's screen agent (data-layer) claims and answers
//   GET  /api/screen/:id?wait=<s>            the share, held until the Mac has answered or it has ended
//                                            (a held request woken by realtime, not a poll)
//   POST /api/screen/:id/stats               the phone's receiving counters, at the end
const COLS = 'id,created_at,status,answer,path,first_frame_ms,connect_ms,ended_reason,error';
/** How long the Mac has to answer before the phone is told it is not answering. */
const ANSWER_MS = 20_000;
/** TURN credentials last this long: a share outlives none of them. */
const CRED_S = 12 * 3600;

module.exports = function ({ gated, sb, sbInsert, sbWrite }) {
  const SECRET = process.env.TURN_SECRET, HOST = process.env.TURN_HOST;
  if (!SECRET || !HOST) console.error('[screen] TURN_SECRET or TURN_HOST is not set: shares will connect only where the two ends can reach each other');

  // TURN's REST credential scheme (coturn use-auth-secret): the username is an expiry, the password its
  // HMAC under the shared secret, so the relay checks it with no list of users.
  function iceServers(who) {
    if (!SECRET || !HOST) return [];
    const username = `${Math.floor(Date.now() / 1000) + CRED_S}:${who}`;
    const credential = crypto.createHmac('sha1', SECRET).update(username).digest('base64');
    return [
      { urls: [`stun:${HOST}:3478`] },
      { urls: [`turn:${HOST}:3478?transport=udp`, `turn:${HOST}:3478?transport=tcp`, `turn:${HOST}:443?transport=tcp`], username, credential },
    ];
  }

  const waiters = new Map();   // id -> Set<fn>
  const wake = (id) => {
    const ws = waiters.get(id);
    if (!ws) return;
    waiters.delete(id);
    for (const w of ws) w();
  };
  // Every change to a screen_shares row, from realtime.
  function changed(row) { if (row && row.id) wake(row.id); }

  async function read(id) {
    const rows = await sb(`screen_shares?id=eq.${encodeURIComponent(id)}&select=${COLS}`);
    return rows && rows[0];
  }
  const uuidOk = (id) => /^[0-9a-f-]{36}$/i.test(id);

  gated.get('/api/screen/ice', (req, res) => res.json({ iceServers: iceServers('phone') }));

  gated.post('/api/screen', express.json({ limit: '64kb' }), async (req, res) => {
    const b = req.body || {};
    if (typeof b.offer !== 'string' || !b.offer.startsWith('v=')) return res.status(400).json({ error: 'offer required' });
    const id = crypto.randomUUID();
    try {
      const ok = await sbInsert('screen_shares', {
        id, target: 'mac', offer: b.offer, ice: iceServers('mac'),
        session: typeof b.session === 'string' ? b.session.slice(0, 64) : null,
        handoff: typeof b.handoff === 'string' && uuidOk(b.handoff) ? b.handoff : null,
        source: String(req.get('user-agent') || '').slice(0, 200) || null,
      });
      if (!ok) throw new Error('insert into screen_shares failed');
    } catch (e) {
      console.error(`[screen] could not record a share: ${e.message || e}`);
      return logged(res).status(502).json({ error: 'could not start the share' });
    }
    // A share asked for is answered by the Mac or it is reported: the Mac asleep, its agent down, or
    // its realtime channel deaf all look the same from here, and all of them leave the phone waiting.
    setTimeout(async () => {
      try {
        const r = await read(id);
        if (r && r.status === 'new') console.error(`[screen] share ${id} was not answered within ${ANSWER_MS / 1000}s: the Mac's screen agent did not take it`);
      } catch (e) { console.error(`[screen] checking share ${id} was answered failed:`, e); }
    }, ANSWER_MS + 2000).unref();
    res.json({ id });
  });

  gated.get('/api/screen/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).json({ error: 'bad id' });
    const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 30) * 1000;
    try {
      const r = await read(id);
      if (!r) return res.status(404).json({ error: 'no such share' });
      if (!wait || r.status !== 'new') return res.json(r);
      let settled = false;
      const done = () => {
        if (settled) return; settled = true; clearTimeout(t);
        read(id).then((x) => res.json(x || r)).catch((e) => fail(res, e, 502, ''));
      };
      const t = setTimeout(done, wait);
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(done);
      req.on('close', () => { waiters.get(id)?.delete(done); settled = true; clearTimeout(t); });
    } catch (e) {
      console.error(`[screen] read ${id} failed: ${e.message || e}`);
      logged(res).status(502).json({ error: 'could not read the share' });
    }
  });

  gated.post('/api/screen/:id/stats', express.json({ limit: '16kb' }), async (req, res) => {
    const id = String(req.params.id);
    if (!uuidOk(id)) return res.status(400).json({ error: 'bad id' });
    const s = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      await sbWrite(`screen_shares?id=eq.${id}`, 'PATCH', { phone_stats: s, updated_at: new Date().toISOString() });
      res.json({ ok: true });
    } catch (e) {
      console.error(`[screen] stats for ${id} not recorded: ${e.message || e}`);
      return logged(res).status(502).json({ error: 'could not record' });
    }
    // Getting slower is a failure too: the time from asking to a picture on the phone, against this
    // share's own recent history.
    if (!(s.first_picture_ms > 0)) return;
    try {
      const past = await sb('screen_shares?phone_stats=not.is.null&order=created_at.desc&limit=21&select=id,phone_stats');
      const xs = past.filter((p) => p.id !== id).map((p) => p.phone_stats && p.phone_stats.first_picture_ms).filter((x) => x > 0).sort((a, b) => a - b);
      if (xs.length >= 5) {
        const median = xs[Math.floor(xs.length / 2)];
        if (s.first_picture_ms > 3 * median) console.error(`[screen] share ${id} took ${s.first_picture_ms} ms to its first picture, against a median of ${median} ms over the last ${xs.length}`);
      }
    } catch (e) { console.error(`[screen] could not compare share ${id} with its history: ${e.message || e}`); }
  });

  return { changed };
};
