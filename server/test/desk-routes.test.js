'use strict';
// Where the hub's session routes send work when a machine cannot take it (lib/failover.js): the other
// home machine, then Fly, and a dead letter only when Fly too fails. A fake consumer stands in for the
// machines, answering each command the way the test says its target would.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const h = require('./harness');

let supa, hub, fly, consumer;
// How each machine answers a command addressed to it: 'done', 'error', or 'silent' (never claims it).
let behave = {};
let flyUp = true;

before(async () => {
  supa = await h.fakeSupabase();
  fly = http.createServer((req, res) => { res.statusCode = flyUp ? 200 : 503; res.end('{}'); });
  await new Promise((r) => fly.listen(0, '127.0.0.1', r));
  hub = await h.startHub(supa, { DESK_CONFIRM_MS: '400', FLY_DESK_URL: `http://127.0.0.1:${fly.address().port}`,
                                 FLY_WAKE_TIMEOUT_MS: '2000' });
  consumer = setInterval(() => {
    for (const c of supa.tables.desk_commands || []) {
      if (!c.status) c.status = 'pending';
      if (c.status !== 'pending' || c.answered) continue;
      const how = behave[c.payload && c.payload.target] || 'silent';
      if (how === 'silent') continue;
      c.answered = true;
      Object.assign(c, { status: how, detail: how === 'done' ? 'launched' : 'boom' });
    }
  }, 20);
});
after(async () => { clearInterval(consumer); await hub.stop(); supa.close(); fly.close(); });

const now = () => new Date().toISOString();
function machines({ pi = false, mac = false } = {}) {
  supa.tables.worker_presence = [
    ...(pi ? [{ worker: 'pi-desk', last_seen: now(), info: {} }] : []),
    ...(mac ? [{ worker: 'desk', last_seen: now(), info: {} }] : []),
  ];
}
beforeEach(() => {
  supa.tables.desk_commands = [];
  supa.tables.desk_dead_letters = [];
  supa.tables.repos = [{ path: '/home/x/repos/proj', name: 'proj' }];
  behave = { pi: 'done', mac: 'done', fly: 'done' };
  flyUp = true;
});

