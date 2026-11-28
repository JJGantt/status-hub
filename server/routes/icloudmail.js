'use strict';
// The hub's watch on his iCloud mailbox, the second email path for a door PIN (docs/DOOR.md § PIN by
// text or email): a PIN emailed to either address works, with nothing but Fly. IMAP IDLE on INBOX and on
// Junk, one connection each (a connection holds one open mailbox), so a new message is pushed to the hub
// the moment iCloud files it; a dropped connection reconnects with backoff. Each new message whose whole
// content is digits goes to the PIN check. Messages are fetched with BODY.PEEK, so nothing here marks
// mail read (the phone's lobby automation fires on the same mailbox).
//
// The cursor is the highest UID seen per mailbox, in app_settings.hub_icloud_uid ({ INBOX: {validity,
// uid}, Junk: ... }); a first start, or a UIDVALIDITY change, begins at the newest message.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const ops = require('../lib/report');
const { fromEmail } = require('../lib/doorpin');

const MAILBOXES = ['INBOX', 'Junk'];
const CURSOR = 'hub_icloud_uid';

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL, handlePin, sb } = ctx;
  const USER = process.env.ICLOUD_EMAIL || '';
  const PASS = process.env.ICLOUD_APP_PASSWORD || '';
  const report = (msg) => ops.report(msg, { service: 'status-hub:icloudmail' });
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  if (!USER || !PASS) { console.error('[icloudmail] ICLOUD_EMAIL / ICLOUD_APP_PASSWORD not set; the hub is not watching iCloud mail'); return; }

  let cursors = null;
  async function loadCursors() {
    if (cursors) return cursors;
    const row = (await sb(`app_settings?select=value&key=eq.${CURSOR}`))[0];
    try { cursors = row && row.value ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {}; } catch { cursors = {}; }
    return cursors;
  }
  async function saveCursors() {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, { method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: CURSOR, value: JSON.stringify(cursors) }) });
    if (!r.ok) throw new Error(`app_settings ${CURSOR}: ${r.status}`);
  }

  function watch(box) {
    let failures = 0;
    let busy = Promise.resolve();

    async function readNew(client) {
      const c = await loadCursors();
      const validity = String(client.mailbox.uidValidity);
      const next = client.mailbox.uidNext;
      const mine = c[box];
      if (!mine || mine.validity !== validity) {
        c[box] = { validity, uid: next - 1 };
        await saveCursors();
        console.log(`[icloudmail] ${box}: cursor started at uid ${next - 1}`);
        return;
      }
      for await (const m of client.fetch(`${mine.uid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (m.uid <= mine.uid) continue;
        const mail = await simpleParser(m.source);
        const pin = fromEmail(mail.subject || '', mail.text || '');
        if (pin) {
          const outcome = await handlePin({ source: 'email', message_id: `icloud:${validity}:${box}:${m.uid}`,
            sender: mail.from ? mail.from.text : null, pin });
          console.log(`[icloudmail] ${box} ${m.uid}: ${outcome}`);
        }
        mine.uid = m.uid;
        await saveCursors();
      }
    }

    async function connect() {
      const client = new ImapFlow({ host: 'imap.mail.me.com', port: 993, secure: true, auth: { user: USER, pass: PASS },
        logger: false, emitLogs: false });
      client.on('error', (e) => console.log(`[icloudmail] ${box} connection error: ${e.message || e}`));
      client.on('exists', () => { busy = busy.then(() => readNew(client)).catch(onReadError); });
      client.on('close', () => reconnect('closed'));
      try {
        await client.connect();
        await client.mailboxOpen(box, { readOnly: true });
        if (failures) console.log(`[icloudmail] ${box}: reconnected after ${failures} failure(s)`);
        failures = 0;
        busy = busy.then(() => readNew(client)).catch(onReadError);   // whatever arrived while disconnected
      } catch (e) {
        client.removeAllListeners('close');
        client.close();
        reconnect(e.message || String(e));
      }
    }
    function onReadError(e) {
      console.error(`[icloudmail] ${box}: reading new mail failed:`, e);
      report(`Hub iCloud mail watch (${box}): reading new mail failed: ${e.message || e}`);
    }
    let pending = null;
    function reconnect(why) {
      if (pending) return;
      failures += 1;
      // Three in a row is a watch that is not coming back by itself.
      if (failures === 3) { console.error(`[icloudmail] ${box}: ${failures} connection failures in a row (${why})`); }
      const wait = Math.min(300e3, 2e3 * 2 ** Math.min(failures, 8));
      pending = setTimeout(() => { pending = null; connect(); }, wait);
    }
    connect();
  }

  setTimeout(() => MAILBOXES.forEach(watch), 15e3);
};
