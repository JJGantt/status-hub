'use strict';
// The hub's own watch on Gmail, so a PIN by email needs nothing but Fly (docs/DOOR.md § PIN by text or
// email). Gmail publishes every mailbox change to the Pub/Sub topic gmail-watcher registered
// (users.watch); the push subscription gmail-watch-hub delivers each one here, authenticated by the
// secret path segment GMAIL_PUSH_TOKEN. A notification carries only a historyId: the messages added since
// the stored cursor (app_settings.hub_gmail_history) are read and every one whose whole content is
// digits goes to the PIN check. The hub renews users.watch itself every day, so a PIN email keeps
// arriving with the Mac and the Pi both off.
const crypto = require('crypto');
const express = require('express');
const ops = require('../lib/report');
const gmail = require('../lib/gmail');
const { fromEmail } = require('../lib/doorpin');

const TOPIC = 'projects/status-hub-507320/topics/gmail-watch';
const RENEW_MS = 24 * 3600e3;
const CURSOR = 'hub_gmail_history';

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL, handlePin, pub, sb } = ctx;
  const TOKEN = process.env.GMAIL_PUSH_TOKEN || '';
  const report = (msg) => ops.report(msg, { service: 'status-hub:gmailpush' });
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  async function getCursor() {
    const row = (await sb(`app_settings?select=value&key=eq.${CURSOR}`))[0];
    return row && row.value ? String(row.value) : null;
  }
  async function putCursor(v) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, { method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: CURSOR, value: String(v) }) });
    if (!r.ok) throw new Error(`app_settings ${CURSOR}: ${r.status}`);
  }

  // Every message added since the cursor, then the cursor moved to `upTo`. One at a time: notifications
  // arrive in bursts and two readers from one cursor would hand the same mail over twice (harmless, as the
  // PIN log dedupes by message id, but wasted calls).
  let chain = Promise.resolve();
  const catchUp = (upTo) => (chain = chain.then(() => readSince(upTo)).catch((e) => {
    console.error('[gmailpush] reading new mail failed:', e);
    report(`Hub Gmail watch: reading new mail failed: ${e.message || e}`);
  }));

  async function readSince(upTo) {
    const start = await getCursor();
    if (!start) { await putCursor(upTo); console.log(`[gmailpush] cursor started at ${upTo}`); return; }
    const ids = new Set();
    let page = '', latest = start;
    try {
      do {
        const h = await gmail.api(`history?startHistoryId=${start}&historyTypes=messageAdded${page ? `&pageToken=${page}` : ''}`);
        for (const rec of h.history || []) for (const a of rec.messagesAdded || []) ids.add(a.message.id);
        if (h.historyId) latest = h.historyId;
        page = h.nextPageToken || '';
      } while (page);
    } catch (e) {
      // A cursor Gmail no longer holds (about a week old) answers 404: start again from now.
      if (e.status !== 404) throw e;
      await putCursor(upTo);
      report(`Hub Gmail watch: history cursor ${start} expired; restarted at ${upTo}, mail in between was not checked`);
      return;
    }
    for (const id of ids) {
      let m;
      try { m = gmail.parseMessage(await gmail.api(`messages/${id}?format=full`)); }
      catch (e) { if (e.status === 404) continue; throw e; }
      if (m.labels.includes('DRAFT')) continue;
      const pin = fromEmail(m.subject, m.body);
      if (!pin) continue;
      const outcome = await handlePin({ source: 'email', message_id: id, sender: m.from, pin });
      console.log(`[gmailpush] ${id}: ${outcome}`);
    }
    if (BigInt(latest) > BigInt(start)) await putCursor(latest);
  }

  pub.post('/api/gmail/push/:token', express.json(), async (req, res) => {
    const a = Buffer.from(String(req.params.token)), b = Buffer.from(TOKEN);
    if (!TOKEN || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).end();
    let note;
    try { note = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf8')); }
    catch { return res.status(204).end(); }   // nothing to act on; acking stops Pub/Sub redelivering it
    // Answered before the work: the history cursor, not the redelivery, is what makes it complete.
    res.status(204).end();
    if (note && note.historyId) catchUp(String(note.historyId));
  });

  async function renew() {
    try {
      const w = await gmail.api('watch', { method: 'POST', body: { topicName: TOPIC, labelFilterBehavior: 'include' } });
      if (!(await getCursor())) await putCursor(w.historyId);
      console.log(`[gmailpush] watch renewed until ${new Date(Number(w.expiration)).toISOString()}`);
    } catch (e) {
      console.error('[gmailpush] renewing the Gmail watch failed:', e);
      report(`Hub Gmail watch: renewing users.watch failed: ${e.message || e}`);
    }
  }
  if (!TOKEN || !gmail.configured()) console.error('[gmailpush] GMAIL_PUSH_TOKEN or the Google credentials are not set; the hub is not watching Gmail');
  else { setTimeout(renew, 20e3); setInterval(renew, RENEW_MS); }
};
