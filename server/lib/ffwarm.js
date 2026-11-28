'use strict';
// Runs ffmpeg once at start, the way a live voice command uses it (an ADTS AAC remuxed into mp4), so the
// first real command does not pay for loading it. On a freshly started machine the first ffmpeg run takes
// ~6 s against ~85 ms after, and a watch command's live audio waits on exactly that run (routes/voice.js
// liveAudio). The hub restarts on every deploy, so without this the first command after each one is slow.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (args) => new Promise((resolve, reject) => execFile('ffmpeg', args, (e, _o, err) => (e ? reject(new Error(String(err || e.message).trim().slice(0, 300))) : resolve())));

async function warmFfmpeg() {
  const base = path.join(os.tmpdir(), `ffwarm-${process.pid}`);
  const t0 = Date.now();
  try {
    await run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.5', '-c:a', 'aac', '-f', 'adts', `${base}.aac`]);
    await run(['-v', 'error', '-y', '-f', 'aac', '-i', `${base}.aac`, '-c', 'copy', '-f', 'mp4', `${base}.mp4`]);
    console.log(`[ffwarm] ffmpeg warmed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[ffwarm] ffmpeg could not run at start: ${e.message}`);
  } finally {
    for (const f of [`${base}.aac`, `${base}.mp4`]) fs.promises.unlink(f).catch(() => {});
  }
}

module.exports = { warmFfmpeg };
