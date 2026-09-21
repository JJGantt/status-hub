'use strict';
// THE SURF ALARM: forecast conditions in, an alarm out, with no one awake to connect them.
//
// A `surf_alarms` row (data-layer 00111) holds one morning's ordered rules. The hub already hears
// every new surf_snapshots row over realtime, so it re-decides here on each one and on any change to
// the rules, and hands the decision to whichever OUTPUTS the row names. docs/ALARMS.md has the whole
// scenario.
//
// Two halves, kept apart on purpose:
//   decide()  — pure: rules + one snapshot's hourly rows -> which rule matched and the wake time.
//   OUTPUTS   — what a decision drives. Each takes the moment (or null for "no alarm") and its own
//               saved state, makes the world match, and returns its new state. A new form of alarm
//               is a new entry here and nothing else.

const SLUG = 'mayport-poles';
// Fair or better. Mayport Poles has never been rated above Fair, so in practice this is "Fair".
const SCALE = ['FLAT', 'VERY_POOR', 'POOR', 'POOR_TO_FAIR', 'FAIR', 'FAIR_TO_GOOD', 'GOOD', 'EPIC'];
const MIN_RATING = SCALE.indexOf('FAIR');

// A snapshot row's hour on the spot's clock, as { date: 'YYYY-MM-DD', hour: 0-23 }.
function localHour(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = {}; for (const part of f.formatToParts(new Date(ts * 1000))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}

// Rules are ORDERED and the first match wins. A rule matches when every hour in `hours` is Fair or
// better on `day` AND no hour in `not_fair` is; any hour in neither list is unconstrained. So "fair at
// 8 and 9 and nothing after" is {hours:[8,9], not_fair:[10,11]}, and the same intent can also be had
// by ORDER: a wider window listed first wins whenever it is fair, leaving the narrower rule below it
// to match only when it is not. An hour the forecast does not cover counts as not fair. A rule with
// both lists empty matches unconditionally — the "otherwise" rule.
function decide(rules, rows, day, tz) {
  const fair = new Map();
  for (const r of rows || []) {
    const { date, hour } = localHour(r.ts, tz);
    if (date === day) fair.set(hour, SCALE.indexOf(r.rk) >= MIN_RATING);
  }
  for (let i = 0; i < (rules || []).length; i++) {
    const hours = rules[i].hours || [];
    const notFair = rules[i].not_fair || [];
    if (hours.every((h) => fair.get(h) === true) && notFair.every((h) => fair.get(h) !== true)) {
      return { rule: i, wake: rules[i].wake };
    }
  }
  return { rule: null, wake: null };
}

// ---- outputs -----------------------------------------------------------------------------------
// apply({ alarm, at, now, state }) -> new state. `at` is the naive-local moment to ring, or null for
// no alarm. `now` is naive-local too. An output must be idempotent: it is called on every decision,
// and most decisions change nothing.

function makeOutputs({ sb, sbWrite, uuid }) {
  return {
    // An alarm-marked list item. The page clock, AlarmKit and dueTick's notification all ring from
    // one of these, so this single output reaches all three.
    item: {
      async apply({ at, now, state }) {
        const stamp = now.slice(0, 19);
        const id = state && state.id;
        if (id) {
          const [cur] = await sb(`list_items?id=eq.${id}&select=id,due,deleted,completed_at`);
          // Deleted or completed by anyone but this output means he dealt with it, and it is not put
          // back. This output forgets an item only when it deletes one itself.
          if (!cur || cur.deleted || cur.completed_at) return state;
          // A moment that has arrived has rung, or is ringing: a later forecast does not move it.
          if (cur.due && cur.due <= now) return state;
          if (!at) {
            await sbWrite(`list_items?id=eq.${id}`, 'PATCH', { deleted: true, updated: stamp });
            return {};
          }
          if (cur.due !== at) await sbWrite(`list_items?id=eq.${id}`, 'PATCH', { due: at, scheduled_at: at, updated: stamp });
          return state;
        }
        if (!at) return {};
        // The list's own default, as add_to_list does when no priority was said.
        const [list] = await sb('lists?id=eq.l_todo&select=default_priority');
        const fresh = uuid();
        await sbWrite('list_items', 'POST', {
          id: fresh, list_id: 'l_todo', text: 'Surf, Mayport Poles', title: 'Surf',
          due: at, scheduled_at: at, priority: (list && list.default_priority) || 0, alarm: true,
          deleted: false, created: stamp, updated: stamp,
        });
        return { id: fresh };
      },
    },
  };
}

// ---- the tick ----------------------------------------------------------------------------------
// Called on a new snapshot, on a rule change, on every (re)subscribe, and by a slow backstop. Runs
// one at a time; a call that lands mid-run makes the running one go round again, so nothing is lost
// and its own writes (which come back as realtime events) settle instead of stacking.

// jsonb comes back with its keys REORDERED (shortest first), so comparing a fresh object to a stored
// one by JSON.stringify always differs — and a write on every tick is a realtime event on every tick,
// which calls the tick. Compare with the keys sorted.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function createSurfAlarms({ sb, sbWrite, uuid, nowLocal, today, tz, log }) {
  const OUTPUTS = makeOutputs({ sb, sbWrite, uuid });
  let snap = null;                 // { captured_at, rows } — rows are ~64KB, so fetched only when new
  let busy = false; let again = false;

  async function latestSnapshot() {
    const [head] = await sb(`surf_snapshots?slug=eq.${SLUG}&select=captured_at&order=captured_at.desc&limit=1`);
    if (!head) return null;
    if (!snap || snap.captured_at !== head.captured_at) {
      const [full] = await sb(`surf_snapshots?slug=eq.${SLUG}&captured_at=eq.${encodeURIComponent(head.captured_at)}&select=captured_at,rows`);
      if (full) snap = full;
    }
    return snap;
  }

  async function run(why) {
    // Disengaged rows are read too, while an output still holds something to clear.
    const alarms = await sb(`surf_alarms?day=gte.${today()}&select=*&order=day`);
    if (!alarms.length) return;
    const s = await latestSnapshot();
    const now = nowLocal();
    for (const a of alarms) {
      if (!a.engaged && !Object.keys(a.state || {}).length) continue;
      const d = a.engaged && s ? decide(a.rules, s.rows, a.day, tz()) : { rule: null, wake: null };
      const at = d.wake ? `${a.day}T${d.wake}` : null;
      // A wake time that has already passed is not rung late and does not cancel anything.
      const late = !!(at && at <= now);
      const state = { ...(a.state || {}) };
      if (!late) {
        for (const name of a.outputs || []) {
          const out = OUTPUTS[name];
          if (!out) { log(`[surf-alarm] ${a.day}: no output named "${name}"`); continue; }
          state[name] = await out.apply({ alarm: a, at, now, state: state[name] || {} });
          if (!Object.keys(state[name]).length) delete state[name];
        }
      }
      const decided = { snapshot: s ? s.captured_at : null, rule: d.rule, at, ...(late ? { late: true } : {}) };
      const patch = {};
      if (canon(decided) !== canon(a.decided)) patch.decided = decided;
      if (canon(state) !== canon(a.state || {})) patch.state = state;
      if (Object.keys(patch).length) {
        patch.updated = now.slice(0, 19);
        await sbWrite(`surf_alarms?day=eq.${a.day}`, 'PATCH', patch);
        log(`[surf-alarm] ${a.day} (${why}): rule ${d.rule == null ? 'none' : d.rule} -> ${at || 'no alarm'}${late ? ' (already past, left alone)' : ''}`);
      }
    }
  }

  async function tick(why) {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do { again = false; await run(why); } while (again);
    } catch (e) {
      log(`[surf-alarm] error: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  return { tick };
}

module.exports = { decide, createSurfAlarms, localHour };
