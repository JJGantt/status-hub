'use strict';
// Overall weekly score = (Training + Nutrition + Tasks) / 3.
//
// TRAINING% = Σ[ min(s,t) + 0.5·max(0,s−t) ] / Σt over the rolling-week clipped per-muscle sets,
//   where t is THAT muscle's own weekly target from lib/volume.js (14 for most, lower for a few).
//   Under-target drags 1:1, over rewards at ½, every muscle at its target = 100%, all-over > 100%.
//
// NUTRITION% — three components per day (carbs are DERIVED from calories, so not scored separately):
//   Day% = 0.35·protein + 0.35·calories + 0.30·fat        (no gate — a single bad macro just costs its
//          own weight; multiple bad macros compound naturally through the weighted sum.)
//   Every macro is scored on the ABSOLUTE gap from PACE (target prorated to the eating-window fraction),
//   NOT the proportional gap. Being 10g/200kcal off pace is the same hit at any time of day — the gram/
//   kcal deficit is what's scored, not deficit÷target. Each is a quadratic falloff to 0 at a fixed
//   absolute tolerance (small misses barely register, big ones bite). Because pace is small early, the
//   absolute gap you can have early is small too, so an unfinished morning never craters to 0.
//     protein  — FLOOR: only being UNDER pace is penalized (overage free). 0 at 50g behind pace.
//     calories — TWO-SIDED. 0 at 750 kcal off pace. (No goal-aware asymmetry: the calorie goal already
//                sitting above maintenance accounts for that.)
//     fat      — TWO-SIDED. 0 at 25g off pace.
//   The two-sided overage is split at the DAY TARGET, because front-loading is not overshooting: the
//   part that merely runs ahead of pace while still under the day's target counts at EARLY_WEIGHT, and
//   only the part past the target costs full. Behind pace always costs full. No today/past branch is
//   needed — a completed day has fraction=1, so pace == target, the early part is 0, and the split
//   collapses back to a plain symmetric deviation.
//   Past completed days use the full target as pace (fraction = 1); an unlogged day = 0. TODAY's pace is
//   prorated to the elapsed eating-window fraction. Nutrition% = 0.5·today + 0.5·past6avg.

//
// TASKS% — the gold band. Starts EMPTY and is earned by completing dated list items; there is no
//   neutral baseline, because a baseline would remove the only incentive the band exists to create,
//   which is putting things on the list in the first place. Completing on time earns full value and
//   completing progressively later earns less, down to nothing at TASK_LATE_ZERO_H — but never less
//   than nothing, because the cost of lateness is billed by the hour instead. Anything past its
//   grace bills for as long as it sits, whether it is eventually done or not. Every effect fades
//   linearly to nothing over the same seven days the other two bands look back over, so a hit's SIZE
//   decides how long it is felt — no separate recovery rule.
//
//   Only COMPLETING scores. Deleting an item is worth nothing in either direction — it is a thing he
//   decided not to do, not a thing he failed at — so calling off a whole series costs nothing and
//   needs no special case. The two are different verbs precisely so that neither has to be guessed
//   at from the clock. DELETING IS THEREFORE THE HONEST WAY OUT of something overdue: it stops the
//   charge without pretending the thing was done, where completing it stops the charge and keeps
//   every hour already billed.
//
//   EXEMPT items (priority < 0) are invisible to all of this. A work shift or an appointment happens
//   at a time but owes nothing, so there is nothing to earn for "completing" one and penalising him
//   for not ticking one off is worse than useless. They are skipped on both sides — no credit, no
//   drain — which is why this is a branch rather than a zero multiplier: a multiplier of zero would
//   still let them count as overdue.
//
//   The drain is UNBOUNDED in what it can bill, deliberately. Ignoring something for a week is not
//   the same as ignoring it for a day, and a floor would say it was. What bounds it is the band: an
//   hour that would take the level below zero is not charged, so neglect can empty the band and
//   never dig under it. Completing does not refund what was already billed — only deleting the item
//   avoids the charge, and that is the difference between calling something off and doing it late.

