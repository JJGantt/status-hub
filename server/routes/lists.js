'use strict';
const { tasksScore, taskDeadline, completionValue, completionStamp, bandPoints, toPoints, TASK_GRACE_MIN, TASK_LATE_ZERO_H, TASK_DRAIN_FULL_H } = require('../lib/score');
const crypto = require('crypto');
const express = require('express');

module.exports = function (ctx) {
  const {
    DESK_STALE_S, broadcast, dirtyRows, etNowString, etStringAt, gated, lateMoment, overdueCount,
    pushLists, sb, sbWrite, settingsAll, syncBadge, timed,
  } = ctx;

  // ---- lists surface. Voice/MCP writes them; this is the visual pane. ----
  //
  // `due` is sent as a normal field on every item, and `due` collects the dated ones from ALL lists
  // into one soonest-first view. That view is what used to be the reminders table — it is now derived,
  // not stored, so an item appears in it and on its own list at once without being duplicated.
  // How hard an overdue row should read: 0 not overdue, then escalating. The health bar cannot carry
  // this on its own — the gold band floors at zero, so once it is pinned there a second neglected item
  // looks identical to the first. The bar shows what has been earned; the row shows what is owed.
  // Computed here rather than in the cards because three surfaces draw these rows and a rule they each
  // re-derive is a rule they will eventually disagree about.
  function overdueHeat(item, nowLocal) {
    const st = chipState(item, nowLocal);
    if (st === 'upcoming') return 0;
    if (st === 'grace') return 1;                    // due, but still free — warm, not hot
    const at = lateMoment(item.scheduled_at || item.due);
    const hrs = (Date.parse(nowLocal.replace(' ', 'T') + 'Z') - Date.parse(at.replace(' ', 'T') + 'Z')) / 3600000;
    return hrs >= 72 ? 4 : hrs >= 24 ? 3 : 2;
  }

  gated.get('/api/todos', async (req, res) => {
    try {
      const [listNames, items] = await Promise.all([
        sb('lists?select=id,name,emoji&order=name'),
        sb('list_items?deleted=eq.false&completed_at=is.null&select=id,list_id,list_name,text,title,due,scheduled_at,priority,series_id,alarm&order=created.asc'),
      ]);
      const all = items || [];
      // Grouped by `list_id`, and the id is sent on so the composer can post it back. `list_name` is a
      // derived copy (data-layer 00094) — fine to display, never the thing to match or write on.
      const lists = (listNames || []).map((l) => ({ id: l.id, name: l.name, emoji: l.emoji, items: all.filter((i) => i.list_id === l.id) }));
      // Longest outstanding first, then upcoming.
      const nowET = etNowString();
      const due = all.filter((i) => i.due)
        .map((i) => ({ ...i, expired: lateMoment(i.scheduled_at || i.due) <= nowET, heat: overdueHeat(i, nowET) }))
        .sort((a, b) => lateMoment(a.scheduled_at || a.due) < lateMoment(b.scheduled_at || b.due) ? -1 : 1);
      res.json({ lists, due });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // Compact feed for the iOS to-do widget. Deliberately NOT /api/todos: that one carries every list
  // and the full body of every item, and the widget draws one list's item titles.
  //
  // Items carry a real `title` now (migration 00056), so this prefers it and only derives one when it
  // is absent. The derivation is the fallback for everything written before the column existed: items
  // written by voice routinely carry the gist, an em dash, then the reasoning ("Replace the Pi thumb
  // drive with a USB SSD — the 32GB one is a corruption risk under 24/7 writes"), and a widget row has
  // space for the first half only. Either way the hub decides what a row says, not the Swift.
  const LIST_WIDGET_MAX = 12;          // the large family draws ~10; a couple spare costs nothing
  function itemTitle(row) {
    const explicit = String(row.title || '').trim();
    if (explicit) return explicit.length > 90 ? explicit.slice(0, 89).trimEnd() + '…' : explicit;
    const first = String(row.text || '').split('\n')[0];
    const derived = first.split(' — ')[0].trim() || first.trim();
    return derived.length > 90 ? derived.slice(0, 89).trimEnd() + '…' : derived;
  }
  // The widget's feed: every dated item, across every list, anchor-ordered. This replaces the
  // per-list widget feed — one surface showing everything that has a time on it, rather than one list
  // at a time, because "what needs dealing with" is never confined to a single list.
  gated.get('/api/due-widget', async (req, res) => {
    try {
      const [rows, listRows] = await Promise.all([
        sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id,alarm&order=scheduled_at.asc'),
        sb('lists?select=name,emoji'),
      ]);
      const emojiOf = {};
      for (const l of listRows || []) emojiOf[l.name] = l.emoji;
      const nowET = etNowString();
      const items = (rows || []).slice(0, LIST_WIDGET_MAX).map((r) => ({
        id: r.id,
        title: itemTitle(r),
        list: r.list_name,
        emoji: emojiOf[r.list_name] || null,
        expired: lateMoment(r.scheduled_at || r.due) <= nowET,
        heat: overdueHeat(r, nowET),
        priority: r.priority || 0,
        alarm: !!r.alarm,
        when: r.scheduled_at || r.due,
        repeating: !!r.series_id,
      }));
      res.json({ items });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // The repo widget's feed. Mirrors what cards/repos.js decides — which branch is worth showing, how
  // old "old" reads — so the two surfaces can't disagree about the same project.
  const REPOS_WIDGET_MAX = 12;
  function repoAgo(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  // Nearly everything sits on main, so that chip would be a column of identical noise.
  const notableBranch = (b) => !!b && b !== 'main' && b !== 'master';
  gated.get('/api/repos-widget', async (req, res) => {
    try {
      const [repos, presence] = await Promise.all([
        sb(`repos?select=path,name,branch,dirty,last_active&order=last_active.desc.nullslast&limit=${REPOS_WIDGET_MAX}`),
        sb('worker_presence?worker=eq.desk&select=last_seen'),
      ]);
      const seen = (presence && presence[0] && presence[0].last_seen) || null;
      const online = !!seen && (Date.now() - new Date(seen).getTime()) / 1000 <= DESK_STALE_S;
      res.json({
        online,
        repos: (repos || []).map((r) => ({
          path: r.path, name: r.name, dirty: !!r.dirty,
          branch: notableBranch(r.branch) ? r.branch : null,
          age: repoAgo(r.last_active),
        })),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  gated.get('/api/list-widget', async (req, res) => {
    try {
      const name = String(req.query.list || 'todo');
      const rows = await sb(`list_items?deleted=eq.false&completed_at=is.null&list_name=eq.${encodeURIComponent(name)}` +
                            `&select=id,text,title,due&order=created.asc&limit=${LIST_WIDGET_MAX}`);
      const nowET = etNowString();
      res.json({ list: name, items: (rows || []).map((r) => ({
        id: r.id,
        title: itemTitle(r),
        // Dated items live on ordinary lists now, so the widget marks the ones that have come due.
        overdue: !!r.due && lateMoment(r.due) <= nowET,
      })) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- calendar: a month of dated items as a finished grid, for /calendar and the calendar wall ----
  //
  // The whole grid is computed HERE — week rows, day cells, per-item chip colors, time labels — and the
  // client only paints it. Read-only by design: writes stay with voice/MCP and the todo pane, which is
  // what keeps this away from the reminder dedupe key and the scheduled_at anchor entirely.
  //
  // Only the FUTURE is dense: clearing an item is a soft delete (purged after 30 days) and a repeater
  // stores only its next `due`, so past days are naturally sparse. That matches what the surface is
  // for — what's coming — and is why there is no attempt at a history view here.
  //
  // Chip colors are hashed from the list name, not assigned by row order, so a list keeps its color
  // when lists are added or removed. Collisions are possible and acceptable at this list count.
  const CAL_COLORS = ['#e5484d', '#f76b15', '#ffb224', '#46a758', '#12a594',
                      '#0091ff', '#6e56cf', '#d6409f', '#b0e64c', '#00b8d9'];
  // A list can also be PINNED to a colour, which then wins over the hash. The hash exists so nobody
  // has to choose, not to stop anyone choosing — and `todo` carries most of what is ever on a day, so
  // it is the one worth naming. Keyed lowercase; the hash still covers everything else.
  const CAL_COLOR_PINNED = { todo: '#ffd60a' };
  function listColor(name) {
    const pinned = CAL_COLOR_PINNED[String(name || '').toLowerCase()];
    if (pinned) return pinned;
    let h = 5381;
    for (const c of String(name || '')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
    return CAL_COLORS[h % CAL_COLORS.length];
  }
  // '...THH:MM' → '9a' / '3:30p'; date-only → null (an all-day chip). Same compaction as the todo
  // pane's fmtDue, minus the date half.
  function calTimeLabel(occ) {
    const m = String(occ).match(/T(\d{2}):(\d{2})/);
    if (!m) return null;
    const h = +m[1]; const mm = m[2]; const h12 = h % 12 || 12;
    return `${h12}${mm === '00' ? '' : ':' + mm}${h < 12 ? 'a' : 'p'}`;
  }
  // Add minutes to a local-naive stamp WITHOUT going near a timezone. Date.parse of a naive string
  // treats it as UTC, and formatting the result back through etStringAt then applies the display zone
  // on top — a double conversion that moved a 13:59 deadline to 10:29. UTC getters over naive
  // components is the same trick the month math uses: no zone is ever applied, so nothing can shift.
  function plusMinutes(naiveLocal, mins) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(naiveLocal || ''));
    if (!m) return naiveLocal;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + mins * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
         + `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  // due -> grace (still on time, costs nothing) -> expired (draining). One place, so the calendar and
  // the pane cannot disagree about when something starts costing.
  function chipState(item, nowLocal) {
    const at = lateMoment(item.scheduled_at || item.due);
    if (!at || at > nowLocal) return 'upcoming';
    return plusMinutes(at, TASK_GRACE_MIN) > nowLocal ? 'grace' : 'expired';
  }

  // How far ahead to look for the next change in a chip's NUMBER. Past four hours late an item is in
  // the slow half of its drain, where the figure moves by a tenth every couple of hours; probing
  // further buys a re-read nothing else would have missed. Every day column re-reads on its own well
  // inside this — the dial when the hour rolls, the others when the now-line leaves the rendered range.
  const SCORE_LOOKAHEAD_MIN = 6 * 60;

  // The client's clock is minute-precision ('YYYY-MM-DDTHH:MM', see cards/dayline.js `stamp`) and it
  // compares these as strings, so a stamp carrying seconds is one it cannot match until the minute
  // AFTER the one meant — which is why grace used to end a minute late while the due moment, having no
  // seconds on it, landed on time. Cutting every candidate to the minute makes them all exact.
  const toMinute = (s) => (s ? String(s).slice(0, 16) : s);

  /**
   * When this item's chip would show a DIFFERENT NUMBER, or null if not within the lookahead.
   *
   * Everything else about a chip changes in steps whose moments are known — it comes due, it leaves
   * grace, it expires. The number does not. From the end of grace it slides continuously, and it is
   * the one thing on the chip that claims to describe THIS moment: complete it now and get this. So
   * it was the one thing with no transition of its own, and it was only ever re-read when something
   * unrelated forced a re-read. On the wall that meant the hour boundary, which is how a task thirty
   * minutes past its grace still offered the full +1.0 that completing it would no longer have earned.
   *
   * Found by asking `scoreFields` rather than by inverting it. Within each regime the rendered value
   * moves one way only, and the two regimes disagree in both sign and kind, so "renders what it
   * renders now" is true up to some moment and false from there on — which is exactly what makes a
   * binary search over the minute exact rather than approximate. Inverting the curve instead would put
   * a second copy of it here, to drift from the first the next time the tuning block is touched.
   */
  function nextScoreChange(item, nowLocal) {
    const shownAt = (mins) => JSON.stringify(scoreFields(item, plusMinutes(nowLocal, mins)));
    const now = shownAt(0);
    if (shownAt(SCORE_LOOKAHEAD_MIN) === now) return null;
    let lo = 0, hi = SCORE_LOOKAHEAD_MIN;          // invariant: shownAt(lo) === now, shownAt(hi) !== now
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (shownAt(mid) === now) lo = mid; else hi = mid;
    }
    return toMinute(plusMinutes(nowLocal, hi));
  }

  // When the next chip changes, so a wall can re-read exactly then instead of polling. Without it
  // nothing re-renders as time passes: the minute tick only moves the now-line, so an item would
  // silently go overdue and keep its old colour until some unrelated edit touched the lists.
  function nextChipTransition(rows, nowLocal) {
    let next = null;
    const consider = (m) => { if (m && m > nowLocal && (next === null || m < next)) next = m; };
    for (const r of rows || []) {
      if (r.completed_at) continue;                // a finished item's chip is settled; nothing moves
      const at = lateMoment(r.scheduled_at || r.due);
      if (!at) continue;
      consider(toMinute(at));                      // it comes due
      consider(toMinute(plusMinutes(at, TASK_GRACE_MIN)));   // it stops being free
      consider(nextScoreChange(r, nowLocal));      // its number moves
    }
    return next;
  }

  // What an item is worth, as a number to put on its chip. ONE number, and its sign says which kind it
  // is — which is the rule the band already follows: a negative has always already happened, while a
  // positive is only potential until the thing is actually done.
  //
  //   completed            what it landed at        realised   (+1, or negative if very late)
  //   overdue, <4h late    what it is still worth   POTENTIAL  (doing it now still pays)
  //   overdue, >=4h        what it has cost so far  realised   (completing it can no longer pay)
  //   upcoming / grace     nothing — it costs nothing yet and the full +1 is still there
  //   exempt               nothing — it never scores in either direction
  //
  // The switch at LATE_ZERO_H is where those two swap importance: before it, "you can still get 0.86"
  // is the useful fact; after it, the only useful fact is what it is taking.
  //
  // The overdue figure is the item's OWN accrued cost at its rate, which is what the bar moves by too
  // unless the band has bottomed out — an hour that would take the level below zero is never charged,
  // so at zero the figure keeps climbing while the bar cannot fall. An item pinning the band at zero
  // is still costing him everything he earns, so its own rate stays the truer statement of what it is
  // doing.
  function chipScore(item, nowLocal, state) {
    const mult = 1 + Math.max(0, Number(item.priority) || 0);
    if ((item.priority || 0) < 0) return null;                       // exempt
    const deadline = taskDeadline(item.scheduled_at || item.due);
    if (deadline == null) return null;
    const ms = (stamp) => Date.parse(String(stamp).replace(' ', 'T') + 'Z');
    // A COMPLETED item is what finishing paid MINUS every hour it sat before that. Those are different
    // things and the chip has to be their sum, because the sum is what the item did to the band: an
    // on-time completion is a clean +7, and one finished three days late is roughly −21 however
    // promptly it was eventually ticked off. Showing only what finishing paid would print "+0" over an
    // item that cost twenty points.
    //
    // Only the first half goes through toPoints(). The drain accrues by the hour and is a continuous
    // quantity, so a chip carrying one is a rounded reading rather than the exact credit — true of the
    // 'lost' branch already. An item completed inside its grace has no drain at all, and there the
    // integer is still exactly what the bar moved by.
    if (item.completed_at) {
      const done = ms(item.completed_at);
      const paid = toPoints(completionValue(done - deadline) * mult);
      const sat = Math.max(0, done - (deadline + TASK_GRACE_MIN * 60000));
      return { value: paid - (sat / (TASK_DRAIN_FULL_H * 3600000)) * toPoints(mult), kind: 'earned' };
    }
    if (state !== 'expired') return null;                            // upcoming or still in grace
    const late = ms(nowLocal) - deadline;
    if (late < TASK_LATE_ZERO_H * 3600000) {
      return { value: toPoints(completionValue(late) * mult), kind: 'potential' };
    }
    // Accrued cost, at the same quantised rate the replay bills it at. Not itself a whole point: the
    // drain accrues by the hour, so this is a readout of something still moving. It keeps climbing
    // while the item sits, and completing the item stops it rather than clearing it.
    const draining = late - TASK_GRACE_MIN * 60000;
    return { value: -(draining / (TASK_DRAIN_FULL_H * 3600000)) * toPoints(mult), kind: 'lost' };
  }

  // Two chips to a half-hour line, each at a fixed half width whether or not there is a second one.
  // Letting a lone chip stretch made the line's shape depend on how busy it happened to be, so a
  // glance could not tell one item from two without reading it. A fixed grid reads at a distance.
  // Anything past the cap becomes a count, so a hidden item is still visible AS hidden.
  const DAYLINE_MAX_PER_HALF = 2;
  const dayHalf = (items) => ({
    items: items.slice(0, DAYLINE_MAX_PER_HALF),
    more: Math.max(0, items.length - DAYLINE_MAX_PER_HALF),
  });

  // A look-ahead day's box holds this many chips, and the rest become its +N. Decided here rather than
  // in the wall for the same reason the half-line's cap is: the box is a sixth of a column of known
  // height, so how many chips fit is a fixed number, and two surfaces working it out separately is two
  // surfaces that will eventually disagree about which item was the one dropped.
  //
  // HOW A LOOK-AHEAD DAY'S BOX IS LAID OUT. The box is a sixth of a column of known height, so this is
  // geometry and it is decided here, the way the month grid's `cols` is — a client working it out
  // separately is a client that will eventually disagree about which item got dropped.
  //
  // The box holds a grid of `rows × cols` chips, each row an equal share of its height, so the chips
  // grow and shrink to FILL it rather than sitting at a fixed size above a spare strip. Two steps,
  // and the reason there are only two:
  //
  //   1-4 items    4 rows, one column   — four filling the box is the CEILING. Nothing is bigger than
  //                                       that however empty the day, or one item alone is a banner.
  //   5-6 items    n rows, one column   — shrink rather than drop one, down to ~12px at six.
  //   7-10 items   2 columns, ceil(n/2) rows, text capped at the five-row size — read across then
  //                                       down, the way text is. Titles truncate; nothing else fits.
  //
  // WHY THE SECOND COLUMN STARTS AT SEVEN and not at six. A six-item day in one column holds every
  // title WHOLE and fills the box; in two it holds four characters of each and leaves two rows empty,
  // because six items need three rows of two and the chips cannot grow into the other two — an 85px
  // chip has no use for 28px of text. Two truncated columns above a gap is worse than one full
  // column, so the split waits until one column would be under ~12px, which is at seven.
  //
  // Ten is the cap; the rest become the day's +N.
  const LOOKAHEAD_ROWS = 5;                 // rows at the small end of a single column
  const LOOKAHEAD_ROWS_MIN = 4;             // the ceiling: chips never larger than four filling the box
  const LOOKAHEAD_ONE_COL_MAX = 6;          // most a single column can hold and still show a title
  const LOOKAHEAD_MAX_PER_DAY = LOOKAHEAD_ROWS * 2;

  // The grid one day's chips are laid out in — geometry, so it is decided here.
  function aheadGrid(n) {
    const cols = n > LOOKAHEAD_ONE_COL_MAX ? 2 : 1;
    return {
      cols,
      rows: cols === 2 ? Math.min(LOOKAHEAD_ROWS, Math.ceil(n / cols))
                       : Math.max(LOOKAHEAD_ROWS_MIN, n),
    };
  }

  // The occurrences of one item falling inside [startKey, endKey] (inclusive 'YYYY-MM-DD' bounds) —
  // which is now at most one, its own `due`. A recurring thing is materialised as an independent row
  // per occurrence (data-layer migration 00085), so the grid reads real rows rather than projecting
  // future ones from a repeat rule. That is what lets a chip on a future day be tapped, cleared, or
  // scored: a projection was a drawing of an item that did not exist yet.
  // Rendered here, not in the cards: three surfaces draw these chips and a format they each re-derive
  // is a format they will eventually disagree about.
  // The number is in the band's POINTS, not its internal units — the gold band is 100 points and this
  // says how many of them the item is worth, so it is the same scale the bar is read on and needs no
  // suffix to say so. It is whole because the SCORING is whole: a completion is quantised to a point
  // by toPoints() before it is admitted, so this rounds nothing on the earned and potential branches
  // and the integer here is exactly what the bar moves by. Only the drain readout is a rounding, and
  // only because a drain is a continuous thing with no moment of landing. Anything under half a point
  // is not rendered at all, since a `+0` chip is worse than no chip.
  function scoreFields(item, nowLocal) {
    const sc = chipScore(item, nowLocal, chipState(item, nowLocal));
    if (!sc) return {};
    const n = Math.round(Math.abs(bandPoints(sc.value)));
    if (n < 1) return {};
    // Sign rides separately so the clients colour on it without parsing the string back apart.
    return { score: (sc.value > 0 ? '+' : '\u2212') + n, score_kind: sc.kind,
             score_sign: sc.value > 0 ? 'pos' : 'neg' };
  }

  // Where an overdue item sat, in the fewest characters that place it. Today, the time (nothing for an
  // all-day item — the day is the only fact it has). Within the last six days, the weekday, which is
  // unambiguous because none of them shares today's. Past that, the date.
  function overdueWhen(due, todayKey) {
    const day = String(due).slice(0, 10);
    if (day === todayKey) return calTimeLabel(due) || '';
    const at = Date.parse(`${day}T00:00:00Z`);
    const ago = Math.round((Date.parse(`${todayKey}T00:00:00Z`) - at) / 86400000);
    const d = new Date(at);
    return ago < 7 ? d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })
                   : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }

  function calOccurrences(item, startKey, endKey) {
    const day = String(item.due).slice(0, 10);
    return day >= startKey && day <= endKey ? [item.due] : [];
  }
  // Two callers, one endpoint. The PHONE page pages one month at a time (?month=YYYY-MM). The WALL
  // (?wall=1) instead gets `calendar_months` months from the current one — the count is an
  // app_settings key so voice can resize the view ("show the full year") the same way it switches
  // walls — plus `dayline`, the server-laid-out timeline of today for the wall's day column.
  gated.get('/api/calendar', async (req, res) => {
    try {
      const nowET = etNowString();
      const todayKey = nowET.slice(0, 10);
      const wall = req.query.wall === '1';
      // The phone's day card wants the timeline and nothing else. Same computation — the day buckets
      // come out of the month expansion either way — but it does not ship a month of grid it will not
      // draw. One endpoint, so the two surfaces cannot disagree about a chip's state.
      const dayOnly = req.query.day === '1';
      const full = req.query.full === '1';
      let count = 1;
      if (wall) {
        let s = {};
        try { s = await settingsAll(); } catch (_) {}
        const n = Number(s.calendar_months);
        count = Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
      }
      const startYm = wall || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || ''))
        ? todayKey.slice(0, 7) : String(req.query.month);
      const [y0, mo0] = startYm.split('-').map(Number);

      // All month math in UTC getters over naive components, so no zone ever shifts a wall-clock date. Each grid runs Sunday-aligned from before the 1st to after the last.
      const DAY = 86400000;
      const pad = (n) => String(n).padStart(2, '0');
      const keyOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
      const bounds = [];
      for (let k = 0; k < count; k++) {
        const first = Date.UTC(y0, mo0 - 1 + k, 1);
        const last = Date.UTC(y0, mo0 + k, 0);
        bounds.push({ first, gridStart: first - new Date(first).getUTCDay() * DAY, gridEnd: last + (6 - new Date(last).getUTCDay()) * DAY });
      }
      // `ahead=N` asks for the N days AFTER today as well, each with what is on it — the home wall's
      // look-ahead column. It can reach past the last month's grid, which ends on the Saturday after
      // the month's last day and so ends ON that day when the month ends on a Saturday. Widening the
      // expansion window is the whole fix: the month grids read from their own bounds, so the extra
      // day buckets cost nothing to anyone who did not ask for them.
      // The cap is a bound on the expansion below, not a view decision: the phone's strip scrolls on
      // past the week and a day off its right-hand end is a day nobody can reach. Ninety is a quarter
      // of a year of mostly-empty boxes, which costs one pass over rows already in hand.
      const aheadDays = Math.max(0, Math.min(90, Math.trunc(Number(req.query.ahead)) || 0));
      const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
      // One expansion over the whole span; every month's grid then reads from the same day buckets.
      const startKey = keyOf(bounds[0].gridStart);
      const gridEndKey = keyOf(bounds[count - 1].gridEnd);
      const aheadEndKey = keyOf(todayMs + aheadDays * DAY);
      const endKey = aheadEndKey > gridEndKey ? aheadEndKey : gridEndKey;

      const [listRows, rows] = await Promise.all([
        sb('lists?select=name,emoji'),
        // The one surface that draws COMPLETED items as well as outstanding ones. Seeing a day fill in
        // with things that got done is half the point of marking them done; every other surface is a
        // list of what is left, and a finished item on it is noise.
        sb('list_items?deleted=eq.false&due=not.is.null&select=id,list_name,text,title,due,scheduled_at,priority,series_id,completed_at,alarm'),
      ]);
      const emojiOf = {};
      for (const l of listRows || []) emojiOf[l.name] = l.emoji;

      // One chip, whichever surface draws it and whatever day it lands on. The day buckets and the
      // dial's overdue list both build from this, so a chip cannot carry different state in the two.
      const calChip = (r, occ) => ({
        id: r.id,
        title: itemTitle(r),
        list: r.list_name,
        emoji: emojiOf[r.list_name] || null,
        color: listColor(r.list_name),
        time: calTimeLabel(occ),
        // `past`: this occurrence's moment has gone by (dims the chip) — for an all-day item that is the
        // end of its day, not the 9am it notified at. `expired`: it is overdue and uncleared, which is
        // also what is draining his score for as long as it stays that way.
        past: lateMoment(occ) <= nowET,
        // `done` means he finished a task. An exempt item closes itself when its moment passes,
        // which is not the same thing and must not read as an achievement — it just becomes past.
        done: !!r.completed_at && (r.priority || 0) >= 0,
        exempt: (r.priority || 0) < 0,
        // Three states, and they line up with what the SCORE is doing rather than with the clock
        // alone: `grace` is due-but-still-free (the 30 minutes that score as on time), `expired` is
        // past that and actively draining. Colouring them the same made a chip go red while it was
        // still costing nothing, and gave no signal at the moment the cost actually starts.
        grace: !r.completed_at && (r.priority || 0) >= 0 && chipState(r, nowET) === 'grace',
        expired: !r.completed_at && (r.priority || 0) >= 0 && chipState(r, nowET) === 'expired',
        priority: r.priority || 0,
        alarm: !!r.alarm,
        ...scoreFields(r, nowET),
        repeating: !!r.series_id,
      });

      const byDay = {};
      for (const r of rows || []) {
        for (const occ of calOccurrences(r, startKey, endKey)) {
          // `_occ` is a sort key only, stripped below — date-only sorts before any 'T…' same-day.
          (byDay[occ.slice(0, 10)] ??= []).push({ _occ: occ, ...calChip(r, occ) });
        }
      }
      for (const k of Object.keys(byDay)) {
        byDay[k].sort((a, b) => (a._occ < b._occ ? -1 : 1));
        for (const it of byDay[k]) delete it._occ;
      }

      const ymStr = (yy, mm) => { const d = new Date(Date.UTC(yy, mm - 1, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
      const months = bounds.map((b, k) => {
        const ym = keyOf(b.first).slice(0, 7);
        const weeks = [];
        for (let ms = b.gridStart; ms <= b.gridEnd; ms += 7 * DAY) {
          const week = [];
          for (let i = 0; i < 7; i++) {
            const date = keyOf(ms + i * DAY);
            const d = new Date(ms + i * DAY);
            week.push({
              date,
              day: d.getUTCDate(),
              label: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }),
              inMonth: date.slice(0, 7) === ym,
              today: date === todayKey,
              items: byDay[date] || [],
            });
          }
          weeks.push(week);
        }
        return {
          month: ym,
          label: new Date(b.first).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }),
          prev: ymStr(y0, mo0 + k - 1),
          next: ymStr(y0, mo0 + k + 1),
          weeks,
        };
      });

      // The wall's day column: today's items laid onto hour slots, with the now-line's position
      // computed here (which hour row, and how far down it). Hour range covers at least 7a–10p and
      // stretches to hold the current hour and any item outside it.
      let dayline = null;
      if (wall || dayOnly) {
        const todayItems = byDay[todayKey] || [];
        // The dial draws no all-day strip. An all-day item is on time until its day ENDS, so it waits in
        // the dock at the bottom with the rest of what is still to come, and moves to `overdue` at the
        // top if the day ends without it (cards/dayline.js). Under the date it read as one of the red
        // rows stacked above it, and it is not one of them.
        const allday = full ? [] : todayItems.filter((i) => !i.time);
        const timed = todayItems.filter((i) => i.time);
        const clockOf = (t) => {
          const m = String(t).match(/^(\d+)(?::(\d+))?([ap])$/);
          let h = +m[1] % 12; if (m[3] === 'p') h += 12;
          return { h, m: +(m[2] || 0) };
        };
        const nowH = +nowET.slice(11, 13); const nowM = +nowET.slice(14, 16);
        // `full` asks for a ROLLING WINDOW instead of a calendar day: WINDOW hours either side of the
        // current hour, crossing midnight in both directions. It exists for the dial, which puts now
        // at the middle of the column — a day cannot feed that, because by evening there is almost
        // nothing below the line and the whole morning is crushed above it. A window always has as
        // much on one side as the other. Only that surface asks; the calendar wall and the phone keep
        // the day they were built around.
        const WINDOW = 12;
        const dayMs = 86400000;
        const baseMs = Date.parse(`${todayKey}T00:00:00Z`);
        const loT = full ? nowH - WINDOW : Math.min(7, nowH, ...timed.map((i) => clockOf(i.time).h));
        const hiT = full ? nowH + WINDOW : Math.max(22, nowH, ...timed.map((i) => clockOf(i.time).h));
        const hours = [];
        for (let t = loT; t <= hiT; t++) {
          // `t` is hours from TODAY's midnight and may be negative or past 24. The client projects on
          // it directly, which is what lets a continuous timeline be drawn without it knowing dates.
          const dayOff = Math.floor(t / 24);
          const h = ((t % 24) + 24) % 24;
          const onDay = dayOff === 0 ? timed
            : (byDay[keyOf(baseMs + dayOff * dayMs)] || []).filter((i) => i.time);
          const inHour = onDay.filter((i) => clockOf(i.time).h === h);
          hours.push({
            t,   // position on the timeline; the dial angles every row off this
            h,   // 24h number: the wall matches the clock against this to move the now-line itself
            // Just the number. The spine runs in order from morning to night, so am/pm is never in
            // doubt, and dropping the letter is what buys the digit enough size to read across a room.
            label: String(h % 12 || 12),
            // Each hour is two lines: :00-:29 and :30-:59. The second is RESERVED for the back half of
            // the hour, so a 4:30 item sits on it even when nothing is at 4:00 — the line a chip
            // occupies is what says which half of the hour it is in, since the chips carry no time of
            // their own. Splitting the row this way also doubles capacity without making a busy hour
            // physically taller, which would misread as the day running longer than it does.
            halves: [0, 1].map((half) => dayHalf(inHour.filter((i) => (clockOf(i.time).m >= 30 ? 1 : 0) === half))),
            now: t === nowH ? Math.round((nowM / 60) * 100) : null,
          });
        }
        const todayCell = months[0].weeks.flat().find((c) => c.date === todayKey);
        dayline = { date: todayKey, label: todayCell ? todayCell.label : todayKey, allday, hours };
      }

      // THE TASK BAND ON THE DIAL'S DATE LINE: what today has earned, and how fast the band is falling
      // right now, fading and overdue together (tasksScore has the arithmetic for both). They belong with
      // the dated items rather than on the health bar, which is three bands and this is one of them. The
      // rows here are exactly the band's own inputs — every dated item, done or open — and the replay
      // ignores completions older than its window, so the same function reads the same numbers the
      // band does. Whole points, the band's own scale.
      let band = null;
      if (full) {
        band = tasksScore({ events: (rows || []).filter((r) => r.completed_at),
                            open: (rows || []).filter((r) => !r.completed_at), nowLocal: nowET });
        if (dayline) {
          dayline.tasks = { gained: Math.round(bandPoints(band.gained_today)),
                            loss_per_day: Math.round(bandPoints(band.loss_per_day)) };
        }
      }
      // A wall re-reads at the next moment anything it draws changes on its own. The band adds two kinds
      // of moment the chips do not have, and neither changes a row: a completion ageing out, which steps
      // the loss rate, and the 4am day origin, which zeroes the gain.
      const transition = [nextChipTransition(rows, nowET), band && band.loss_changes_at, band && band.today_ends_at]
        .filter(Boolean).sort()[0] || null;

      // THE DIAL'S OVERDUE LIST — every expired, unfinished item, whatever day it was due, oldest first.
      // The dial only reaches twelve hours back and its far rows are too thin for words, so an item
      // that has gone red and receded past what it can show was simply gone from the wall while it went
      // on draining — and anything overdue from an earlier day was never on it at all. The whole list
      // ships and the dial holds whichever of these it cannot show legibly; which ones that is depends
      // on the measured projection, so it is decided there (paintEdges in cards/dayline.js).
      //
      // Read from the rows, not the day buckets: the buckets stop at the first month's grid, and an
      // item nobody cleared a month ago is still overdue.
      let overdue = null;
      if (full) {
        overdue = (rows || [])
          .filter((r) => !r.completed_at && (r.priority || 0) >= 0 && chipState(r, nowET) === 'expired')
          .sort((a, b) => (String(a.due) < String(b.due) ? -1 : 1))
          .map((r) => ({ ...calChip(r, r.due), when: overdueWhen(r.due, todayKey) }));
      }

      // THE LOOK-AHEAD — one box per day, in order, and it STARTS AT TODAY. It is a list rather than a
      // timeline: the useful fact about a day you are not inside is what is on it, not where in it.
      //
      // It used to start at tomorrow, on the reasoning that the dial already had today. The dial does
      // not. The dial is a rolling window centred on now and it foreshortens hard, so its READABLE band
      // is roughly -9h to +8h — narrower than the +-12h it spans, and far narrower than a day. Just
      // after midnight that band ends around breakfast, so an item at noon sat on a ONE-PIXEL row and
      // everything later was outside the window entirely: the day rolled over and its whole contents
      // left the wall.
      //
      // A threshold would close most of that gap — hold today in the list until the dial reaches it —
      // and it was rejected twice over. It still drops the day at a moment the dial cannot yet read,
      // and the hour it turns on is a function of the column's height and CHIP_MIN, so it goes quietly
      // wrong the next time either moves. Starting at today costs one day off the far end and needs no
      // number at all.
      let ahead = null;
      if (aheadDays) {
        ahead = [];
        for (let k = 0; k < aheadDays; k++) {
          const d = new Date(todayMs + k * DAY);
          const date = keyOf(todayMs + k * DAY);
          const items = byDay[date] || [];
          const shown = items.slice(0, LOOKAHEAD_MAX_PER_DAY);
          ahead.push({
            date,
            dow: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }),
            day: d.getUTCDate(),
            // First of the month gets its month said; nothing else does. Six weekday names running
            // forward already fix where you are, and the one place that stops being true is the day
            // the number resets.
            month: d.getUTCDate() === 1 ? d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' }) : null,
            items: shown,
            more: Math.max(0, items.length - LOOKAHEAD_MAX_PER_DAY),
            ...aheadGrid(shown.length),
          });
        }
      }

      if (dayOnly) return res.json({ today: todayKey, dayline, ...(ahead ? { ahead } : {}), ...(overdue ? { overdue } : {}), next_transition: transition });
      res.json({
        today: todayKey,
        dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        count,
        // How many mini-month columns the wall lays the grid out in — geometry is decided here, not
        // in the client, like every other display value.
        cols: count === 1 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4,
        months,
        ...(dayline ? { dayline } : {}),
        ...(ahead ? { ahead } : {}),
        next_transition: transition,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Clear an item. There is ONE cleared state — checking off and deleting are the same act — and it's
  // soft, so the row survives for the recovery window before being purged. No `kind` any more: dated
  // and undated items live in the same table, so there is only one thing to clear.
  // Mark done. Distinct from /clear, which deletes: this one keeps the item (the calendar draws it as
  // something that happened) and moves the health bar's gold band. Every surface that can finish a
  // task calls this — the pane's ✓ swipe, the widget's Done, and voice through the data MCP.
  //
  // `at` says WHEN it was done, for the case where that is not now — "I finished that at 10:15", or
  // finishing a 10am thing a quarter of an hour in. Omitting it stamps the clock, which is what every
  // button on every surface does and what almost every completion is. The value is a local wall-clock
  // reading in the same shape `due` is stored in; completionStamp is what decides that, because the
  // band is what has to read it back.
  //
  // The hub's OWN writes announce themselves the moment they land (`announceListWrite`) rather than
  // waiting for their realtime echo, which takes seconds. A ring on the TV stops only when the feed
  // changes, so a STOP that waits for the echo leaves the TV ringing long enough to read as not having
  // worked. The echo still arrives and repeats the announcement; that is one redundant reload per tap.
  function announceListWrite() { dirtyRows('list_items'); pushLists(); broadcast(); }
  gated.post('/api/todos/complete', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const id = String(b.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      let completedAt = null;
      if (!b.undo) {
        if (b.at == null || b.at === '') completedAt = etNowString();
        else {
          const s = completionStamp(b.at, etNowString());
          if (!s.ok) return res.status(400).json({ error: `at ${s.reason}` });
          completedAt = s.value;
        }
      }
      const now = new Date().toISOString();
      await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH',
        { completed_at: completedAt, updated: now });
      console.log(`[todos] ${b.undo ? 'uncomplete' : 'complete'} ${id}`);
      res.json({ ok: true, completed_at: completedAt });
      announceListWrite();
      syncBadge().catch((e) => console.error('[badge]', e.message || e));   // don't make the caller wait on APNs
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  gated.post('/api/todos/clear', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const id = String(b.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH', { deleted: true, updated: new Date().toISOString() });
      // Answer on the WRITE, not on a recount. This used to await overdueCount() before responding,
      // which meant a second sequential Supabase round-trip from Fly on the one path a person is
      // actually watching — the widget's ✕ can't redraw until this returns. Nothing needed that
      // number here: the pane re-reads /api/badge after every load anyway, and syncBadge() pushes the
      // authoritative count to the devices a moment later.
      res.json({ ok: true });
      announceListWrite();
      syncBadge().catch((e) => console.error('[badge]', e.message || e));   // don't make the caller wait on APNs
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // Snooze: push an item's due time out by N hours from NOW (not from its old due, which may be long
  // past). It stays un-cleared — snoozing is deferral, not completion — but it stops being overdue, so
  // it correctly drops off the badge until it comes round again. Works on any list. No dedupe-row
  // surgery needed: the ledger key includes the due (see dueTick), so moving the date is already a new
  // occupancy and the item can fire again on its own.
  gated.post('/api/todos/snooze', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const id = String(b.id || '');
      const hours = Number(b.hours);
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return res.status(400).json({ error: 'hours out of range' });
      const due = etStringAt(new Date(Date.now() + hours * 3600 * 1000));
      await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH', { due, updated: new Date().toISOString() });
      announceListWrite();
      res.json({ ok: true, due, badge: await overdueCount() });
      syncBadge().catch((e) => console.error('[badge]', e.message || e));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Mark a dated item ALARM-GRADE, or take the mark off. An alarm breaks silent mode and a Focus, so
  // nothing sets this on its own — not priority, not wording. It is set because someone said so.
  gated.post('/api/todos/alarm', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const id = String(b.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const alarm = !(b.alarm === false || b.alarm === 0 || b.alarm === '0' || b.alarm === 'false');
      await sbWrite(`list_items?id=eq.${encodeURIComponent(id)}`, 'PATCH',
        { alarm, updated: new Date().toISOString() });
      res.json({ ok: true, id, alarm });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // The app reads this when it comes to the foreground, so the badge is right even if a silent
  // background push never landed.
  gated.get('/api/badge', async (req, res) => {
    const n = await overdueCount();
    res.json({ badge: Number.isInteger(n) ? n : 0 });
  });

  gated.post('/api/todos/add', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const text = String(b.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const now = new Date().toISOString();
      // No list named means the default one. A due date is just another field — supplying it is what
      // makes the item fire, whichever list it lands on.
      const list_id = String(b.list_id || '').trim() || 'l_todo';
      const due = String(b.due || '').trim() || null;
      const title = String(b.title || '').trim() || null;
      // Importance is score-only: an important item earns more for being done on time and drains more
      // for being ignored, and notifies exactly like anything else.
      const priority = Number(b.priority) > 0 ? 1 : 0;
      // This surface does NOT create lists. It used to, on any unrecognised name — the same silent fork
      // the data layer removed in 00094, and worse here, because this match was case-SENSITIVE where the
      // tools' was not. Composers post an id that came from this same payload, so a miss is a bug.
      const exists = await sb(`lists?id=eq.${encodeURIComponent(list_id)}&select=id&limit=1`);
      if (!exists.length) return res.status(404).json({ error: `no list with id ${list_id}` });
      // This surface writes one item. Recurrence is materialised rather than stored (data-layer
      // migration 00085), so "every day" is a scheduling instruction that expands to one row per
      // occurrence — which is `add_to_list`'s job, not a text box's.
      await sbWrite('list_items', 'POST', { id: crypto.randomUUID(), list_id, text, title, due, scheduled_at: due, priority, deleted: false, created: now, updated: now });
      res.json({ ok: true, badge: await overdueCount() });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return { itemTitle };
};
