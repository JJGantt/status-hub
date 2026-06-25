// Phone "wall mode": the /tv dashboard is tuned for a 1920×1080 wall (fixed grid, 100vh everywhere). On a
// small (phone) viewport we keep that exact layout but render it at a fixed 1920×1080 and CSS-scale the whole
// shell to fit the screen, so the phone shows a faithful miniature of the wall. Plus an exit back to the
// full-detail hub and a push-to-talk button. No-op on the real wall (≥1400px wide), so the Pi kiosk is untouched.
import { makeRecorder } from './voiceagent.js';
const PHONE = window.innerWidth < 1400;
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
      if (vw > vh) {
        const logicalH = 1080, logicalW = Math.round(logicalH * vw / vh), s = vh / logicalH;
        shell.style.width = logicalW + 'px'; shell.style.height = logicalH + 'px';
        shell.style.transform = `scale(${s})`; shell.style.left = '0px'; shell.style.top = '0px';
      } else {
        const s = Math.min(vw / 1920, vh / 1080);
        shell.style.width = '1920px'; shell.style.height = '1080px';
        shell.style.transform = `scale(${s})`;
        shell.style.left = Math.round((vw - 1920 * s) / 2) + 'px';
        shell.style.top = Math.round((vh - 1080 * s) / 2) + 'px';
      }
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 250));

    const ex = document.createElement('button');
    ex.className = 'wallexit'; ex.textContent = '✕';
    ex.title = 'Exit wall mode'; ex.setAttribute('aria-label', 'Exit wall mode');
    ex.onclick = () => { location.href = '/'; };
    document.body.appendChild(ex);

    // Push-to-talk: hold to speak, release to send — through the same pipeline as the hub mic. The reply
    // streams back into the wall's own voice column (tv.js). Independent of always-on (manual mic).
    const ptt = document.createElement('button');
    ptt.className = 'wallptt'; ptt.type = 'button'; ptt.setAttribute('aria-label', 'Push to talk');
    ptt.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>';
    document.body.appendChild(ptt);
    const rec = makeRecorder({
      onStatus: () => {},                              // reply surfaces in the voice column; no overlay needed
      onActive: (a) => ptt.classList.toggle('rec', a),
      quick: true, autoStop: false, tier: 'fast',      // PTT controls start/stop manually (hold), terse reply
    });
    const down = (e) => { e.preventDefault(); rec.start(); };
    const up = (e) => { e.preventDefault(); rec.stop(); };
    ptt.addEventListener('pointerdown', down);
    ptt.addEventListener('pointerup', up);
    ptt.addEventListener('pointerleave', up);
    ptt.addEventListener('pointercancel', up);
  }
}