const W_PRO = 0.35, W_CAL = 0.35, W_FAT = 0.30;     // nutrition macro weights (sum 1); carbs derived, not scored
const PRO_TOL = 50;     // protein: grams BEHIND pace at which the score hits 0 (under only; over is free)
const CAL_TOL = 750;    // calories: kcal off pace (either direction) at which the score hits 0
const FAT_TOL = 25;     // fat: grams off pace (either direction) at which the score hits 0
const EARLY_WEIGHT = 0.5; // ahead-of-pace-but-under-target overage counts at half
const W_TODAY = 0.5;                                 // today's weight within nutrition

// ---- task band tuning. Everything adjustable about the gold band is in this block. ----
// On-time completions/day that HOLDS the band full. This is the amplitude knob: one ordinary
// completion is worth 1/(RATE·DECAY/2) of the band, so raising it makes each task move the bar less.
// Set it from the rate actually EARNED against, which is what the late curve leaves rather than the
// raw count: five completions run one to two hours past their deadlines land about four units.
// A rate far above that leaves the gold unreachable however well the day goes, and a band that
// cannot be filled is not measuring anything — which is what 8 did.
// 2.5 was set when a day here carried two or three dated items. A week of real use (2026-09-05..09)
// ran 2.1-2.7 units/day against it, so two a day settled the band at 80% and three pinned it at
// 95%: full became the resting state, which is a gauge reporting nothing. 4 restores the spread —
// two a day reads 50%, three 77%, and only four or more on time fills it.
// One ordinary on-time completion is ~7.1% of the band, ~2.4 points of the overall bar.
const TASK_RATE = 4;
const TASK_DECAY_DAYS = 7;    // a completion's effect fades linearly to nothing over this
const TASK_GRACE_MIN = 30;    // still "on time" this long past the deadline
const TASK_LATE_ZERO_H = 4;   // lateness at which a completion is worth nothing
const TASK_DRAIN_FULL_H = 24; // an overdue item drains one unit per this many hours, forever
const DAY_START_HOUR = 4;     // the display day's 4am origin, shared with lib/dates.js
const TASK_STEP_H = 1;        // replay granularity

// One ordinary on-time completion is worth 1 unit, so FULL is how many of those the band holds.
const TASK_FULL_UNITS = TASK_RATE * TASK_DECAY_DAYS / 2;
// A steady TASK_RATE completions a day, each aging out linearly over TASK_DECAY_DAYS, settles at
// RATE·DAYS/2 — which is what FULL is, so the band is exactly reachable and holdable at that rate.

// Units are the band's internal currency; POINTS are what a person reads. The band is 100 of them —
// the same 100 the bar is drawn against — so an ordinary on-time completion is worth
// 100/TASK_FULL_UNITS of them. One definition, because a chip claiming a task is worth 7 while the
// bar moves by 11 is a chip nobody can trust again.
const bandPoints = (units) => (TASK_FULL_UNITS > 0 ? (units * 100) / TASK_FULL_UNITS : 0);
const POINT = TASK_FULL_UNITS / 100;                               // one displayed point, in units
// Nearest WHOLE point, in units. Everything a chip announces is quantised through this before it is
// scored, so the integer on the chip is the credit itself rather than a rendering of a number next
// to it. A chip reading "+7" while 7.14 lands is a small lie that compounds — seven of them and the
// bar is a point away from where the chips said it would be — and it makes the POTENTIAL chip
// unactionable, since "do it now for +5" would move while he was reading it. Quantised, the 5 is a
// plateau: completing anywhere inside the stretch of lateness that rounds to 5 pays exactly 5.
const toPoints = (units) => Math.round(units / POINT) * POINT;

// Quadratic falloff on an ABSOLUTE deviation: 1 at dev 0, 0 once |dev| >= tol. Small misses barely
// register; big ones bite (3× the deviation ≈ 9× the penalty).
const quadAbs = (dev, tol) => (tol > 0 ? Math.max(0, 1 - (dev / tol) ** 2) : (dev <= 0 ? 1 : 0));

