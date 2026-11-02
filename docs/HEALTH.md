# Apple Health

Everything Apple Health holds reaches Supabase through the iPhone app, because Health has no
cloud API: the only reader is an app on the phone. Sleep has its own table and its own doc
(`docs/SLEEP.md`); this is everything else.

    watch / phone ─(Apple's sync)─▶ Health on the iPhone ─▶ HealthSync.swift ─▶ POST /api/health/samples ─▶ health_samples

- `apps/Sources/HealthSync.swift` asks for read access to every quantity type in its list (heart,
  vitals, body, activity, workout metrics, mobility, audio, nutrition other apps write), the event
  categories (stand hours, mindful minutes, heart-rate and rhythm alerts, ...) and workouts. ONE
  observer and ONE anchored query cover all of them, posted 2000 samples a page; the anchor commits
  only after the hub answers 200. It asks for sleep in the same Health sheet and starts `SleepSync`
  once that is answered, so there is one sheet rather than two.
- **Adding a type to the lists is not enough on its own.** The single anchor is a position in
  Health's whole history, so a type added later is read only from that position forward. Change
  `anchorKey` in the same commit to re-read everything; the UUID upsert absorbs the resend.
- Values are in the unit Health itself displays for the type (`preferredUnits`): count/min for heart
  rate, ms for HRV, kcal, count, %, degC. A quantity whose unit Health will not name, or whose value
  is not finite, is skipped — one NaN in a page fails its JSON, and an unpostable page stalls the anchor.
- `POST /api/health/samples` (server.js, behind the auth gate) upserts by HealthKit UUID and deletes
  the UUIDs Health removed. It accepts any `type`, so the server needs no change for a new one.
- **The hub paces it.** A page of N rows earns the next page a gap of N / 100 seconds (`HEALTH_ROWS_PER_S`),
  stretched to ten times the write's own duration when the database is slow and to a minute after a
  failed write (logged as a warning; three failures in a row are logged as an error and reach the ops
  responder); a page inside the gap gets `503` + `Retry-After` before Supabase is touched, and the
  phone waits exactly that long and resumes from the same anchor. Live deliveries are a few rows and
  never wait. The full-history read is millions of rows: unpaced it wrote ~1.3M in twenty minutes and
  starved the database's disk until Postgres stopped answering, because each random-UUID insert dirties
  its own index page. Raising the rate, or changing `anchorKey` to re-read everything, is a load on the
  database to size first.

## The table

`health_samples` (data-layer 00136): `type` is the HealthKit identifier with its prefix dropped
(`heartRate`, `restingHeartRate`, `heartRateVariabilitySDNN`, `stepCount`, `activeEnergyBurned`).
Quantities carry `value` + `unit`; categories carry the raw HKCategoryValue in `value` and no unit;
workouts are `type = 'workout'` with the activity in `label`, duration seconds in `value`, and the
workout's per-type statistics in `metadata.stats` (avg/min/max/sum per type).

Heart rate is the bulk: a reading every few minutes at rest, every few seconds in a workout.

## Reading it

The data MCP's `get_health_data` is the way in for voice and sessions — no type lists what exists,
then per-day rollups, `sleep` per night, `workout` per workout, `readings: true` for raw samples in a
window. It reads three SQL functions from data-layer 00137: `health_types()`, `health_daily(type,
from, to)` and `sleep_nights(from, to)`. Days are New York calendar days, not the hub's 4am day.

## What it is not

**Not live.** iOS decides when to wake the app for a background delivery — roughly hourly for most
types, and sleep only after waking — so nothing here can react to heart rate as it happens.

## Prerequisites

The same as sleep: the App ID's `HEALTHKIT` capability, and the user's grant on the Health sheet the app
shows at the first launch after an update that asks for new types. Denied, queries return nothing
and nothing errors; Health → Sharing → Apps → Status Hub is where it is changed.

## Checking it

    curl -s "$SUPABASE_URL/rest/v1/rpc/health_types" -X POST -H "apikey: $KEY" -H "Authorization: Bearer $KEY"

The hub logs `[health] +N -M (sent K) <ms>` per post (`fly logs -a jared-status-hub`).
