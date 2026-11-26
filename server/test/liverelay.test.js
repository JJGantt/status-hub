'use strict';
// The live Chrome relay (lib/liverelay.js): who is told to stream what, and where frames and input go.
const test = require('node:test');
const assert = require('node:assert');
const { createRelay, headerOf } = require('../lib/liverelay');

function sock() {
  return { readyState: 1, bufferedAmount: 0, sent: [], closed: null,
    send(d) { this.sent.push(d); }, close(code) { this.closed = code; this.readyState = 3; } };
}
const json = (ws) => ws.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
const frame = (target, bytes = 'jpeg') => {
  const h = Buffer.from(JSON.stringify({ target, w: 400, h: 800 }));
  const n = Buffer.alloc(4); n.writeUInt32BE(h.length);
  return Buffer.concat([n, h, Buffer.from(bytes)]);
};

function setup(rows) {
  const closed = [], metas = [];
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  const relay = createRelay({ rows: () => rows, closeTab: (m, t) => closed.push([m, t]), meta: (m, t, x) => metas.push([m, t, x]), timers });
  return { relay, closed, metas };
}

const ROWS = [
  { id: 'a', machine: 'mac', target: '11', conversation: 'c1' },
  { id: 'b', machine: 'mac', target: '12', conversation: 'c2' },
  { id: 'p', machine: 'pi', target: '21', conversation: 'c3' },
];

test('a tab streams only while someone watches it', () => {
  const { relay } = setup(ROWS);
  const mac = sock(); relay.addAgent('mac', mac);
  assert.deepStrictEqual(json(mac)[0], { op: 'tabs', targets: ['11', '12'] });
  const v1 = sock(), v2 = sock();
  relay.addViewer('a', v1);
  relay.addViewer('a', v2);
  assert.strictEqual(json(mac).filter((m) => m.op === 'watch').length, 1, 'one watch however many viewers');
  relay.dropViewer('a', v1);
  assert.strictEqual(json(mac).filter((m) => m.op === 'unwatch').length, 0);
  relay.dropViewer('a', v2);
  assert.deepStrictEqual(json(mac).at(-1), { op: 'unwatch', target: '11' });
});

test('a viewer with no extension connected is told, and the watch goes out when it connects', () => {
  const { relay } = setup(ROWS);
  const v = sock();
  const err = console.error; console.error = () => {};
  try { relay.addViewer('p', v); } finally { console.error = err; }
  assert.deepStrictEqual(json(v).at(-1), { op: 'status', agent: false });
  const pi = sock(); relay.addAgent('pi', pi);
  assert.ok(json(pi).some((m) => m.op === 'watch' && m.target === '21'));
  assert.deepStrictEqual(json(v).at(-1), { op: 'status', agent: true });
});

test('frames reach only that tab\'s viewers, and a backed-up viewer is skipped', () => {
  const { relay } = setup(ROWS);
  relay.addAgent('mac', sock());
  const va = sock(), vb = sock(), slow = sock();
  relay.addViewer('a', va); relay.addViewer('b', vb); relay.addViewer('a', slow);
  slow.bufferedAmount = 10 * 1024 * 1024;
  relay.agentMessage('mac', frame('11'), true);
  assert.strictEqual(va.sent.filter(Buffer.isBuffer).length, 1);
  assert.strictEqual(vb.sent.filter(Buffer.isBuffer).length, 0);
  assert.strictEqual(slow.sent.filter(Buffer.isBuffer).length, 0);
  // The same tab id on the other machine is a different tab.
  relay.agentMessage('pi', frame('11'), true);
  assert.strictEqual(va.sent.filter(Buffer.isBuffer).length, 1);
  assert.strictEqual(headerOf(frame('11')).target, '11');
});

test('input goes to the agent of the machine holding the tab, and only known kinds pass', () => {
  const { relay } = setup(ROWS);
  const mac = sock(), pi = sock();
  relay.addAgent('mac', mac); relay.addAgent('pi', pi);
  relay.viewerMessage('p', JSON.stringify({ t: 'tap', x: 0.5, y: 0.25 }));
  relay.viewerMessage('p', JSON.stringify({ t: 'eval', js: 'x' }));
  assert.deepStrictEqual(json(pi).filter((m) => m.op === 'input'), [{ op: 'input', target: '21', ev: { t: 'tap', x: 0.5, y: 0.25 } }]);
  assert.strictEqual(json(mac).filter((m) => m.op === 'input').length, 0);
});

test('a tab that closes ends its viewers; a tab the extension reports gone is closed', () => {
  const rows = ROWS.slice();
  const { relay, closed } = setup(rows);
  relay.addAgent('mac', sock());
  const v = sock(); relay.addViewer('b', v);
  relay.agentMessage('mac', JSON.stringify({ op: 'gone', target: '12' }), false);
  assert.deepStrictEqual(closed, [['mac', '12']]);
  rows.splice(1, 1);
  relay.tabsChanged();
  assert.deepStrictEqual(json(v).at(-1), { op: 'closed' });
  assert.strictEqual(v.closed, 4004);
});

test('a reconnecting extension replaces the old socket', () => {
  const { relay } = setup(ROWS);
  const old = sock(), fresh = sock();
  relay.addAgent('mac', old);
  relay.addAgent('mac', fresh);
  assert.strictEqual(old.closed, 4000);
  relay.dropAgent('mac', old);       // the old socket's close arriving late changes nothing
  assert.deepStrictEqual(relay.connected(), ['mac']);
});
