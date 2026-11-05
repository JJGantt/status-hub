'use strict';
// The hub's scheduled work: dated items coming due, exempt items closing, published reports announced,
// the badge backstop, the retention sweep and the daily weigh-in reminder. One instance, made in
// server.js; `start` arms the timers once the server is listening.
const ops = require('./report');
const weightReminder = require('./weightReminder');
const { taskDeadline } = require('./score');

function createJobs(ctx) {
  const {
    SUPABASE_KEY, SUPABASE_URL, alarmLog, apns, etNowString, itemTitle, pushAll, ringerReport, sb, sbInsert,
    sbWrite, settingsAll, syncBadge,
  } = ctx;

  // ---- reminder firing: app-push a reminder once its due time (local) has passed. Dedupe via a
  // `notifications` row keyed `reminder:<id>` so it fires exactly once. Date-only dues fire at 9am local.
  // A date-only due FIRES at 9am local that day; otherwise the stored local-naive timestamp is the moment.
  // This is when it notifies and nothing else — whether it is late is `lateMoment`.
  function dueMoment(due) {
    const d = String(due);
    return /T\d/.test(d) ? d : d.slice(0, 10) + 'T09:00:00';
  }

  // ---- what happens when a dated item comes due ----
  //
  // The scheduler below finds due items; it does not deliver them. Delivery is a named handler, so a
  // second channel is a new entry here rather than surgery on the loop. Today there is exactly one —
  // APNs.
  //
  // Handlers receive the whole item and the dedupe key. They must be idempotent-safe to skip: the
  // ledger check happens before dispatch, not inside them.
  // A dated item now comes from a named list, so the notification leads with WHICH:
  //
  //     ⏰ Amazon — Order water filter
  //     Order the replacement before the current one runs out
  //
  // One headline, list first, em dash, then what the thing is. The old fixed "Reminder" title carried
  // no information at all — it was only ever there because reminders had no list to come from.
  const listLabel = (name) => {
    const n = String(name || '').trim();
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Reminder';
  };
  const notifyHeadline = (item) => `${listLabel(item.list_name)} \u2014 ${itemTitle(item)}`;

  // The body carries the DETAIL, and only when there is any: itemTitle() is already the short label
  // (the explicit `title`, or the text up to its first em dash), so repeating the whole text under a
  // headline that says the same thing is just noise. Empty is fine — apns.js only treats a push as
  // silent when title AND body are both absent.
  const NOTIFY_BODY_MAX = 180;
  const itemBody = (item) => {
    const full = String(item.text || '').trim();
    const label = itemTitle(item);
    if (!full || full === label) return '';
    // When the label was DERIVED from this text (cut at the first em dash), the body is what the cut
    // removed — not the whole string again with the headline repeated at the front of it.
    const rest = full.startsWith(label) ? full.slice(label.length).replace(/^\s*[\u2014-]\s*/, '').trim() : full;
    if (!rest) return '';
    return rest.length > NOTIFY_BODY_MAX ? rest.slice(0, NOTIFY_BODY_MAX - 1).trimEnd() + '\u2026' : rest;
  };

  const DUE_HANDLERS = {
    // category + the row id give the notification its Done button and tell the
    // app which item an action refers to. `reminder_id` keeps its name: the app's notification
    // actions and the APNs category are built around it, and renaming it would break every
    // notification already sitting in Notification Centre on the phone. An ALARM gets its own
    // category, whose buttons are Stop and Snooze rather than Done (docs/ALARMS.md).
    push: (item, dedupeKey) =>
      // `emoji` overrides NOTIFY_STYLE.reminder's clock — pushAll merges `extra` over the style, so a
      // list's own mark wins and a list without one falls back to ⏰ automatically.
      pushAll('reminder', notifyHeadline(item), itemBody(item), dedupeKey,
              { category: item.alarm ? 'ALARM' : 'REMINDER', payload: { reminder_id: item.id },
                ...(item.emoji ? { emoji: item.emoji } : {}) }),
  };

  // THE NEXT MOMENT anything here has to happen, spelled the way everything below compares — an ET
  // `YYYY-MM-DDTHH:MM:SS` string. Between now and then there is nothing to do, so the minute tick costs
  // no queries at all; a `list_items` change dirties it through the realtime subscription. The clock
  // stays because a moment arriving is not a row changing — but the QUERY goes: this read every open
  // dated item 1,440 times a day, overwhelmingly to learn that 9am has still not come.
  let dueNextAt = '';
  let dueDirty = true;
  const dirtyDue = () => { dueDirty = true; };
  const earlierOf = (a, b) => (!a ? (b || '') : (!b || a <= b ? a : b));

  async function dueTick() {
    const nowET = etNowString();
    if (!dueDirty && (!dueNextAt || nowET < dueNextAt)) return;
    let rows;
    // Every list, not just todo — "reminder" is a predicate (has a due), not a place.
    try { rows = await sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id,alarm'); } catch (_) { return; }
    // Only once the read succeeded: a failed read must leave the state dirty so the next tick retries.
    dueDirty = false;
    dueNextAt = '';
    if (!rows.length) return;
    // One lookup for the whole tick rather than one per item — a handful of lists, read at most once a
    // minute, and only when something is actually dated.
    let emojiOf = {};
    try { for (const l of await sb('lists?select=name,emoji')) emojiOf[l.name] = l.emoji; } catch (_) {}
    for (const r of rows) {
      if (dueMoment(r.due) > nowET) {                                   // not due yet
        dueNextAt = earlierOf(dueNextAt, dueMoment(r.due));             // …so wake for the soonest one
        continue;
      }
      // Scoped to the occurrence rather than the row. Each occurrence is its own row now, so the id
      // alone would do — except for snoozing, which moves `due` on an existing row and must be allowed
      // to fire again at its new moment. Including the due gets that for free instead of needing the
      // old ledger row deleted by hand. Do not shorten this key: see the note in CLAUDE.md.
      const dk = `reminder:${r.id}:${r.due}`;
      // AN ALARM NOTIFIES TOO, always. The TV and the open hub page are what make noise; this is the
      // layer under them, and a redundant notification costs a buzz where a missing one costs the morning.
      try { if ((await sb(`notifications?dedupe_key=eq.${encodeURIComponent(dk)}&select=id&limit=1`)).length) continue; } catch (_) { continue; }
      const handler = DUE_HANDLERS.push;
      if (handler === DUE_HANDLERS.push && !apns.configured()) continue;   // nothing to deliver through
      await handler({ ...r, emoji: emojiOf[r.list_name] }, dk);
      console.log(`[due] fired ${r.id} [${r.list_name}] "${String(r.title || r.text).slice(0, 40)}"`);
      if (r.alarm) alarmLog('hub', 'due', { title: itemTitle(r), due: r.due, ringers: ringerReport() }, r.id);
      // Nothing to re-arm. Every occurrence of a recurring thing is its own row with its own due
      // (data-layer migration 00085), so each one fires once and then stays put — which is also what
      // lets it sit there visibly overdue and drain the score until it is dealt with.
    }
    dueNextAt = earlierOf(dueNextAt, await closeExempt(nowET, rows));
    // The badge follows what just fired or closed. It is pushed from the `list_items` subscription too,
    // so its own timer can be a backstop rather than the thing that keeps the icon honest.
    syncBadge().catch((e) => console.error('[badge] error', e.message));
  }

  // Exempt items close themselves once their moment has gone. A shift is not something the user finishes;
  // it is something that happens and is then over, and leaving it on the list would make the user tidy up
  // after the user's own calendar. Uses the SCORING deadline rather than the firing time, so an all-day
  // exempt item closes at the end of its day instead of at 9am when it notified.
  // Takes the rows `dueTick` has already read rather than reading them again: that query was this same
  // open-dated-item set filtered to `priority=lt.0`, and the caller's rows carry `priority` already.
  // Returns the next exempt deadline still in the future, so the caller knows when to wake.
  async function closeExempt(nowET, rows) {
    const now = Date.parse(nowET + 'Z');   // both sides are naive ET, compared in one pseudo-UTC space
    let next = '';
    for (const r of rows || []) {
      if (!(Number(r.priority) < 0)) continue;   // exempt items only — what the old query's filter said
      // An ALARM is never closed here. The page rings it until STOP, and STOP is what completes it;
      // closing it on time would silence the alarm in the minute it starts.
      if (r.alarm) continue;
      const deadline = taskDeadline(r.scheduled_at || r.due);
      if (deadline == null) continue;
      if (deadline > now) {
        next = earlierOf(next, new Date(deadline).toISOString().slice(0, 19));
        continue;
      }
      try {
        await sbWrite(`list_items?id=eq.${encodeURIComponent(r.id)}`, 'PATCH',
          { completed_at: etNowString(), updated: new Date().toISOString() });
        console.log(`[due] closed exempt ${r.id} "${String(r.title || r.text).slice(0, 40)}"`);
      } catch (e) { console.error('[due] closeExempt:', e.message); }
    }
    return next;
  }

  // A published report announces itself on the phone.
  //
  // The ledger is the row's own `notified` column, not an in-memory set: the hub restarts on every
  // deploy, and an in-memory set would either re-announce everything or lose whatever was in flight.
  // A report is therefore announced exactly once, whatever happens to this process.
  async function reportTick() {
    let rows = [];
    try { rows = await sb('reports?notified=eq.false&select=id,title,summary&order=created&limit=5'); }
    catch (_) { return; }
    for (const r of rows) {
      const body = String(r.summary || '').trim() || 'Tap to read the write-up.';
      // report_id rides in the APNs payload so tapping the notification opens that page rather than
      // dumping you on the dashboard to go find it.
      await pushAll('report', r.title || 'Report', body, `report:${r.id}`,
        { payload: { report_id: r.id, url: `/report/${r.id}` } });
      // Flip the flag even when the push failed. pushAll has already logged the failure to
      // `notifications`, and leaving it false would re-buzz the phone every tick once APNs recovers.
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/reports?id=eq.${encodeURIComponent(r.id)}`, {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
          },
          body: JSON.stringify({ notified: true }),
        });
      } catch (_) {}
    }
  }

  // ---- retention. Clearing is a SOFT delete so it can be undone, but that's only tenable if the rows
  // don't pile up forever. Anything cleared longer ago than the window is hard-deleted. Hourly is
  // plenty for a 30-day horizon; exactness doesn't matter here.
  const PURGE_AFTER_DAYS = 30;
  async function purgeCleared() {
    const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 86400000).toISOString();
    try {
      await sbWrite(`list_items?deleted=eq.true&updated=lt.${encodeURIComponent(cutoff)}`, 'DELETE');
    } catch (e) { console.error('[purge] list_items:', e.message); }
  }

  function start() {
    // ---- daily weight-logging push reminder (APNs). Checks each minute; fires once/day at the
    // configured time unless weight or food is already logged (see lib/weightReminder.js). ----
    const reminderCtx = { sb, supaInsert: sbInsert, apns, settingsAll, log: (m) => console.log('[weight-reminder]', m) };
    setInterval(() => weightReminder.tick(reminderCtx).catch((e) => console.error('[weight-reminder] error', e.message)), 60000);
    weightReminder.tick(reminderCtx).catch((e) => console.error('[weight-reminder]', e.message || e));  // also evaluate once on boot
    console.log(`[weight-reminder] armed (apns: ${apns.configured() ? 'configured, ' + apns.ENV : 'NOT configured'})`);

    // The hub's heartbeat comes from this loop: it runs every minute doing real work, so a hub whose event
    // loop is wedged goes quiet to the responder the same way a dead one does.
    setInterval(() => { ops.beat(60); dueTick().catch((e) => console.error('[due] error', e.message)); }, 60000);
    ops.beat(60);   // at boot too, so a restart does not leave a minute's gap on top of the deploy's own

    // A BACKSTOP, not the mechanism — an INSERT on `reports` fires reportTick directly (startRealtime).
    // This only covers an event the subscription missed while deaf, so it is minutes rather than the 20s
    // that made it the fastest database timer here.
    const REPORT_BACKSTOP_MS = 10 * 60 * 1000;
    setInterval(() => reportTick().catch((e) => console.error('[report] error', e.message)), REPORT_BACKSTOP_MS);
    reportTick().catch((e) => console.error('[report]', e.message || e));
    dueTick().catch((e) => console.error('[due]', e.message || e));
    console.log('[due] firing armed');

    // A BACKSTOP. The badge is pushed by the `list_items` subscription and by `dueTick` when something
    // fires, so this only catches a change that arrived while the socket was deaf. It was a 60s count of
    // every open dated item, and the count changes a handful of times a day.
    const BADGE_BACKSTOP_MS = 10 * 60 * 1000;
    setInterval(() => syncBadge().catch((e) => console.error('[badge] error', e.message)), BADGE_BACKSTOP_MS);
    syncBadge().catch((e) => console.error('[badge]', e.message || e));

    setInterval(() => purgeCleared().catch((e) => console.error('[purge]', e.message || e)), 3600000);
    purgeCleared().catch((e) => console.error('[purge]', e.message || e));
  }

  return { dirtyDue, reportTick, start };
}

module.exports = { createJobs };
