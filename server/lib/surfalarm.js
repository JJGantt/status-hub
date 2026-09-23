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
//
// `notFairFrom` is the wind veto: every hour of `day` from that one on counts as not Fair, whatever
// the forecast rated it. Null when there is no veto.
//
// `boost` is the veto's opposite and is deliberately NOT its mirror image. The veto can be blunt
// because its failure mode is safe — nobody is woken. An upgrade's failure mode is being woken at 6am
// for nothing, so it is narrow: { from, until } bounds the hours, and inside them an hour only turns
// Fair when the forecast put it EXACTLY one step below Fair and the forecast's own wind for that hour
// is not offshore. That second test is what makes it coherent rather than a thumb on the scale — it
// only fires where the forecast's stated reason for the lower rating is a wind direction the dock is
// measuring to be wrong. A two-step jump on wind alone is never credible, so POOR never becomes Fair.
function decide(rules, rows, day, tz, notFairFrom = null, boost = null) {
  const fair = new Map();
  for (const r of rows || []) {
    const { date, hour } = localHour(r.ts, tz);
    if (date !== day) continue;
    if (notFairFrom != null && hour >= notFairFrom) { fair.set(hour, false); continue; }
    const rated = SCALE.indexOf(r.rk) >= MIN_RATING;
    const lifted = !rated && boost && hour >= boost.from && hour <= boost.until
      && SCALE.indexOf(r.rk) === MIN_RATING - 1 && r.wType !== 'Offshore';
    fair.set(hour, rated || !!lifted);
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
    // An alarm-marked list item. The TV, the hub page and dueTick's notification all ring from one of
    // these, so this single output reaches all three.
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
        // An alarm is not a task: it goes on the alarms list, and it is EXEMPT, because waking up is
        // not something to earn points for. Exempt items close themselves once their moment passes;
        // closeExempt in server.js waits out the ring for an alarm before doing so.
        const fresh = uuid();
        await sbWrite('list_items', 'POST', {
          id: fresh, list_id: 'l_alarms', text: 'Surf, Mayport Poles', title: 'Surf',
          due: at, scheduled_at: at, priority: -1, alarm: true,
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

function createSurfAlarms({ sb, sbWrite, uuid, nowLocal, today, tz, log, record = () => {},
                            veto = async () => null, boost = async () => null }) {
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
    // THE WIND VETO — the live wind ruling out the rest of TODAY (the hub's surfVeto). It speaks for
    // the hours from now on, so it touches only today's alarm, and only while it holds: every new
    // reading re-runs this, and a veto that lifts before the wake time brings the alarm back.
    const v = await veto();
    const nowHour = Number(now.slice(11, 13));
    const vetoFrom = v ? nowHour : null;
    // THE UPGRADE, and only when there is no veto to overrule: the two cannot both hold — one wants
    // measured onshore wind and the other measured offshore — but reading it that way means a veto is
    // never softened by a stale idea of the morning. It speaks from now to its own last hour.
    const b = v ? null : await boost();
    const boostWindow = b && nowHour <= b.until ? { from: nowHour, until: b.until } : null;
    for (const a of alarms) {
      if (!a.engaged && !Object.keys(a.state || {}).length) continue;
      const live = a.day === today() && a.engaged && s;
      const plain = a.engaged && s ? decide(a.rules, s.rows, a.day, tz()) : { rule: null, wake: null };
      let d = plain;
      if (live && v) d = decide(a.rules, s.rows, a.day, tz(), vetoFrom);
      else if (live && boostWindow) d = decide(a.rules, s.rows, a.day, tz(), null, boostWindow);
      // Recorded only when it CHANGED the answer, so a windy morning with no alarm at stake writes nothing.
      const vetoed = v && d.rule !== plain.rule ? { kts: Math.round(v.kts), type: v.type, threshold: v.threshold, from: vetoFrom, overruled: plain.wake } : null;
      const boosted = b && boostWindow && d.rule !== plain.rule
        ? { kts: Math.round(b.kts), dir: b.dir, type: b.type, threshold: b.threshold,
            from: boostWindow.from, until: boostWindow.until, was: plain.wake } : null;
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
      const decided = { snapshot: s ? s.captured_at : null, rule: d.rule, at, ...(late ? { late: true } : {}),
                        ...(vetoed ? { veto: vetoed } : {}), ...(boosted ? { boost: boosted } : {}) };
      const patch = {};
      if (canon(decided) !== canon(a.decided)) patch.decided = decided;
      if (canon(state) !== canon(a.state || {})) patch.state = state;
      if (Object.keys(patch).length) {
        patch.updated = now.slice(0, 19);
        await sbWrite(`surf_alarms?day=eq.${a.day}`, 'PATCH', patch);
        log(`[surf-alarm] ${a.day} (${why}): rule ${d.rule == null ? 'none' : d.rule} -> ${at || 'no alarm'}${late ? ' (already past, left alone)' : ''}`);
        // One row per new forecast or rule change — the decision history `decided` overwrites.
        record('decision', { day: a.day, why, snapshot: decided.snapshot, rule: d.rule, at, late,
                             was: (a.decided && a.decided.at) || null, item: (state.item && state.item.id) || null,
                             ...(vetoed ? { veto: vetoed } : {}), ...(boosted ? { boost: boosted } : {}) });
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
