'use strict';
// Supabase realtime: what each table's change sets off, the watchdog that recycles a socket gone quiet,
// and the freshness probe that catches a change realtime never announced. One instance, made in
// server.js; the two timers are armed when it is made, the channel is opened by `start`.
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

function createRealtime(ctx) {
  const {
    MUTE_HOLD, SUPABASE_KEY, SUPABASE_URL, agentModeOn, auth, broadcast, dirtyDesk, dirtyDue, dirtyHeatHistory,
    dirtyNutDay, dirtyRows, dirtySettings, dirtySurfHist, dirtyWorkoutDay, markLive, notifyAnswer, pushDay,
    pushLists, pushSessions, pushSurfLive, pushVoice, recomputeMute, reportTick, requestView, sb, settleReply,
    surfAlarms, syncBadge, takeUsage, tvPush,
  } = ctx;

  // Supabase client used only for the Realtime subscription (push). Data reads use sb() REST.
  const supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket },
  });

  // Last time ANY realtime event arrived. The socket can sit reporting SUBSCRIBED while
  // delivering nothing — it has done exactly that on the voice server and the Mac
  // listener, and the only symptom is that things stop appearing. Nothing in the client
  // notices, so liveness has to be judged by whether events are actually arriving.
  let lastRealtimeEvent = Date.now();
  let hubChannel = null;

  // device_status is mirrored roughly every two minutes by other devices, so in normal
  // operation this channel is never quiet for long. Silence well past that is the
  // signature of a dead socket rather than a quiet house.
  const REALTIME_SILENCE_LIMIT_MS = 6 * 60 * 1000;

  // Realtime events on exactly the three tables the freshness fingerprint below can see. The probe
  // asks "did the database move without realtime saying so", and this counter is the "saying so" half.
  // Module scope, not inside startRealtime: a recycle rebuilds the handlers and must not reset it.
  let rtEvents = 0;
  const fpSeen = () => { rtEvents++; };

  function startRealtime() {
    // A change to any cached source table dirties the row cache, then rebuilds + pushes. The extra
    // subscriptions (weight_log … surf_snapshots) exist for the cache: without them an edit would sit
    // invisible until the 15-min backstop refetch.
    const seen = () => { lastRealtimeEvent = Date.now(); };
    // `p.table` names what moved, so only the row groups that table feeds are refetched.
    const changed = (p) => { seen(); dirtyRows(p && p.table); dirtyNutDay(); dirtyWorkoutDay(); dirtyHeatHistory(); broadcast(); };
    hubChannel = supa.channel('hub-changes')
      // device_status is fetched live per build (not cached) — its routine ~2-min state mirrors must
      // rebuild the frame but must NOT drag the heavy cached queries along. Plain broadcast only.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' },
        () => { seen(); broadcast(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_entries' },
        (p) => { fpSeen(); changed(p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sets' },
        (p) => { fpSeen(); changed(p); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weight_log' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nutrition_targets' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_catalog' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_muscles' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'muscle_volume_targets' }, changed)
      // A new snapshot changes both the card's current reading and the heatmap behind it.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_snapshots' },
        (p) => { dirtySurfHist(); changed(p); surfAlarms.tick('snapshot'); pushSurfLive(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_alarms' },
        () => { seen(); surfAlarms.tick('rule'); })
      // A TV command, pushed to the TV's app the moment it is written (tvPush).
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tv_commands' },
        (p) => { seen(); tvPush(p.new).catch((e) => console.error('[tv] push', e.message || e)); })
      // The rep watcher, so setting it appears at once rather than on the next periodic
      // frame. Its whole value is confirming BEFORE a set that sets are being logged as
      // the right thing, and a delay there defeats the purpose. workset_reports is NOT
      // subscribed: every report writes a row to `sets`, which is, so the push already
      // happens and adding reports would only duplicate it.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'set_watcher' }, changed)
      // A new usage reading (the table only gains a row when a number moves).
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'claude_usage' },
        (p) => { seen(); if (p.new) { takeUsage(p.new); } broadcast(); pushDay('usage'); })
      // Settings (routing model/thinking/runner, wake toggle, nutrition goal): rebuild so the TV routing
      // panel reflects an MCP/voice/settings change near-instantly instead of waiting for the 30s tick.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, (p) => {
        seen();
        dirtySettings();
        dirtyNutDay();   // surplus_cal shapes the day header's goal figures
        broadcast(p);
        // When the agent_mode toggle flips (from anywhere — voice, another device), tell the voice panel to
        // switch to that mode's conversation live, so the on-screen context always matches the active mode.
        if (p.new && p.new.key === 'agent_mode') pushVoice('mode', { agent: agentModeOn(p.new.value) });
        if (p.new && ['tv_sidebar_view', 'tv_sidebar_font', 'tv_sidebar_width'].includes(p.new.key)) pushSessions();
        // A holder written straight into the table (the Mac's listener) is a mute taken or given back.
        if (p.new && String(p.new.key || '').startsWith(MUTE_HOLD)) recomputeMute().catch((e) => console.error('[mute]', e.message || e));
      })
      // Dated items and the lists that colour them. `list_items` DOES feed the status frame now — the
      // health bar's gold band is earned by clearing dated items and drained by leaving them — so a
      // change has to invalidate the row cache and rebuild, not merely notify the calendar surfaces.
      // Without the rebuild a completion would not show on the bar until the 15-minute backstop, which
      // is the one moment the reward is supposed to land.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'list_items' },
        (p) => {
          fpSeen();
          seen(); dirtyRows('list_items'); pushLists(); broadcast();
          // A dated item added, snoozed, completed or cleared changes both when the next thing is due
          // and what the icon should read. Pushing the badge here is what lets its own poll be a
          // backstop instead of the mechanism that keeps a cleared task from lingering on the user's phone.
          dirtyDue();
          syncBadge().catch((e) => console.error('[badge] error', e.message));
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lists' },
        () => { seen(); pushLists(); })
      // Voice pipeline: stream inserts/updates straight to the /tv conversation panel. INSERT and
      // UPDATE both carry the new row in `payload.new` (UPDATE = a streamed row flipping done=true).
      .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_messages' },
        (p) => {
          seen();
          if (!p.new) return;
          pushVoice('message', p.eventType === 'INSERT' ? markLive(p.new) : p.new);
          if (p.eventType === 'INSERT') notifyAnswer(p.new);
        })
      // A client waiting on its own command (/api/voice-reply/:id) is answered the moment the worker
      // marks the request finished.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_requests' },
        (p) => {
          seen();
          if (!p.new) return;
          if (p.eventType === 'UPDATE') settleReply(p.new);
          // The user's words the moment they exist: the worker writes the user's voice_messages row only beside the
          // answer, which can be half a minute later. The TV sidebar shows them from this.
          const r = requestView(p.new);
          if (r) pushVoice('request', r);
        })
      // The three tables a session view is assembled from. These are why the walls no longer poll
      // /api/sessions every 5s: a session starting, ending, being renamed, finishing a turn, being
      // focused or queueing behind another one all land here, and each pushes a fresh payload.
      // dirtyDesk on the two that feed the status strip, so the NEXT frame is fresh. Deliberately no
      // broadcast() here: a frame still costs four uncached presence reads, so pushing one per desk
      // change would spend more than the poll it replaced.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'desk_sessions' },
        () => { seen(); dirtyDesk(); pushSessions(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'desk_queue' },
        () => { seen(); pushSessions(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'desk_focus' },
        () => { seen(); dirtyDesk(); pushSessions(); })
      // A written report announces itself rather than being discovered: reportTick's timer is now only
      // the net under this, instead of the fastest database timer on the server.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hub_sessions' }, (p) => { seen(); auth.onChange(p); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reports' },
        () => { seen(); reportTick().catch((e) => console.error('[report] error', e.message)); })
      .subscribe((status) => {
        console.log('realtime channel:', status);
        // SUBSCRIBED means the handshake completed, not that events will flow. Treat it
        // only as "the clock starts now" so a channel that comes back deaf still trips
        // the watchdog instead of looking healthy forever.
        if (status === 'SUBSCRIBED') lastRealtimeEvent = Date.now();
        // Whatever arrived while the socket was down was missed, so re-decide from the current state.
        if (status === 'SUBSCRIBED') surfAlarms.tick('subscribe');
      });
  }

  // Recycle a socket that has gone quiet.
  //
  // A half-open realtime connection reports SUBSCRIBED and delivers nothing. The
  // visible effect is that a set logged on the watch does not reach the screen until
  // the 15-minute cache backstop lapses, which reads as "the hub is slow" rather than
  // as a fault. Reconnecting is cheap and the check costs one comparison a minute.
  setInterval(() => {
    const quiet = Date.now() - lastRealtimeEvent;
    if (quiet < REALTIME_SILENCE_LIMIT_MS) return;
    console.log(`realtime silent for ${Math.round(quiet / 1000)}s — recycling the socket`);
    try { if (hubChannel) supa.removeChannel(hubChannel); } catch (e) { console.log('removeChannel:', e.message); }
    lastRealtimeEvent = Date.now();   // give the new channel a full window before retrying
    try { startRealtime(); } catch (e) { console.error('resubscribe failed:', e.message); }
  }, 60000);

  // The watchdog above judges the socket by whether ANY event arrives, and that is a proxy it cannot
  // keep honest: `seen()` is fed by every subscription, and device_status is written every couple of
  // minutes by the litter and feeder watchers. So the one table with a permanent heartbeat vouches for
  // all the others, and a channel that reports SUBSCRIBED while delivering nothing for
  // `nutrition_entries` looks perfectly alive. That is not hypothetical — on 2026-09-10 a meal logged
  // at 09:26 did not reach any surface until the 15-minute backstop lapsed, the socket had been
  // SUBSCRIBED since 08:17 with device_status flowing the whole time, and the watchdog logged nothing.
  //
  // So check FUNCTION, not liveness: ask the database directly whether anything has been written that
  // the cache has not seen. The probe is a row COUNT per write-active table plus the newest completion
  // stamp — a few hundred bytes, against the ~143KB of the real queries — so it can run often enough
  // to close the window without undoing the caching it is protecting.
  //
  // A miss is also evidence the channel is lying, so it recycles the socket as well as refetching, and
  // it LOGS. The failure it exists to catch produced no output at all, which is why it went unnoticed
  // long enough to be reported as a date bug.
  const FRESH_PROBE_MS = 2 * 60 * 1000;
  // count=exact + a zero-row Range: PostgREST answers in the Content-Range header and sends no body.
  async function tableCount(table) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Range-Unit': 'items', Range: '0-0', Prefer: 'count=exact' },
    });
    if (!r.ok && r.status !== 206) throw new Error(`count ${table} -> ${r.status}`);
    const cr = r.headers.get('content-range') || '';
    return cr.slice(cr.indexOf('/') + 1);      // "0-0/1234" -> "1234"
  }
  async function freshnessFingerprint() {
    const [nutrition, sets, items, completed] = await Promise.all([
      tableCount('nutrition_entries'),
      tableCount('sets'),
      tableCount('list_items'),
      // Completing an item changes no count, and it is the write the gold band is built on.
      sb('list_items?completed_at=not.is.null&select=completed_at&order=completed_at.desc&limit=1')
        .then((r) => (r[0] && r[0].completed_at) || ''),
    ]);
    return [nutrition, sets, items, completed].join('|');
  }
  let lastFingerprint = null;
  // `rtEvents` as of the end of the previous run. Anything realtime announced since then is credited to
  // whatever move this run finds, so the question the probe asks is exactly: the database changed, did
  // realtime mention it?
  let rtMark = 0;
  setInterval(async () => {
    let fp;
    try { fp = await freshnessFingerprint(); } catch (e) { console.error('freshness probe:', e.message); return; }
    // Sampled AFTER the read, so an event arriving during it still counts, and consumed on every run —
    // including the quiet ones — so credit cannot accumulate across intervals.
    const announced = rtEvents !== rtMark;
    rtMark = rtEvents;
    if (lastFingerprint === null) { lastFingerprint = fp; return; }   // first run only establishes a baseline
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    if (!announced) {
      // The database moved and realtime said nothing about any of the three tables this fingerprint can
      // see. That is the miss the probe exists for.
      //
      // It tested `rowCache.dirty` before, which cannot tell a dropped event from a handled one:
      // `broadcast()` is what CLEARS that flag and it runs on every realtime event, so by the time the
      // probe looked the flag had almost always been cleared by the very event it was checking for. It
      // therefore fired after ORDINARY writes — on 2026-09-17 a completion realtime delivered in under
      // 20 seconds was declared missing 105 seconds later — and every firing tore down a healthy
      // socket. A recycle is a real CLOSED→SUBSCRIBED gap, so a watchdog for dropped events was
      // manufacturing the windows in which events drop.
      console.log(`freshness probe: rows changed with no realtime event (${fp}) — refetching and recycling the socket`);
      dirtyRows(); dirtyNutDay(); dirtyWorkoutDay(); dirtyHeatHistory();
      try { if (hubChannel) supa.removeChannel(hubChannel); } catch (e) { console.log('removeChannel:', e.message); }
      lastRealtimeEvent = Date.now();
      try { startRealtime(); } catch (e) { console.error('resubscribe failed:', e.message); }
      broadcast();
      // Then everything the `list_items` subscription does, because the write this probe just caught
      // may well have been one of its — the fingerprint counts list_items rows and carries the newest
      // completion stamp precisely so it can see them.
      //
      // A rebuilt status frame does not repaint a chip. The calendar surfaces re-read on the `lists`
      // frame and on nothing else but a transition minute they computed in advance, which can be hours
      // out. So whenever this probe is the path that reconciles a list write rather than the
      // subscription, every chip stays drawn from before it: on 2026-09-17 a task completed at 18:42
      // held its next transition at 21:00 and sat red on the wall, the phone and the browser while
      // /api/calendar answered `done`. Recovering the server's caches without re-announcing to the
      // clients fixes only the half nobody is looking at.
      pushLists();
      dirtyDue();
      syncBadge().catch((e) => console.error('[badge] error', e.message));
    }
  }, FRESH_PROBE_MS);

  return { start: startRealtime };
}

module.exports = { createRealtime };
