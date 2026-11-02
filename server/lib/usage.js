'use strict';
// The Claude subscription's usage windows: the walls' two hairline bars and the watch's usage page.
// One instance, made in server.js.

function createUsage({ sb }) {
  // The Claude subscription's usage windows (data-layer 00144: one row per change, newest = current),
  // for the two thin bars along the top of every wall. A new row arrives over realtime (→ usageCache.row),
  // so the read here is a boot fill and the 15-min backstop behind a dropped event.
  const usageCache = { row: null, at: 0 };
  const USAGE_BACKSTOP_MS = 15 * 60 * 1000;
  async function claudeUsageRow() {
    if (usageCache.row && Date.now() - usageCache.at < USAGE_BACKSTOP_MS) return usageCache.row;
    const rows = await sb('claude_usage?select=five_hour_pct,five_hour_resets_at,seven_day_pct,seven_day_resets_at,observed_at&order=observed_at.desc&limit=1');
    usageCache.row = (rows || [])[0] || null;
    usageCache.at = Date.now();
    return usageCache.row;
  }
  // Fills 0-100 for the bars, and the minutes to each reset for whatever later shows them. A window whose
  // reset has passed is empty until the next turn reports the new one.
  function buildUsage(r) {
    if (!r) return null;
    const win = (pct, resets) => {
      const ms = resets ? Date.parse(resets) - Date.now() : null;
      const over = ms !== null && ms <= 0;
      return { pct: over ? 0 : Math.max(0, Math.min(100, Number(pct) || 0)),
               resets_at: over ? null : resets, resets_in_min: over || ms === null ? null : Math.round(ms / 60000) };
    };
    return { five_hour: win(r.five_hour_pct, r.five_hour_resets_at), seven_day: win(r.seven_day_pct, r.seven_day_resets_at),
             observed_at: r.observed_at };
  }

  // A reading delivered over realtime replaces the cached one without a read.
  function take(row) { usageCache.row = row; usageCache.at = Date.now(); }

  return { claudeUsageRow, buildUsage, take };
}

module.exports = { createUsage };
