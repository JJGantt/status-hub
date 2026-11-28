// THE MAC'S SCREEN, LIVE (docs/SCREEN.md): the whole display streamed over WebRTC from the Mac's
// screenshare helper, with his touches sent back on a data channel as clicks, scrolls and keys. In the
// phone app it lives in a session TAB (cards/repos.js): on demand from the session bar, and in place of
// the screenshot tap screen when a session hands over a Mac screen (`handoff`), whose Done and Cancel then
// end the handoff as the tap screen's do.
//
// Gestures: a tap clicks there; a long press right-clicks; one finger pans the picture (or, in Drag mode,
// drags on the Mac); two fingers pinch to zoom, or scroll the Mac when they move together without
// spreading. The text box sends each character as it is typed.

import { noteWake, reportPageOccurrence } from './shared.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** How long to wait for the picture before falling back (a handoff) or offering Retry. */
const CONNECT_MS = 25_000;

// `mount`: the pane to draw into. `handoff`: {id, focus} when it stands in for a Mac handoff. `onEnd`:
// called once it is over (closed, or the handoff ended). `onFail`: called instead of offering Retry when
// no picture came (the handoff falls back to screenshots). Returns `close`.
export function openScreen({ mount, session = null, handoff = null, onEnd = null, onFail = null }) {
  const ov = h('div', 'ho ho-inline scr');
  const stage = h('div', 'ho-stage');
  const wrap = h('div', 'ho-wrap');
  const video = h('video', 'scr-video');
  Object.assign(video, { autoplay: true, muted: true, playsInline: true });
  video.setAttribute('playsinline', '');
  const mark = h('div', 'ho-mark');
  wrap.append(video, mark); stage.append(wrap);
  const veil = h('div', 'scr-veil');
  const spin = h('div', 'scr-spin');
  const retry = h('button', 'ho-btn scr-retry', 'Retry');
  veil.append(spin, retry); stage.append(veil);
  const bar = h('div', 'ho-bar');
  const btn = (label, fn, cls = '') => { const b = h('button', `ho-btn ${cls}`, label); b.type = 'button'; b.onclick = fn; return b; };
  const sugg = h('div', 'ho-row ho-sugg'); sugg.hidden = true;
  const keys = h('div', 'ho-row scr-keys');
  const row1 = h('div', 'ho-row');
  const row2 = h('div', 'ho-row');
  const state = h('div', 'ho-state scr-state');
  const input = h('input', 'ho-input');
  Object.assign(input, { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'Type' });
  input.setAttribute('autocorrect', 'off');
  bar.append(sugg, keys, row1, row2, state);
  ov.append(stage, bar);
  mount.append(ov);

  let alive = true, pc = null, dc = null, shareId = null, askedAt = 0, firstAt = 0, timer = null, ended = false, frozen = 0, replaced = false;
  let disp = { w: 0, h: 0 };          // the Mac display in points, from the helper
  let cmd = false, dragMode = false;

  // ---- the picture: scale s and offset (tx, ty) of the video's own pixels within the stage ----------
  let s = 1, tx = 0, ty = 0, W = 0, H = 0, unframed = true;
  // THE PICTURE NEVER LEAVES THE STAGE. A one-finger drag pans it, and nothing else brings it back in a
  // handoff, so an unbounded pan (a stray drag with something in the other hand) leaves him a black box
  // over a share that is still live. Larger than the stage, its edges stop at the stage's edges; smaller,
  // it stays wholly inside.
  const bound = () => {
    if (!W || !stage.clientWidth || !stage.clientHeight) return;
    const pw = W * s, ph = H * s, sw = stage.clientWidth, sh = stage.clientHeight;
    tx = pw <= sw ? Math.min(Math.max(tx, 0), sw - pw) : Math.min(Math.max(tx, sw - pw), 0);
    ty = ph <= sh ? Math.min(Math.max(ty, 0), sh - ph) : Math.min(Math.max(ty, sh - ph), 0);
  };
  const apply = () => {
    bound();
    wrap.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    mark.style.transform = `translate(-50%,-50%) scale(${1 / s})`;
  };
  const fitScale = () => Math.min(stage.clientWidth / W, stage.clientHeight / H);
  const clampScale = (v) => Math.min(Math.max(v, fitScale() * 0.8), 6);
  function fit() {
    unframed = !W || !stage.clientWidth || !stage.clientHeight;
    if (unframed) return;
    const f = (handoff && handoff.focus) || { x: 0, y: 0, w: 1, h: 1 };
    const fw = f.w * W, fh = f.h * H;
    s = Math.min(stage.clientWidth / fw, stage.clientHeight / fh);
    tx = (stage.clientWidth - fw * s) / 2 - f.x * W * s;
    ty = (stage.clientHeight - fh * s) / 2 - f.y * H * s;
    apply();
  }
  video.addEventListener('resize', () => {
    const fresh = !W;
    W = video.videoWidth; H = video.videoHeight;
    wrap.style.width = `${W}px`; wrap.style.height = `${H}px`;
    if (fresh) fit();
  });
  // A video started while its pane was hidden (a handoff tab mounted behind the conversation) keeps decoding
  // frames on iOS but draws them BLACK once shown. So whenever the stage goes from no size to a size, the
  // stream is re-attached and played again.
  let sized = false;
  new ResizeObserver(() => {
    const now = stage.clientWidth > 0 && stage.clientHeight > 0;
    if (now && !sized && video.srcObject) { const m = video.srcObject; video.srcObject = null; video.srcObject = m; play('shown'); }
    sized = now;
    if (unframed) fit();
  }).observe(stage);
  function play(why) {
    video.play().catch((e) => console.error(`[screen] the live picture would not play (${why}): ${e.message || e}`));
  }

  // A BLACK PICTURE IS NEVER ALL HE SEES. Frames can arrive and be drawn black (above, or anything else that
  // breaks the picture without breaking the stream), which every other check here reads as working. So a
  // frame is sampled every 2 s, and a picture that has stayed black for BLACK_MS while visible falls back
  // to the screenshot tap screen (onFail), as a share that never connected does.
  const BLACK_MS = 6000;
  const probe = document.createElement('canvas'); probe.width = 16; probe.height = 10;
  let blackSince = 0;
  const blackCheck = setInterval(() => {
    if (!alive || !firstAt || !sized || video.readyState < 2) { blackSince = 0; return; }
    let black;
    try {
      const g = probe.getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0, 16, 10);
      const d = g.getImageData(0, 0, 16, 10).data;
      black = true;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 10 || d[i + 1] > 10 || d[i + 2] > 10) { black = false; break; }
    } catch (_) { return; }   // a frame that cannot be read says nothing either way
    if (!black) { blackSince = 0; blackTries = 0; return; }
    blackSince ||= Date.now();
    if (Date.now() - blackSince < BLACK_MS) return;
    blackSince = 0;
    // The video is the mode: a black picture is answered with a fresh share first, and only a fresh share
    // that is black too falls back to the screenshot tap screen, as the net under it.
    if (blackTries++ < 1) {
      console.error(`[screen] the live picture stayed black for ${BLACK_MS / 1000}s while frames arrived; reconnecting`);
      teardown('black'); ended = false; connect();
      return;
    }
    console.error(`[screen] the live picture was black again after reconnecting${onFail ? '; showing the screenshot instead' : ''}`);
    clearInterval(blackCheck);
    if (onFail) { close(); onFail(); } else { lost('black picture'); }
  }, 2000);
  let blackTries = 0;

  // A point on the stage as fractions of the Mac's display, or null off the picture.
  const at = (cx, cy) => {
    if (!W) return null;
    const r = stage.getBoundingClientRect();
    const x = (cx - r.left - tx) / (s * W), y = (cy - r.top - ty) / (s * H);
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  };
  const send = (m) => { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(m)); };
  const showMark = (p) => {
    mark.style.left = `${p.x * 100}%`; mark.style.top = `${p.y * 100}%`;
    mark.classList.remove('on'); void mark.offsetWidth; mark.classList.add('on');
  };

  // ---- touches -----------------------------------------------------------------------------------
  const pts = new Map();
  let tapAt = null, press = null, two = null, dragging = false, scrollAcc = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(press);
    if (pts.size === 1) {
      tapAt = { x: e.clientX, y: e.clientY, t: Date.now() };
      press = setTimeout(() => {   // held still: a right click
        const p = tapAt && at(tapAt.x, tapAt.y);
        if (p) { showMark(p); send({ t: 'click', ...p, button: 'right' }); }
        tapAt = null;
      }, 550);
    } else { tapAt = null; endDrag(e); startTwo(); }
  });
  function startTwo() {
    const [a, b] = [...pts.values()];
    two = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, tx, ty, mode: null, lx: (a.x + b.x) / 2, ly: (a.y + b.y) / 2 };
  }
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    const p = at(e.clientX, e.clientY) || {};
    send({ t: 'up', x: p.x ?? 0, y: p.y ?? 0 });
  }
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size >= 2 && two) {
      const [a, b] = [...pts.values()];
      const r = stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // Decided once per gesture: fingers spreading or closing zoom the picture, fingers moving together
      // scroll the Mac.
      if (!two.mode) {
        const spread = Math.abs(d - two.d), moved = Math.hypot(mx - two.mx, my - two.my);
        if (spread > 14) two.mode = 'zoom';
        else if (moved > 12) two.mode = 'scroll';
      }
      if (two.mode === 'zoom') {
        s = clampScale(two.s * d / two.d);
        const px = (two.mx - r.left - two.tx) / two.s, py = (two.my - r.top - two.ty) / two.s;
        tx = mx - r.left - px * s; ty = my - r.top - py * s;
        apply();
      } else if (two.mode === 'scroll' && W && disp.w) {
        // Finger distance on the phone, in the Mac's points, sent once a frame.
        const k = disp.w / (s * W);
        if (!scrollAcc) {
          scrollAcc = { dx: 0, dy: 0, at: at(mx, my) };
          requestAnimationFrame(() => {
            const a = scrollAcc; scrollAcc = null;
            if (a && (a.dx || a.dy)) send({ t: 'scroll', ...(a.at || {}), dx: Math.round(a.dx), dy: Math.round(a.dy) });
          });
        }
        scrollAcc.dx += (mx - two.lx) * k; scrollAcc.dy += (my - two.ly) * k;
      }
      two.lx = mx; two.ly = my;
    } else if (pts.size === 1) {
      if (tapAt && Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) > 8) {
        clearTimeout(press);
        if (dragMode) {
          const q = at(tapAt.x, tapAt.y);
          if (q) { dragging = true; send({ t: 'down', ...q }); }
        }
        tapAt = null;
      }
      if (tapAt) return;
      if (dragging) { const q = at(e.clientX, e.clientY); if (q) send({ t: 'move', ...q }); }
      else { tx += dx; ty += dy; apply(); }
    }
  });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    clearTimeout(press);
    if (pts.size < 2) two = null;
    if (e.type === 'pointerup' && pts.size === 0 && tapAt) {
      const p = at(e.clientX, e.clientY);
      if (p) { showMark(p); send({ t: 'click', ...p }); }
    }
    if (pts.size === 0) { tapAt = null; endDrag(e); }
  };
  stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('wheel', (e) => {   // a browser: the wheel scrolls the Mac, ctrl-wheel zooms
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey) {
      const px = (e.clientX - r.left - tx) / s, py = (e.clientY - r.top - ty) / s;
      s = clampScale(s * Math.exp(-e.deltaY / 200));
      tx = e.clientX - r.left - px * s; ty = e.clientY - r.top - py * s;
      apply();
    } else send({ t: 'scroll', ...(at(e.clientX, e.clientY) || {}), dx: Math.round(-e.deltaX), dy: Math.round(-e.deltaY) });
  }, { passive: false });

  // ---- keys --------------------------------------------------------------------------------------
  const cmdBtn = btn('⌘', () => { cmd = !cmd; cmdBtn.classList.toggle('on', cmd); });
  const key = (k) => { send({ t: 'key', k, ...(cmd ? { mods: ['cmd'] } : {}) }); if (cmd) { cmd = false; cmdBtn.classList.remove('on'); } };
  keys.append(cmdBtn, btn('Esc', () => key('escape')), btn('Tab', () => key('tab')), btn('⌫', () => key('backspace')),
    btn('←', () => key('left')), btn('↑', () => key('up')), btn('↓', () => key('down')), btn('→', () => key('right')),
    btn('⏎', () => key('enter')));
  // Each character goes as it is typed, and the box is reset behind it, so it never holds what he typed.
  // It is reset to ONE INVISIBLE CHARACTER, not to empty: iOS sends nothing at all for the delete key in
  // an empty box, so an empty box is a backspace that never reaches the Mac. With the character there, a
  // delete always has something to remove, and removing it is the backspace.
  const ZW = '\u200b';
  const reset = () => { input.value = ZW; try { input.setSelectionRange(1, 1); } catch (_) {} };
  input.addEventListener('focus', reset);
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'deleteContentBackward') { e.preventDefault(); key('backspace'); reset(); return; }
    if (e.inputType === 'insertLineBreak') { e.preventDefault(); key('enter'); return; }
  });
  input.addEventListener('input', () => {
    const v = input.value;
    reset();
    if (!v) { key('backspace'); return; }       // the invisible character itself was deleted
    const typed = v.split(ZW).join('');
    if (!typed) return;
    if (cmd && typed.length === 1) key(typed);
    else send({ t: 'text', s: typed });
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); key('enter'); } });
  const dragBtn = btn('Drag', () => { dragMode = !dragMode; dragBtn.classList.toggle('on', dragMode); });
  row1.append(input, dragBtn);
  if (handoff) {
    row2.append(btn('Fit', fit), btn('Cancel', () => handoffAct('cancel')), btn('Done', () => handoffAct('done'), 'ho-done'));
  } else {
    row2.append(btn('Fit', fit), btn('Close', () => { close(); if (onEnd) onEnd(); }));
  }

  // ---- the connection ----------------------------------------------------------------------------
  function setState(text) { state.textContent = text; }
  function waiting(on) { veil.classList.toggle('on', on); retry.hidden = true; }

  async function connect() {
    teardown('reconnect');
    waiting(true);
    setState('');
    askedAt = Date.now(); firstAt = 0; ended = false;
    try {
      const ice = await (await fetch('/api/screen/ice')).json();
      pc = new RTCPeerConnection({ iceServers: ice.iceServers || [] });
      const tr = pc.addTransceiver('video', { direction: 'recvonly' });
      // H.264 first: the phone decodes it in hardware, and the Mac encodes it in hardware.
      if (tr.setCodecPreferences && window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
        const cs = RTCRtpReceiver.getCapabilities('video').codecs;
        const isH = (c) => /h264/i.test(c.mimeType);
        tr.setCodecPreferences([...cs.filter(isH), ...cs.filter((c) => !isH(c))]);
      }
      dc = pc.createDataChannel('input', { ordered: true });
      dc.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.t === 'display') disp = { w: m.w, h: m.h }; } catch (_) {} };
      pc.ontrack = (e) => { video.srcObject = new MediaStream([e.track]); play('track'); };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        const st = pc.connectionState;
        if (st === 'failed') lost('failed');
        else if (st === 'connected') describe();
      };
      const mine = pc;
      await pc.setLocalDescription(await pc.createOffer());
      // No trickle: the offer goes once. It waits for the relay candidate (one round trip to the TURN
      // server) and no longer: what is still gathering after it (TCP relays, other interfaces) is not
      // worth holding the offer for. At most 2 s, with whatever there is.
      await new Promise((ok) => {
        if (mine.iceGatheringState === 'complete') return ok();
        mine.addEventListener('icegatheringstatechange', () => mine.iceGatheringState === 'complete' && ok());
        mine.addEventListener('icecandidate', (e) => { if (e.candidate && / typ relay/.test(e.candidate.candidate)) setTimeout(ok, 150); });
        setTimeout(ok, 2000);
      });
      if (mine !== pc) return;
      const r = await fetch('/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: pc.localDescription.sdp, session, handoff: handoff ? handoff.id : null }) });
      if (!r.ok) throw new Error(`start ${r.status}`);
      shareId = (await r.json()).id;
      // A timer that fires well past its time means iOS froze the page (it stays `visible`, so nothing
      // else says so): the viewer was not running, so the share could not connect. That is the phone, not
      // the share, and it is counted rather than raised.
      const due = Date.now() + CONNECT_MS;
      timer = setTimeout(() => {
        if (firstAt) return;
        const late = Date.now() - due;
        if (late > 2000) { noteWake(late); frozen = late; }
        lost('no picture');
      }, CONNECT_MS);
      const id = shareId;
      // Held until the Mac answers; asked again only if a request ends with no answer yet.
      while (alive && id === shareId) {
        const v = await (await fetch(`/api/screen/${id}?wait=20`)).json();
        if (v.answer) { await pc.setRemoteDescription({ type: 'answer', sdp: v.answer }); break; }
        // `stopped`: the screen agent ended it on purpose, for a newer share from this same device.
        if (v.status === 'ended' && v.ended_reason === 'stopped') { frozen = 0; replaced = true; lost('replaced'); return; }
        if (v.status === 'failed' || v.status === 'ended') { lost(v.error || v.status); return; }
        if (Date.now() - askedAt > CONNECT_MS) return;
      }
    } catch (e) {
      console.error(`[screen] could not connect: ${e.message || e}`);
      lost(String(e.message || e));
    }
  }

  // The first frame on glass, and from then on the frame rate, counted off the frames themselves.
  let fpsN = 0, fpsAt = 0, path = '';
  const onFrame = () => {
    if (!alive) return;
    const now = performance.now();
    if (!firstAt) {
      firstAt = Date.now(); clearTimeout(timer); waiting(false);
      fpsAt = now; drops = 0;
    }
    fpsN++;
    if (now - fpsAt >= 1000) { setState(`${path}${path ? ' · ' : ''}${Math.round(fpsN * 1000 / (now - fpsAt))} fps`); fpsN = 0; fpsAt = now; }
    video.requestVideoFrameCallback(onFrame);
  };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else video.addEventListener('playing', () => { if (!firstAt) { firstAt = Date.now(); clearTimeout(timer); waiting(false); } });

  async function describe() {
    try {
      const st = await pc.getStats();
      st.forEach((x) => {
        if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') {
          const l = st.get(x.localCandidateId), r = st.get(x.remoteCandidateId);
          path = [l && l.candidateType, r && r.candidateType].includes('relay') ? 'relay' : 'direct';
        }
      });
    } catch (_) {}
  }

  // The phone's receiving counters, once, at the end: they are cumulative, so one read is the whole share.
  // `frozen_ms`: how long iOS held this page frozen while it stayed visible. The Mac sees that as a dead
  // peer and ends the share `failed`; it reads this to count that end rather than raise it (data-layer
  // screenAgent.ts), since this page has already counted the freeze.
  async function report(id, why, froze) {
    if (!pc || !id) return;
    const out = { why, first_picture_ms: firstAt ? firstAt - askedAt : null, secs: Math.round((Date.now() - askedAt) / 1000),
      frozen_ms: froze > 0 ? froze : null };
    try {
      const st = await pc.getStats();
      st.forEach((x) => {
        if (x.type === 'inbound-rtp' && x.kind === 'video') {
          Object.assign(out, { frames: x.framesDecoded, dropped: x.framesDropped, bytes: x.bytesReceived, w: x.frameWidth, h: x.frameHeight,
            jitter_buffer_ms: x.jitterBufferEmittedCount ? Math.round(1000 * x.jitterBufferDelay / x.jitterBufferEmittedCount) : null,
            decode_ms: x.framesDecoded ? Math.round(1000 * x.totalDecodeTime / x.framesDecoded) : null,
            freezes: x.freezeCount, decoder: x.decoderImplementation, packets_lost: x.packetsLost });
          const c = x.codecId && st.get(x.codecId);
          if (c) out.codec = c.mimeType;
        }
        if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') {
          out.rtt_ms = x.currentRoundTripTime != null ? Math.round(x.currentRoundTripTime * 1000) : null;
          const l = st.get(x.localCandidateId), r = st.get(x.remoteCandidateId);
          out.path = `${l && l.candidateType}/${r && r.candidateType}`;
        }
      });
      if (out.frames && out.secs) { out.fps = +(out.frames / out.secs).toFixed(1); out.kbps = Math.round(out.bytes * 8 / out.secs / 1000); }
    } catch (_) {}
    fetch(`/api/screen/${id}/stats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) }).catch(() => {});
  }

  function teardown(why, froze) {
    clearTimeout(timer);
    const id = shareId; shareId = null;
    if (pc) {
      if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify({ t: 'bye' })); } catch (_) {} }
      const p = pc;
      report(id, why, froze).finally(() => { try { p.close(); } catch (_) {} });
    }
    pc = null; dc = null; path = '';
  }

  function lost(why) {
    if (!alive || ended) return;
    ended = true;
    if (!firstAt && replaced) reportPageOccurrence('[screen] no picture from the Mac: replaced by a newer share from this device');
    else if (!firstAt && frozen) reportPageOccurrence(`[screen] no picture from the Mac: the page was frozen ${Math.round(frozen / 1000)}s`);
    else if (!firstAt) console.error(`[screen] no picture from the Mac: ${why}`);
    const froze = frozen;
    frozen = 0; replaced = false;
    teardown(why, froze);
    if (onFail && !firstAt) { close(); onFail(); return; }
    // A share that was showing and dropped (the Mac's agent restarted, the network blinked) comes back by
    // itself: a few attempts a few seconds apart, and only then the Retry button.
    if (firstAt && drops < 3) {
      drops++;
      setState(why);
      waiting(true);
      setTimeout(() => { if (alive && ended) { ended = false; connect(); } }, 1500 * drops);
      return;
    }
    veil.classList.add('on'); retry.hidden = false;
    setState(why);
  }
  let drops = 0;
  retry.onclick = () => connect();

  // Into the background: iOS freezes the page without a pagehide, so the Mac would see a dead peer and end
  // the share `failed`. The share is ended with `bye` here instead. Back from the background: a connection
  // that is gone comes back without being asked.
  const onVis = () => {
    if (!alive || !ov.isConnected) return;
    if (document.visibilityState === 'hidden') { if (pc) teardown('hidden'); return; }
    if (document.visibilityState !== 'visible') return;
    if (!pc || ['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { ended = false; connect(); }
  };
  document.addEventListener('visibilitychange', onVis);
  // A reload (a deploy's safeReload) or the app closing tears the page down without Close: the Mac is told
  // the viewer has gone, so its helper ends the share as `bye` instead of waiting out a dead connection.
  const onHide = (e) => { if (e.persisted) return; if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify({ t: 'bye' })); } catch (_) {} } };
  addEventListener('pagehide', onHide);

  // ---- a handoff it stands in for --------------------------------------------------------------
  // Values the session knows he will type (his email, a card number): one tap types it on the Mac, where
  // the cursor is. The same `suggest` the screenshot tap screen shows (handoff.js).
  let suggested = '';
  function paintSuggest(list) {
    const k = JSON.stringify(list);
    if (k === suggested) return;
    suggested = k;
    sugg.replaceChildren(...list.map((o) => btn(o.label, () => send({ t: 'text', s: o.text }), 'ho-chip')));
    sugg.hidden = !list.length;
  }
  async function handoffAct(kind) {
    try {
      const r = await fetch(`/api/handoffs/${handoff.id}/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
      if (!r.ok) setState(`error ${r.status}`);
    } catch (e) { setState(String(e.message || e)); }
  }
  if (handoff) (async () => {
    // Followed with held requests, as the tap screen does, so Done on the watch ends this too.
    let after = -1;
    while (alive) {
      try {
        const r = await fetch(`/api/handoffs/${handoff.id}?after=${after}&wait=${after < 0 ? 0 : 40}`);
        if (!r.ok) return;
        const v = await r.json();
        after = v.seq;
        paintSuggest(v.suggest || []);
        if (!['new', 'open'].includes(v.status)) {
          setState(v.status === 'done' ? 'Done' : v.status === 'cancelled' ? 'Cancelled' : `Failed: ${v.error || ''}`);
          setTimeout(() => { close(); if (onEnd) onEnd(); }, 1200);
          return;
        }
      } catch (_) {
        await new Promise((ok) => (navigator.onLine ? setTimeout(ok, 2000) : addEventListener('online', ok, { once: true })));
      }
    }
  })();

  function close() {
    if (!alive) return;
    alive = false;
    clearInterval(blackCheck);
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pagehide', onHide);
    teardown('closed');
    ov.remove();
  }
  connect();
  return close;
}
