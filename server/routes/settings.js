'use strict';
const express = require('express');
const { setTZ, nutritionWindow } = require('../lib/dates');
const speech = require('../lib/speech');

module.exports = function (ctx) {
  const {
    GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, dirtySettings, gated, putSetting, sb, settingsAll,
  } = ctx;

  // ---- app settings (voice routing mode + per-device trailing-silence). Read by the worker + devices;
  // edited from the hub settings panel. Returns/accepts a flat {key: value} map. ----
  // Settings a browser has no use for. `voiceprint` is a 24KB base64 exemplar bank for speaker ID: the
  // voice pipeline reads it from app_settings directly with the service key and it has never been read
  // by any client here, but it was 92% of this response, fetched twice on every cold load.
  const SETTINGS_SERVER_ONLY = new Set(['voiceprint']);
  // ---- the mute has HOLDERS ----------------------------------------------------------------------
  // Every microphone in the house goes deaf while an explicit command is being captured, and that was
  // one flag — `voice_muted` — written 1 and 0 by whoever was capturing. Two sources capturing at once
  // is the ordinary case (a watch recording while the user dictates on the Mac), and the one that finished
  // FIRST wrote 0 and woke every mic mid-dictation: on 2026-09-23 the Mac's listener heard the rest of
  // a dictation 0.7s after push-to-talk had muted it, and ran it as a command.
  //
  // So a mute is HELD, by name. `voice_mute_<holder>` carries the instant it was taken and is emptied
  // when it is given back; `voice_muted` stays what every listener reads, and is recomputed here — the
  // hub is one process, so the recompute is serialised however many devices write at once.
  //
  // A holder that dies mid-capture would hold the mute forever, so one older than MUTE_STALE_MS is
  // ignored: past that it is a crash, not a sentence.
  const MUTE_HOLD = 'voice_mute_';
  const MUTE_STALE_MS = 15 * 60 * 1000;

  function mutedBy(all) {
    const now = Date.now();
    return Object.entries(all)
      .filter(([k, v]) => k.startsWith(MUTE_HOLD) && v)
      .filter(([, v]) => { const t = Date.parse(v); return !Number.isFinite(t) || now - t < MUTE_STALE_MS; })
      .map(([k]) => k.slice(MUTE_HOLD.length));
  }

  /// Recomputes `voice_muted` from the holders. Called after a holder writes here, and off the realtime
  /// subscription for a holder written straight into the table (the Mac's listener does that).
  async function recomputeMute() {
    const all = await settingsAll();
    const held = mutedBy(all).length > 0 ? '1' : '0';
    if ((all.voice_muted || '0') === held) return;
    await putSetting('voice_muted', held);
    dirtySettings();
    console.log('[mute]', held === '1' ? `held by ${mutedBy(all).join(', ')}` : 'released');
  }

  // Take or give back one holder's mute. Every capture path uses this rather than writing `voice_muted`.
  gated.post('/api/voice-mute', express.json(), async (req, res) => {
    try {
      const holder = String((req.body && req.body.holder) || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(holder)) return res.status(400).json({ error: 'holder required' });
      const on = !!(req.body && req.body.on);
      await putSetting(MUTE_HOLD + holder, on ? new Date().toISOString() : '');
      dirtySettings();
      await recomputeMute();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  gated.get('/api/settings', async (req, res) => {
    try {
      const all = await settingsAll();   // realtime-invalidated cache — see settingsAll()
      res.json(Object.fromEntries(Object.entries(all).filter(([k]) => !SETTINGS_SERVER_ONLY.has(k))));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // **A reply in a real voice** (`lib/speech.js`). The client posts the reply's text and which chunk it
  // wants; the answer is that chunk's audio, with the total count in a header so the first request is
  // also the plan. The client asks for chunk 0, plays it, and fetches the rest while it plays.
  gated.post('/api/tts', express.json({ limit: '256kb' }), async (req, res) => {
    if (!GROQ_API_KEY) return res.status(503).json({ error: 'tts not configured' });
    const list = speech.chunks((req.body && req.body.text) || '');
    const i = Number((req.body && req.body.i) || 0);
    if (!list.length || !(i >= 0 && i < list.length)) return res.status(400).json({ error: 'no such chunk' });
    const t0 = Date.now();
    try {
      const st = await settingsAll();
      const wav = await speech.synth(list[i], GROQ_API_KEY, { voice: st.tts_voice, speed: st.tts_speed, surface: req.body.surface });
      console.log('[tts]', JSON.stringify({ i, of: list.length, chars: list[i].length, ms: Date.now() - t0, bytes: wav.length }));
      res.set({ 'Content-Type': 'audio/wav', 'X-Chunks': String(list.length), 'Access-Control-Expose-Headers': 'X-Chunks' });
      res.send(wav);
    } catch (e) {
      console.error('[tts] FAILED', String(e.message || e));
      res.status(502).json({ error: String(e.message || e).slice(0, 300) });
    }
  });

  // How long a play waited for its first sound, and any stall between chunks, as the client measured it.
  gated.post('/api/tts/timing', express.json({ limit: '8kb' }), (req, res) => {
    console.log('[tts-timing]', JSON.stringify(req.body));
    res.json({ ok: true });
  });

  // TEMPORARY. The voice button's stop tap misbehaves only on the user's phone, so the phone reports what it
  // actually saw — every pointer event and every state change — into this log. Read it with
  // `fly logs -a jared-status-hub | grep tap`. Delete this route and its caller once that is understood.
  gated.post('/api/tapdebug', express.json({ limit: '8kb' }), (req, res) => {
    const ua = String(req.headers['user-agent'] || '');
    const surface = ua.includes('StatusHub') ? 'app' : /iPhone|iPad/.test(ua) ? 'ios-safari' : 'other';
    console.log('[tap]', surface, JSON.stringify(req.body));
    res.json({ ok: true });
  });

  gated.post('/api/settings', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const key = typeof b.key === 'string' ? b.key.trim() : '';
      if (!key) return res.status(400).json({ error: 'key required' });
      const value = b.value == null ? '' : String(b.value);
      const prevSurplus = key === 'surplus_cal' ? (await settingsAll()).surplus_cal : null;   // before the write
      await putSetting(key, value);
      dirtySettings();   // synchronous — a write-then-read client must not race the realtime round-trip
      // A goal sign-flip (bulk↔cut) starts a NEW maintenance phase, seeded with the maintenance measured
      // robustly up to now (= today's synced target − the OLD surplus) and held until the new phase has its
      // own data. Same-sign magnitude tweaks (e.g. +150→+250) do NOT reset the phase.
      if (key === 'surplus_cal') {
        const oldS = parseInt(prevSurplus, 10), newS = parseInt(value, 10);
        const oldSign = Number.isFinite(oldS) ? Math.sign(oldS) : 0;
        const newSign = Number.isFinite(newS) ? Math.sign(newS) : 0;
        if (newSign !== 0 && newSign !== oldSign) {
          const today = nutritionWindow().day;
          const trows = await sb(`nutrition_targets?date=eq.${today}&select=calories`);
          const curTarget = trows && trows[0] ? Number(trows[0].calories) : null;
          const seed = (curTarget != null && Number.isFinite(oldS)) ? Math.round(curTarget - oldS) : null;
          const phaseRec = { start: today, seed, sign: newSign, hold: false };
          await putSetting('maintenance_phase', JSON.stringify(phaseRec));
          dirtySettings();
          console.log(`[phase] goal sign flip ${oldSign}→${newSign}; new phase start=${today} seed=${seed}`);
        }
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Register a device's APNs token (sent by the native app, authed by x-hub-token). Upsert so a
  // re-launch just refreshes last_seen rather than piling up rows.
  //
  // The phone also reports its IANA timezone here, which is how the hub knows where the user is. It is
  // the best available proxy: the phone travels with the user, and it re-registers on every launch. Stored
  // in app_settings.display_tz and picked up by the next settings read (see settingsAll).
  gated.post('/api/register-push', express.json(), async (req, res) => {
    try {
      const token = String((req.body && req.body.token) || '').trim();
      if (!/^[0-9a-fA-F]{16,}$/.test(token)) return res.status(400).json({ error: 'bad token' });
      const env = (req.body && req.body.environment) === 'production' ? 'production' : 'sandbox';
      const row = {
        token,
        platform: (req.body && req.body.platform) || 'ios',
        bundle_id: (req.body && req.body.bundle_id) || null,
        environment: env,
        last_seen: new Date().toISOString(),
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/device_tokens?on_conflict=token`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                   'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`device_tokens upsert -> ${r.status}`);

      // Follow the phone's timezone. Validated by setTZ (which rejects anything Intl won't accept), and
      // only written when it actually changed, so this isn't a Supabase write on every app launch.
      const tz = String((req.body && req.body.tz) || '').trim();
      if (setTZ(tz)) {                       // false when unchanged or not a real IANA zone
        console.log(`[tz] phone reports ${tz} — persisting`);
        try { await putSetting('display_tz', tz); dirtySettings(); }
        catch (e) { console.error('[tz] persist failed:', e.message); }   // in-memory zone still moved
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return { MUTE_HOLD, recomputeMute };
};
