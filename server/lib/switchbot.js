'use strict';
// SwitchBot's cloud API (Open API v1.1) for the front door's Lock Ultra: signed calls, the lock's
// status, and lock/unlock confirmed against the lock's own state. data-layer src/switchbot.ts is the
// MCP's copy of the same calls (README § The front door there).
const crypto = require('crypto');

const API = 'https://api.switch-bot.com/v1.1';
const CONFIRM_MS = 15000;
const STEP_MS = 1500;

function createSwitchBot({ token, secret, lockId = '', fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function api(method, path, body) {
    const t = String(Date.now()), nonce = crypto.randomUUID();
    const sign = crypto.createHmac('sha256', secret).update(token + t + nonce).digest('base64');
    const r = await fetchImpl(API + path, {
      method,
      headers: { Authorization: token, sign, t, nonce, 'Content-Type': 'application/json; charset=utf8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (!r.ok || j.statusCode !== 100) throw new Error(`SwitchBot ${method} ${path} -> HTTP ${r.status}, statusCode ${j.statusCode} ${j.message || ''}`.trim());
    return j.body;
  }

  async function findLock() {
    if (lockId) return lockId;
    const locks = ((await api('GET', '/devices')).deviceList || []).filter((d) => /lock/i.test(String(d.deviceType)));
    if (locks.length !== 1) throw new Error(`expected one lock on the SwitchBot account, found ${locks.length}`);
    return (lockId = locks[0].deviceId);
  }

  /** The lock's status body, as SwitchBot answers it (lockState, doorState, battery, …). */
  async function status() {
    return api('GET', `/devices/${await findLock()}/status`);
  }

  /** Lock or unlock (`want` 'locked' | 'unlocked'), answered with the status body once the lock
   *  reports that state; already there sends nothing. Not there after CONFIRM_MS throws. */
  async function command(want, norm) {
    const before = await status();
    if (norm(before) === want) return { body: before, changed: false };
    const id = await findLock();
    await api('POST', `/devices/${id}/commands`, { command: want === 'locked' ? 'lock' : 'unlock', parameter: 'default', commandType: 'command' });
    const sent = Date.now();
    let body = before;
    while (Date.now() - sent < CONFIRM_MS) {
      await sleep(STEP_MS);
      body = await status();
      if (norm(body) === want) return { body, changed: true };
    }
    throw new Error(`sent ${want === 'locked' ? 'lock' : 'unlock'}, but after ${CONFIRM_MS / 1000}s the lock reports ${body.lockState}`);
  }

  return { api, findLock, status, command };
}

module.exports = { createSwitchBot, CONFIRM_MS };
