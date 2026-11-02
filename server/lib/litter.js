'use strict';
// ---- Litter-Robot display state -------------------------------------------------------------
// The robot is held in Sleep Mode and the Fly watcher fires every clean itself, so the robot's own
// `status` is not the state of the box: it reads READY through a queued clean, a phantom weight, a
// 30-minute lockout, and a watcher that died an hour ago. The watcher publishes what it is doing in
// device_status.data; fold the two into one verdict here so every surface paints the same thing.
const LITTER_STATUS_LABEL = { READY:'Ready', CLEAN_CYCLE_COMPLETE:'Ready', DRAWER_FULL:'Ready',
  CLEAN_CYCLE:'Cleaning', CAT_DETECTED:'Cat detected', CAT_SENSOR_TIMING:'Waiting (post-cat)',
  CAT_SENSOR_INTERRUPTED:'Stuck (auto-resuming)', PAUSED:'Stuck (auto-resuming)', OFF:'Off',
  OFFLINE:'Offline' };
const LITTER_STALE_MS = 25 * 60 * 1000;   // the watcher refreshes every 10 min; miss two and it is gone
const LITTER_DRAWER_FULL_PCT = 90;        // the robot's own flag trips at ~53% depth; trust the depth

function agoShort(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 48 ? h + 'h' : Math.floor(h / 24) + 'd';
}

function buildLitter(row) {
  if (!row) return null;
  const d = row.data || {};
  const now = Date.now();
  const age = row.updated_at ? now - Date.parse(row.updated_at) : null;
  const cleanIn = d.clean_due_at ? Math.max(0, Date.parse(d.clean_due_at) - now) : null;
  const usedAgo = d.last_visit_at ? now - Date.parse(d.last_visit_at) : null;
  const cleanedAgo = d.last_clean_at ? now - Date.parse(d.last_clean_at) : null;
  const st = row.status || 'OFFLINE';
  let state, label;
  // Ordered worst-first: a fault outranks the cycle it interrupted, and both outrank a queued clean.
  if (age == null || age > LITTER_STALE_MS) { state = 'STALE'; label = 'Stale'; }
  else if (!row.online) { state = 'OFFLINE'; label = 'Offline'; }
  else if (st === 'CAT_SENSOR_INTERRUPTED' || st === 'PAUSED') { state = 'STUCK'; label = LITTER_STATUS_LABEL[st]; }
  else if (d.locked_out) { state = 'LOCKED_OUT'; label = 'Locked out'; }
  else if (d.scale_stuck) { state = 'SCALE_STUCK'; label = 'Scale stuck'; }
  else if (row.waste_drawer_pct >= LITTER_DRAWER_FULL_PCT) { state = 'DRAWER_FULL'; label = 'Drawer full!'; }
  else if (st === 'CLEAN_CYCLE') { state = 'CLEANING'; label = 'Cleaning'; }
  // Sleep mode is the whole model — out of it the robot auto-cycles and the watcher is a bystander.
  else if (d.sleeping === false) { state = 'SELF_CYCLING'; label = 'Self-cycling'; }
  else if (d.clean_pending) { state = 'CLEAN_QUEUED'; label = cleanIn ? 'Clean in ' + Math.ceil(cleanIn / 60000) + 'm' : 'Clean queued'; }
  else { state = 'READY'; label = LITTER_STATUS_LABEL[st] || st; }
  const color = { STALE:'#ef4444', OFFLINE:'#ef4444', STUCK:'#f97316', LOCKED_OUT:'#f97316',
    SCALE_STUCK:'#f97316', DRAWER_FULL:'#ef4444', CLEANING:'#eab308', SELF_CYCLING:'#f97316',
    CLEAN_QUEUED:'#a855f7', READY:'#3b82f6' }[state];
  return { ...row, state, label, color, clean_in_s: cleanIn == null ? null : Math.round(cleanIn / 1000),
    used_ago: agoShort(usedAgo), cleaned_ago: agoShort(cleanedAgo) };
}

module.exports = { buildLitter };
