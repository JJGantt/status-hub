'use strict';
// Runs the real server (server.js, unmodified) as a child process against a fake Supabase, so a test
// exercises the same Express app, middleware order and routes that run on Fly. Only external services
// are stood in for: Supabase is `fakeSupabase` below; Groq, APNs and the ops responder are simply left
// unconfigured (no keys), which every route already handles.
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// PostgREST, as far as the hub uses it: GET with eq./in./is.null filters, POST (insert), PATCH, DELETE.
// Every table starts empty. `tables` is exposed so a test can seed or inspect rows.
function fakeSupabase() {
  const tables = {};
  const matches = (row, params) => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict', 'offset'].includes(k)) continue;
      if (v.startsWith('eq.') && String(row[k]) !== v.slice(3)) return false;
      if (v === 'is.null' && row[k] != null) return false;
      if (v.startsWith('in.(') && !v.slice(4, -1).split(',').includes(String(row[k]))) return false;
    }
    return true;
  };
  let api;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const m = /^\/rest\/v1\/([^/]+)$/.exec(u.pathname);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Range', '0-0/0');
      if (!m) { res.statusCode = 404; return res.end('{}'); }
      const rows = (tables[m[1]] = tables[m[1]] || []);
      const hit = rows.filter((r) => matches(r, u.searchParams));
      if (api.failWrites && req.method !== 'GET') { res.statusCode = 500; return res.end('{}'); }
      let data = [];
      try { data = body ? JSON.parse(body) : []; } catch {}
      if (req.method === 'GET') return res.end(JSON.stringify(hit));
      if (req.method === 'POST') {
        const added = [].concat(data).map((r) => ({ created_at: new Date().toISOString(), ...r }));
        rows.push(...added);
        res.statusCode = 201;
        return res.end(JSON.stringify(added));
      }
      if (req.method === 'PATCH') { hit.forEach((r) => Object.assign(r, data)); return res.end(JSON.stringify(hit)); }
      if (req.method === 'DELETE') { tables[m[1]] = rows.filter((r) => !hit.includes(r)); return res.end('[]'); }
      res.end('[]');
    });
  });
  api = { tables, failWrites: false, close: () => server.close() };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    api.url = `http://127.0.0.1:${server.address().port}`;
    resolve(api);
  }));
}

const PASSWORD = 'test-password';
const DEVICE_TOKEN = 'test-device-token';
const OWNER_TOKEN = 'test-owner-token';
const OWNER_KEY = 'test-anthropic-key';
const PASSWORD_TOKEN = sha256hex('status-hub:' + PASSWORD);

// Start the hub on a free port. Resolves once it is listening and has loaded its sessions.
async function startHub(supa, env = {}) {
  const port = await new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      PATH: process.env.PATH, HOME: spool, TZ: process.env.TZ || 'UTC',
      PORT: String(port), SUPABASE_URL: supa.url, SUPABASE_KEY: 'test-service-key',
      HUB_PASSWORD: PASSWORD, TV_TOKEN: DEVICE_TOKEN,
      CG_OWNER_TOKEN_SHA256: sha256hex(OWNER_TOKEN), CG_OWNER_KEY_SHA256: sha256hex(OWNER_KEY),
      OPS_TOKEN: '', OPS_URLS: 'http://127.0.0.1:9', OPS_SPOOL: path.join(spool, 'ops-spool.jsonl'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hub did not start:\n' + out)), 20000);
    const check = () => {
      if (/status-hub on :/.test(out) && /sessions loaded/.test(out)) { clearTimeout(t); resolve(); }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`hub exited ${code}:\n${out}`)); });
  });
  child.removeAllListeners('exit');
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    output: () => out,
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); }),
    req: (p, init) => request(base + p, init),
  };
}

// One HTTP request with exactly the headers given (fetch would add its own Sec-Fetch-Mode, which is the
// header the gate reads to tell a page load from a fetch), never following a redirect. Resolves to
// { status, headers: { get }, text(), json() }.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  if (body instanceof URLSearchParams) {
    headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers };
    body = body.toString();
  }
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return v == null ? null : [].concat(v).join(', '); } },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

// The `hub` cookie a response sets, or null.
function setCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const m = /(?:^|,\s*)hub=([^;]*)/.exec(raw);
  return m ? m[1] : null;
}

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WKWEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const NAV = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };

module.exports = { fakeSupabase, startHub, setCookie, sha256hex, PASSWORD, DEVICE_TOKEN, PASSWORD_TOKEN,
                   OWNER_TOKEN, OWNER_KEY, SAFARI, WKWEBVIEW, NAV };
