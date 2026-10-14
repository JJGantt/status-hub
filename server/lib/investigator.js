// When a machine is unhealthy beyond what is normal for it, start a Claude session in the `health`
// repo to find out why and fix it. docs/HUB-INTERNALS.md § Health investigator.
//
// The hub decides this rather than either machine, because the machine that is sick is the one
// least able to report it: a Pi whose Wi-Fi is failing cannot dispatch anything.
//
// Pure: `observe` folds one reading of worker_presence into the state, `due` says which subjects
// have crossed a threshold. The server owns the clock, the reads and the dispatch.

const STALE_S = 90;                  // the workers' own HEARTBEAT_FRESH_S
const SUSTAINED_MS = 10 * 60e3;      // bad without a break for this long
const FLAP_WINDOW_MS = 60 * 60e3;    // ...or this many separate bad stretches inside this window
const FLAP_COUNT = 3;

// What "unhealthy" means per machine. The Mac's silence is not a symptom — it sleeps whenever the lid
// closes — so only its own report of a failing link counts. The Pi and Fly are always on, so silence is.
const SUBJECTS = {
  pi:  { workers: ['pi', 'pi-desk'], silenceIsBad: true },
  mac: { workers: ['mac', 'desk'], silenceIsBad: false },
  fly: { workers: ['fly'], silenceIsBad: true },
};

function badNow(subject, rows, now) {
  const { workers, silenceIsBad } = SUBJECTS[subject];
  const why = [];
  for (const w of workers) {
    const r = rows.find((x) => x.worker === w);
    const age = r && r.last_seen ? (now - Date.parse(r.last_seen)) / 1000 : Infinity;
    if (silenceIsBad && age > STALE_S) why.push(`${w} heartbeat ${Number.isFinite(age) ? `${Math.round(age)}s old` : 'missing'}`);
    if (age <= STALE_S && r.info && r.info.degraded) why.push(`${w} reports its network degraded`);
  }
  return why;
}

function newState() {
  return Object.fromEntries(Object.keys(SUBJECTS).map((s) => [s, { badSince: null, starts: [], log: [] }]));
}

// Record one reading. `log` keeps the transitions of the last window, which is what the session is
// handed as its evidence.
function observe(state, rows, now) {
  for (const s of Object.keys(SUBJECTS)) {
    const st = state[s];
    const why = badNow(s, rows || [], now);
    if (why.length && st.badSince == null) {
      st.badSince = now;
      st.starts.push(now);
      st.log.push({ at: now, bad: true, why });
    } else if (!why.length && st.badSince != null) {
      st.badSince = null;
      st.log.push({ at: now, bad: false });
    }
    st.starts = st.starts.filter((t) => now - t <= FLAP_WINDOW_MS);
    st.log = st.log.filter((e) => now - e.at <= FLAP_WINDOW_MS);
  }
}

// Subjects over a threshold now, each with the reason.
function due(state, now) {
  const out = [];
  for (const s of Object.keys(SUBJECTS)) {
    const st = state[s];
    if (st.badSince != null && now - st.badSince >= SUSTAINED_MS) {
      out.push({ subject: s, reason: `unhealthy without a break for ${Math.round((now - st.badSince) / 60e3)} minutes` });
    } else if (st.starts.length >= FLAP_COUNT) {
      out.push({ subject: s, reason: `dropped out ${st.starts.length} separate times in the last hour` });
    }
  }
  return out;
}

const NAMES = { pi: 'the Pi', mac: 'the Mac', fly: 'the Fly voice worker' };

function prompt(subject, reason, st, rows, now) {
  const fmt = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: process.env.TZ_DISPLAY || 'America/New_York' });
  const timeline = st.log.map((e) => `- ${fmt(e.at)} ${e.bad ? `BAD: ${e.why.join('; ')}` : 'recovered'}`).join('\n');
  const presence = (rows || []).map((r) => `- ${r.worker}: last_seen ${r.last_seen}${r.info && Object.keys(r.info).length ? ` info ${JSON.stringify(r.info)}` : ''}`).join('\n');
  return `Automatic health investigation, started by the hub (not by Jared): ${NAMES[subject]} has ${reason}.

What the hub saw in worker_presence over the last hour (times are Jared's local time):
${timeline || '- (no transitions recorded)'}

worker_presence right now (${new Date(now).toISOString()}):
${presence}

Find out what is wrong and fix it if you can. Start from WATCHLIST.md in this repo, and use the
machine itself: \`ssh pi\` (by IP if mDNS fails — the Pi's address is in \`ip route\` on it, or the
router's DHCP list) and its journal. If SSH cannot reach the Pi, ~/CLAUDE.md describes reaching it
through a dispatched session.

Rules, as Jared set them:
- On your own: fix anything whose cause is clear and whose fix is obvious — code changes committed,
  pushed and deployed like any other session; restarting services; clearing temporary files;
  adjusting settings. Add what broke to WATCHLIST.md so future checks catch it.
- Ask him first, by push, with your diagnosis and proposed fix: anything that deletes, rewrites or
  moves data that is not regenerable; schema changes; spending money or reaching outside his systems
  (messages, orders, accounts); any fix where you are not sure of the cause.
- Never start another investigation.
- Finish with one push to his phone (the hub's /api/notify, as ~/.claude/CLAUDE.md describes, kind
  "health") saying what broke, what you did, and what is waiting on him.`;
}

module.exports = { observe, due, prompt, newState, SUBJECTS, NAMES, STALE_S, SUSTAINED_MS, FLAP_COUNT };
