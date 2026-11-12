// Where a desk command goes when a machine cannot take it: the failover order, handoffs followed to the
// machine that really ran it, and a silent machine's command taken back before the next is tried.
'use strict';
// The same cases as data-layer test/desk-routing.test.mjs: the two implementations have to agree.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { failoverOrder, parseHandoff, presenceReady, routeCommand, settle } = require('../lib/failover');

// A world of three machines. `machines[m]` says how m behaves: not ready (`ready: 'why'`), answers with a
// verdict, hands the work on, or stays silent. `cancel` answers what an atomic take-back would find.
function world(machines, { cancel = () => ({ cancelled: true }) } = {}) {
  const log = [];
  let n = 0;
  const handed = new Map();   // handed-on command id -> machine that received it
  const verdictFor = (m, id) => {
    const b = machines[m] || {};
    if (b.verdict) return typeof b.verdict === 'function' ? b.verdict(id) : b.verdict;
    return { state: 'unconfirmed', detail: 'no answer from the machine yet' };
  };
  const deps = {
    ready: async (m) => {
      log.push(['ready', m]);
      const why = machines[m]?.ready;
      return why ? { ok: false, why } : { ok: true };
    },
    send: async (id, kind, payload) => { log.push(['send', payload.target, kind, id]); return verdictFor(payload.target, id); },
    wait: async (id) => { const m = handed.get(id); log.push(['wait', m, id]); return verdictFor(m, id); },
    cancel: async (id, why) => { log.push(['cancel', id]); return cancel(id, why); },
    newId: () => `c${++n}`,
  };
  return { deps, log, handed };
}
const sends = (log) => log.filter((e) => e[0] === 'send').map((e) => e[1]);

describe('failoverOrder', () => {
  test('the other home machine before Fly, and Fly always last for a home machine', () => {
    assert.deepEqual(failoverOrder('pi'), ['pi', 'mac', 'fly']);
    assert.deepEqual(failoverOrder('mac'), ['mac', 'pi', 'fly']);
  });
  test('a Fly session tries Fly, then the Pi, then the Mac', () => {
    assert.deepEqual(failoverOrder('fly'), ['fly', 'pi', 'mac']);
  });
});

describe('parseHandoff', () => {
  test('reads all three machines, with and without a reason', () => {
    assert.deepEqual(parseHandoff('handed to the Mac as abc-1 — no room on the Pi'), { machine: 'mac', id: 'abc-1', why: 'no room on the Pi' });
    assert.deepEqual(parseHandoff('handed to the Pi as abc-2'), { machine: 'pi', id: 'abc-2', why: null });
    assert.deepEqual(parseHandoff('handed to Fly as abc-3 — the Mac is asleep'), { machine: 'fly', id: 'abc-3', why: 'the Mac is asleep' });
  });
  test('a transfer verdict naming a session is not a handoff', () => {
    assert.equal(parseHandoff('handed hub-x to the Mac'), null);
    assert.equal(parseHandoff('launched hub-x'), null);
    assert.equal(parseHandoff(''), null);
  });
});

describe('routeCommand', () => {
  test('the first machine that answers keeps it, and nothing is rerouted', async () => {
    const { deps, log } = world({ pi: { verdict: { state: 'done', detail: 'launched hub-a' } } });
    const r = await routeCommand('open_session', { name: 'x' }, failoverOrder('pi'), deps);
    assert.equal(r.ok, true);
    assert.equal(r.machine, 'pi');
    assert.equal(r.state, 'done');
    assert.equal(r.rerouted, null);
    assert.deepEqual(sends(log), ['pi']);
  });

  test('a machine that is not ready is skipped without a command being written', async () => {
    const { deps, log } = world({ pi: { ready: 'the Pi is not responding' }, mac: { verdict: { state: 'done', detail: 'ok' } } });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.machine, 'mac');
    assert.equal(r.rerouted, 'the Pi is not responding');
    assert.deepEqual(sends(log), ['mac']);
  });

  test('a silent machine has its command taken back before the next machine is sent it', async () => {
    const { deps, log } = world({ mac: { verdict: { state: 'done', detail: 'ok' } } });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.ok, true);
    assert.equal(r.machine, 'mac');
    assert.match(r.rerouted, /the Pi did not take it/);
    const i = log.findIndex((e) => e[0] === 'cancel' && e[1] === 'c1');
    const j = log.findIndex((e) => e[0] === 'send' && e[1] === 'mac');
    assert.ok(i >= 0 && i < j, 'cancel of the Pi command comes before the send to the Mac');
  });

  test('a refusal reroutes too, without a take-back', async () => {
    const { deps, log } = world({ pi: { verdict: { state: 'error', detail: 'boom' } }, mac: { verdict: { state: 'done', detail: 'ok' } } });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.machine, 'mac');
    assert.match(r.rerouted, /refused it \(boom\)/);
    assert.equal(log.some((e) => e[0] === 'cancel'), false);
  });

  test('Fly is reached when both home machines fail, and is the last thing tried', async () => {
    const { deps, log } = world({
      pi: { ready: 'the Pi is not responding' },
      mac: { verdict: { state: 'error', detail: 'nope' } },
      fly: { verdict: { state: 'done', detail: 'ok' } },
    });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.machine, 'fly');
    assert.deepEqual(sends(log), ['mac', 'fly']);
  });

  test('when every machine fails, the reasons are all given and it is not ok', async () => {
    const { deps } = world({ pi: { ready: 'the Pi is not responding' }, mac: { ready: 'the Mac is not responding' },
                             fly: { ready: 'the Fly machine did not start' } });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.ok, false);
    assert.equal(r.why, 'the Pi is not responding, and the Mac is not responding, and the Fly machine did not start');
  });

  test('a machine that claimed the command in the take-back window keeps it: claimed, not resent', async () => {
    const { deps, log } = world({}, { cancel: () => ({ cancelled: false, status: 'running', detail: '' }) });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.ok, true);
    assert.equal(r.state, 'claimed');
    assert.equal(r.machine, 'pi');
    assert.deepEqual(sends(log), ['pi']);
  });

  test('a command that finished in the take-back window is judged on that verdict', async () => {
    const lost = world({}, { cancel: () => ({ cancelled: false, status: 'done', detail: 'launched hub-late' }) });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), lost.deps);
    assert.equal(r.state, 'done');
    assert.equal(r.detail, 'launched hub-late');
    const failed = world({ mac: { verdict: { state: 'done', detail: 'ok' } } },
                         { cancel: (id) => (id === 'c1' ? { cancelled: false, status: 'error', detail: 'x' } : { cancelled: true }) });
    assert.equal((await routeCommand('open_session', {}, failoverOrder('pi'), failed.deps)).machine, 'mac');
  });

  test('a queued verdict is a failure that routes on', async () => {
    const { deps } = world({ pi: { verdict: { state: 'done', detail: 'queued — no room' } }, mac: { verdict: { state: 'done', detail: 'ok' } } });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), deps);
    assert.equal(r.machine, 'mac');
    assert.match(r.rerouted, /queued it/);
  });
});