// Protein is a floor: only a shortfall vs pace costs anything; being at/over pace scores 1.
const proteinScore = (actual, pace) => quadAbs(Math.max(0, pace - actual), PRO_TOL);
// Two-sided deviation, discounted for front-loading. Behind pace costs full. Ahead of pace splits at
// the day target: the under-target part is only early (EARLY_WEIGHT), the part past target costs full.
function twoSidedDev(actual, pace, target) {
  if (actual <= pace) return pace - actual;
  const excess = Math.max(0, actual - target);       // genuinely overshot the day
  const early = actual - pace - excess;              // merely ahead of schedule
  return EARLY_WEIGHT * early + excess;
}
const calorieScore = (actual, pace, target) => quadAbs(twoSidedDev(actual, pace, target), CAL_TOL);
const fatScore = (actual, pace, target) => quadAbs(twoSidedDev(actual, pace, target), FAT_TOL);
const pct = (x) => Math.round(x * 1000) / 10;

// Each muscle carries its OWN target on the volume payload, so the band's denominator is the sum of
// those targets, not one constant times the muscle count. Lower a muscle's target in lib/volume.js and
// both sides move together: its sets saturate sooner AND the total needed drops by the same amount.
function trainingScore(volume) {
  const muscles = (volume && volume.groups || []).flatMap((g) => g.muscles);
  const points = muscles.reduce((sum, m) => {
    const t = Number(m.target) || 0;
    return sum + Math.min(m.sets, t) + 0.5 * Math.max(0, m.sets - t);
  }, 0);
  const target = muscles.reduce((sum, m) => sum + (Number(m.target) || 0), 0);
  return { pct: target > 0 ? points / target : 0, points: Math.round(points * 10) / 10, target };
}

// days: [{ date, isToday, fraction, cal, protein, fat, calGoal, proteinFloor, fatTarget }].
function nutritionScore(days) {
  const scored = days.map((d) => {
    const f = d.isToday ? d.fraction : 1;          // today's pace is prorated to the elapsed window fraction
    const calPace = d.calGoal * f, proPace = d.proteinFloor * f, fatPace = d.fatTarget * f;
    const cal = calorieScore(d.cal, calPace, d.calGoal);
    const pro = proteinScore(d.protein, proPace);
    const fat = fatScore(d.fat, fatPace, d.fatTarget);
    const dayPct = W_PRO * pro + W_CAL * cal + W_FAT * fat;
    return { ...d, f, calPace, proPace, fatPace, calScore: cal, proScore: pro, fatScore: fat, dayPct };
  });
  const todayEntry = scored.find((d) => d.isToday);
  const past = scored.filter((d) => !d.isToday);
  const pastAvg = past.length ? past.reduce((s, d) => s + d.dayPct, 0) / past.length : 0;
  const todayPct = todayEntry ? todayEntry.dayPct : pastAvg;
  let p;
  if (todayEntry && past.length) p = W_TODAY * todayPct + (1 - W_TODAY) * pastAvg;
  else if (todayEntry) p = todayPct;
  else p = pastAvg;
  return { pct: p, today: todayPct, pastAvg, days: scored };
}

