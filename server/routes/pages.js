'use strict';
const BODY_SVG = require('../lib/bodymap');
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const { gated } = ctx;

  // Dashboard HTML, read once from disk with the muscle-map SVG injected at the placeholder.
  const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace('<!--BODY_SVG-->', BODY_SVG);
  // THE DEFAULT WALL — the home wall, at `/` and `/tv`. The aggregate: the shared frame (status strip,
  // rings, health bar, footer, voice column) around today's day column, the three heat maps, and the
  // newest session's last answer. `tv-home.js` + `tv-home.css` are its own; every other card on it is
  // one core.js already paints.
  // Injects the body-map SVG like the health wall does. It is ONE 72x93 figure here too; cards/muscle.js
  // splits it into the stacked front/back pair itself (tvStackFigures) on any wall, so this wall only has
  // to give it a column to be thin in.
  // Injects the body map like the health wall does: this wall runs it as a thin column beside its two
  // heat maps. It is ONE 72x93 figure here too — cards/muscle.js splits it into the stacked front/back
  // pair itself, so the wall only has to give it a column to be thin in.
  const TV_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'tv-home.html'), 'utf8')
    .replace('<!--BODY_SVG-->', BODY_SVG);
  // THE PHONE'S HOME PAGE, at `/`. Everything the home wall carries, in portrait and at the phone's
  // own scale — no scaled canvas, so a size in phone-home.css is the size it is read at. It is a file
  // rather than a portrait mode on the home wall because the two want different sizes for the same
  // facts; what they share is the CARDS, which is most of it.
  // Injects the body-map SVG like the walls do: cards/muscle.js splits the one 72x93 figure into the
  // front/back pair itself, and this page runs them side by side.
  const PHONE_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'phone-home.html'), 'utf8')
    .replace('<!--BODY_SVG-->', BODY_SVG);
  // THE HEALTH WALL, at /tv-health. What used to be the default: nutrition, the muscle map and volume
  // bars, the workout heatmap, each with the detail panel its heatmap fills. Too much to glance at,
  // which is why the home wall took `/` from it, and still the only place all of it is on one screen.
  // Injects the body-map SVG at its placeholder — this is the wall with the muscle map.
  const TV_HEALTH_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'tv-health.html'), 'utf8')
    .replace('<!--BODY_SVG-->', BODY_SVG);
  // THE SESSIONS WALL, at /tv-session-focus — always-on, no interaction, stripped down around the
  // sessions list so it reads from across a room and eventually from a watch.
  //
  // Every wall is a separate FILE rather than a mode flag, so work on one cannot disturb another. They
  // share their scripts until something has to diverge, and whatever diverges gets split at that point.
  const TV_FOCUS_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'tv-session-focus.html'), 'utf8')
    .replace('<!--BODY_SVG-->', BODY_SVG);
  // THE TV SIDEBAR, at /tv-sidebar — the focused session, narrow and see-through, which the bedroom TV's
  // companion app overlays on whatever is playing (google-tv repo). Not a wall: nothing navigates it.
  const TV_SIDEBAR_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'tv-sidebar.html'), 'utf8');
  // Minimal home-screen "Voice" launcher (Add to Home Screen → standalone fullscreen tap-to-talk button).
  const MIC_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'mic.html'), 'utf8');
  // THE CALENDAR, twice. /calendar is the phone/desktop page — standalone like mic.html, navbar,
  // tappable days. /tv-calendar is THE CALENDAR WALL: the shared frame (status strip, rings, health
  // bar, footer, voice column) with the freed middle holding a day timeline + month grid(s), so
  // wallmode.js can put it on the TV when wall_mode says 'calendar'.
  const ALARM_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'alarm.html'), 'utf8');
  const CAL_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'calendar.html'), 'utf8');
  const SURF_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'surf.html'), 'utf8');
  const TV_CAL_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'tv-calendar.html'), 'utf8');

  // `/` AND `/tv` ARE NOT THE SAME PAGE, and this is the one thing to know before changing either.
  //
  // `/tv` is the TV — the Pi's kiosk loads it, and it serves whichever wall is being built. `/` is the
  // PHONE, which the iOS app loads. They are different FILES and they are laid out at different
  // scales: a wall is 1920x1080 read from a couch, and every other phone view of one is that canvas
  // CSS-transformed down, which is why their type is written at wall sizes. phone-home.html is not
  // scaled at all — it is laid out at the phone's own size, in portrait — so the two share their cards
  // and nothing else.
  //
  // `/phone` is the same page under its own name, for looking at it on something that is not a phone.
  // The full detail page is '/page'. no-cache so a deploy is never masked by a stale cached page.
  gated.get('/tv', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(TV_HTML);
  });
  gated.get(['/', '/phone'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(PHONE_HTML);
  });
  gated.get('/tv-session-focus', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(TV_FOCUS_HTML);
  });
  gated.get('/tv-sidebar', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(TV_SIDEBAR_HTML);
  });
  gated.get('/tv-health', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(TV_HEALTH_HTML);
  });
  gated.get('/page', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(DASHBOARD_HTML);
  });
  gated.get('/mic', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(MIC_HTML);
  });
  // A spare device left on this page IS an alarm clock: the same clock as the hub page, standalone. It
  // rings from its own timer and its own speaker, so nothing has to be delivered at the moment itself.
  gated.get('/alarm', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(ALARM_HTML);
  });
  // Two pages on purpose: wallmode.js switches only kiosk paths, so a spoken "put the calendar on
  // the TV" moves /tv-calendar and never yanks a phone sitting on /calendar.
  gated.get('/calendar', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(CAL_HTML);
  });
  gated.get('/tv-calendar', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(TV_CAL_HTML);
  });

  return { SURF_HTML };
};
