'use strict';
// The caches the dashboard build reads through: source rows by group, the focused session, and the
// epoch every invalidation moves. One instance, made in server.js.

function createRowCache({ sb }) {
  // ---- dashboard source rows, cached by GROUP ---------------------------------------------------
  // The 30s broadcast tick exists to advance clock-derived fields (pace drain, session clock) — but
  // the DB rows it renders only change on writes, and realtime already announces every write. So the
  // heavy queries are fetched once and reused for every rebuild; a refetch happens only when
  // (a) a write to that group's table dirtied it, (b) the date window in its queries rolled over, or
  // (c) the 15-min reconciliation backstop lapses (covers a silently dropped realtime event).
  // Presence and device_status rows are NOT cached — they're tiny (~200B/~1KB) and are WRITTEN every
  // couple of minutes by design (worker heartbeats, litter/feeder state mirrors); caching them would
  // make those routine writes dirty the cache and drag the heavy queries along ~720×/day.
  // This took Supabase egress from ~143KB × every 30s (≈0.5GB/day, the free-plan quota blowout) to
  // effectively zero at idle.
  //
  // A write dirties only the groups its TABLE feeds: a checked-off list item refetches the two task
  // reads, not the 210 days of intake behind the maintenance estimate. And a group is read on its own,
  // so an endpoint that needs only the rings never touches the surf, task or catalog rows.
  const ROW_GROUPS = {
    nut: ['nutrition_entries'], weight: ['weight_log'], targets: ['nutrition_targets'],
    train: ['sets', 'exercise_muscles', 'exercise_catalog', 'muscle_volume_targets'], catalog: ['exercise_catalog', 'exercise_muscles'], surf: ['surf_snapshots'],
    tasks: ['list_items'],
  };
  const ROWCACHE_BACKSTOP_MS = 15 * 60 * 1000;
  const rowCache = new Map();   // group -> { rows, key, at, gen, pending, pendingGen, pendingKey }
  // `rowGen[g]` lets a read that began before an invalidation see that it has been overtaken.
  const rowGen = Object.fromEntries(Object.keys(ROW_GROUPS).map((g) => [g, 0]));
  // Moves on every invalidation of anything a status build reads from a cache, so a build in flight can
  // tell whether it is still current enough to share (buildStatus).
  let statusEpoch = 0;
  // Dirty the groups fed by these tables — or every group, with none named (the freshness probe, which
  // cannot say what moved).
  function dirtyRows(...tables) {
    statusEpoch++;
    const named = tables.filter(Boolean);
    for (const [g, ts] of Object.entries(ROW_GROUPS)) {
      if (!named.length || ts.some((t) => named.includes(t))) rowGen[g]++;
    }
  }
  // One group's rows. Concurrent callers share one read — several endpoints opening together is the
  // ordinary case, since a page asks for all of its parts at once — and a read overtaken by a write is
  // served but not kept.
  function groupRows(group, key, read) {
    const c = rowCache.get(group) || {};
    const gen = rowGen[group];
    if (c.rows && c.gen === gen && c.key === key && Date.now() - c.at < ROWCACHE_BACKSTOP_MS) return Promise.resolve(c.rows);
    if (c.pending && c.pendingGen === gen && c.pendingKey === key) return c.pending;
    const settle = () => { const now = rowCache.get(group); if (now && now.pending === pending) now.pending = null; };
    const pending = read().then((rows) => {
      settle();
      if (rowGen[group] === gen) rowCache.set(group, { rows, key, at: Date.now(), gen });
      else console.log(`[rowcache] ${group}: a write was announced mid-read: serving this read, leaving it dirty`);
      return rows;
    }, (e) => { settle(); throw e; });
    rowCache.set(group, { ...c, pending, pendingGen: gen, pendingKey: key });
    return pending;
  }

  // The status strip's session fields, on the same terms as the row cache above. These two reads ran on
  // EVERY frame — and a frame is rebuilt on every realtime event as well as every 30s — to answer a
  // question whose answer changes a handful of times a day. `desk_sessions` and `desk_pins` are in the
  // publication now (data-layer 00104), so a change dirties this directly instead of being discovered.
  const deskCache = { rows: null, at: 0, dirty: true };
  const DESKCACHE_BACKSTOP_MS = 15 * 60 * 1000;
  const dirtyDesk = () => { deskCache.dirty = true; statusEpoch++; };

  // → the focused session as the strip draws it ({id, repo, label, pinned}), or null. Which session that
  // is comes from desk_sessions_state() (data-layer 00157), the rule /api/sessions and the voice tools
  // read too.
  async function fetchDeskFocus() {
    if (!deskCache.dirty && deskCache.at && Date.now() - deskCache.at < DESKCACHE_BACKSTOP_MS) {
      return deskCache.rows;
    }
    const state = await sb('rpc/desk_sessions_state');
    const f = (state && state.focus) || {};
    let focus = null;
    if (f.session_id) {
      const [row] = await sb(`desk_sessions?id=eq.${encodeURIComponent(f.session_id)}&select=id,repo,label`);
      if (row) focus = { id: row.id, repo: row.repo, label: row.label || null, pinned: !!f.pinned };
    }
    deskCache.rows = focus; deskCache.at = Date.now(); deskCache.dirty = false;
    return focus;
  }

  const epoch = () => statusEpoch;
  const bump = () => { statusEpoch++; };

  return { groupRows, dirtyRows, fetchDeskFocus, dirtyDesk, epoch, bump };
}

module.exports = { createRowCache };