// ---- tasks ----
//
// Naive local wall-clock strings throughout ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM[:SS]'), parsed as if
// UTC so differences are exact wall-clock arithmetic with no DST step. What matters here is how late
// the CLOCK said something was, which is what he experienced.
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
function naive(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
const isTimed = (s) => /T\d/.test(String(s || ''));
/** priority -1: on the schedule, but not a task. Scores nothing and can never be overdue. */
const isExempt = (i) => (Number(i && i.priority) || 0) < 0;

// An untimed item is on time any moment before its day ends, so its deadline is the NEXT day's 4am
// origin. A timed one is its own moment. (Untimed items still FIRE at 9am — when it notifies and
// when it is late are different questions about the same value.)
function taskDeadline(occurrence) {
  const at = naive(occurrence);
  if (at == null) return null;
  return isTimed(occurrence) ? at : at + DAY + DAY_START_HOUR * HOUR;
}
// +1 on time, sliding to 0 at LATE_ZERO and staying there. It does NOT go negative: the cost of
// being late is the drain, charged by the hour for as long as the thing actually sat, and a negative
// here would charge the same lateness a second time in a lump. This curve says only what finishing
// is worth; the drain says what waiting cost.
function completionValue(lateMs) {
  const grace = TASK_GRACE_MIN * MIN, zero = TASK_LATE_ZERO_H * HOUR;
  if (lateMs <= grace) return 1;
  if (lateMs >= zero) return 0;
  return 1 - (lateMs - grace) / (zero - grace);
}

// How far ahead of the caller's own clock a completion stamp may still be accepted. Two machines
// write these — the hub from Fly and the data layer from whichever host ran the tool — and their
// clocks are not the same clock. Without a tolerance a phone running a minute fast would have an
// ordinary "done, now" rejected as time travel. Far below TASK_GRACE_MIN, so it cannot change what
// anything scores; a stamp inside it that is still fractionally ahead is simply skipped by the
// replay below until the clock reaches it, and the next rebuild picks it up.
const STAMP_SKEW_MS = 2 * MIN;

/**
 * Normalise a caller-supplied completion time into a stamp the band can actually read.
 *
 * Completing something "now" needs none of this — the writer stamps its own clock. This is for the
 * other case: saying WHEN it was done, after the fact ("I finished that at 10:15"). The time is the
 * entire input to what the completion is worth, so a caller that knows it better than the clock does
 * has to be able to say so, and what it says has to be checked before it reaches the column.
 *
 * TIMEZONE. `completed_at` is compared against `due` as naive wall-clock arithmetic — that is what
 * makes a lateness one he actually experienced rather than one an offset invented — so a stamp
 * carrying a `Z` or a `+HH:MM` is rejected rather than converted. This module never learns a
 * timezone, so converting here would be guessing at an offset, and guessing is precisely how a
 * completion lands an hour from the deadline it is scored against.
 *
 * THE FUTURE is rejected for a different reason, and it is the one worth stating: the replay walks
 * up to `now` and skips any completion past it. Storing a future stamp would take the item off every
 * active surface while earning nothing at all — from the outside, indistinguishable from the band
 * being broken. Better to refuse it than to lose it silently.
 *
 * THE DISTANT PAST is NOT rejected. A completion older than TASK_DECAY_DAYS earns nothing, but that
 * is the decay doing its job on a true record of something that happened, not a bad input.
 *
 * `reason` is for the caller that has to explain the refusal — an API body, or a model composing a
 * reply. Returns { ok: true, value } or { ok: false, reason }.
 */
function completionStamp(at, nowLocal) {
  const raw = String(at == null ? '' : at).trim();
  if (!raw) return { ok: false, reason: 'a completion time is required' };
  // Anchored at BOTH ends, unlike naive() — which is a lenient reader of stamps already in the
  // database and would happily take the 'Z' off the end of one this has to turn away.
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!m) {
    return { ok: false, reason: 'expected local wall clock YYYY-MM-DDTHH:MM (or YYYY-MM-DD), with no timezone' };
  }
  const value = m[2] == null ? m[1] : `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`;
  const t = naive(value);
  // Date.UTC ROLLS OVER out-of-range components, so month 13 and day 45 both parse to a real instant
  // in the wrong month. Only the round trip catches that.
  if (t == null || new Date(t).toISOString().slice(0, 19) !== (m[2] == null ? `${value}T00:00:00` : value)) {
    return { ok: false, reason: 'not a real date' };
  }
  const now = naive(nowLocal);
  if (now != null && t > now + STAMP_SKEW_MS) return { ok: false, reason: 'is in the future' };
  return { ok: true, value };
}

