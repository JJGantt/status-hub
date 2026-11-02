'use strict';
// The app icon's badge: the overdue count, pushed to every iOS device token whenever it changes.

function createBadge({ apns, overdueCount, sb }) {
  // ---- badge sync. A reminder can be completed from anywhere — the hub UI, a voice command, the
  // data MCP — and none of those go through this server, so polling the count is the one mechanism
  // that covers every path. Only pushes when the number actually CHANGES, so it's silent no-ops most
  // ticks. Badge-only pushes show nothing; they just correct the icon.
  let lastBadge = null;
  async function syncBadge() {
    if (!apns.configured()) return;
    const n = await overdueCount();
    if (!Number.isInteger(n) || n === lastBadge) return;
    lastBadge = n;
    let tokens = [];
    try { tokens = await sb('device_tokens?platform=eq.ios&select=token,environment'); } catch (_) { return; }
    for (const { token, environment } of tokens) await apns.send(token, { environment, badge: n });
    console.log(`[badge] -> ${n}`);
  }

  return { syncBadge };
}

module.exports = { createBadge };
