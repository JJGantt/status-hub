'use strict';
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { safeEqual } = require('../lib/auth');
const { transcribe } = require('../lib/transcribe');

module.exports = function (ctx) {
  const {
    GROQ_API_KEY, HUB_PASSWORD, SUPABASE_KEY, SUPABASE_URL, auth, pub, sb, sbWrite,
    settingsAll,
  } = ctx;

  // Public. Reports the commit this instance is RUNNING, which is the only way
  // to tell a deploy that shipped from one that silently never ran — a push whose workflow never fired
  // looks identical to a successful one from the outside, and did exactly that twice on 2026-08-26.
  // COMMIT is stamped at deploy time; 'dev' locally.
  pub.get('/healthz', (req, res) => res.type('text').send('ok ' + (process.env.COMMIT || 'dev')));

  // The restaurant watch app's voice input: the same Groq Whisper as /api/voice-command, transcription
  // only. It is on `pub` because that app (the Menu app, repo Menu) cannot carry
  // the hub token — it ships to TestFlight testers, so anything built into it is public. Only the OWNER's
  // device gets through, and all it can do here is turn a clip into words.
  //
  // The owner is recognised by either of two credentials, both matched by SHA-256:
  //   - `X-Owner-Token`: a dedicated random token (Fly secret CG_OWNER_TOKEN_SHA256 holds its hash). What
  //     the app should send.
  //   - `X-Owner-Key`: the owner's Anthropic API key (the same hash as `AppGate.ownerKeyHash` in
  //     the Menu repo). What every build up to 44 sends. Retire it once no build in use sends it.
  const CG_OWNER_KEY_SHA256 = process.env.CG_OWNER_KEY_SHA256
    || '0c4eb3445e20e7d8b5164aca839f65fad2d05683f7556addbf4ca774d9a9c990';
  const CG_OWNER_TOKEN_SHA256 = process.env.CG_OWNER_TOKEN_SHA256 || '';
  // What the clips are about, as Whisper's vocabulary hint: brand names otherwise come back as ordinary
  // English that sounds alike.
  const CG_WHISPER_PROMPT = 'Someone behind a restaurant bar asking about the menu and restocking: '
    + 'liquor, wine and cocktail names, mostly brand names of vodka, gin, tequila, whiskey, bourbon and wine.';
  // Each clip's timings go to app_logs (kind voice_hub) under the watch's interaction id, beside the watch's
  // own voice_* rows, because Fly keeps only minutes of stdout. arrived = when the request reached the hub;
  // upload = how long the body took after that; groq = the transcription itself.
  function cgLog(req, started, fields) {
    const id = String(req.headers['x-interaction-id'] || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    sbWrite('app_logs', 'POST', {
      timestamp: new Date(started).toISOString(), interaction_id: id.toLowerCase(), backend: 'hub:transcribe',
      kind: 'voice_hub', latency_ms: Date.now() - started, ...fields,
    }).catch((e) => console.error(`[cg-transcribe] log write failed: ${e.message}`));
  }
  // The owner's device. Every /api/cg route is behind this alone.
  const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  function cgOwner(req) {
    const token = String(req.headers['x-owner-token'] || '');
    if (token) return !!CG_OWNER_TOKEN_SHA256 && safeEqual(sha256hex(token), CG_OWNER_TOKEN_SHA256);
    const key = String(req.headers['x-owner-key'] || '');
    return !!key && safeEqual(sha256hex(key), CG_OWNER_KEY_SHA256);
  }
  pub.post('/api/cg/transcribe', async (req, res) => {
    const arrived = Date.now();
    if (!cgOwner(req)) {
      const sent = req.headers['x-owner-token'] || req.headers['x-owner-key'];
      console.log(`[cg-transcribe] REFUSED: ${sent ? 'not the owner' : 'no key'}`);
      req.resume();
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!GROQ_API_KEY) {
      console.log('[cg-transcribe] FAILED: GROQ_API_KEY is not set');
      req.resume();
      return res.status(503).json({ error: 'transcription not configured' });
    }
    const tmp = path.join(os.tmpdir(), 'cg-voice-' + crypto.randomUUID());
    let uploaded = null;
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      uploaded = Date.now();
      const { size } = await fs.promises.stat(tmp);
      if (!size) {
        console.log('[cg-transcribe] FAILED: empty upload');
        cgLog(req, arrived, { error: 'empty upload', output: `upload ${uploaded - arrived}ms` });
        return res.status(400).json({ error: 'no audio' });
      }
      const ct = String(req.headers['content-type'] || 'audio/mp4');
      const { transcript } = await transcribe(tmp, ct, GROQ_API_KEY, { prompt: CG_WHISPER_PROMPT });
      const groq = Date.now() - uploaded;
      console.log(`[cg-transcribe] ${size} bytes ${ct} upload=${uploaded - arrived}ms groq=${groq}ms words=${transcript.split(/\s+/).filter(Boolean).length}`);
      cgLog(req, arrived, { output: `${size} bytes, upload ${uploaded - arrived}ms, groq ${groq}ms` });
      res.json({ transcript });
    } catch (e) {
      // The watch hanging up mid-upload (its own timeout, a dropped link) is the client's failure, not the
      // hub's: the watch logs it as voice_transcribe_retry / orders_failed, so here it is a plain line.
      const clientGone = !uploaded && (e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.message === 'aborted');
      (clientGone ? console.log : console.error)(`[cg-transcribe] ${clientGone ? 'CLIENT GONE' : 'FAILED'}: ${e.status || 500} ${String(e.message || e).slice(0, 200)}`);
      cgLog(req, arrived, { error: String(e.message || e).slice(0, 200),
        output: uploaded ? `upload ${uploaded - arrived}ms, failed in groq` : 'failed during upload' });
      res.status(e.status || 500).json({ error: String(e.message || e) });
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  });
  // THE ORDER LIST (data-layer 00125, 00126): what the restaurant watch app heard guests order, one row per
  // item, written in two passes by the watch's own model (Menu repo, MenuApp/Orders.swift): POST as heard,
  // then /standardize matches each row to the menu and renames it in place. The table has no anon policy,
  // so these owner-gated routes are the only way in. Open orders are the ones not marked done.
  //
  // Which model runs each pass is a hub setting, so switching needs no build: `cg_orders_model_first` /
  // `cg_orders_model_second` in app_settings (a model id, e.g. claude-haiku-4-5), Sonnet when unset.
  const CG_ORDER_KINDS = new Set(['dish', 'wine', 'liquor', 'cocktail', 'other']);
  async function cgOrdersOpen() {
    return sb('cg_orders?select=id,created_at,kind,item_id,name,qty,note,heard_name,standardized_at'
      + '&done_at=is.null&order=created_at.desc&limit=200');
  }
  async function cgOrderModels() {
    const s = await settingsAll().catch(() => ({}));
    return { first: s.cg_orders_model_first || 'claude-sonnet-5', second: s.cg_orders_model_second || 'claude-sonnet-5' };
  }
  pub.get('/api/cg/orders', async (req, res) => {
    if (!cgOwner(req)) return res.status(401).json({ error: 'unauthorized' });
    try { res.json({ orders: await cgOrdersOpen(), models: await cgOrderModels() }); }
    catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });
  pub.post('/api/cg/orders', express.json({ limit: '64kb' }), async (req, res) => {
    if (!cgOwner(req)) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body || {};
    const id = /^[0-9a-f-]{36}$/i.test(String(b.interaction_id || '')) ? String(b.interaction_id).toLowerCase() : null;
    // Items arrive as heard (the first pass); an item already carrying a menu id (a build from before the
    // two passes) counts as standardized.
    const rows = (Array.isArray(b.items) ? b.items : []).map((i) => {
      const name = String((i && i.name) || '').trim().slice(0, 200);
      const matched = !!(i && i.item_id);
      return {
        kind: CG_ORDER_KINDS.has(i && i.kind) ? i.kind : 'other',
        item_id: matched ? String(i.item_id).slice(0, 200) : null,
        name,
        heard_name: name,
        qty: Math.max(1, Math.min(99, parseInt(i && i.qty, 10) || 1)),
        note: i && i.note ? String(i.note).trim().slice(0, 300) : null,
        heard: b.heard ? String(b.heard).slice(0, 2000) : null,
        interaction_id: id,
        standardized_at: matched ? new Date().toISOString() : null,
      };
    }).filter((r) => r.name);
    if (!rows.length) return res.status(400).json({ error: 'no items' });
    try {
      // One write per recording: a retry of it (the watch's request timed out after this insert landed, or
      // its fallback after a failed pass) answers with the rows already written under the id, never a copy.
      if (id) {
        const prior = await sb(`cg_orders?interaction_id=eq.${id}&select=id,created_at,kind,item_id,name,qty,note,heard_name,standardized_at`);
        if (prior.length) {
          console.log(`[cg-orders] ${id} already written (${prior.length} rows); not adding again`);
          return res.json({ added: prior, orders: await cgOrdersOpen() });
        }
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/cg_orders`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
                   Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
      if (!r.ok) throw new Error(`supabase POST cg_orders -> ${r.status}`);
      const added = await r.json();
      console.log(`[cg-orders] +${rows.length}: ${rows.map((x) => `${x.qty}x ${x.name}`).join(', ').slice(0, 300)}`);
      res.json({ added, orders: await cgOrdersOpen() });
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });
  // The second pass: each row the first pass wrote, matched to the menu ({id, kind, item_id, name, note}) or
  // left as heard ({id} alone). Either way the row is marked standardized.
  pub.post('/api/cg/orders/standardize', express.json({ limit: '64kb' }), async (req, res) => {
    if (!cgOwner(req)) return res.status(401).json({ error: 'unauthorized' });
    const ups = Array.isArray(req.body && req.body.updates) ? req.body.updates : [];
    const now = new Date().toISOString();
    try {
      for (const u of ups) {
        if (!/^[0-9a-f-]{36}$/i.test(String(u && u.id || ''))) continue;
        const patch = { standardized_at: now };
        if (u.item_id && u.name) {
          patch.kind = CG_ORDER_KINDS.has(u.kind) ? u.kind : 'other';
          patch.item_id = String(u.item_id).slice(0, 200);
          patch.name = String(u.name).trim().slice(0, 200);
          if (u.note !== undefined) patch.note = u.note ? String(u.note).trim().slice(0, 300) : null;
        }
        await sbWrite(`cg_orders?id=eq.${u.id}`, 'PATCH', patch);
      }
      res.json({ orders: await cgOrdersOpen() });
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });
  // Marks one order done ({id}) or every open one ({all: true}).
  pub.post('/api/cg/orders/done', express.json(), async (req, res) => {
    if (!cgOwner(req)) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body || {};
    const which = b.all ? 'done_at=is.null' : /^[0-9a-f-]{36}$/i.test(String(b.id || '')) ? `id=eq.${b.id}` : null;
    if (!which) return res.status(400).json({ error: 'id or all' });
    try {
      await sbWrite(`cg_orders?${which}`, 'PATCH', { done_at: new Date().toISOString() });
      res.json({ orders: await cgOrdersOpen() });
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });
  pub.get('/login', (req, res) => res.type('html').send(loginHtml()));
  // LOGIN LOCKOUT: a wrong password is a guess against the same per-address budget as a wrong
  // password-derived token at the gate (`guessLimit`, lib/auth.js), so neither way in can be used to
  // guess past the other's limit. Signed-in devices are unaffected: they never post to /login.
  pub.post('/login', (req, res) => {
    if (!auth.mayGuess(req)) return res.status(429).type('html').send(loginHtml('Too many attempts'));
    if (safeEqual(req.body.password || '', HUB_PASSWORD)) {
      return auth.login(req, res).then(() => res.redirect('/'), (e) => {
        console.error('[login] could not store the session:', e.message);
        res.status(503).type('text').send('unavailable');
      });
    }
    auth.failGuess(req, String(req.body.password || ''));
    console.warn(`[login] wrong password from ${auth.clientIp(req)}`);
    res.status(401).type('html').send(loginHtml('Wrong password'));
  });

  // Public, unauthenticated, and deliberately on `pub`: Google has to fetch these
  // as an anonymous crawler. Behind the gate it gets the login page and every check fails.
  //
  // Why the hub hosts them at all: publishing an OAuth app to production (which the Gmail
  // integration needs, because an app left in "Testing" is issued refresh tokens Google
  // revokes after 7 days) requires a homepage, privacy policy and terms on a domain verified
  // in Search Console. fly.dev is on the Public Suffix List, so jared-status-hub.fly.dev is a
  // registrable domain we control -- no domain purchase needed.
  //
  // GSC_VERIFICATION holds the filename Search Console issues, e.g. "google<hex>.html". Matching
  // on it rather than answering any /google*.html means this cannot be used by anyone else to
  // claim the domain in their own Search Console.
  if (process.env.GSC_VERIFICATION) {
    pub.get(`/${process.env.GSC_VERIFICATION}`, (req, res) =>
      res.type('text').send(`google-site-verification: ${process.env.GSC_VERIFICATION}`));
  }

  for (const doc of ['privacy', 'terms']) {
    pub.get(`/${doc}`, (req, res) => {
      const file = path.join(__dirname, '..', 'legal', `${doc}.html`);
      if (!fs.existsSync(file)) return res.status(404).type('text').send('not found');
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(fs.readFileSync(file, 'utf8'));
    });
  }


  // ---- login page (server-rendered; public, no client modules) ----
  function loginHtml(err) {
    return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Status Hub</title><style>
  body{background:#0b0d10;color:#e8eaed;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}
  form{background:#151a20;padding:28px;border-radius:14px;width:280px;text-align:center}
  input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #2a313a;background:#0b0d10;color:#e8eaed;box-sizing:border-box}
  button{width:100%;padding:12px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
  .err{color:#f87171;font-size:14px;min-height:18px}</style>
  <form method=post action=/login><h2>Status Hub</h2>
  <div class=err>${err || ''}</div>
  <input type=password name=password placeholder=Password autofocus>
  <button>Enter</button></form>`;
  }

};
