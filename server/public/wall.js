// Phone "wall mode": the /tv dashboard is tuned for a 1920×1080 wall (fixed grid, 100vh everywhere). On a
// small (phone) viewport we keep that exact layout but render the shell at a fixed logical size and CSS-scale
// it to fit, reserving BAR px at the bottom for the shared navbar (navbar.js, mounted by core.js). No-op on
// the real wall (≥1400px wide), so the Pi kiosk is untouched.
const PHONE = window.innerWidth < 1400;
const BAR = 58;   // height (px) reserved at the bottom for the shared control bar

if (PHONE) {
  const shell = document.querySelector('.tv-shell');
  if (shell) {
    document.body.classList.add('phonewall');
    // Fit a fixed logical canvas into the area above the bottom bar, full width. Landscape: height pinned to
    // 1080. Portrait: width pinned to 1080, height grows tall. Portrait reflows via CSS (body.wallportrait).
    const fit = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const portrait = vh >= vw;
      document.body.classList.toggle('wallportrait', portrait);
      let logicalW, logicalH, s;
      if (portrait) { logicalW = 1080; s = vw / logicalW; logicalH = Math.round((vh - BAR) / s); }
      else { logicalH = 1080; s = (vh - BAR) / logicalH; logicalW = Math.round(vw / s); }
      shell.style.width = logicalW + 'px'; shell.style.height = logicalH + 'px';
      shell.style.transform = `scale(${s})`; shell.style.left = '0px'; shell.style.top = '0px';
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 250));
  }
}
