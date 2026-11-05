'use strict';
// app_settings, read through one cache, and the typed readers the dashboard and the routes take from
// it. One instance, made in server.js.
const { getTZ, setTZ } = require('./dates');

// `onDirty` is called on every invalidation, so whatever caches a build of these values can tell it is stale.
function createSettings({ sb, onDirty }) {
  // Settings cache: app_settings is read several times per status build but only changes on explicit
  // writes, which the realtime subscription announces (→ dirtySettings). One whole-table fetch serves
  // every reader; the 15-min backstop covers a silently dropped realtime event.
  const settingsCache = { map: null, at: 0 };
  const SETTINGS_BACKSTOP_MS = 15 * 60 * 1000;
  const dirtySettings = () => { settingsCache.map = null; onDirty(); };

  async function settingsAll() {
    if (settingsCache.map && Date.now() - settingsCache.at < SETTINGS_BACKSTOP_MS) return settingsCache.map;
    const rows = await sb('app_settings?select=key,value');
    settingsCache.map = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
    settingsCache.at = Date.now();
    if (setTZ(settingsCache.map.display_tz)) console.log(`[tz] display timezone -> ${getTZ()}`);
    return settingsCache.map;
  }

  // Current surplus/deficit setting (signed kcal over maintenance; default +150 lean-bulk). Drives the
  // live daily goal and the active run's goal on the plot/heatmap. Editable in the settings panel.
  const SURPLUS_LIMIT = 1000; // clamp: nobody runs a surplus/deficit beyond ~1000 kcal; guards typos
  // Daily produce goals (vegetables / dark green vegetables / fruit). FIXED constants in app_settings — nothing
  // recalculates them, unlike the macro targets which the maintenance engine re-derives every build.
  // veg INCLUDES dark_green (dark green is a floor within the vegetable goal), so the two are never added.
  const PRODUCE_TARGET_DEFAULTS = { veg_g: 300, dark_green_g: 150, fruit_g: 250 };
  async function produceTargets() {
    try {
      const s = await settingsAll();
      const pick = (key, dflt) => {
        const v = parseFloat(s[key]);
        return Number.isFinite(v) && v > 0 ? v : dflt;
      };
      return {
        veg_g: pick('produce_target_veg_g', PRODUCE_TARGET_DEFAULTS.veg_g),
        dark_green_g: pick('produce_target_dark_green_g', PRODUCE_TARGET_DEFAULTS.dark_green_g),
        fruit_g: pick('produce_target_fruit_g', PRODUCE_TARGET_DEFAULTS.fruit_g),
      };
    } catch { return { ...PRODUCE_TARGET_DEFAULTS }; }
  }

  async function surplusCal() {
    try {
      const v = parseInt((await settingsAll()).surplus_cal, 10);
      if (!Number.isFinite(v)) return 150;
      return Math.max(-SURPLUS_LIMIT, Math.min(SURPLUS_LIMIT, v));
    } catch { return 150; }
  }
  // Min length (days) of the aligned intake-tracking window before adaptive maintenance goes live.
  // Editable in settings; default 14, clamped to a sane 7–60.
  async function maintenanceMinDays() {
    try {
      const v = parseInt((await settingsAll()).maintenance_min_days, 10);
      return Number.isFinite(v) && v >= 7 && v <= 60 ? v : 14;
    } catch { return 14; }
  }
  // Current goal phase: { start, seed, sign, hold }. A phase begins when surplus_cal flips sign
  // (bulk↔cut); its start caps the maintenance window and `seed` holds the pre-flip maintenance until the
  // new phase has enough of its own data. Stored as JSON in app_settings.maintenance_phase.
  async function maintenancePhase() {
    try {
      const raw = (await settingsAll()).maintenance_phase;
      if (!raw) return null;
      const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!p || !p.start) return null;
      return { start: String(p.start).slice(0, 10), seed: p.seed != null ? Number(p.seed) : null,
               sign: Number(p.sign) || 0, hold: !!p.hold };
    } catch { return null; }
  }
  // Voice state for the TV strip + the mic-liveness check: whether always-on (wake-free) voice and inject
  // mode are on. Routing is fixed (every turn is Opus), so there's no model/route to resolve here.
  async function routingConfig() {
    let s = {};
    try { s = await settingsAll(); } catch { /* fall through to defaults */ }
    return {
      wake: ['1', 'true', 'on', 'yes'].includes(String(s.wakefree_enabled ?? '0').toLowerCase()),
      inject: ['1', 'true', 'on', 'yes'].includes(String(s.voice_inject_mode ?? '0').toLowerCase()),
      // Which wall the TV should be showing. The kiosk cannot be told to navigate from outside — it is
      // a browser on a machine nothing can reach — so the page watches this and goes there itself.
      wall: (() => {
        const w = String(s.wall_mode ?? 'standard').toLowerCase();
        // 'home' is a second word for the default wall, not a fourth wall — voice reaches it either
        // way and one value is stored, so nothing has to decide which of two names is current.
        if (w === 'home') return 'standard';
        return ['sessions', 'calendar', 'health'].includes(w) ? w : 'standard';
      })(),
    };
  }

  // The cached map as it stands, without a read (null until the first one).
  const cached = () => settingsCache.map;

  return { settingsAll, dirtySettings, cached, produceTargets, surplusCal, maintenanceMinDays, maintenancePhase,
           routingConfig };
}

module.exports = { createSettings };