/**
 * The gold band is a BOUNDED QUEUE of decaying completions, replayed forward.
 *
 * It was a window sum, and that could not honour its own limits: the total ran uncapped while only
 * the DISPLAY was clamped to 0-100%, so a heavy week banked surplus that silently held the bar full
 * afterwards, and a neglected item dug an invisible hole that several completions had to fill before
 * anything moved. The bar was describing a number that was not the number.
 *
 * The fix is a queue with a fixed capacity rather than a cap applied at the end. Each completion is
 * admitted with a credit and still ages out linearly over TASK_DECAY_DAYS on its own clock, so the
 * decay is unchanged. When admitting one would take the level past FULL, the OLDEST credits are
 * pushed out to make room — the newest work always lands, and what falls off the far end is gone
 * for good rather than waiting above the ceiling as a buffer.
 *
 * Draining does NOT work from that end, or from the queue at all. The level is `credit − debt`,
 * debt is a running total an overdue item adds to for every hour it sits, and A POINT LOST STAYS
 * LOST: the debt does not decay, and finishing the item does not clear it. Completing buys one
 * thing, which is that no further hours are billed. Raising the bar again takes new completions.
 *
 * Three shapes were built and measured before this one, and the two that coupled the drain to a
 * specific credit both handed the loss back:
 *
 *   - taken from the OLDEST credits, on the symmetry that overfill is. The oldest credit is nearly
 *     spent, so a day of neglect moved the bar five points instead of seven and stopped biting after
 *     two days.
 *   - taken from the NEWEST credit instead, which is the intuitive fix. It fails for a subtler
 *     reason: the credit destroyed was going to expire anyway, so the loss fades on that credit's
 *     clock. Coupling a debit to an event does not make it permanent — it makes it inherit that
 *     event's decay. It also undercharges, since a point billed at 9am is worth less by the time the
 *     day is read: a day overdue landed at 6.5 rather than 7.
 *   - as a decaying NEGATIVE ENTRY stamped with the hour billed. Same outcome — the gap between
 *     "was late" and "was never late" closed from 8.2 points to 1.4 over five idle days, so being
 *     late was something you could wait out.
 *
 * A flat debt is the only one where the gap holds (measured: 9.0 points, unchanged over five idle
 * days). What ages it out is the same thing that ages out a completion — the SPAN that billed it
 * falls off the back of the seven-day window — so the penalty is tied to when the neglect happened
 * rather than to when some unrelated credit happens to expire.
 *
 * Debt is capped at the credit actually present, checked as it accrues, and that cap is what
 * "cannot empty past 0%" means. Uncapped it would run below the bottom of the bar, where it is a
 * hole nobody can see — the bar reads 0 either way, and the next completion vanishes into the hole
 * instead of moving it. Capped, every new credit shows immediately however long the neglect ran.
 *
 * A COMPLETED row still carries a drain span, from its deadline to its completed_at, which is what
 * makes the band more than a function of what is open right now. Deleting the item is the honest way
 * out: it stops the charge without claiming the thing was done.
 *
 * completed: [{ scheduled_at|due, completed_at, priority }] — items marked done.
 * open:      [{ scheduled_at|due, priority }]               — dated items still outstanding.
 * nowLocal:  naive local wall-clock string.
 */
