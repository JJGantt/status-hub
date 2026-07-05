'use strict';
// Daily "log your weight" push. Runs every minute (server is always-on). Fires once per local day,
// at the configured time, and only if you haven't already weighed in or eaten that day.
//
// Settings (app_settings):
//   weight_reminder_enabled : default on  (anything but 0/false/off/no enables)
//   weight_reminder_mode    : 'manual' (default) | 'dynamic'
//   weight_reminder_time    : 'HH:MM' local, default '08:00' (manual mode)
// Dynamic mode times it to your derived first-meal time (pace.deriveWindow), so the ping lands
// right when you'd normally be about to eat.
//
// Suppression: skip (and claim the day so we stop re-checking) if weight OR food is already logged
// today. Dedupe/log via the notifications table (unique dedupe_key 'weight_reminder:<YYYY-MM-DD>'),
// so a server restart can't double-send.
const pace = require('./pace');
const { localDate, nutritionWindow } = require('./dates');
const TZ = process.env.TZ_DISPLAY || 'America/New_York';

const TITLE = 'Log your weight';
const BODY = 'Step on the scale before your first meal.';

function nowHM() {  // current wall time HH:MM (24h) in the display timezone
  return new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5);
}

function minutesSince4amToHM(min) {  // pace offsets are minutes since 4am local
  const total = (4 * 60 + Math.round(min)) % 1440;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

async function targetTime(sb, settings) {
  const manual = /^\d{2}:\d{2}$/.test(settings.weight_reminder_time || '') ? settings.weight_reminder_time : '08:00';
  if (settings.weight_reminder_mode !== 'dynamic') return manual;
  try {
    const histStart = localDate(new Date(Date.now() - 40 * 86400000));
    const rows = await sb(`nutrition_entries?occurred_at=gte.${histStart}T00:00:00&staged=eq.false&select=occurred_at`);
    const w = pace.deriveWindow((rows || []).map((r) => r.occurred_at));
    if (w && Number.isFinite(w.firstMin)) return minutesSince4amToHM(w.firstMin);
  } catch (_) {}
  return manual;  // fall back to the manual time if history is unavailable
}

// Once a day is handled (sent or skipped), later ticks that day return without touching Supabase —
// the notifications dedupe row remains the restart-safe source of truth; this just avoids re-asking
// it every minute. The dynamic target (a 40-day nutrition read) is computed once per day too.
let claimedDay = null;
let cachedTarget = { day: null, hm: null };

async function tick(ctx) {
  const { sb, supaInsert, apns, log, settingsAll } = ctx;

  const today = localDate();
  if (claimedDay === today) return;                   // handled — quiet until the day rolls over

  let settings = {};
  try {
    if (settingsAll) settings = await settingsAll();  // server's realtime-invalidated cache
    else (await sb('app_settings?select=key,value')).forEach((r) => (settings[r.key] = r.value));
  } catch (_) { return; }

  const enabledRaw = String(settings.weight_reminder_enabled ?? '1').toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(enabledRaw)) return;

  let target;
  if (settings.weight_reminder_mode !== 'dynamic') {
    target = await targetTime(sb, settings);          // manual mode reads no history — free
  } else {
    if (cachedTarget.day !== today) cachedTarget = { day: today, hm: await targetTime(sb, settings) };
    target = cachedTarget.hm;
  }
  if (nowHM() < target) return;                       // not time yet today

  const dedupe = `weight_reminder:${today}`;
  try {
    const seen = await sb(`notifications?dedupe_key=eq.${encodeURIComponent(dedupe)}&select=id&limit=1`);
    if (seen.length) { claimedDay = today; return; }  // already handled (sent or skipped) today
  } catch (_) { return; }

  // Suppress if weight OR food already logged today.
  let skip = null;
  try {
    if ((await sb(`weight_log?date=eq.${today}&select=date&limit=1`)).length) skip = 'weight already logged';
    if (!skip) {
      const win = nutritionWindow();
      const food = await sb(`nutrition_entries?occurred_at=gte.${win.start}&occurred_at=lt.${win.end}&staged=eq.false&select=occurred_at&limit=1`);
      if (food.length) skip = 'food already logged';
    }
  } catch (_) { return; }

  if (skip) {
    await supaInsert('notifications', { kind: 'weight_reminder', dedupe_key: dedupe, ok: false, detail: 'skipped: ' + skip });
    claimedDay = today;
    if (log) log(`skipped (${skip})`);
    return;
  }

  let tokens = [];
  try { tokens = await sb('device_tokens?platform=eq.ios&select=token,environment'); } catch (_) {}
  if (!tokens.length) {
    await supaInsert('notifications', { kind: 'weight_reminder', dedupe_key: dedupe, ok: false, detail: 'no device tokens' });
    return;
  }
  if (!apns.configured()) {
    await supaInsert('notifications', { kind: 'weight_reminder', dedupe_key: dedupe, ok: false, detail: 'apns not configured' });
    if (log) log('apns not configured — set APNS_KEY_* secrets');
    return;
  }

  let okAny = false; const details = [];
  for (const { token, environment } of tokens) {
    const r = await apns.send(token, { title: TITLE, body: BODY, environment });
    okAny = okAny || r.ok;
    details.push(`${token.slice(0, 8)}=${r.status}${r.ok ? '' : '(' + (r.detail || '').slice(0, 60) + ')'}`);
  }
  await supaInsert('notifications', {
    kind: 'weight_reminder', dedupe_key: dedupe, title: TITLE, body: BODY,
    sent_at: new Date().toISOString(), ok: okAny, detail: details.join(' '),
  });
  claimedDay = today;
  if (log) log(`sent (ok=${okAny}) ${details.join(' ')}`);
}

module.exports = { tick, nowHM, minutesSince4amToHM };
