'use strict';
// THE LIVE CHROME RELAY (docs/SESSION-TABS.md § Live Chrome). Two kinds of socket meet here:
//
//   an AGENT — our browser extension, one per machine (the Mac's Chrome, the Pi's Chromium), which
//              attaches to a tab with chrome.debugger and screencasts it;
//   a VIEWER — a phone with a session's Chrome tab open.
//
// Nothing streams unless someone is looking. The first viewer of a tab sends its agent `watch`, the last
// one leaving sends `unwatch`, and the agent attaches and detaches with them — which is also what keeps
// Chrome's "started debugging this browser" bar off the screen whenever nobody is watching.
//
// A FRAME is one binary message, agent → hub → viewer unchanged: a 4-byte big-endian header length, the
// header as JSON (`{ target, w, h }`, w and h the page's size in CSS pixels), then the JPEG. A viewer
// whose socket is backed up is skipped rather than queued: the next frame supersedes this one anyway,
// so a slow phone sees a lower frame rate instead of a growing delay.
//
// A viewer's input is JSON (`{ t: 'tap' | 'wheel' | 'text' | 'key' | 'back' | 'reload', ... }`, positions
// as fractions of the frame), forwarded to the agent as `{ op: 'input', target, ev }`.

const SKIP_BUFFERED = 512 * 1024;
// How long a watched tab may go without its first frame before that is reported. A screencast only sends
// on a paint, so the agent sends one screenshot as soon as it attaches; silence past this means the
// attach or the capture failed without saying so.
const FIRST_FRAME_MS = 15000;

const OPEN = 1;
const sendJson = (ws, m) => { if (ws && ws.readyState === OPEN) try { ws.send(JSON.stringify(m)); } catch (_) {} };