describe('handoffs', () => {
  test('a handoff to Fly is followed to Fly\'s verdict', async () => {
    const w = world({
      pi: { verdict: () => { w.handed.set('f1', 'fly'); return { state: 'done', detail: 'handed to Fly as f1 — the Mac is asleep' }; } },
      fly: { verdict: { state: 'done', detail: 'launched hub-f' } },
    });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), w.deps);
    assert.equal(r.ok, true);
    assert.equal(r.id, 'f1');
    assert.equal(r.machine, 'fly');
    assert.deepEqual(r.handedOff, { from: 'pi', why: 'the Mac is asleep' });
  });

  test('a handed-on command that goes silent is taken back and routing skips the machine it went to', async () => {
    const w = world({
      pi: { verdict: () => { w.handed.set('m1', 'mac'); return { state: 'done', detail: 'handed to the Mac as m1' }; } },
      fly: { verdict: { state: 'done', detail: 'ok' } },
    });
    const r = await routeCommand('open_session', {}, failoverOrder('pi'), w.deps);
    assert.equal(r.machine, 'fly');
    assert.ok(w.log.some((e) => e[0] === 'cancel' && e[1] === 'm1'), 'the Mac command is taken back');
    assert.deepEqual(sends(w.log), ['pi', 'fly'], 'the Mac is not sent it a second time');
  });

  test('settle alone follows a Pi handoff to the Mac', async () => {
    const w = world({ mac: { verdict: { state: 'done', detail: 'typed' } } });
    w.handed.set('m9', 'mac');
    const r = await settle('c0', 'pi', { state: 'done', detail: 'handed to the Mac as m9 — moved there' }, w.deps);
    assert.equal(r.ok, true);
    assert.equal(r.machine, 'mac');
    assert.equal(r.id, 'm9');
  });

  test('settle reports a silent machine as silent and a refusal as refused', async () => {
    const w = world({});
    assert.equal((await settle('c0', 'pi', { state: 'unconfirmed', detail: '' }, w.deps)).failed, 'silent');
    assert.equal((await settle('c0', 'pi', { state: 'error', detail: 'no such session' }, w.deps)).failed, 'refused');
  });
});

describe('presenceReady', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const beat = (info) => ({ last_seen: new Date(now - 10e3).toISOString(), info });
  test('a stale beat is not responding, whatever it says', () => {
    assert.deepEqual(presenceReady('mac', { last_seen: new Date(now - 120e3).toISOString() }, { now }),
                     { ok: false, why: 'the Mac is not responding' });
    assert.equal(presenceReady('pi', null, { now }).ok, false);
  });
  test('an expired Claude login is not ready; a beat without the field is', () => {
    assert.match(presenceReady('pi', beat({ login_expires_at: '2026-11-01T00:00:00Z' }), { now }).why, /login has expired/);
    assert.equal(presenceReady('pi', beat({ login_expires_at: null }), { now }).ok, false);
    assert.equal(presenceReady('pi', beat({}), { now }).ok, true);
    assert.equal(presenceReady('pi', beat({ login_expires_at: '2026-12-01T00:00:00Z' }), { now }).ok, true);
  });
  test('a Codex session needs Codex signed in there, and nothing of the Claude login', () => {
    assert.equal(presenceReady('mac', beat({ codex: true, login_expires_at: null }), { now, agent: 'codex' }).ok, true);
    assert.match(presenceReady('mac', beat({}), { now, agent: 'codex' }).why, /Codex is not signed in/);
  });
});
