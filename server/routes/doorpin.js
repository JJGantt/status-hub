'use strict';
// PIN unlock by text or email (docs/DOOR.md § PIN by text or email). Messages arrive from the
// hub's own Gmail watch (routes/gmailpush.js, which needs nothing but Fly), the Mac's text watcher
// (data-layer presence/textpin.py) and the Gmail watchers on the Mac and the Pi (gmail-watcher
// handlers/doorpin.py); this decides. One PIN starts a lobby race for the main
// entrance, the other unlocks the apartment door. The PINs are kept only as keyed hashes
// (app_settings.door_pins, keyed by the Fly secret DOOR_PIN_PEPPER), and every message is logged in
// door_pin_messages by outcome, never by content.
const express = require('express');
const ops = require('../lib/report');
const { fromText, fromEmail, keyed, doorFor, readPins, DIGITS } = require('../lib/doorpin');

const SOURCES = ['imessage', 'email'];

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL, gated, pushAll, sb, startRace, unlockFront } = ctx;
  const PEPPER = process.env.DOOR_PIN_PEPPER || '';
  const report = (msg) => ops.report(msg, { service: 'status-hub:doorpin' });
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  if (!PEPPER) console.error('[doorpin] DOOR_PIN_PEPPER not set; PIN unlock by text or email is off');

  async function setting(key) {
    const row = (await sb(`app_settings?select=value&key=eq.${key}`))[0];
    return row ? row.value : null;
  }
  async function putSetting(key, value) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, { method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key, value }) });
    if (!r.ok) throw new Error(`app_settings ${key}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }
  // The log row, claimed before anything happens: false when this message was already handled (both
  // machines' Gmail watchers, a Pub/Sub redelivery, a restarted text watcher).
  async function claim(row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/door_pin_messages?on_conflict=source,message_id`, { method: 'POST',
      headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`door_pin_messages: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return (await r.json())[0] || null;
  }
  async function setOutcome(id, outcome) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/door_pin_messages?id=eq.${id}`, { method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ outcome }) });
    if (!r.ok) throw new Error(`door_pin_messages outcome: ${r.status}`);
  }
  const push = (title, body) => pushAll('door', title, body).catch((e) => console.error('[doorpin] push failed:', e));

  // Decide one PIN-shaped message: { source, message_id, sender, pin } -> outcome (lobby, front, wrong,
  // duplicate). Throws when the door command or the log write fails.
  async function handlePin({ source, message_id, sender, pin }) {
    const via = `${source === 'email' ? 'Email' : 'Text'} from ${sender || 'unknown'}`;
    if (!PEPPER) throw new Error('DOOR_PIN_PEPPER is not set');
    const door = doorFor(pin, readPins(await setting('door_pins')), PEPPER);
    const outcome = door || 'wrong';
    const row = await claim({ source, message_id: String(message_id).slice(0, 200), sender: sender ? String(sender).slice(0, 120) : null, outcome });
    if (!row) return 'duplicate';
    if (outcome === 'wrong') { push('Wrong door PIN', via); return outcome; }
    try {
      if (door === 'lobby') await startRace(`pin:${source}`, 'main');
      else await unlockFront(`pin:${source}`);
    } catch (e) {
      await setOutcome(row.id, 'failed').catch((e2) => console.error('[doorpin] recording a failure failed:', e2));
      push(door === 'lobby' ? 'Lobby PIN failed' : 'Door PIN failed', via);
      throw e;
    }
    push(door === 'lobby' ? 'Lobby PIN used' : 'Door PIN used', via);
    console.log(`[doorpin] ${door} opened by ${source} from ${sender}`);
    return door;
  }

  // The Mac's text watcher and the Gmail watchers on the Mac and the Pi.
  gated.post('/api/door/pin', express.json(), async (req, res) => {
    const b = req.body || {};
    if (!SOURCES.includes(b.source) || typeof b.message_id !== 'string' || !b.message_id) {
      return res.status(400).json({ error: 'source (imessage or email) and message_id are required' });
    }
    const pin = b.source === 'email' ? fromEmail(b.subject, b.body) : fromText(b.text);
    if (!pin) return res.json({ outcome: 'ignored' });
    try {
      res.json({ outcome: await handlePin({ source: b.source, message_id: b.message_id, sender: b.sender, pin }) });
    } catch (e) {
      console.error(`[doorpin] ${b.source} PIN message failed:`, e);
      report(`PIN unlock by ${b.source} failed: ${e.message || e}`);
      res.status(502).json({ error: 'failed' });
    }
  });

  // Set one door's PIN ({ door: lobby | front, pin }), stored only as its keyed hash.
  gated.post('/api/door/pin/set', express.json(), async (req, res) => {
    const { door, pin } = req.body || {};
    if (!['lobby', 'front'].includes(door) || typeof pin !== 'string' || !DIGITS.test(pin)) {
      return res.status(400).json({ error: 'door (lobby or front) and a 4-12 digit pin are required' });
    }
    try {
      if (!PEPPER) throw new Error('DOOR_PIN_PEPPER is not set');
      const hashes = readPins(await setting('door_pins'));
      const other = door === 'lobby' ? 'front' : 'lobby';
      if (hashes[other] && hashes[other] === keyed(PEPPER, pin)) return res.status(400).json({ error: `that is the ${other} PIN` });
      hashes[door] = keyed(PEPPER, pin);
      await putSetting('door_pins', JSON.stringify(hashes));
      res.json({ ok: true, door });
    } catch (e) {
      console.error('[doorpin] setting a PIN failed:', e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  gated.get('/api/door/pin/messages', async (req, res) => {
    try {
      res.json({ messages: await sb('door_pin_messages?select=at,source,sender,outcome&order=at.desc&limit=20') });
    } catch (e) { console.error('[doorpin] reading messages failed:', e); res.status(502).json({ error: 'unreachable' }); }
  });

  return { handlePin };
};
