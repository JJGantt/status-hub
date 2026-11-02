// Bundles each page's modules into one file.
//
// The hub's client is 26 ES modules in a three-level import graph. Served raw, a phone pays a full
// round trip per LEVEL before the next set of files is even discovered — about 420ms of pure waiting
// on cellular, before any of them run. Bundled, a page fetches one script.
//
// One bundle PER PAGE, never one per entry module: several pages share core.js, shared.js and
// voiceagent.js, and those modules hold state that must exist exactly once on a page (the activity
// popup singleton, the held microphone, the KIOSK verdict). Separate bundles sharing a module would
// each get their own copy of it.
//
// Runs inside the Docker build, so the bundle can never be stale against the source it was built
// from. Local: `npm run build` before `npm start`.
const esbuild = require('esbuild');
const { readdirSync, rmSync, existsSync } = require('fs');
const path = require('path');

const PAGES = path.join(__dirname, 'public', 'pages');
const OUT = path.join(__dirname, 'public', 'dist');
const entries = readdirSync(PAGES).filter((f) => f.endsWith('.js')).map((f) => path.join(PAGES, f));

if (existsSync(OUT)) rmSync(OUT, { recursive: true });   // never serve a bundle for a page that is gone

esbuild.build({
  entryPoints: entries,
  outdir: OUT,
  bundle: true,
  format: 'esm',
  target: 'safari16',        // the floor is the user's phone and the Pi's kiosk browser
  minify: true,
  sourcemap: true,           // the minified frame in a console error still names the real file and line
  logLevel: 'info',
}).catch(() => process.exit(1));