function headerOf(buf) {
  if (!buf || buf.length < 4) return null;
  const n = buf.readUInt32BE(0);
  if (n <= 0 || n > 4096 || buf.length < 4 + n) return null;
  try { return JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch (_) { return null; }
}

/**
 * `rows()` is every OPEN chrome tab row (`{ id, machine, target, conversation }`); `closeTab(machine,
 * target)` ends one whose browser tab is gone; `meta(machine, target, { title, url })` records what it
 * is showing.
 */
function createRelay({ rows, closeTab, meta, timers = { setTimeout, clearTimeout } }) {
  const agents = new Map();    // machine -> ws
  const viewers = new Map();   // row id -> Set<ws>
  const waiting = new Map();   // row id -> first-frame timer

  const rowById = (id) => rows().find((r) => r.id === id) || null;
  const rowOf = (machine, target) => rows().find((r) => r.machine === machine && String(r.target) === String(target)) || null;

  function tabsFor(machine) {
    return rows().filter((r) => r.machine === machine).map((r) => String(r.target));
  }

  function tellViewers(id, m) { for (const v of viewers.get(id) || []) sendJson(v, m); }

  function startWatch(row) {
    const agent = agents.get(row.machine);
    if (!agent) {
      console.error(`[live] a live tab on the ${row.machine} was opened with no browser extension connected there (tab ${row.target})`);
      tellViewers(row.id, { op: 'status', agent: false });
      return;
    }
    sendJson(agent, { op: 'watch', target: String(row.target) });
    tellViewers(row.id, { op: 'status', agent: true });
    timers.clearTimeout(waiting.get(row.id));
    waiting.set(row.id, timers.setTimeout(() => {
      waiting.delete(row.id);
      if (!viewers.get(row.id)?.size) return;
      console.error(`[live] no frame from the ${row.machine}'s browser ${FIRST_FRAME_MS / 1000}s after asking to watch tab ${row.target}`);
      tellViewers(row.id, { op: 'status', agent: true, stalled: true });
    }, FIRST_FRAME_MS));
  }

  function stopWatch(row) {
    timers.clearTimeout(waiting.get(row.id));
    waiting.delete(row.id);
    sendJson(agents.get(row.machine), { op: 'unwatch', target: String(row.target) });
  }

  function addAgent(machine, ws) {
    const old = agents.get(machine);
    if (old && old !== ws) try { old.close(4000, 'replaced'); } catch (_) {}
    agents.set(machine, ws);
    sendJson(ws, { op: 'tabs', targets: tabsFor(machine) });
    for (const [id, set] of viewers) {
      const row = rowById(id);
      if (row && row.machine === machine && set.size) startWatch(row);
    }
  }

  function dropAgent(machine, ws) {
    if (agents.get(machine) !== ws) return;
    agents.delete(machine);
    for (const [id, set] of viewers) {
      const row = rowById(id);
      if (row && row.machine === machine && set.size) tellViewers(id, { op: 'status', agent: false });
    }
  }

  function agentMessage(machine, data, isBinary) {
    if (isBinary) {
      const h = headerOf(data);
      const row = h && rowOf(machine, h.target);
      if (!row) return;
      if (waiting.has(row.id)) { timers.clearTimeout(waiting.get(row.id)); waiting.delete(row.id); }
      for (const v of viewers.get(row.id) || []) {
        if (v.readyState !== OPEN || v.bufferedAmount > SKIP_BUFFERED) continue;
        try { v.send(data, { binary: true }); } catch (_) {}
      }
      return;
    }
    let m;
    try { m = JSON.parse(String(data)); } catch (_) { return; }
    const row = m.target != null ? rowOf(machine, m.target) : null;
    if (m.op === 'gone' && m.target != null) {
      Promise.resolve(closeTab(machine, String(m.target))).catch((e) => console.error(`[live] closing tab ${m.target}: ${e.message || e}`));
    } else if (m.op === 'meta' && row) {
      Promise.resolve(meta(machine, String(m.target), { title: m.title, url: m.url })).catch((e) => console.error(`[live] tab meta: ${e.message || e}`));
      tellViewers(row.id, { op: 'meta', title: m.title, url: m.url });
    } else if (m.op === 'error') {
      // The extension has no reporter of its own; this is how its failures reach the responder.
      console.error(`[live] the ${machine}'s browser extension: ${String(m.message || '').slice(0, 500)}`);
      if (row) tellViewers(row.id, { op: 'status', agent: true, error: String(m.message || '').slice(0, 200) });
    }
  }

  function addViewer(id, ws) {
    const row = rowById(id);
    if (!row) { sendJson(ws, { op: 'closed' }); try { ws.close(4004, 'no such tab'); } catch (_) {} return false; }
    if (!viewers.has(id)) viewers.set(id, new Set());
    const set = viewers.get(id);
    set.add(ws);
    if (set.size === 1) startWatch(row);
    else sendJson(ws, { op: 'status', agent: agents.has(row.machine) });
    return true;
  }

  function dropViewer(id, ws) {
    const set = viewers.get(id);
    if (!set || !set.delete(ws)) return;
    if (set.size) return;
    viewers.delete(id);
    const row = rowById(id);
    if (row) stopWatch(row);
  }

  const INPUTS = new Set(['tap', 'wheel', 'text', 'key', 'back', 'reload']);
  function viewerMessage(id, data) {
    const row = rowById(id);
    if (!row) return;
    let ev;
    try { ev = JSON.parse(String(data)); } catch (_) { return; }
    if (!ev || !INPUTS.has(ev.t)) return;
    sendJson(agents.get(row.machine), { op: 'input', target: String(row.target), ev });
  }

  // The open rows changed: each agent learns its tabs, and viewers of a tab that closed are told so.
  function tabsChanged() {
    for (const [machine, ws] of agents) sendJson(ws, { op: 'tabs', targets: tabsFor(machine) });
    for (const [id, set] of viewers) {
      if (rowById(id)) continue;
      for (const v of set) { sendJson(v, { op: 'closed' }); try { v.close(4004, 'tab closed'); } catch (_) {} }
      viewers.delete(id);
      timers.clearTimeout(waiting.get(id));
      waiting.delete(id);
    }
  }

  const connected = () => [...agents.keys()];
  return { addAgent, dropAgent, agentMessage, addViewer, dropViewer, viewerMessage, tabsChanged, connected };
}

module.exports = { createRelay, headerOf };