function tasksScore({ events = [], open = [], nowLocal }) {
  const now = naive(nowLocal);
  const empty = { pct: 0, level: 0, units: 0, earned: 0, drained: 0, overdue: 0, completed: 0,
                  drain_per_day: 0, drain_per_hour: 0, drain_next_hour_pct: 0 };
  if (now == null) return empty;

  const stepMs = TASK_STEP_H * HOUR;
  // Anchored to the CLOCK hour, not to `now`. Stepping back from now would put the grid at whatever
  // minute the payload happened to be built at, so the quantisation boundary would slide on every
  // rebuild and the level would jitter between two neighbouring values. Flooring pins it: the drain
  // lands on the hour, every rebuild agrees, and only the final partial step tracks the live clock.
  const start = Math.floor((now - TASK_DECAY_DAYS * DAY) / stepMs) * stepMs;
  const decayWindow = TASK_DECAY_DAYS * DAY;
  const weightAt = (credit, t) => Math.max(0, 1 - (t - credit.at) / decayWindow);

  const landings = [];
  for (const e of events) {
    if (isExempt(e)) continue;                                     // nothing owed, so nothing earned
    const done = naive(e.completed_at), deadline = taskDeadline(e.scheduled_at || e.due);
    if (done == null || deadline == null || done < start || done > now) continue;
    landings.push({ at: done, amount: toPoints(completionValue(done - deadline) * (1 + (Number(e.priority) || 0))) });
  }
  landings.sort((a, b) => a.at - b.at);

  // An item is overdue from its grace expiring until it is DONE — or until now, if it never was.
  // Finishing stops the charge; it does not refund it. Both spans are reconstructible from the rows,
  // since a completed item still carries its own deadline and its completed_at, so nothing has to be
  // stored to remember that it sat there.
  //
  // The rate is quantised for the same reason a landing is, so the two sides are on one scale: a day
  // overdue costs 7, an on-time completion pays 7.
  const drains = [];
  const overdueSpan = (row, until) => {
    if (isExempt(row)) return;                                     // an appointment cannot be late
    const deadline = taskDeadline(row.scheduled_at || row.due);
    if (deadline == null) return;
    const from = deadline + TASK_GRACE_MIN * MIN;
    if (!(until > from)) return;
    drains.push({ from, to: until, rate: toPoints(1 + (Number(row.priority) || 0)) });
  };
  for (const o of open) overdueSpan(o, Infinity);
  for (const e of events) {
    const done = naive(e.completed_at);
    if (done != null) overdueSpan(e, done);
  }

  // The queue holds EARNED credit. A drain is a running DEBT subtracted from it, and the level is
  // credit − debt. The debt does not decay, and finishing the item does not clear it.
  //
  // Two other shapes were built and measured first, and both handed the loss back:
  //
  //   - a decaying NEGATIVE ENTRY, stamped with the hour it was billed. It carries a full window of
  //     its own, so it fades — the gap between "was late" and "was never late" closed from 8.2
  //     points to 1.4 over five idle days. Lateness became something you could wait out.
  //   - DEBITING A CREDIT, taking the points off the newest completion. Same result and for a
  //     sharper reason: the credit it destroys was going to expire anyway, so the loss fades on that
  //     credit's clock. Coupling the debit to an event does not make it permanent; it makes it
  //     inherit the event's own decay. It also undercharges, because a point billed at 9am is worth
  //     less by the time the day is read — a day overdue landed at 6.5 rather than 7.
  //
  // A flat debt is the only one of the three where a point lost stays lost. What ages it out is the
  // same thing that ages out everything else: the SPAN that billed it eventually falls off the back
  // of the seven-day window. So the penalty is tied to when the neglect happened, not to when some
  // unrelated completion happens to expire.
  //
  // The debt is capped at the credit present, checked as it accrues, and that cap is what "cannot
  // empty past 0%" means: debt banked under the floor is invisible, and the next completion would
  // vanish into it instead of moving the bar.
  const credits = [];                                              // oldest first
  const creditAt = (t) => credits.reduce((sum, c) => sum + c.credit * weightAt(c, t), 0);
  // OVERFILL only: push `want` off the oldest end — the credit closest to ageing out is the right
  // thing to displace when the queue is merely full. Returns what was actually removed.
  const takeOldest = (want, t) => {
    let left = want;
    for (const c of credits) {
      if (left <= 1e-9) break;
      const w = weightAt(c, t);
      if (w <= 0 || c.credit <= 0) continue;
      const removable = c.credit * w;
      const taken = Math.min(removable, left);
      c.credit -= taken / w;
      left -= taken;
    }
    return want - left;
  };

  let earned = 0, li = 0, debt = 0;
  for (let t = start; t <= now; t += stepMs) {
    const stepEnd = Math.min(t + stepMs, now);
    while (li < landings.length && landings[li].at <= stepEnd) {
      const L = landings[li];
      if (L.amount > 0) {
        credits.push({ at: L.at, credit: L.amount });
        // The ceiling is on the level a person READS, not on raw credit: with debt outstanding there
        // is room under 100, and a completion has to be visible in it.
        const over = creditAt(L.at) - debt - TASK_FULL_UNITS;
        earned += over > 0 ? Math.max(0, L.amount - takeOldest(over, L.at)) : L.amount;
      }
      li++;
    }
    // Every hour any item spent overdue inside this step, at that item's rate.
    for (const d of drains) {
      const a = Math.max(t, d.from), b = Math.min(stepEnd, d.to);
      if (b > a) debt += d.rate * ((b - a) / DAY);
    }
    const cap = creditAt(stepEnd);
    if (debt > cap) debt = cap;
    while (credits.length && credits[0].credit <= 1e-9) credits.shift();
  }
  const drained = -debt;

  const level = Math.max(0, Math.min(TASK_FULL_UNITS, creditAt(now) - debt));
  // What the next hour costs at the current rate, if nothing changes. Surfaced rather than derived
  // by a caller so there is one answer to "how fast am I bleeding" — and so it cannot drift from the
  // rate the replay above actually applied.
  const liveRate = drains.reduce((r, d) => r + (d.from < now && d.to > now ? d.rate : 0), 0);
  const perHour = liveRate / 24;
  return {
    pct: TASK_FULL_UNITS > 0 ? level / TASK_FULL_UNITS : 0,
    level, units: level, earned, drained,
    drain_per_day: liveRate,
    drain_per_hour: perHour,
    // Capped by what is actually there: at 0.4 units left, the next hour cannot cost more than that.
    drain_next_hour_pct: TASK_FULL_UNITS > 0 ? Math.min(level, perHour) / TASK_FULL_UNITS : 0,
    overdue: drains.filter((d) => d.from < now && d.to > now).length,
    completed: landings.length,
  };
}

