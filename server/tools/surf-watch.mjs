// Waits for a new Surfline snapshot to land in Supabase, then exits so the session that started it
// is re-invoked. Run it as a BACKGROUND task: the harness wakes the session when it exits, and it
// costs nothing while it waits. See docs/ALARMS.md, "The surf alarm".
//
//   WATCH_UNTIL=2026-09-22T06:45:00-04:00 node tools/surf-watch.mjs      (from server/)
//   node tools/surf-watch.mjs --selftest                                  (connects, then exits 0)
//
// Exit 0: a new snapshot landed (it is printed). 3: WATCH_UNTIL passed with none. 1: could not start.
//
// Realtime push is the mechanism; the slow poll is only a backstop, because a realtime channel can
// go deaf while still reporting SUBSCRIBED.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

// The hub's own env names. Outside Fly they come from data-layer's .env, which both machines have.
function dotenv () {
  const f = [`${homedir()}/repos/data-layer/.env`, `${homedir()}/data-layer/.env`].find(existsSync)
  if (!f) return {}
  return Object.fromEntries(readFileSync(f, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]))
}
const env = { ...dotenv(), ...process.env }
const URL = env.SUPABASE_URL
const KEY = env.SUPABASE_KEY
const SLUG = 'mayport-poles'
const SELFTEST = process.argv.includes('--selftest')
const DEADLINE = Date.parse(env.WATCH_UNTIL || '')
const POLL_MS = 10 * 60 * 1000

const log = (...a) => console.log(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }), '|', ...a)
const et = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York' })

if (!URL || !KEY) { log('FATAL: no SUPABASE_URL / SUPABASE_KEY'); process.exit(1) }
if (!SELFTEST && Number.isNaN(DEADLINE)) { log('FATAL: set WATCH_UNTIL to an ISO time with its offset'); process.exit(1) }

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

async function newest () {
  const { data, error } = await sb.from('surf_snapshots')
    .select('id,captured_at,run_init').eq('slug', SLUG)
    .order('captured_at', { ascending: false }).limit(1)
  if (error) { log('query error:', error.message); return null }
  return data?.[0] ?? null
}

const base = await newest()
if (!base) { log('FATAL: no baseline snapshot'); process.exit(1) }
log(`baseline: snapshot #${base.id} captured ${et(base.captured_at)} run_init=${base.run_init}`)

let done = false
async function check (why) {
  if (done) return
  const n = await newest()
  if (!n) return
  if (n.id !== base.id || n.captured_at !== base.captured_at) {
    done = true
    log(`NEW SNAPSHOT (${why}): #${n.id} captured ${et(n.captured_at)} run_init=${n.run_init}${n.run_init === base.run_init ? ' [same model run]' : ' [NEW MODEL RUN]'}`)
    process.exit(0)
  }
}

sb.channel('surf-watch')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'surf_snapshots' }, p => {
    log('realtime event:', p.eventType)
    check('realtime')
  })
  .subscribe(status => {
    log('channel:', status)
    if (status === 'SUBSCRIBED' && SELFTEST) { log('selftest OK'); process.exit(0) }
  })

if (!SELFTEST) {
  setInterval(() => check('poll backstop'), POLL_MS)
  setInterval(() => {
    if (Date.now() >= DEADLINE) { log('deadline reached, no further snapshot'); process.exit(3) }
  }, 30 * 1000)
  log(`watching until ${et(DEADLINE)}`)
}
