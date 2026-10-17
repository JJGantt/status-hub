// The live microphone relay: the phone streams its microphone up, every watch listening gets it down.
// docs/LIVE-MIC.md is the whole path.
//
// THE WIRE FORMAT, both directions: a run of packets, each a 2-byte big-endian length and that many
// bytes of one AAC-LC packet (24 kHz mono, 1024 frames). A zero length is a keepalive and carries no
// audio. Every WebSocket message from the phone holds whole packets, so the down stream is just those
// messages written one after another and a listener never has to find a boundary.
//
// A LISTENER THAT ASKS FOR SEQUENCE NUMBERS (`?seq=1`) also gets, after every message, a marker: the
// length 0xFFFF and an 8-byte big-endian sequence number for the message just sent. A watch that
// reconnects asks for `?seq=1&after=<the last one it got>` and is sent everything since from the ring,
// so a dropped connection loses nothing; it catches up by playing fast (LiveListen.swift). Numbers
// start at the process's start time in ms, so a restarted hub's are above any it handed out before and
// a resume from them starts at the oldest audio this process has.
//
// In memory only. The hub is one always-on machine, so the phone and every watch meet in this process;
// a second machine would split them, and fly.toml keeping one is what this relies on.
const { WebSocketServer } = require('ws');

const PATH_UP = '/api/live-mic/up';
// What a watch that joins (or rejoins, after the switch to its own LTE) is handed first: exactly the
// watch's own starting buffer (`startAfter` in LiveListen.swift), so it plays at once. Every millisecond
// here is delay the watch keeps for the whole listen, since it never catches up; at 2s the watch ran a
// steady 2s behind.
const RECENT_MS = 250;
// Fly's proxy closes a connection that has sent nothing for 60s; a ping keeps the phone's socket open.
const PING_MS = 15000;
// A listener's heartbeat. The watch counts 5s with no bytes as a dead connection (LiveListen.swift), which
// is how a stream killed silently by the switch from the phone's Bluetooth to the watch's LTE is noticed
// in seconds rather than at URLSession's 60. Between streams this is the only thing it receives.
const KEEPALIVE_MS = 2000;
const KEEPALIVE = Buffer.from([0, 0]);
// How far back a resuming listener can be handed what it missed. 32 kbit/s is about 1.2MB for this.
const RING_MS = 5 * 60 * 1000;

function marker(seq) {
  const b = Buffer.alloc(10);
  b.writeUInt16BE(0xffff, 0);
  b.writeBigUInt64BE(BigInt(seq), 2);
  return b;
}

let source = null;            // the phone's socket, while it streams
let ring = [];                // [{ seq, t, buf }] — the last RING_MS of messages, across phone reconnects
let seq = Date.now();
const listeners = new Map();  // watch response -> whether it takes markers

function send(res, marked, m) {
  res.write(m.buf);
  if (marked) res.write(marker(m.seq));
}

function tellSource() {
  if (source) try { source.send(JSON.stringify({ listeners: listeners.size })); } catch {}
}

function takeSource(ws) {
  // Newest wins: a phone that reconnects after a dropped connection replaces its own stale socket.
  if (source) try { source.close(4000, 'replaced'); } catch {}
  source = ws;
  console.log(`live-mic: source on (${listeners.size} listening)`);
  tellSource();
  const ping = setInterval(() => { try { ws.ping(); } catch {} }, PING_MS);
  ws.on('message', (data, isBinary) => {
    if (!isBinary || ws !== source) return;
    const now = Date.now();
    const m = { seq: ++seq, t: now, buf: data };
    ring.push(m);
    while (ring.length && now - ring[0].t > RING_MS) ring.shift();
    for (const [res, marked] of listeners) send(res, marked, m);
  });
  ws.on('close', () => {
    clearInterval(ping);
    if (ws !== source) return;
    source = null;
    console.log('live-mic: source off');
  });
  ws.on('error', () => {});
}

// The phone's upload. A WebSocket upgrade never reaches Express's middleware, so the auth gate is
// checked here.
function attach(server, authed) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith(PATH_UP) || !authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, takeSource);
  });
}

// GET /api/live-mic — a watch listening. One response held open for as long as it listens.
// `?seq=1` adds the markers; `&after=N` resumes after message N instead of joining at the live edge.
function listen(req, res) {
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const marked = req.query.seq === '1';
  const after = Number(req.query.after);
  const now = Date.now();
  const missed = marked && after > 0 && after <= seq
    ? ring.filter(m => m.seq > after)
    : ring.filter(m => now - m.t <= RECENT_MS);
  for (const m of missed) send(res, marked, m);
  listeners.set(res, marked);
  console.log(`live-mic: listener on (${listeners.size})`);
  tellSource();
  const ka = setInterval(() => { try { res.write(KEEPALIVE); } catch {} }, KEEPALIVE_MS);
  req.on('close', () => {
    clearInterval(ka);
    listeners.delete(res);
    console.log(`live-mic: listener off (${listeners.size})`);
    tellSource();
  });
}

module.exports = { attach, listen };
