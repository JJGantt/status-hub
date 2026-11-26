'use strict';
const { logged } = require('../lib/httpfail');

// ---- images shown in a reply: data-layer share_image → bucket `shared-images` → here --------------------
//
// A session or the orchestrator calls share_image, which stores the picture and answers with a markdown
// line pointing at /img/<name>. The phone's markdown renderer (shared.js `md`) and the watch's
// (Markdown.swift) draw that line inline; both fetch it through this route, the phone with its cookie
// and the watch with X-Hub-Token. Gated like everything else: a link opened outside the app lands on
// the login page.
//
// The name is a uuid plus an extension, and the bucket is flat, so anything path-like is refused. The
// response is locked down as well as typed: `nosniff` and a sandboxing CSP, so even a file that is not
// what its type says cannot run as a page on this origin if it is opened directly.

const BUCKET = 'shared-images';
const imgName = (n) => /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(n);

module.exports = function ({ SUPABASE_KEY, SUPABASE_URL, gated }) {
  gated.get('/img/:name', async (req, res) => {
    const name = String(req.params.name || '');
    if (!imgName(name)) return res.status(400).type('text').send('bad image name');
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (r.status === 404 || r.status === 400) return res.status(404).type('text').send('no such image');
      if (!r.ok) {
        console.error(`[img] storage answered ${r.status} for ${name}`);
        return logged(res).status(502).type('text').send('could not read image');
      }
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');   // a name is never reused
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error(`[img] ${name}: ${e.message || e}`);
      logged(res).status(502).type('text').send('could not read image');
    }
  });
};

module.exports.imgName = imgName;
