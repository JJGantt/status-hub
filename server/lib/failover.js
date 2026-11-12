'use strict';
// Where a desk command goes when the machine it is for cannot take it NOW. The same rules as data-layer
// src/desk.ts (failoverOrder, settle, routeCommand, resumeMirrored), restated here because the hub is a
// separate deploy with no dependency on data-layer; the two have to agree, or a follow-up from the phone
// and the same follow-up spoken to the orchestrator end up in different places.
//
// THE RULE: nothing waits on one machine while another could run it. A command goes to the machine asked
// for, and when that one is not beating, not signed in, refuses it, or is silent for CONFIRM_MS, to the
// next: the other home machine, then Fly, which is always there to be woken (`GET /wake` on its desk app;
// Fly's proxy holds the request until the host is listening, so a 200 means it is up). A silent machine's
// command is taken back first (`cancel`, atomic on `status=pending`), so a machine that wakes a second
// later cannot run it as well; one that claimed it in that second keeps it. Only when Fly too fails is the
// work dead-lettered, and that is a console.error.

const crypto = require('crypto');

const DESK_WORKER = { pi: 'pi-desk', mac: 'desk', fly: 'fly-desk' };
const NAME = { pi: 'Pi', mac: 'Mac', fly: 'Fly machine' };
const machineOf = (worker) => (worker === 'desk' ? 'mac' : worker === 'fly-desk' ? 'fly' : 'pi');

/** The order to try machines in, `first` first: the other home machine before Fly, and Fly last. */
function failoverOrder(first) {
  return [first, ...['pi', 'mac', 'fly'].filter((m) => m !== first)];
}

/**
 * A consumer that sends the work on answers `handed to the Mac as <id> — why` (or the Pi, or Fly). That is
 * not a launch: the receiving machine's verdict on command `<id>` is the one that counts.
 */
function parseHandoff(detail) {
  const m = /^handed to (?:the )?(Mac|Pi|Fly)(?: machine)? as (\S+)(?: — (.*))?/.exec(detail || '');
  if (!m) return null;
  return { machine: m[1] === 'Mac' ? 'mac' : m[1] === 'Pi' ? 'pi' : 'fly', id: m[2], why: m[3] || null };
}

/**
 * Can the machine whose `worker_presence` row this is start a session right now: beating within `staleS`,
 * and signed in — Claude's login unexpired (`info.login_expires_at`; a beat without it counts as signed
 * in), or Codex signed in for a Codex session. data-layer machinesReady.
 */
function presenceReady(machine, row, { staleS = 90, agent = 'claude', now = Date.now() } = {}) {
  const t = row && row.last_seen;
  if (!t || (now - new Date(t).getTime()) / 1000 > staleS) return { ok: false, why: `the ${NAME[machine]} is not responding` };
  const info = (row && row.info) || {};
  if (agent === 'codex') return info.codex === true ? { ok: true } : { ok: false, why: `Codex is not signed in on the ${NAME[machine]}` };
  const exp = info.login_expires_at;
  if (exp !== undefined && !(exp && Date.parse(exp) > now)) return { ok: false, why: `the ${NAME[machine]}'s Claude login has expired` };
  return { ok: true };
}

/**
 * Turn command `id`'s first verdict into where the work really is. A handoff is followed to the machine it
 * names (`tried` learns it, so routing does not send there again). `claimed` is a command a machine took
 * but has not answered: it is running there, so it is neither re-sent nor reported as launched.
 *
 *   { ok: true, state: 'done'|'claimed', id, machine, detail, handedOff }
 *   { ok: false, failed: 'refused'|'silent', why, machine }
 */
async function settle(id, machine, v, deps, tried) {
  const secs = Math.round((deps.confirmMs || 20000) / 1000);
  let handedOff = null;
  for (let hop = 0; hop < 4; hop++) {
    if (v.state === 'done') {
      const h = parseHandoff(v.detail);
      if (h) {
        handedOff = { from: machine, why: h.why || `the ${NAME[machine]} sent it on` };
        if (tried) tried.add(h.machine);
        id = h.id; machine = h.machine;
        v = await deps.wait(id);
        continue;
      }
      // No consumer queues any more; one that still does has parked the work where nothing will run it
      // soon, which is a failure to route around.
      if (/^queued\b/.test(v.detail)) {
        console.error(`[desk] ${id}: the ${NAME[machine]} queued it (${v.detail}); routing it on`);
        return { ok: false, failed: 'refused', why: `the ${NAME[machine]} queued it instead of running it`, machine };
      }
      return { ok: true, state: 'done', id, machine, detail: v.detail, handedOff };
    }
    if (v.state === 'error') return { ok: false, failed: 'refused', why: `the ${NAME[machine]} refused it (${v.detail})`, machine };
    const c = await deps.cancel(id, `no answer from the ${NAME[machine]} in ${secs}s`);
    if (c.cancelled || c.status === 'expired' || c.status === 'missing') {
      return { ok: false, failed: 'silent', why: `the ${NAME[machine]} did not take it within ${secs}s`, machine };
    }
    if (c.status === 'done' || c.status === 'error') { v = { state: c.status, detail: c.detail }; continue; }
    return { ok: true, state: 'claimed', id, machine, detail: v.detail, handedOff };
  }
  console.error(`[desk] ${id}: handed on more than four times; stopped following it`);
  return { ok: true, state: 'claimed', id, machine, detail: v.detail, handedOff };
}

