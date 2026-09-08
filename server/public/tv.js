// /tv kiosk voice layer. The full hub dashboard is rendered by core.js from /api/stream (same cards as the
// main hub). This module adds ONLY the kiosk's activity popup and its heard-you pop, driven from
// /api/voice-stream (event: voice {kind,row}).
//
// KIOSK ONLY, and the guard is load-bearing rather than tidy: every other surface — the phone wall, the
// Mac app's side panel — boots voiceagent.js, which drives the same popup off the same stream. Running
// both meant the phone held a SECOND EventSource open for the life of the page and fetched settings and
// a thread backfill nothing on it would ever show.
import { KIOSK, liveStream } from './shared.js';
import { activityBar, applyActivitySettings } from './voiceagent.js';

if (KIOSK) initKiosk();

function initKiosk() {
  // The SAME floating .ai-act popup the page view uses: live Listening → Working → each tool call →
  // Done, with the result persisting briefly. Exported from voiceagent so the wall mic buttons drive
  // the one instance.
  const activity = activityBar();

  // Heard-you pop. The UI plays it ITSELF the instant the words land on screen — synced to the paint.
  const popSound = new Audio('/pop.m4a');
  popSound.preload = 'auto';
  const playPop = () => { try { popSound.currentTime = 0; popSound.play().catch(() => {}); } catch (_) {} };

  // (core.js owns /api/stream for the dashboard cards.)
  liveStream('/api/voice-stream', { voice: (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'activity') {
      const a = msg.row || {};
      if (a.state === 'working') playPop();                                          // command's words just landed → pop
      // identical mapping to the page view, escalation included (Sonnet → Opus shows as its own row + chip)
      if (a.state === 'done') activity.done(a.text);
      else if (a.state === 'escalate') activity.escalate(a.text);
      else activity.tool(a.text);
    }
    else if (msg.kind === 'reset') activity.clear();
  } });

  fetch('/api/settings').then((r) => r.json()).then(applyActivitySettings).catch(() => {});
}
