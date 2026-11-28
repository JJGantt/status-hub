'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSwitchBot } = require('../lib/switchbot');

// A fake SwitchBot: status answers from `states` in turn (the last repeats); commands are recorded.
function fake(states) {
  const sent = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.switch-bot.com/v1.1', '');
    let body;
    if (path === '/devices') body = { deviceList: [{ deviceId: 'L1', deviceType: 'Smart Lock Ultra' }, { deviceId: 'K1', deviceType: 'Keypad Touch' }] };
    else if (path.endsWith('/status')) body = { lockState: states[Math.min(i++, states.length - 1)] };
    else { sent.push(JSON.parse(init.body).command); body = {}; }
    return { ok: true, status: 200, json: async () => ({ statusCode: 100, body }) };
  };
  let clock = 0;
  const realNow = Date.now;
  const bot = createSwitchBot({ token: 't', secret: 's', fetchImpl, sleep: async (ms) => { clock += ms; } });
  return { bot, sent, withClock: async (fn) => { Date.now = () => realNow() + clock; try { return await fn(); } finally { Date.now = realNow; } } };
}
const norm = (b) => String(b.lockState).toLowerCase();

test('a command answers once the lock reports the new state', async () => {
  const f = fake(['unlocked', 'locked']);
  const r = await f.withClock(() => f.bot.command('locked', norm));
  assert.deepEqual([norm(r.body), f.sent], ['locked', ['lock']]);
});

test('the command is sent without reading the lock first, even when it is already in that state', async () => {
  const f = fake(['locked']);
  const r = await f.withClock(() => f.bot.command('locked', norm));
  assert.deepEqual([norm(r.body), f.sent], ['locked', ['lock']]);
});

test('a command that never takes effect throws', async () => {
  const f = fake(['unlocked']);
  await assert.rejects(f.withClock(() => f.bot.command('locked', norm)), /after 15s the lock reports unlocked/);
});

test('the keypad is not taken for the lock', async () => {
  assert.equal(await fake(['locked']).bot.findLock(), 'L1');
});
