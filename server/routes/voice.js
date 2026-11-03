'use strict';
const { transcribe, shortenPauses, diarize, clipSeconds, extFor } = require('../lib/transcribe');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const fs = require('fs');
const heicConvert = require('heic-convert');
const { localDate } = require('../lib/dates');
const ops = require('../lib/report');
const { vanishedRecordings, RECORD_EVENTS } = require('../lib/outcomes');
const { FrameReader, endOf } = require('../lib/livestream');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

module.exports = function (ctx) {
  const {
    CLIENT_NOW_RE, GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, VOICE_RESET_SENTINEL,
    dirtySettings, gated, noteRinger, pushVoice, putSetting, sb, sbWrite, settingsAll,
  } = ctx;

  // De-dupe resent sends: the durable outboxes (photos, and every voice clip) re-POST when a screen-lock
  // or a dropped connection killed the ack after the server had already enqueued. A client_msg_id turns
  // that retry into a no-op instead of a duplicate command. In-memory suffices — the hub runs a single
  // instance and the retry window is seconds to minutes; the map is bounded so it can't grow without limit.
  const seenMsgIds = new Map();   // client_msg_id -> the voice_requests id it enqueued (null if none returned)
  function markSeen(msgId, requestId = null) {
    if (!msgId) return;
    seenMsgIds.set(msgId, requestId);
    if (seenMsgIds.size > 1000) seenMsgIds.delete(seenMsgIds.keys().next().value);
  }

  // Where the user was when speaking, if the device sent it: numbers from the watch's or the browser's
  // location fix, and a place name only when the device produced one itself. Nothing here looks a
  // position up, so a command never sends the user's location to a third party. It is stored on the request
  // row, and a trigger there keeps `locations` current (data-layer 00129), which a model reads through
  // `get_location` only when a request depends on where the user is.
  function parseLocation(src) {
    const lat = parseFloat(src && src.lat), lon = parseFloat(src && src.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const acc = parseFloat(src.acc);
    const place = typeof src.place === 'string' ? src.place.trim().slice(0, 160) : '';
    return { lat: +lat.toFixed(5), lon: +lon.toFixed(5),
             ...(Number.isFinite(acc) ? { acc: Math.round(acc) } : {}), ...(place ? { place } : {}) };
  }

  // The recording behind a phone command, kept in the voice-clips bucket for as long as its voice_requests
  // row (pi-desk's sweepRetention deletes both after KEEP_REQUEST_DAYS). Without it a bad transcription
  // leaves nothing to go on: a clip heard as Icelandic can only be understood by listening to it, and the
  // temp file is gone when this handler ends. Runs after the reply and swallows its own failure, so it can
  // neither slow a command down nor fail one.
  const CLIP_BUCKET = 'voice-clips';

  // ---- IS IT THE USER? speaker ID for the devices that UPLOAD a clip -------------------------------------
  // The Mac and the ESP score every utterance against the user's voiceprint before it becomes a command, and
  // the phone and the watch never could: the model (ECAPA) lives in the voice server, and those two hand
  // this a finished file instead of streaming. So an always-on watch sent whatever it heard — on
  // 2026-09-23, eleven minutes of it sent a podcast, a television and a room to the worker, and only the
  // worker's own "didn't catch that" kept any of it from running.
  //
  // The clip goes to the voice server as 16k mono WAV (it reads the bucket with the service key it
  // already has) and comes back as the top-3 cosine against the voiceprint. Below `voice_upload_accept`
  // (see the bar below) it is not enqueued.
  //
  // **A gate that cannot run lets the command through.** A voice server that is down, a missing
  // voiceprint and a clip that will not decode all answer 0, and 0 means "cannot tell": eating the user's
  // commands because a service is unreachable is a worse failure than running a stray one.
  const VOICE_VERIFY_URL = process.env.VOICE_VERIFY_URL || 'https://jared-voice.fly.dev/verify';
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
  // A press is its own proof: someone holding a watch to their mouth has identified themselves, which is
  // why the phone's own button has never been gated either (docs/LISTENERS.md). Only always-on captures
  // are scored. This set is also what stamps `always_on` on the request, which is the only thing the
  // worker reads to decide whether a turn may be dropped as overheard — so it is the one list of which
  // uploaded labels are listeners.
  const GATED_SOURCES = new Set(['watch', 'phone']);

  async function soundsLikeHim(id, file, source) {
    if (!GATED_SOURCES.has(source)) return { ok: true, why: 'not a listener' };
    const wav = `${os.tmpdir()}/verify-${id}.wav`;
    const object = `${CLIP_BUCKET}/verify/${id}.wav`;
    try {
      // 16k mono, which is what ECAPA is fed everywhere else in the pipeline.
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', '16000', wav],
          (e) => (e ? reject(e) : resolve()));
      });
      const put = await fetch(`${SUPABASE_URL}/storage/v1/object/${object}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'audio/wav' },
        body: await fs.openAsBlob(wav, { type: 'audio/wav' }),
      });
      if (!put.ok) throw new Error(`upload -> ${put.status}`);
      // The token rides a header, never the URL, where it would land in the voice server's proxy logs.
      const r = await fetch(`${VOICE_VERIFY_URL}?p=${encodeURIComponent(object)}`, {
        headers: VERIFY_TOKEN ? { 'X-Token': VERIFY_TOKEN } : {}, signal: AbortSignal.timeout(20000) });
      const sim = parseFloat(await r.text());
      // ITS OWN SETTING, not the room mics'. `voiceid_accept_threshold` is the ESP's whole-clip gate and
      // reads 0 (off) today; sharing it would mean a number tuned for an ESP streaming raw audio silently
      // deciding what a watch may say, and a 0 there quietly opening this. Unset here is 0.22; 0 is off.
      const raw = parseFloat((await settingsAll()).voice_upload_accept);
      const bar = Number.isFinite(raw) && raw >= 0 ? raw : 0.22;
      if (bar === 0) return { ok: true, sim, why: 'gate off' };
      if (!Number.isFinite(sim) || sim <= 0) return { ok: true, sim, why: 'could not tell' };
      return { ok: sim >= bar, sim, bar };
    } catch (e) {
      return { ok: true, why: `verify failed: ${e.message || e}` };
    } finally {
      fs.promises.unlink(wav).catch(() => {});
      fetch(`${SUPABASE_URL}/storage/v1/object/${object}`, {
        method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      }).catch((e) => console.error('[voice-verify] clip delete', e.message || e));
    }
  }

  // A damaged capture (see /api/voice-command) keeps about 11% of its recorded time and a sound one over
  // 99%, so half sits far from both. Under a second the device's own timing is too coarse to judge by.
  const CAPTURE_MIN_KEPT = 0.5;
  const CAPTURE_CHECK_MIN_S = 1;
  // Whether the Mac's voice worker is heartbeating — the only host with a local Whisper.
  async function macWorkerUp() {
    try {
      const rows = await sb('worker_presence?worker=eq.mac&select=last_seen,info');
      const r = rows && rows[0];
      return !!r && !(r.info || {}).stopping && Date.now() - Date.parse(r.last_seen) < 90e3;
    } catch { return false; }
  }

  async function keepClip(id, file, contentType, bytes, dur) {
    try {
      const type = contentType.split(';')[0].trim();
      const path = `${id}.${extFor(contentType)}`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${CLIP_BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': type },
        body: await fs.openAsBlob(file, { type }),
      });
      if (!r.ok) throw new Error(`upload -> ${r.status}`);
      await sbWrite(`voice_requests?id=eq.${id}`, 'PATCH',
        { audio: { path, bytes, type, ...(dur > 0 ? { dur: +dur.toFixed(1) } : {}) } });
    } catch (e) { console.error(`[voice-command] could not keep clip ${id}: ${e.message || e}`); }
  }


  // ---- REWIND: a grab from the watch's ring (docs/REWIND.md) -----------------------------------------
  // The watch posts the last N seconds it heard. Every grab is kept whole while the feature is built: the
  // clip in voice-clips under rewind/, and a rewind_grabs row with the words and the timing. Plain Groq
  // Whisper; speaker labels (OpenAI diarize) only with `rewind_diarize` = 1, falling back to Whisper with
  // the failure in the row. Never enqueued — a grab only becomes a command when the user records instructions for it, and
  // that command carries `rewind=<id>` to /api/voice-command.
  const REWIND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  gated.post('/api/rewind', async (req, res) => {
    const tmp = path.join(os.tmpdir(), 'rewind-' + crypto.randomUUID());
    const id = crypto.randomUUID();
    const began = Date.now();
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const { size } = await fs.promises.stat(tmp);
      if (!size) return res.status(400).json({ error: 'no audio' });
      const ct = String(req.headers['content-type'] || 'audio/mp4').split(';')[0].trim();
      const held = parseFloat(req.query.held);
      // Plain Whisper unless `rewind_diarize` is on: the words go to a model either way, which reads who
      // is talking from the conversation itself, and the speaker-labeled pass costs seconds and money.
      let result = null, error = null;
      if (String((await settingsAll()).rewind_diarize || '') === '1') {
        try { result = await diarize(tmp, ct); }
        catch (e) {
          error = String(e.message || e).slice(0, 500);
          console.log(`[rewind] diarize failed, plain Whisper instead: ${error}`);
        }
      }
      if (!result) {
        const { transcript } = await transcribe(tmp, ct, GROQ_API_KEY);
        result = { transcript, segments: null, model: 'whisper' };
      }
      const ms = Date.now() - began;
      const object = `rewind/${id}.${extFor(ct)}`;
      let audio = null;
      try {
        const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${CLIP_BUCKET}/${object}`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': ct },
          body: await fs.openAsBlob(tmp, { type: ct }),
        });
        if (!r.ok) throw new Error(`upload -> ${r.status}`);
        audio = { path: object, bytes: size, type: ct };
      } catch (e) { console.error(`[rewind] could not keep clip ${id}: ${e.message || e}`); }
      await sbWrite('rewind_grabs', 'POST', { id, held_s: Number.isFinite(held) ? held : null, audio, model: result.model,
        transcript: result.transcript, segments: result.segments, error, ms });
      console.log(`[rewind] ${id} ${size} bytes ${Number.isFinite(held) ? held.toFixed(1) + 's ' : ''}${result.model} ` +
        `${(result.segments || []).length} segments ${ms}ms`);
      res.json({ id, transcript: result.transcript, model: result.model });
    } catch (e) {
      res.status(e.status || 500).json({ error: String(e.message || e) });
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  });

  // `about`: the inbox answer a command was spoken from (docs/WATCH.md § The answers inbox). The worker
  // puts that answer and its question on the prompt (voice-pipeline process.py `about_directive`).
  const aboutId = (v) => (/^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : null);

  // What a command recorded for a grab is sent to the model as: the grab's words, framed so the model
  // knows they are overheard audio and that the user's own words are the instructions.
  async function withRewind(rewindId, instructions) {
    const rows = await sb(`rewind_grabs?id=eq.${rewindId}&select=transcript,held_s,model`);
    const g = rows && rows[0];
    if (!g) throw Object.assign(new Error('no such rewind grab'), { status: 404 });
    const secs = g.held_s ? `${Math.round(g.held_s)} seconds` : 'stretch';
    const who = g.model === 'whisper' ? '' : ' Speakers are labeled A, B, … by the transcriber; they are not identified, and one of them may be me.';
    return `[Rewind] Below is a transcription of the last ${secs} of audio my watch overheard.${who} ` +
      `My instructions for what to do with it follow the transcription.\n\nTranscription:\n${g.transcript || '(nothing heard)'}\n\n` +
      `My instructions: ${instructions}`;
  }

  // In-app voice button: the browser/app uploads a recorded clip; we transcribe it with the SAME
  // Groq Whisper the ESP uses, then enqueue into voice_requests exactly like the Jarvis path. The
  // Mac worker claims it and writes the user+assistant turns into voice_messages (focus 'hub') —
  // the one shared conversation shown on the TV wall and in the app.
  //
  // There is NO size or length limit on a command. The body streams to a temp file rather than into
  // memory (a long uncompressed phone clip would not fit in this 256 MB machine), and lib/transcribe.js
  // re-encodes and splits anything too big for Groq. The file is deleted as soon as the request ends.
  gated.post('/api/voice-command', async (req, res) => {
    const tmp = path.join(os.tmpdir(), 'voice-' + crypto.randomUUID());
    let short = null;   // the pause-shortened copy of a locked clip, removed with tmp
    try {
      if (!GROQ_API_KEY && !process.env.OPENAI_API_KEY) { req.resume(); return res.status(503).json({ error: 'transcription not configured' }); }
      // ?dry=1 → transcribe only, no enqueue. The chat composer uses this while photos are pending: the
      // transcript lands in the text box so the user sends text + photos together when they're ready.
      const dry = String(req.query.dry || '') === '1';
      const msgId = String(req.query.client_msg_id || '').slice(0, 64);
      if (!dry && msgId && seenMsgIds.has(msgId)) { req.resume(); return res.json({ enqueued: true, duplicate: true, id: seenMsgIds.get(msgId) }); }
      await pipeline(req, fs.createWriteStream(tmp));
      const { size } = await fs.promises.stat(tmp);
      if (!size) return res.status(400).json({ error: 'no audio' });
      const ct = String(req.headers['content-type'] || 'audio/webm');
      const dur = parseFloat(req.query.dur);
      // A CLIP THAT HOLDS A FRACTION OF WHAT WAS RECORDED IS REFUSED, NOT TRANSCRIBED. The phone's
      // capture can drop most of its frames while still producing a valid file: 36.7s of talking came
      // up as 4.2s of chopped fragments, one frame kept in about nine. Whisper hears that as noise and
      // writes "Thank you." — which would then be enqueued and acted on as the user's command. Only the
      // device knows how long it recorded, so the check needs its `dur`; a clip that keeps well under
      // half of it is damaged (a sound one keeps over 99%). The page resets its microphone on
      // `capture: 'damaged'` — see captureDamaged() in voiceagent.js.
      const heldS = dur >= CAPTURE_CHECK_MIN_S ? await clipSeconds(tmp) : null;
      if (heldS != null && heldS < dur * CAPTURE_MIN_KEPT) {
        console.log(`[voice-command] DAMAGED ${size} bytes ${ct}: holds ${heldS.toFixed(2)}s of ${dur.toFixed(1)}s recorded, refused`);
        return res.json({ transcript: '', enqueued: false, capture: 'damaged', held_s: +heldS.toFixed(2), dur });
      }
      // THE LAST TRANSCRIBER IS THE MAC. When Groq and OpenAI both fail, a command is not lost while the Mac
      // worker is up: the clip is kept and the row is queued 'untranscribed', which the Mac's worker takes,
      // runs through its local Whisper and turns 'pending' (voice-pipeline worker.py `transcribe_local`).
      // A LOCKED watch recording (?flow=locked) is long and full of pauses, so it goes to whisper-large-v3
      // rather than turbo: turbo dropped the first 10s of a 27s locked command on every retry, while large
      // got all of it. ?model=large asks for the same on any clip. Its long pauses are shortened first
      // (shortenPauses), from the stretches the watch's speech classifier marked as `quiet=a-b,…`.
      const locked = String(req.query.flow || '') === 'locked';
      const whisperModel = locked || String(req.query.model || '') === 'large' ? 'whisper-large-v3' : undefined;
      const quiet = String(req.query.quiet || '').split(',').map((r) => r.split('-').map(Number)).filter((r) => r.length === 2);
      // A SECOND OPINION FROM THE OTHER WHISPER, run alongside the first. The two models mishear
      // different words — large-v3 wrote "it's called pair putt" where turbo heard "haircut", and turbo
      // wrote "schedule it to view" where large heard "a to-do" — so neither is the better transcriber,
      // and a word one gets wrong the other usually gets right. When they disagree the worker hands the
      // model both (voice_requests.alt_transcript). Parallel, and Groq answers a command in well under a
      // second either way, so it adds no wait. A dry run's words are typed into a session, which gets
      // only the primary reading.
      const altModel = whisperModel ? 'whisper-large-v3-turbo' : 'whisper-large-v3';
      let transcript = '', segments = 0, untranscribed = false, alt = null;
      try {
        short = locked ? await shortenPauses(tmp, quiet).catch((e) => { console.log(`[voice-command] pause shortening failed: ${e.message}`); return null; }) : null;
        if (short) console.log(`[voice-command] locked clip: ${short.gaps} pause(s) shortened, ${short.cut.toFixed(1)}s cut`);
        const [file, type] = short ? [short.file, 'audio/wav'] : [tmp, ct];
        const second = dry ? null : transcribe(file, type, GROQ_API_KEY, { model: altModel })
          .catch((e) => { console.log(`[voice-command] second transcriber failed: ${e.message || e}`); return null; });
        ({ transcript, segments } = await transcribe(file, type, GROQ_API_KEY, { model: whisperModel }));
        const other = second && (await second);
        const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (other && other.transcript && words(other.transcript) !== words(transcript)) {
          alt = other.transcript;
          console.log(`[voice-command] transcribers disagree: ${JSON.stringify(transcript.slice(0, 120))} vs ${altModel} ${JSON.stringify(alt.slice(0, 120))}`);
        }
      } catch (e) {
        if (!e.allFailed || dry || !(await macWorkerUp())) throw e;
        untranscribed = true;
        console.error('[voice-command] every transcription provider failed; queued for the Mac\'s local Whisper');
      }
      // Bytes per second of speech is what decides whether a clip fits Groq's cap, and it is set by the
      // recording device, not by us — so every clip reports it.
      console.log(`[voice-command] ${size} bytes ${ct}` +
        (dur > 0 ? ` ${dur.toFixed(1)}s ${Math.round(size * 8 / dur / 1000)} kbps` : '') +
        (segments ? ` re-encoded into ${segments} segment(s)` : ''));
      // THE WORDS SAID BEFORE AN INTERRUPTION. The phone pauses a command when a timer, Siri or a call
      // takes the microphone, and the parts recorded before it cannot be joined to this one as audio, so
      // they arrive already transcribed, as this clip's prefix (makeRecorder / deliverVoice in
      // voiceagent.js). The command is one command: prefix, then whatever this clip holds.
      let prefix = '';
      try { prefix = decodeURIComponent(String(req.headers['x-voice-prefix'] || '')).trim().slice(0, 8000); } catch (_) {}
      if (prefix && !untranscribed) {
        transcript = transcript ? `${prefix} ${transcript}` : prefix;
        if (alt) alt = `${prefix} ${alt}`;
      }
      if (!transcript && !untranscribed) return res.json({ transcript: '', enqueued: false });
      if (dry) return res.json({ transcript, enqueued: false });
      // Instructions recorded for a rewind grab: the command the model sees is the grab plus the user's words.
      const rewindId = REWIND_ID.test(String(req.query.rewind || '')) ? String(req.query.rewind) : null;
      if (rewindId && !untranscribed) transcript = await withRewind(rewindId, transcript);
      // The navbar mic sends ?quick=1, which tags the request's source `web-quick`.
      const quick = String(req.query.quick || '') === '1';
      const client_now = CLIENT_NOW_RE.test(String(req.query.client_now || '')) ? String(req.query.client_now) : null;
      const location = parseLocation(req.query);
      // THE CAPTURE WINDOW IS WHAT MAKES A LISTENER A PEER. The worker collapses two mics that heard the
      // same utterance by overlapping [capture_start, capture_end] (_duplicate_of_recent), which is how
      // the Mac and the ESP listen at the same time without running every command twice. Web clips
      // carried neither, so a third always-on device could not take part: its row fell back to
      // arrival-time proximity, and a clip that uploads after it is recorded arrives too late for that
      // to mean anything. Any caller that knows when its utterance began and ended sends both and joins
      // the same collapse — see docs/LISTENERS.md.
      const isoAt = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
      const capture_start = isoAt(req.query.capture_start);
      const capture_end = isoAt(req.query.capture_end);
      // A listener names itself, so a new device is a label rather than a code change here. Unknown or
      // absent falls back to the two the FAB has always used.
      const srcRaw = String(req.query.source || '').trim().toLowerCase();
      const source = /^[a-z0-9][a-z0-9-]{0,23}$/.test(srcRaw) ? srcRaw : (quick ? 'web-quick' : 'web');
      const id = crypto.randomUUID();   // chosen here so the caller can wait on it (/api/voice-reply/:id)
      // An always-on device's clip has to sound like the user before it becomes a command.
      const him = await soundsLikeHim(id, tmp, source);
      console.log(`[voice-command] ${source} voice ${him.ok ? 'accepted' : 'REFUSED'}` +
        (him.sim != null ? ` sim=${him.sim.toFixed(2)}${him.bar ? ` bar=${him.bar}` : ''}` : '') +
        (him.why ? ` (${him.why})` : ''));
      if (!him.ok) return res.json({ transcript, enqueued: false, notHim: true });
      const about = aboutId(req.query.about);
      await sbWrite('voice_requests', 'POST', { id, transcript, source, focus: 'hub', ...(rewindId ? { rewind_id: rewindId } : {}),
        ...(about ? { about_id: about } : {}),
        ...(alt ? { alt_transcript: alt } : {}),
        ...(untranscribed ? { status: 'untranscribed' } : {}),
        always_on: GATED_SOURCES.has(source),
        ...(capture_start ? { capture_start } : {}), ...(capture_end ? { capture_end } : {}),
        ...(client_now ? { client_now } : {}), ...(location ? { location } : {}) });
      markSeen(msgId, id);
      if (untranscribed) {
        // The Mac needs the clip before it can do anything, so it is kept BEFORE the answer here, and the
        // row only becomes claimable for it once `audio` is on it.
        await keepClip(id, tmp, ct, size, dur);
        return res.json({ transcript: '', enqueued: true, id, untranscribed: true });
      }
      res.json({ transcript, enqueued: true, id });
      await keepClip(id, tmp, ct, size, dur);   // before the finally below deletes the temp file
    } catch (e) {
      res.status(e.status || 500).json({ error: String(e.message || e) });
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
      if (short) fs.promises.unlink(short.file).catch(() => {});
    }
  });

  // Photo attachments: the chat composer uploads each image here (raw body, one per request); it lands
  // in the private voice-attachments bucket and the returned flat object name (uuid.ext) rides the
  // voice_request, so whichever worker claims it (Mac/Pi) pulls the bytes down for the model to view.
  // The daily sweep below reaps objects after 7 days — photos exist to make ONE log entry, not to keep.
  const ATT_BUCKET = 'voice-attachments';
  const ATT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  // iOS cameras hand back HEIC/HEIF, which neither browsers (the chat thumbnails) nor Claude's vision API
  // can read. The client normally shrinks to JPEG in-canvas, but a fallback upload (when that canvas can't
  // decode the capture) can still arrive as HEIC — convert it to JPEG here so the pipeline never breaks on format.
  const ATT_HEIC = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
  const attName = (p) => /^[\w.\-]+$/.test(p);   // flat bucket — reject anything path-like
  // Phones report unreliable (sometimes empty) content-types — especially on the shrink-failed fallback
  // that uploads the raw camera file — so identify the real format from the file's own magic bytes and
  // ignore the header. HEIC/HEIF is then converted to JPEG (browsers + the vision API can't read it).
  function sniffImageType(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {   // ISO-BMFF 'ftyp' box → HEIC/HEIF family
      const brand = b.toString('latin1', 8, 12);
      if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'].includes(brand)) return 'image/heic';
    }
    return null;
  }
  gated.post('/api/attach', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
    try {
      if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
      let body = req.body;
      let ct = sniffImageType(body) || String(req.headers['content-type'] || '').split(';')[0].trim();
      if (ATT_HEIC.has(ct)) {
        try {
          body = Buffer.from(await heicConvert({ buffer: req.body, format: 'JPEG', quality: 0.85 }));
          ct = 'image/jpeg';
        } catch (e) { return res.status(415).json({ error: 'could not read HEIC image' }); }
      }
      const ext = ATT_TYPES[ct];
      if (!ext) return res.status(415).json({ error: `unsupported image type (${ct || 'unknown'}, ${body.length}b)` });
      const name = `${crypto.randomUUID()}.${ext}`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATT_BUCKET}/${name}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': ct },
        body,
      });
      if (!r.ok) return res.status(502).json({ error: `storage upload failed (${r.status})` });
      res.json({ path: name });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Gesture captures from the watch's gesture page (apps/Watch/GestureLab.swift): raw motion around one
  // gesture, labelled, for designing gestures of our own. One JSON object per capture in the private
  // gesture-captures bucket, under its day. Kept indefinitely: the recordings are the training set.
  const GESTURE_BUCKET = 'gesture-captures';
  const gestureName = (p) => /^\d{4}-\d{2}-\d{2}\/[\w.\-]+\.json$/.test(p);
  gated.post('/api/gestures', express.json({ limit: '8mb' }), async (req, res) => {
    try {
      const b = req.body || {};
      if (!Array.isArray(b.samples) || !b.samples.length) return res.status(400).json({ error: 'no samples' });
      const label = String(b.label || 'none').replace(/[^\w\-]/g, '').slice(0, 24) || 'none';
      const at = new Date(b.started_at || Date.now());
      const name = `${localDate(at)}/${at.toISOString().replace(/[:.]/g, '-')}-${label}.json`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${GESTURE_BUCKET}/${name}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...b, label, received_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        console.error('[gestures] storage upload failed', r.status, await r.text().catch(() => ''));
        return res.status(502).json({ error: `storage upload failed (${r.status})` });
      }
      res.json({ path: name });
    } catch (e) {
      console.error('[gestures] upload', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  // Newest first. `?day=YYYY-MM-DD` lists that day; without it, today and the six days before.
  gated.get('/api/gestures', async (req, res) => {
    try {
      const days = req.query.day ? [String(req.query.day)]
        : Array.from({ length: 7 }, (_, i) => localDate(new Date(Date.now() - i * 86400000)));
      const out = [];
      for (const day of days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'bad day' });
        const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${GESTURE_BUCKET}`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: day, limit: 1000, sortBy: { column: 'name', order: 'desc' } }),
        });
        if (!r.ok) throw new Error(`storage list failed (${r.status})`);
        for (const o of await r.json()) if (o.id) out.push({ path: `${day}/${o.name}`, bytes: o.metadata?.size ?? null });
      }
      res.json({ captures: out });
    } catch (e) {
      console.error('[gestures] list', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  gated.get(/^\/api\/gestures\/(.+)$/, async (req, res) => {
    const name = req.params[0];
    if (!gestureName(name)) return res.status(400).json({ error: 'bad path' });
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${GESTURE_BUCKET}/${name}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!r.ok) return res.status(r.status === 400 || r.status === 404 ? 404 : 502).json({ error: `storage read failed (${r.status})` });
      res.type('application/json').send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error('[gestures] read', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Client error sink: the phone POSTs a failed quick-photo's real reason here (step, file type/size,
  // server error) so a failure that's otherwise invisible in the phone's console lands in the app log.

  // THE WATCH'S AND THE PHONE'S LINES ARE KEPT (client_log, 14 days). The console alone holds about an
  // hour, which is not long enough to trace a command lost on the wrist once the user mentions it. The TV's
  // alarm heartbeats and the watch's per-frame lines stay console-only: they are once a minute, or once
  // per tool call, and say nothing a step of a command does not.
  const CLIENT_LOG_SOURCES = new Set(['watch', 'phone']);
  const CLIENT_LOG_SKIP = new Set(['frame', 'geo', 'alarmclock', 'tvring']);
  // A client may send one line, or a batch as `{ lines: [...] }`: the watch keeps its lines until they
  // are acknowledged and sends what piled up while it was offline all at once. A kept batch is answered
  // only once it is stored, so a failed write leaves the lines on the watch to be sent again.
  gated.post('/api/clientlog', express.json({ limit: '256kb' }), async (req, res) => {
    const b = req.body || {};
    const lines = Array.isArray(b.lines) ? b.lines.filter((l) => l && typeof l === 'object') : [b];
    const keep = [];
    for (const l of lines) {
      try { console.log('[clientlog]', JSON.stringify(l).slice(0, 900)); } catch (_) {}
      if (l.ev === 'alarmclock' || l.ev === 'tvring') noteRinger(l, req);
      // A client's own error, sent by the page's global handler (public/shared.js) or by an app, is
      // reported as that client's, not the hub's.
      if (l.ev === 'error') {
        ops.report(String(l.msg || 'client error'), { machine: 'client', service: `${l.src || 'unknown'}${l.page ? `:${l.page}` : ''}`,
          stack: l.stack ? String(l.stack) : undefined, context: { ua: req.headers['user-agent'] } });
      }
      if (CLIENT_LOG_SOURCES.has(l.src) && l.ev && !CLIENT_LOG_SKIP.has(l.ev)) {
        const { src, ev, t, ...data } = l;
        const at = Date.parse(t);
        // Every row names its time (a batch insert needs the same keys in every row): the device's own
        // clock when it sent one, which is when it happened rather than when it got here.
        keep.push({ src, ev: String(ev).slice(0, 40), data, at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString() });
      }
    }
    if (keep.length) {
      try { await sbWrite('client_log', 'POST', keep); }
      catch (e) { console.error('[clientlog] not kept:', e.message || e); return res.status(502).end(); }
      checkRecordings(keep).catch((e) => console.error('[clientlog] recording check failed:', e.message || e));
    }
    res.status(204).end();
  });

  // A watch recording that never ended (lib/outcomes.js) is found at the NEXT record-start, the first
  // moment the device says anything after it, and reported as an error so the ops responder investigates.
  // Only a vanished start whose successor is in this batch is reported, so each is reported once.
  async function checkRecordings(rows) {
    const starts = rows.filter((r) => r.src === 'watch' && r.ev === 'record-start').map((r) => r.at).sort();
    if (!starts.length) return;
    const from = new Date(Date.parse(starts[0]) - 6 * 3600e3).toISOString();
    const to = rows.reduce((m, r) => (r.at > m ? r.at : m), starts[0]);
    const events = await sb(`client_log?src=eq.watch&ev=in.(${RECORD_EVENTS.join(',')})`
      + `&at=gte.${encodeURIComponent(from)}&at=lte.${encodeURIComponent(to)}&select=ev,at,data&order=at.asc,id.asc`);
    const mine = new Set(starts.map((t) => Date.parse(t)));
    for (const v of vanishedRecordings(events)) {
      if (!mine.has(Date.parse(v.next))) continue;
      const start = events.find((e) => e.ev === 'record-start' && e.at === v.at);
      ops.report(`watch recording started at ${v.at} never ended: no record-stop, record-cancel or mic-failed before the next record-start at ${v.next}; the clip was not sent`,
        { machine: 'client', service: 'watch', context: { started: v.at, next: v.next, start: start && start.data,
          look: 'client_log where src=watch between those two times (docs/WATCH.md § The wrist can drop mid-recording)' } });
    }
  }

  // ---- A RECORDING STREAMED WHILE IT RECORDS (lib/livestream.js) ------------------------------------------
  // The watch opens this for every command and follow-up the moment its microphone opens, and keeps it
  // open until the recording ends, saying how it ended (E or C) before closing it. A connection that
  // drops mid-audio without that is a recording that died with the app, found the moment it happens: it
  // is reported, and the audio up to that second is kept and transcribed, so what was said is not lost
  // with it. The finished clip still arrives the ordinary way (/api/voice-command); this stream is only
  // the part that survives the app.
  const LIVE_ID = /^[0-9A-Fa-f-]{36}$/;
  const LIVE_MAX_BYTES = 16 << 20;
  gated.post('/api/voice-live', (req, res) => {
    const id = String(req.query.id || '');
    if (!LIVE_ID.test(id)) { req.resume(); return res.status(400).json({ error: 'id required' }); }
    const meta = { id, view: String(req.query.view || '').slice(0, 16), flow: String(req.query.flow || '').slice(0, 16) };
    const reader = new FrameReader();
    const audio = [];
    let bytes = 0, last = null, paused = false, lastByteAt = Date.now(), complete = false, settled = false;
    const startedAt = Date.now();
    req.on('data', (chunk) => {
      lastByteAt = Date.now();
      for (const f of reader.push(chunk)) {
        if (f.type === 'A') { if (bytes + f.data.length <= LIVE_MAX_BYTES) { audio.push(Buffer.from(f.data)); bytes += f.data.length; } }
        else { last = f.type; paused = f.type === 'P' ? true : f.type === 'R' ? false : paused; }
      }
    });
    req.on('end', () => { complete = true; if (!res.headersSent) res.status(204).end(); });
    const settle = () => {
      if (settled) return;
      settled = true;
      const verdict = endOf({ complete, last, paused, gapMs: Date.now() - lastByteAt });
      const seconds = (Date.now() - startedAt) / 1000;
      console.log(`[voice-live] ${id} ${verdict}: ${seconds.toFixed(1)}s open, ${bytes} audio bytes, last ${last || '-'}, `
        + `${Date.now() - lastByteAt}ms from the last byte to the close${reader.bad ? `, ${reader.bad}` : ''}`);
      if (verdict === 'lost' || verdict === 'unmarked') {
        lostRecording(meta, verdict, Buffer.concat(audio), seconds)
          .catch((e) => console.error(`[voice-live] ${id} could not handle a ${verdict} recording: ${e.message || e}`));
      }
    };
    // 'close' fires for a finished body and for a dropped connection alike; `complete` tells them apart.
    req.on('close', settle);
  });

  async function lostRecording(meta, verdict, audio, seconds) {
    // Marks the recording ended in the watch's own log, so the next-start check (lib/outcomes.js) does
    // not report the same loss a second time when the user next records.
    await sbWrite('client_log', 'POST', [{ src: 'watch', ev: 'record-lost', at: new Date().toISOString(),
      data: { live: meta.id, verdict, seconds: +seconds.toFixed(1), bytes: audio.length } }]);
    let words = '', kept = null;
    if (audio.length) {
      const raw = path.join(os.tmpdir(), `live-${meta.id}.aac`);
      const m4a = path.join(os.tmpdir(), `live-${meta.id}.m4a`);
      try {
        await fs.promises.writeFile(raw, audio);
        await new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-y', '-f', 'aac', '-i', raw, '-c', 'copy', m4a],
          (e) => (e ? reject(e) : resolve())));
        const object = `lost/${meta.id}.m4a`;
        const put = await fetch(`${SUPABASE_URL}/storage/v1/object/${CLIP_BUCKET}/${object}`, {
          method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'audio/mp4' },
          body: await fs.openAsBlob(m4a, { type: 'audio/mp4' }) });
        if (put.ok) kept = `${CLIP_BUCKET}/${object}`;
        else console.error(`[voice-live] ${meta.id} clip not kept: upload -> ${put.status}`);
        words = (await transcribe(m4a, 'audio/mp4', GROQ_API_KEY, { model: meta.flow === 'locked' ? 'whisper-large-v3' : undefined })).transcript || '';
      } catch (e) {
        console.error(`[voice-live] ${meta.id} audio not recovered: ${e.message || e}`);
      } finally {
        fs.promises.unlink(raw).catch(() => {});
        fs.promises.unlink(m4a).catch(() => {});
      }
    }
    const how = verdict === 'lost' ? 'the connection dropped while audio was still arriving'
      : 'the stream closed without the recording saying it had ended or been cancelled, which is what the app being killed looks like';
    ops.report(`watch recording lost after ${seconds.toFixed(1)}s (${meta.view || 'chat'}${meta.flow ? `, ${meta.flow}` : ''}): ${how}; `
      + (words ? `it had heard: "${words.slice(0, 300)}"` : 'no words recovered'),
      { machine: 'client', service: 'watch', context: { live: meta.id, verdict, seconds, audio_bytes: audio.length, kept, words,
        look: 'hub log [voice-live], and client_log where src=watch around now (docs/WATCH.md § The wrist can drop mid-recording)' } });
  }

  async function sweepClientLog() {
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    try { await sbWrite(`client_log?at=lt.${cutoff}`, 'DELETE'); }
    catch (e) { console.error('client_log sweep failed:', e.message || e); }
  }
  setInterval(sweepClientLog, 24 * 3600 * 1000);
  sweepClientLog();

  // Thumbnails for the chat thread — proxies the private bucket behind the hub auth gate.
  gated.get('/api/attachment', async (req, res) => {
    try {
      const name = String(req.query.path || '');
      if (!attName(name)) return res.status(400).json({ error: 'bad path' });
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATT_BUCKET}/${name}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!r.ok) return res.status(404).end();
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');   // object content never changes
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  async function sweepAttachments() {
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${ATT_BUCKET}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'created_at', order: 'asc' } }),
      });
      if (!r.ok) return;
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      const old = (await r.json()).filter((o) => o.name && Date.parse(o.created_at) < cutoff).map((o) => o.name);
      if (!old.length) return;
      await fetch(`${SUPABASE_URL}/storage/v1/object/${ATT_BUCKET}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: old }),
      });
      console.log(`attachment sweep: deleted ${old.length} object(s) older than 7 days`);
    } catch (e) { console.error('attachment sweep failed:', e.message || e); }
  }
  setInterval(sweepAttachments, 24 * 3600 * 1000);
  sweepAttachments();

  // Typed command from the Jarvis card — no audio, just enqueue the text like the voice path.
  // Photo attachments (object names from /api/attach) ride along; a photo-only send (no text) is valid —
  // the worker's framing directive tells the model the intent is to log what the photos show.
  // A client_msg_id de-dupes a resent send (see seenMsgIds above /api/voice-command).
  // `shared: true` is the iOS share extension (apps/Share): the request is stamped source 'share', which
  // tells the worker the pictures are something the user wants looked at, not a meal to log.
  gated.post('/api/voice-text', express.json(), async (req, res) => {
    try {
      const text = String((req.body && req.body.text) || '').trim();
      const attachments = Array.isArray(req.body && req.body.attachments)
        ? req.body.attachments.map(String).filter(attName).slice(0, 12) : [];
      if (!text && !attachments.length) return res.status(400).json({ error: 'empty' });
      const msgId = String((req.body && req.body.client_msg_id) || '').slice(0, 64);
      if (msgId && seenMsgIds.has(msgId)) return res.json({ enqueued: true, duplicate: true, id: seenMsgIds.get(msgId) });
      const client_now = CLIENT_NOW_RE.test(String((req.body && req.body.client_now) || '')) ? String(req.body.client_now) : null;
      const location = parseLocation(req.body && req.body.location);
      const id = crypto.randomUUID();   // chosen here so the caller can wait on it (/api/voice-reply/:id)
      const source = req.body && req.body.shared === true ? 'share' : 'web';
      const about = aboutId(req.body && req.body.about);
      await sbWrite('voice_requests', 'POST', { id, transcript: text, source, focus: 'hub', ...(about ? { about_id: about } : {}),
        ...(attachments.length ? { attachments } : {}), ...(client_now ? { client_now } : {}),
        ...(location ? { location } : {}) });
      markSeen(msgId, id);
      res.json({ enqueued: true, id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Wait for one command to finish: held open until voice_requests row :id is done or error, then
  // answered with its outcome. The watch uploads its clip to /api/voice-command and waits here rather
  // than polling. Settled by the voice_requests realtime subscription; the read on entry covers a row that
  // finished before the wait began, and the waiter is registered BEFORE that read so a finish landing
  // between the two cannot be missed. A wait that runs out answers `pending` and the client asks
  // again — REPLY_WAIT_MS is only a bound on one HTTP request, kept under Fly's proxy idle timeout.
  const REPLY_WAIT_MS = 25000;
  const replyWaiters = new Map();   // request id -> Set of settle fns
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function settleReply(row) {
    if (!row || (row.status !== 'done' && row.status !== 'error')) return;
    const waiting = replyWaiters.get(row.id);
    if (waiting) for (const settle of [...waiting]) settle(row);
  }
  gated.get('/api/voice-reply/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
    let waiting = replyWaiters.get(id);
    if (!waiting) replyWaiters.set(id, (waiting = new Set()));
    let over = false;
    const finish = (send) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      waiting.delete(settle);
      if (!waiting.size && replyWaiters.get(id) === waiting) replyWaiters.delete(id);
      send();
    };
    const settle = (row) => finish(() => res.json({ status: row.status, result: row.result ?? null, error: row.error ?? null }));
    waiting.add(settle);
    const timer = setTimeout(() => finish(() => res.json({ status: 'pending' })), REPLY_WAIT_MS);
    req.on('close', () => finish(() => {}));
    try {
      const rows = await sb(`voice_requests?id=eq.${id}&select=id,status,result,error`);
      if (!rows || !rows.length) return finish(() => res.status(404).json({ error: 'no such request' }));
      settleReply(rows[0]);
    } catch (e) {
      finish(() => res.status(500).json({ error: String(e.message || e) }));
    }
  });

  // Reset the shared hub conversation: record where the old context ends (voice_reset_at), tell every live
  // surface, and enqueue a sentinel so the worker drops its resumed Claude session — the next command
  // starts with fresh context. The thread itself is kept: the conversation card shows older contexts behind
  // a divider, and every other surface starts its view at the reset.
  gated.post('/api/voice-reset', async (req, res) => {
    try {
      await putSetting('voice_reset_at', new Date().toISOString());
      dirtySettings();
      pushVoice('reset', null);
      await sbWrite('voice_requests', 'POST', { transcript: VOICE_RESET_SENTINEL, source: 'web', focus: 'hub' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Low-latency activity push from the Mac worker: transient "what Jarvis is doing right now" events
  // (each tool call + args, and a done marker) relayed straight to the SSE clients, bypassing the
  // Supabase-realtime hop so the on-screen activity bar tracks the run in real time. Not persisted.
  // Live session activity, pushed by the orchestrator on BOTH machines the moment a transcript grows.
  // The same shape as /api/voice-activity and for the same reason: the machine running the work knows
  // what it is doing, so it says so, rather than the hub asking on a timer. The orchestrator writes
  // `last_reply` to Supabase separately, for durability, off this path; what is stored from here is the
  // finished turn's ordered list (`storeTurn`).
  //
  //   state 'tool'  — a tool call, `text` is its one-line description
  //   state 'text'  — what the session said between tool calls, never its final reply
  //   state 'done'  — the turn finished, `text` is the reply (truncated for the row it lands on) and
  //                   `at` its reply_at; it is also pushed to the phone (notifySessionReply)
  //   state 'replay' — the part of a turn this hub asked a host to say again (`logFrame`)
  // THE CURRENT TURN'S STEPS, kept so a view opened mid-turn shows the turn so far. The frames are only
  // streamed, so a session opened in the middle of a long turn showed its last finished reply and nothing
  // of what it had done since, until the next tool call. In memory, per session row, cleared by the turn's
  // `done` and capped; a hub restart loses them, which costs only the steps before it.
  // A prompt carries two things that were never meant for a human to read, and every surface that shows
  // "the user's words" verbatim (the watch, the phone thread, the TV) has to have them out before the user sees them:
  //
  // - The bracketed location line voice-dispatched prompts used to carry ("[Where Jared was when he
  //   asked: lat, lon (within about N m)]"). Nothing appends it now; it is in turns already stored.
  // - The format instruction older watch builds appended to a follow-up while replies were spoken:
  //   "[This reply is read aloud. …]". Nothing sends it now; it is in turns already stored.
  //   Either bracket can be the last one, so both are peeled off the end until neither matches.
  // - The stub a message too long for a tty is typed as instead of itself (`orchestrator/src/
  //   applescript.js` `handoff`), naming the file the real words are parked in. It is meant to be
  //   resolved back to those words before anything is stored (`transcripts.js` `resolvePrompt`) — this
  //   is a backstop for the rare case that resolution did not happen (the file was swept, or the read
  //   raced it), since the alternative is showing the user an internal instruction to go read a file.
  const FOR_THE_AGENT = [
    /\s*\[Where Jared was when he asked: [^\]]*\]\s*$/,
    /\s*\[This reply is read aloud\.[^\]]*\]\s*$/,
    // Speak mode's note (SPEAK_NOTE). resolvePrompt strips it upstream; this is the backstop.
    /\s*<speak-mode>[\s\S]*?<\/speak-mode>\s*$/,
  ];
  // Both wordings the stub has had (orchestrator/src/handoff.js): stored turns keep the older one.
  const UNRESOLVED_STASH = /^\[(?:Jared's message is in \S+?\. |A message from Jared, too long to type into this terminal\. It is in \S+).*\]\s*$/s;
  function cleanSaid(text) {
    let s = String(text || '');
    if (UNRESOLVED_STASH.test(s.trim())) return '';
    for (let peeled = true; peeled;) {
      const before = s;
      for (const re of FOR_THE_AGENT) s = s.replace(re, '');
      peeled = s !== before;
    }
    return s;
  }

  return { cleanSaid, markSeen, seenMsgIds, settleReply };
};
