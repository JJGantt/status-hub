'use strict';
// The front door's events (SwitchBot Lock Ultra; data-layer README § The front door). Pure rules, so
// they are tested: what a SwitchBot report means against the state we last recorded.

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

/** The door_events rows a report produces after `prev` (the latest row's lock_state/door_state, or
 *  null): one per value that changed, the other value carried along. A field the report omits keeps
 *  its previous value; a report that changes nothing produces no row. */
function eventsFor(prev, next, source, raw) {
  const p = { lock: prev ? prev.lock_state : null, door: prev ? prev.door_state : null };
  const lock = next.lock || p.lock;
  const door = next.door || p.door;
  const rows = [];
  if (next.lock && next.lock !== p.lock) rows.push({ event: next.lock, lock_state: lock, door_state: p.door });
  if (next.door && next.door !== p.door) rows.push({ event: next.door, lock_state: lock, door_state: door });
  return rows.map((r) => ({ ...r, source, raw }));
}

module.exports = { stateOf, eventsFor };
