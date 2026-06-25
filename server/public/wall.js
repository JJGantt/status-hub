// Phone "wall mode": the /tv dashboard is tuned for a 1920×1080 wall (fixed grid, 100vh everywhere). On a
// small (phone) viewport we keep that exact layout but render it at a fixed 1920×1080 and CSS-scale the whole
// shell to fit the screen, so the phone shows a faithful miniature of the wall. Plus an exit back to the
// full-detail hub and a control rail. No-op on the real wall (≥1400px wide), so the Pi kiosk is untouched.
import { makeRecorder } from './voiceagent.js';
import { open as openSettings } from './settings.js';
const PHONE = window.innerWidth < 1400;
const RAIL = 72;   // landscape: width (px) of the right-side control rail beside the dashboard
const BAR = 58;    // portrait: height (px) of the horizontal control bar along the bottom
if (PHONE) {
  const shell = document.querySelector('.tv-shell');
  if (shell) {
    document.body.classList.add('phonewall');
    // Fit the wall to the phone. In LANDSCAPE (the intended use) match the logical canvas to the phone's
    // actual aspect ratio — height pinned to the 1080 design reference, width grown to the phone's ratio — so
    // the flexible dashboard columns FILL the screen width: no letterbox, no distortion. In portrait, fall
    // back to letterboxing the fixed 16:9 (the 540px voice column would otherwise overflow a narrow canvas).
    const fit = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const portrait = vh >= vw;
      document.body.classList.toggle('wallportrait', portrait);  // portrait reflows to a condensed vertical stack (CSS)
      // Fit a fixed logical canvas to the available area (controls live outside it). Landscape: full height,
      // reserve the rail on the RIGHT. Portrait: full width, reserve the control bar along the BOTTOM.
      let logicalW, logicalH, s;
      if (portrait) { logicalW = 1080; s = vw / logicalW; logicalH = Math.round((vh - BAR) / s); }
      else { const availW = vw - RAIL; logicalH = 1080; s = vh / logicalH; logicalW = Math.round(availW / s); }
      shell.style.width = logicalW + 'px'; shell.style.height = logicalH + 'px';
      shell.style.transform = `scale(${s})`; shell.style.left = '0px'; shell.style.top = '0px';
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 250));

    // Right-side control rail (out of the dashboard's way). Top: exit. Bottom group mirrors the hub FAB —
    // sparkle (fast/efficiency → Haiku) + brain (full Opus thinking), both TAP-to-talk with VAD auto-send
    // (hold-to-talk doesn't work in a web view) — plus a gear that opens the settings panel. Replies stream
    // into the wall's own voice column (tv.js).
    const SPARKLE = '<svg viewBox="0 0 24 24" width="25" height="25" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 1c.6 5.7 4.3 9.4 10 10-5.7.6-9.4 4.3-10 10-.6-5.7-4.3-9.4-10-10 5.7-.6 9.4-4.3 10-10Z"/></svg>';
    const BRAIN = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path>' +
      '<path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path></svg>';
    const GEAR = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path></svg>';

    const rail = document.createElement('div'); rail.className = 'wallrail';
    const ex = document.createElement('button');
    ex.className = 'wallexit'; ex.textContent = '✕'; ex.type = 'button';
    ex.title = 'Exit wall mode'; ex.setAttribute('aria-label', 'Exit wall mode');
    ex.onclick = () => { location.href = '/'; };

    const mkVoice = (cls, svg, tier, label) => {
      const b = document.createElement('button');
      b.className = 'wfab ' + cls; b.type = 'button'; b.setAttribute('aria-label', label);
      b.innerHTML = svg;
      const rec = makeRecorder({ onStatus: () => {}, onActive: (a) => b.classList.toggle('rec', a),
        quick: true, autoStop: true, tier });          // tap to talk; VAD auto-sends on a trailing silence
      b.addEventListener('click', () => rec.toggle());
      return b;
    };
    const fast = mkVoice('wfab-fast', SPARKLE, 'fast', 'Quick voice command (efficiency)');
    const power = mkVoice('wfab-power', BRAIN, 'power', 'Voice command (full Opus thinking)');
    const gear = document.createElement('button');
    gear.className = 'wallgear'; gear.type = 'button'; gear.setAttribute('aria-label', 'Settings');
    gear.innerHTML = GEAR;
    gear.addEventListener('click', () => openSettings());

    // Left cluster: settings + exit (switch back out of wall view). Right cluster: brain + sparkle (sparkle outermost).
    const left = document.createElement('div'); left.className = 'wallrail-grp wallrail-left';
    left.appendChild(gear); left.appendChild(ex);
    const right = document.createElement('div'); right.className = 'wallrail-grp wallrail-right';
    right.appendChild(power); right.appendChild(fast);
    rail.appendChild(left); rail.appendChild(right);
    document.body.appendChild(rail);
  }
}