/**
 * Send `kind` to the first machine in `order` that takes it. `rerouted` says why the ones before it did
 * not, and is null when the first one did. Not ok only when every machine, Fly included, failed.
 */
async function routeCommand(kind, payload, order, deps) {
  const reasons = [];
  const tried = new Set();
  for (const m of order) {
    if (tried.has(m)) continue;
    tried.add(m);
    const r = await deps.ready(m);
    if (!r.ok) { reasons.push(r.why); continue; }
    const id = deps.newId();
    const out = await settle(id, m, await deps.send(id, kind, { ...payload, target: m }), deps, tried);
    if (out.ok) return { ...out, rerouted: reasons.length ? reasons.join(', and ') : null };
    reasons.push(out.why);
  }
  return { ok: false, why: reasons.join(', and ') || 'there was no machine to try' };
}

/**
 * The live half: Supabase and Fly. `onCommand` is fed every desk_commands UPDATE the hub's realtime channel
 * sees (lib/realtime.js), which is what answers a waiting `send`; the one read at the deadline is the net
 * under a channel that has gone deaf, not a poll.
 */
function createDesk({ SUPABASE_URL, SUPABASE_KEY, sb, DESK_STALE_S = 90 }) {
  const CONFIRM_MS = Number(process.env.DESK_CONFIRM_MS || 20000);
  const FLY_DESK_URL = process.env.FLY_DESK_URL || 'https://jared-desk-fly.fly.dev';
  const FLY_WAKE_MS = Number(process.env.FLY_WAKE_TIMEOUT_MS || 120000);
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  async function wakeFly() {
    try { return (await fetch(`${FLY_DESK_URL}/wake`, { signal: AbortSignal.timeout(FLY_WAKE_MS) })).ok; }
    catch (e) { console.error('[desk] waking the Fly machine:', e.message || e); return false; }
  }

  /** PATCH and return the rows it changed — how an atomic `status=eq.X` claim learns whether it won. */
  async function patchRows(path, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`supabase PATCH ${path} -> ${r.status}`);
    return r.json();
  }

  const waiters = new Map();   // command id -> resolve(verdict)
  function onCommand(row) {
    if (!row || !waiters.has(row.id)) return;
    if (row.status === 'done' || row.status === 'error') waiters.get(row.id)({ state: row.status, detail: String(row.detail || '') });
  }

  async function readVerdict(id) {
    try {
      const rows = await sb(`desk_commands?id=eq.${encodeURIComponent(id)}&select=status,detail`);
      const row = rows && rows[0];
      if (row && (row.status === 'done' || row.status === 'error')) return { state: row.status, detail: String(row.detail || '') };
    } catch (e) { console.error(`[desk] reading ${id}: ${e.message}`); }
    return null;
  }

  /** Wait for command `id`'s verdict. `write` runs once the waiter is registered, so no answer is missed. */
  async function awaitVerdict(id, write) {
    let resolve;
    const verdict = new Promise((r) => { resolve = r; });
    waiters.set(id, resolve);
    let timer;
    try {
      if (write) {
        const err = await write();
        if (err) return { state: 'error', detail: err };
      } else {
        const now = await readVerdict(id);
        if (now) return now;
      }
      const deadline = new Promise((r) => { timer = setTimeout(() => r(null), CONFIRM_MS); });
      return (await Promise.race([verdict, deadline])) || (await readVerdict(id))
        || { state: 'unconfirmed', detail: 'no answer from the machine yet' };
    } finally {
      clearTimeout(timer);
      waiters.delete(id);
    }
  }

  function send(id, kind, payload) {
    return awaitVerdict(id, async () => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/desk_commands`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ id, kind, payload }),
      }).catch((e) => ({ ok: false, status: e.message }));
      return r.ok ? null : `could not write the command (${r.status})`;
    });
  }

  /**
   * Take a pending command back. Only a row still `pending` can be taken: one a machine has claimed is that
   * machine's now, and its status comes back so the caller can see what became of it.
   */
  async function cancel(id, why) {
    try {
      const won = await patchRows(`desk_commands?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
        { status: 'error', detail: `rerouted: ${why}`, updated: new Date().toISOString() });
      if (won && won.length) return { cancelled: true };
    } catch (e) { console.error(`[desk] cancelling ${id}: ${e.message}`); }
    const rows = await sb(`desk_commands?id=eq.${encodeURIComponent(id)}&select=status,detail`).catch(() => []);
    const row = rows && rows[0];
    return { cancelled: false, status: String((row && row.status) || 'missing'), detail: String((row && row.detail) || '') };
  }

  /** Readiness of all three, read once per routing so every hop agrees. Fly is woken only when reached. */
  function deps(agent = 'claude', { onSend } = {}) {
    let homes = null;
    return {
      confirmMs: CONFIRM_MS,
      ready: async (m) => {
        if (m === 'fly') return (await wakeFly()) ? { ok: true } : { ok: false, why: 'the Fly machine did not start' };
        homes = homes || sb('worker_presence?worker=in.(desk,pi-desk)&select=worker,last_seen,info').catch(() => []);
        const row = ((await homes) || []).find((r) => r.worker === DESK_WORKER[m]);
        return presenceReady(m, row, { staleS: DESK_STALE_S, agent });
      },
      send: (id, kind, payload) => { if (onSend) onSend(id); return send(id, kind, payload); },
      wait: (id) => awaitVerdict(id),
      cancel,
      newId: () => crypto.randomUUID(),
    };
  }

  /** Is the machine beating right now (Fly: did it answer a wake)? A beat alone, as data-layer machineAwake. */
  async function machineAwake(machine) {
    if (machine === 'fly') return wakeFly();
    try {
      const rows = await sb(`worker_presence?worker=eq.${DESK_WORKER[machine]}&select=last_seen`);
      const t = rows && rows[0] && rows[0].last_seen;
      return !!t && (Date.now() - new Date(t).getTime()) / 1000 <= DESK_STALE_S;
    } catch { return false; }   // cannot tell → treat as down, and route around it
  }

  /** Whether anything of a conversation has been mirrored. A failed listing is not taken as empty. */
  async function mirrored(claudeSessionId) {
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/transcripts`, {
        method: 'POST', headers, body: JSON.stringify({ prefix: claudeSessionId, limit: 1 }),
      });
      if (!r.ok) { console.error(`[desk] listing the mirror of ${claudeSessionId}: ${r.status}`); return true; }
      const parts = await r.json();
      return Array.isArray(parts) ? parts.length > 0 : true;
    } catch (e) { console.error(`[desk] listing the mirror of ${claudeSessionId}: ${e.message}`); return true; }
  }

  /**
   * Resume a session's mirrored conversation on the first of `dests` that takes it, and mark the old row
   * handed over, so `source` closes that session if it ever comes back with it still open. Only for a source
   * that is NOT responding: an awake source must close and flush first (transfer_session).
   *
   * The row is CLAIMED FIRST — `transferred`, written only if it still has the status it was read with — and
   * put back if no machine takes the session. Two movers of one conversation (this and the responder's
   * evacuate, or the phone and the orchestrator) would otherwise each resume it and fork the transcript.
   */
  async function resumeMirrored(row, source, dests, extra = {}, routeDeps = deps('claude')) {
    let won;
    try {
      won = await patchRows(`desk_sessions?id=eq.${encodeURIComponent(row.id)}&status=eq.${encodeURIComponent(row.status)}`,
        { status: 'transferred', ended: new Date().toISOString(), working: false });
    } catch (e) { return { ok: false, error: e.message }; }
    if (!won || !won.length) return { ok: false, error: 'something else moved or closed that session at the same moment' };
    const r = await routeCommand('resume_mirrored', {
      claude_session_id: row.claude_session_id, repo: row.repo,
      label: row.label || null, origin: row.origin || 'dispatched', from: source, ...extra,
    }, dests, routeDeps);
    if (!r.ok) {
      try {
        await patchRows(`desk_sessions?id=eq.${encodeURIComponent(row.id)}&status=eq.transferred`,
          { status: row.status, ended: row.ended || null, working: !!row.working });
      } catch (e) { console.error(`[desk] putting ${row.id} back to ${row.status}: ${e.message}`); }
      return { ok: false, error: r.why };
    }
    return { ok: true, id: r.id, machine: r.machine, confirmed: r.state === 'done', rerouted: r.rerouted };
  }

  return { CONFIRM_MS, awaitVerdict, cancel, deps, machineAwake, mirrored, onCommand, patchRows, resumeMirrored, wakeFly };
}

module.exports = { DESK_WORKER, NAME, createDesk, failoverOrder, machineOf, parseHandoff, presenceReady, routeCommand, settle };
