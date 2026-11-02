'use strict';
// The alarm log and the ringers' last word. One instance, made in server.js.

function createAlarmLog({ sbWrite }) {
  // ---- the alarm log (data-layer 00113) ---------------------------------------------------------
  // What happened to every alarm, durably. Stdout here is a buffer of about a hundred lines, and an
  // alarm is audited the morning after — so without this the phone's half of any alarm was gone
  // within the hour. EVENTS only: a beacon that says nothing new writes nothing (noteRinger). Never
  // throws into the caller.
  function alarmLog(source, ev, detail = {}, itemId = null) {
    sbWrite('alarm_log', 'POST', { source, ev, item_id: itemId, detail })
      .catch((e) => console.error('[alarm-log] write failed:', e.message));
  }

  // THE RINGERS' LAST WORD. Every alarm clock — the TV's tv-ring and each page running alarmclock.js —
  // beacons its state once a minute. Held here per source so the log records a CHANGE, or a ringer
  // coming back after a silence, rather than every beat; and so an alarm's due moment can say what
  // each ringer last reported, which is the question every audit starts with.
  const RINGER_SILENCE_MS = 5 * 60 * 1000;
  const ringers = new Map();   // source -> { at, state }
  function ringerSource(b, req) {
    if (b.ev === 'tvring') return 'tv';
    const ua = String(req.get('user-agent') || '');
    // The Pi's kiosk Chromium reports itself as `X11; CrOS x86_64`, not as Linux.
    const device = /iPhone|iPad/.test(ua) ? 'iphone' : /Macintosh/.test(ua) ? 'mac' : /X11|Linux/.test(ua) ? 'pi' : 'other';
    return `${b.surface || 'page'}@${device}`;
  }
  function ringerState(b) {
    if (b.ev === 'tvring') return { next: b.next, ringing: b.ringing, player: b.player, tone: b.tone };
    return { next: b.next, armed: b.armed, ringing: b.ringing, guided: b.guided, visible: b.visible,
             lock: b.lock, audio: b.audio, loaded: b.media >= 2, tone: b.tone };
  }
  function noteRinger(b, req) {
    const source = ringerSource(b, req);
    // Something the ringer reports AS an event — a ring, a stop, the sound failing — is logged as itself.
    const beat = b.ev === 'tvring' ? b.at === 'beat' : !b.at;
    if (!beat) {
      const { ev, at, ...detail } = b;
      return alarmLog(source, at, detail, b.id || null);
    }
    const state = ringerState(b);
    const now = Date.now();
    const prev = ringers.get(source);
    ringers.set(source, { at: now, state });
    // First heard since the hub started: the user agent rides along once, so a source named from it
    // can be traced to the actual device.
    if (!prev) return alarmLog(source, 'state', { ...state, ua: String(req.get('user-agent') || '').slice(0, 160) });
    if (now - prev.at > RINGER_SILENCE_MS) return alarmLog(source, 'resumed', { silent_s: Math.round((now - prev.at) / 1000), ...state });
    const changed = Object.keys(state).filter((k) => state[k] !== prev.state[k]);
    if (changed.length) alarmLog(source, 'state', { changed, ...state });
  }
  function ringerReport() {
    const now = Date.now();
    return Object.fromEntries([...ringers].map(([s, r]) => [s, { heard_s_ago: Math.round((now - r.at) / 1000), ...r.state }]));
  }

  return { alarmLog, noteRinger, ringerReport };
}

module.exports = { createAlarmLog };
