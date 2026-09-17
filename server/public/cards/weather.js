// Rain-chance card — the next seven days as an hours x days grid, beside the surf plots it shares a
// card with. Both halves describe the same week, in the same grammar: days across, hours up.
//
// Data: NWS gridpoint for the house -> lib/weather.js -> the status frame. The grid, the palette,
// the drawn window and the week's peak are all decided there; this file only paints.
//
// It carries no labels. The day letters went the way the surf grids' did — the leftmost column is
// today by definition and the rest are counted off from it — and the sky icons went with them: the
// grid answers "will it rain, when, how likely" at hourly resolution, where an icon answers the same
// question once a day in one glyph. In this climate that glyph was a thunderstorm six days out of
// seven, so it discriminated nothing the colour did not already say.
import { state } from '../shared.js';

const EMPTY = '#0b0f13';   // no claim from the forecast, and the ramp's own zero

// The one number on the block: the highest chance in the drawn window, under the column it belongs
// to. A row of seven numbers read as a single long integer at couch distance — one number reads as a
// number, and every other cell is judged against it by colour. The scale it anchors is absolute (see
// lib/weather.js), so this says how far up the ramp the week reaches, not what full brightness means.
// A length or a number off the block, in px, falling back to the default when the surface says
// nothing. Same mechanism cards/surf.js uses for its plot heights: the server ships one grid and
// every surface draws the part of it that suits the box it has.
function cssNum(name, dflt) {
  const el = document.getElementById('weather');
  if (!el) return dflt;
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(v) ? v : dflt;
}

function paint(cv, W, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // The DRAWN window, which a surface can narrow or shift: `pop` carries all 24 hours, and
  // `W.window` is only the one the server took its peak over. The phone's home page draws 6am to
  // midnight in a block forty pixels tall, where the server's 5am-to-10pm put an hour under two
  // pixels and the grid read as a smear of horizontal bands.
  const H0 = cssNum('--wx-h0', W.window[0]);
  const H1 = cssNum('--wx-h1', W.window[1]);
  const cols = W.cols.length;
  const cw = w / cols, ch = h / (H1 - H0);
  const Y = (hr) => h - (hr - H0) * ch;

  for (let c = 0; c < cols; c++) {
    for (let hr = H0; hr < H1; hr++) {
      const ch36 = W.pop[c * 24 + hr];
      g.fillStyle = ch36 === '.' ? EMPTY : (W.colors[parseInt(ch36, 36)] || EMPTY);
      g.fillRect(c * cw, Y(hr + 1), Math.ceil(cw) + .5, Math.ceil(ch) + .5);
    }
  }

  // Same ink rule as the surf grids beside it: BLACK is fixed structure, WHITE is live. The week
  // break at Saturday -> Sunday, then noon carrying the hour axis, then now.
  g.strokeStyle = '#000'; g.lineWidth = 1;
  W.cols.forEach((date, c) => {
    if (c === 0 || new Date(date + 'T12:00:00').getDay()) return;
    g.beginPath(); g.moveTo(c * cw, 0); g.lineTo(c * cw, h); g.stroke();
  });
  // The hour axis. Three graded lines on a block tall enough to tell them apart; ONE where there is
  // not, because three marks two pixels apart say less than one does — `--wx-guide` names the hour
  // it should be. Whichever it is, `now` is drawn over it and is the only solid white on the block.
  const one = cssNum('--wx-guide', 0);
  const guides = one ? [[one, .7]] : [[6, .35], [12, .7], [18, .35]];
  for (const [hr, alpha] of guides) {
    if (hr <= H0 || hr >= H1) continue;
    g.strokeStyle = `rgba(255,255,255,${alpha})`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Y(hr)); g.lineTo(w, Y(hr)); g.stroke();
  }
  const now = new Date();
  const nowCol = W.cols.indexOf(now.toLocaleDateString('en-CA'));
  if (nowCol >= 0) {
    const x = (nowCol + .5) * cw;
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    const hNow = now.getHours() + now.getMinutes() / 60;
    if (hNow > H0 && hNow < H1) {
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x - cw * .45, Y(hNow)); g.lineTo(x + cw * .45, Y(hNow)); g.stroke();
    }
  }
}

export function render(s) {
  const W = s && s.weather;
  const el = document.getElementById('weather');
  if (!el) return;                       // surfaces without a weather block
  if (!W || !W.cols) { el.innerHTML = ''; return; }

  const peak = W.peak;
  el.innerHTML =
    '<div class=wx-grid><canvas id=wxgrid></canvas></div>' +
    '<div class=wx-peak>' + W.cols.map((d, i) =>
      '<span>' + (peak && i === peak.col ? peak.v : '') + '</span>').join('') + '</div>';

  // The grid takes the block minus the number under it, measured rather than assumed: this block is
  // a flex child on the wall and a full-width one on the phone, and a canvas with no CSS size is
  // 300x150 wherever it lands.
  const box = el.querySelector('.wx-grid');
  const w = box.clientWidth, h = box.clientHeight;
  if (w > 0 && h > 0) paint(el.querySelector('#wxgrid'), W, w, h);
}

// Repaint on resize for the same reason the plot next door does: the canvas is sized in device
// pixels from a box that changes when the wall is scaled into the phone's swipe pane.
addEventListener('resize', () => render(state.last), { passive: true });
