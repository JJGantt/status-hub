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

/**
 * Whether an arrival at `at` (a Wi-Fi join or a Bluetooth arrival) follows him actually leaving, so a
 * phone restarting or Bluetooth toggled at home never unlocks the door. Leaving is: the door opened, and
 * after that opening, evidence he went away from it — one of his devices going unheard over Bluetooth
 * (`leaves`, presence_events 'leave') or the phone riding the elevator down (`downs`, elevator_rides
 * 'down' start times). And the door has not opened since that evidence: an opening after it is him
 * already back inside. All times are ms; each list is any order.
 * Answers { ok, why } so a refusal says which part was missing.
 */
function leftAndCameBack(at, { opens = [], leaves = [], downs = [] }) {
  const before = (xs) => xs.filter((t) => t < at).sort((a, b) => a - b);
  const o = before(opens);
  if (!o.length) return { ok: false, why: 'no door opening before it' };
  // The latest opening that was followed by evidence of leaving, before the arrival.
  const evidence = before([...leaves, ...downs]);
  for (let i = o.length - 1; i >= 0; i--) {
    const left = evidence.find((t) => t > o[i]);
    if (left === undefined) continue;
    const reopened = o.some((t) => t > left);
    return reopened ? { ok: false, why: 'the door opened again after he left' } : { ok: true, why: 'left through the door and came back' };
  }
  return { ok: false, why: 'nothing shows he left after the door opened' };
}

module.exports = { stateOf, leftAndCameBack };
