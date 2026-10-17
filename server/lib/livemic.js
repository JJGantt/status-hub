// The live microphone relay: the phone streams its microphone up, every watch listening gets it down.
// docs/LIVE-MIC.md is the whole path.
//
// THE WIRE FORMAT, both directions: a run of packets, each a 2-byte big-endian length and that many
// bytes of one AAC-LC packet (24 kHz mono, 1024 frames). A zero length is a keepalive and carries no
// audio. Every WebSocket message from the phone holds whole packets, so the down stream is just those
// messages written one after another and a listener never has to find a boundary.
//
// In memory only. The hub is one always-on machine, so the phone and every watch meet in this process;
// a second machine would split them, and fly.toml keeping one is what this relies on.
const { WebSocketServer } = require('ws');

const PATH_UP = '/api/live-mic/up';
// What a watch that joins (or rejoins, after the switch to its own LTE) is handed first, so it has
// enough to start playing at once rather than waiting out its own buffer on a live edge.
const RECENT_MS = 2000;
// Fly's proxy closes a connection that has sent nothing for 60s, and a watch's URLSession gives up on
// a stream after 60s of silence. The phone is silent between streams; this keeps both open.
const KEEPALIVE_MS = 15000;
const KEEPALIVE = Buffer.from([0, 0]);

let source = null;            // the phone's socket, while it streams
let recent = [];              // [{ t, buf }] — the last RECENT_MS of messages from it
const listeners = new Set();  // watch responses

function tellSource() {
  if (source) try { source.send(JSON.stringify({ listeners: listeners.size })); } catch {}
}

function takeSource(ws) {
  // Newest wins: a phone that reconnects after a dropped connection replaces its own stale socket.
  if (source) try { source.close(4000, 'replaced'); } catch {}
  source = ws;
  recent = [];
  console.log(`live-mic: source on (${listeners.size} listening)`);
  tellSource();
  const ping = setInterval(() => { try { ws.ping(); } catch {} }, KEEPALIVE_MS);
  ws.on('message', (data, isBinary) => {
    if (!isBinary || ws !== source) return;
    const now = Date.now();
    recent.push({ t: now, buf: data });
    while (recent.length && now - recent[0].t > RECENT_MS) recent.shift();
    for (const res of listeners) res.write(data);
  });
  ws.on('close', () => {
    clearInterval(ping);
    if (ws !== source) return;
    source = null;
    recent = [];
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
function listen(req, res) {
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  for (const { buf } of recent) res.write(buf);
  listeners.add(res);
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