function computeScore({ volume, days = [], surplus = 0, taskEvents = [], openTasks = [], nowLocal = null }) {
  const t = trainingScore(volume);
  const n = nutritionScore(days);
  const k = tasksScore({ events: taskEvents, open: openTasks, nowLocal });
  const overall = (t.pct + n.pct + k.pct) / 3;
  return {
    overall: pct(overall),
    tasks: {
      pct: pct(k.pct), units: Math.round(k.units * 100) / 100,
      earned: Math.round(k.earned * 100) / 100, drained: Math.round(k.drained * 100) / 100,
      overdue: k.overdue, completed: k.completed,
      // What the next hour costs at the current rate. Carried on the payload rather than left to a
      // client to derive, so every surface that ever shows it agrees with the replay that applied it.
      drain_per_day: Math.round(k.drain_per_day * 100) / 100,
      drain_next_hour_pct: pct(k.drain_next_hour_pct),
    },
    training: { pct: pct(t.pct), points: t.points, target: t.target },
    nutrition: {
      pct: pct(n.pct), today: pct(n.today), past_avg: pct(n.pastAvg),
      goal_mode: surplus > 0 ? 'surplus' : surplus < 0 ? 'deficit' : 'maintenance',
      days: n.days.map((d) => ({
        date: d.date, is_today: !!d.isToday, day_pct: pct(d.dayPct),
        cal: { actual: Math.round(d.cal), goal: Math.round(d.calPace), score: pct(d.calScore) },
        protein: { actual: Math.round(d.protein), floor: Math.round(d.proPace), score: pct(d.proScore) },
        fat: { actual: Math.round(d.fat), target: Math.round(d.fatPace), score: pct(d.fatScore) },
      })),
    },
  };
}

// Exported so the calendar can label a chip with the same numbers the band is actually scored on.
// One definition, so a chip cannot claim a value the band would not give it.
module.exports = { computeScore, tasksScore, taskDeadline, completionValue, completionStamp, bandPoints, toPoints,
                   TASK_GRACE_MIN, TASK_LATE_ZERO_H, TASK_DRAIN_FULL_H };
