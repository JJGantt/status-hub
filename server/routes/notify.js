'use strict';
const apns = require('../lib/apns');
const express = require('express');

module.exports = function (ctx) {
  const {
    TV_TOKEN, auth, etNowString, gated, lateMoment, sb, sbInsert,
  } = ctx;

  // Native push to Jared's phone (APNs), ad-hoc text. The voice worker POSTs its failure alerts here;
  // orchestrator answers are pushed by `notifyAnswer`, not through this. Gated on the kiosk
  // token. Fans out to every registered iOS token on its own push environment (sandbox vs production), and logs the result to `notifications`.
  // Push a notification to every registered iOS device; records one `notifications` row (with an optional
  // dedupe_key so a caller can guarantee once-only delivery). Shared by /api/notify and reminder firing.
  // Every notification from this app shows the SAME icon, so the sound is what tells them apart
  // without looking. Sounds are .caf files bundled in the iOS app (apps/Sounds/); an unknown kind
  // falls back to the system default. 'passive' keeps voice acks from buzzing — they're confirmations
  // you'll read later, not things to interrupt you.
  // Sound distinguishes these by ear, the emoji distinguishes them by eye — the app icon is identical
  // on every one, so without a marker in the title a reminder and a voice confirmation look the same
  // in a stacked list. 'time-sensitive' is what lets a reminder through a Focus; a voice ack is
  // 'passive' so it lands in the list without lighting the screen.
  const NOTIFY_STYLE = {
    reminder: { emoji: '⏰', sound: 'reminder.caf', interruptionLevel: 'time-sensitive' },
    voice:    { emoji: '🎙️', interruptionLevel: 'passive' },
    // A finished piece of dispatched work. 'active' rather than 'time-sensitive': it is worth seeing
    // when you pick the phone up, but a build that finished is not worth breaking a Focus for.
    report:   { emoji: '📄', interruptionLevel: 'active' },
    // A session's finished reply (notifySessionReply). 'active', not 'passive' like a voice ack: it has
    // to reach the watch with its Open button, and a passive one never lights either screen.
    session:  { interruptionLevel: 'active' },
    // An orchestrator answer worth reading (notifyAnswer): lights the wrist, as a session reply does.
    answer:   { interruptionLevel: 'active' },
    // A session blocked on a permission dialog (routes/prompts.js), with Approve / Deny on it.
    // 'active': it has to light the wrist, and a session is stalled until somebody answers.
    prompt:   { interruptionLevel: 'active' },
  };

  // The home-screen badge = every EXPIRED item: not cleared, dated, and past the moment it was FIRST
  // scheduled for — on ANY list. A dated Amazon item counts exactly like a dated todo, because they
  // are the same kind of thing (migration 00056).
  //
  // Measured against `scheduled_at`, not `due`, and that is the whole point: a repeating item's `due`
  // jumps into the future the instant it fires, so counting `due` would empty the badge at exactly the
  // moment the item became outstanding. Expired means "its moment came and it still hasn't been dealt
  // with", which is true of a one-shot and a repeater alike and stops being true only when the item is
  // cleared. Undated items never badge.
  //
  // Returns null if the count can't be read — the push then omits the badge rather than clearing it to
  // a wrong number.
  async function overdueCount() {
    try {
      const rows = await sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=due,scheduled_at,priority');
      const nowET = etNowString();
      // Exempt items (a shift, an appointment) owe nothing, so they can never be overdue and must
      // never badge — a red count he cannot clear by doing anything is just noise.
      return rows.filter((r) => (r.priority || 0) >= 0 && lateMoment(r.scheduled_at || r.due) <= nowET).length;
    } catch (_) { return null; }
  }

  async function pushAll(kind, title, body, dedupe_key, extra = {}) {
    const base = { kind, title, body, ...(dedupe_key ? { dedupe_key } : {}) };
    const { emoji, ...style } = { ...(NOTIFY_STYLE[kind] || {}), ...extra };   // copy: never mutate the shared constant
    if (emoji && !String(title).startsWith(emoji)) title = `${emoji} ${title}`;
    const badge = await overdueCount();
    if (Number.isInteger(badge)) style.badge = badge;
    if (!apns.configured()) { await sbInsert('notifications', { ...base, ok: false, detail: 'apns not configured' }); return { ok: false, detail: 'apns not configured' }; }
    let tokens = [];
    try { tokens = await sb('device_tokens?platform=eq.ios&select=token,environment'); } catch (_) {}
    if (!tokens.length) { await sbInsert('notifications', { ...base, ok: false, detail: 'no device tokens' }); return { ok: false, detail: 'no device tokens' }; }
    const details = []; let anyOk = false;
    for (const { token, environment } of tokens) {
      const r = await apns.send(token, { title, body, environment, ...style });
      if (r.ok) anyOk = true;
      details.push(`${token.slice(0, 8)}=${r.status}${r.ok ? '' : '(' + (r.detail || '').slice(0, 60) + ')'}`);
    }
    await sbInsert('notifications', { ...base, ok: anyOk, detail: details.join(' ') });
    return { ok: anyOk, detail: details.join(' ') };
  }

  gated.post('/api/notify', express.json(), async (req, res) => {
    if (TV_TOKEN && !auth.deviceRequest(req)) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const title = String(b.title || 'Hub').slice(0, 100);
    const body = String(b.body || '').trim().slice(0, 300);
    const kind = String(b.kind || 'voice').slice(0, 40);
    if (!body) return res.status(400).json({ error: 'body required' });
    const r = await pushAll(kind, title, body);
    if (r.detail === 'apns not configured') return res.status(503).json({ error: 'apns not configured' });
    res.json(r);
  });

  return { overdueCount, pushAll };
};
