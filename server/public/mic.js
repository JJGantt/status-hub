// Home-screen "Voice" web-clip: one big button that runs the SAME recorder + pipeline as the hub's
// bottom-right voice FAB. Tap → listen (VAD auto-stops) → transcribe → enqueue. Shows the transcribed
// command + a "Sent" confirmation, then resets. The reply itself runs on the hub (and is spoken if
// speak-replies is on); this page is purely a fast launcher.
import { makeRecorder, bindTap } from './voiceagent.js';

const btn = document.getElementById('micbtn');
const statusEl = document.getElementById('status');
const echoEl = document.getElementById('echo');
let resetTimer = null;

function setStatus(t, err) { statusEl.textContent = t; statusEl.classList.toggle('err', !!err); }
function scheduleReset() {
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { setStatus('Tap to talk'); echoEl.textContent = ''; }, 4000);
}

const rec = makeRecorder({
  quick: true, autoStop: true,
  onState: (s) => { btn.classList.toggle('rec', s === 'rec'); btn.classList.toggle('armed', s === 'armed'); },
  onStatus: (t, kind) => {
    clearTimeout(resetTimer);
    if (kind === 'rec') { setStatus(t || 'Listening…'); echoEl.textContent = ''; }
    else if (kind === 'prompt') { echoEl.textContent = t; }              // the transcribed command
    else if (kind === 'busy') {
      if (t === 'Thinking…') { setStatus('✓ Sent'); scheduleReset(); }   // enqueued — the hub runs it
      else setStatus(t || 'Working…');                                    // e.g. Transcribing…
    } else if (kind === 'err') { setStatus(t || 'Try again', true); scheduleReset(); }
    else if (kind === 'clear') { setStatus('Tap to talk'); echoEl.textContent = ''; }
  },
});

bindTap(btn, () => rec.toggle());
// tapping anywhere on the empty page also toggles, so you don't have to hit the circle exactly.
document.body.addEventListener('pointerdown', (e) => { if (e.target === document.body) rec.toggle(); });