const post = async (p, body) => {
  const r = await hub.req(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Token': h.DEVICE_TOKEN },
                               body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const sent = () => (supa.tables.desk_commands || []).map((c) => [c.kind, c.payload.target, c.status]);

describe('opening a session (/api/repos/open)', () => {
  test('the machine asked for takes it when it can', async () => {
    machines({ pi: true, mac: true });
    const r = await post('/api/repos/open', { path: '/home/x/repos/proj' });
    assert.equal(r.status, 200);
    assert.equal(r.json.machine, 'pi');
    assert.deepEqual(sent(), [['open_session', 'pi', 'done']]);
  });

  test('with the Pi down it goes to the Mac, and with both down to Fly', async () => {
    machines({ mac: true });
    assert.equal((await post('/api/repos/open', { path: '/home/x/repos/proj' })).json.machine, 'mac');
    supa.tables.desk_commands = [];
    machines({});
    const r = await post('/api/repos/open', { path: '/home/x/repos/proj', target: 'mac' });
    assert.equal(r.json.machine, 'fly');
    assert.deepEqual(sent(), [['open_session', 'fly', 'done']]);
  });

  test('a machine that never takes it has its command taken back before the next is sent it', async () => {
    machines({ pi: true, mac: true });
    behave.pi = 'silent';
    const r = await post('/api/repos/open', { path: '/home/x/repos/proj' });
    assert.equal(r.json.machine, 'mac');
    assert.deepEqual(sent(), [['open_session', 'pi', 'error'], ['open_session', 'mac', 'done']]);
    assert.match(supa.tables.desk_commands[0].detail, /^rerouted: /);
  });

  test('dead-lettered with a 409 only when Fly too cannot take it', async () => {
    machines({});
    flyUp = false;
    const r = await post('/api/repos/open', { path: '/home/x/repos/proj' });
    assert.equal(r.status, 409);
    assert.ok(r.json.saved);
    assert.equal(supa.tables.desk_dead_letters.length, 1);
    assert.deepEqual(sent(), []);
  });
});

describe('words for a session whose machine is down (/api/sessions/followup)', () => {
  const CONV = 'c0ffee00-aaaa-bbbb-cccc-000000000001';
  beforeEach(() => {
    supa.tables.desk_sessions = [{ id: 'mac-live1', worker: 'desk', status: 'resident', working: false,
                                   claude_session_id: CONV, repo: 'proj', label: 'proj' }];
  });

  test('the conversation moves to the other home machine with the words, and the old row is handed over', async () => {
    machines({ pi: true });
    const r = await post('/api/sessions/followup', { id: 'mac-live1', text: 'carry on', client_msg_id: 'm-1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.moved, 'pi');
    const c = supa.tables.desk_commands[0];
    assert.equal(c.kind, 'resume_mirrored');
    assert.equal(c.payload.target, 'pi');
    assert.equal(c.payload.prompt, 'carry on');
    assert.equal(c.payload.msg, 'm-1');
    assert.equal(supa.tables.desk_sessions[0].status, 'transferred');
  });

  test('with no home machine up it moves to Fly', async () => {
    machines({});
    const r = await post('/api/sessions/followup', { id: 'mac-live1', text: 'carry on' });
    assert.equal(r.json.moved, 'fly');
    assert.deepEqual(sent(), [['resume_mirrored', 'fly', 'done']]);
  });

  test('when nothing takes it the row is put back and the words are saved', async () => {
    machines({});
    flyUp = false;
    const r = await post('/api/sessions/followup', { id: 'mac-live1', text: 'carry on' });
    assert.equal(r.status, 409);
    assert.ok(r.json.saved);
    assert.equal(supa.tables.desk_sessions[0].status, 'resident');
    assert.equal(supa.tables.desk_dead_letters[0].payload.prompt, 'carry on');
  });

  test('a Codex session, which cannot move, gets the words as a new session in its repo', async () => {
    supa.tables.desk_sessions[0].agent = 'codex';
    machines({ pi: true });
    supa.tables.worker_presence[0].info = { codex: true };
    const r = await post('/api/sessions/followup', { id: 'mac-live1', text: 'carry on' });
    assert.equal(r.status, 200);
    assert.equal(r.json.started, true);
    const c = supa.tables.desk_commands[0];
    assert.equal(c.kind, 'open_session');
    assert.equal(c.payload.target, 'pi');
    assert.equal(c.payload.path, '/home/x/repos/proj');
    assert.equal(c.payload.agent, 'codex');
  });
});

describe('session verbs and moves for a machine that is down', () => {
  const CONV = 'c0ffee00-aaaa-bbbb-cccc-000000000002';
  beforeEach(() => {
    supa.tables.desk_sessions = [{ id: 'pi-park1', worker: 'pi-desk', status: 'evicted', working: false,
                                   claude_session_id: CONV, repo: 'proj' }];
  });

  test('a resume moves the conversation to the next machine', async () => {
    machines({ mac: true });
    const r = await post('/api/sessions/resume', { id: 'pi-park1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.moved, 'mac');
    assert.deepEqual(sent(), [['resume_mirrored', 'mac', 'done']]);
  });

  test('an end closes a running row here, parked so it can still be resumed', async () => {
    supa.tables.desk_sessions[0].status = 'resident';
    machines({ mac: true });
    const r = await post('/api/sessions/end', { id: 'pi-park1' });
    assert.equal(r.status, 200);
    assert.equal(supa.tables.desk_sessions[0].status, 'evicted');
    assert.deepEqual(sent(), []);
  });

  test('a transfer from a machine that is down resumes the mirror on the other one, else Fly', async () => {
    supa.tables.desk_sessions[0].status = 'resident';
    machines({});
    const r = await post('/api/sessions/transfer', { id: 'pi-park1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.to, 'fly');
    assert.deepEqual(sent(), [['resume_mirrored', 'fly', 'done']]);
    assert.equal(supa.tables.desk_sessions[0].status, 'transferred');
  });

  test('a transfer from a machine that is up asks it to close and hand over', async () => {
    supa.tables.desk_sessions[0].status = 'resident';
    machines({ pi: true, mac: true });
    const r = await post('/api/sessions/transfer', { id: 'pi-park1' });
    assert.equal(r.json.to, 'mac');
    const c = supa.tables.desk_commands[0];
    assert.deepEqual([c.kind, c.payload.target, c.payload.to], ['transfer_session', 'pi', 'mac']);
  });
});
