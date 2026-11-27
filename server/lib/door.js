'use strict';
// The front door's state as SwitchBot spells it (data-layer README § The front door). Which reports
// become door_events rows is decided in Supabase, by door_report() (data-layer migration 00209).

const LOCK = { locked: 'locked', unlocked: 'unlocked', jammed: 'jammed', lock: 'locked', unlock: 'unlocked' };
const DOOR = { opened: 'opened', open: 'opened', closed: 'closed', close: 'closed' };

/** A lock or door value as SwitchBot spells it (LOCKED, "opened", CLOSE…) → ours, or null. */
function norm(table, v) {
  return v == null ? null : table[String(v).toLowerCase()] || null;
}

/** The state a webhook context or a status body reports. Either field may be absent. */
function stateOf(o) {
  return { lock: norm(LOCK, o && o.lockState), door: norm(DOOR, o && (o.doorState ?? o.openState)) };
}

module.exports = { stateOf };
