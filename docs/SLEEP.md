# Sleep

Apple Watch sleep reaches Supabase's `sleep_samples` (data-layer 00134) through the iPhone app,
because Apple Health has no cloud API: the only reader is an app on the phone.

    watch ─(Apple's sync)─▶ Health on the iPhone ─▶ SleepSync.swift ─▶ POST /api/health/sleep ─▶ sleep_samples

- `apps/Sources/SleepSync.swift` is started by `HealthSync` once the one Health sheet asking for every
  type (sleep included) has been answered (`docs/HEALTH.md`). It registers an observer
  with background delivery, and posts what an anchored query returns: new samples and deleted
  UUIDs, 500 at a time. The anchor is committed only after the hub answers 200, so a failed post
  is retried from the same place on the next run.
- `POST /api/health/sleep` (server.js, behind the auth gate) upserts by HealthKit UUID and deletes
  the UUIDs Health removed.
- One row per sample: `stage` is `in_bed`, `asleep_unspecified`, `awake`, `core`, `deep` or `rem`.
  `source` tells the watch's stages apart from anything else that writes sleep to Health.

## What it is not

**Not a live "asleep now" signal.** The watch writes a night's stages after waking, so the first
rows for a night arrive in the morning. Anything that has to act at sleep onset needs a signal from the watch during the night, which this is not.

## Prerequisites

- `HEALTHKIT` capability on the App ID `com.jaredgantt.statushub`
  (`node apps/tools/asc.mjs capability com.jaredgantt.statushub HEALTHKIT`). Without it the
  archive fails at signing on the healthkit entitlement.
- The user grants read access on the Health sheet the app shows at first launch after the update.
  Denied, the query returns nothing and nothing errors; Health → Sharing → Apps → Status Hub is
  where it is changed.

## Checking it

    curl -s "$SUPABASE_URL/rest/v1/sleep_samples?select=start_at,end_at,stage,source&order=start_at.desc&limit=20" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY"

The hub logs `[sleep] +N -M (sent K)` per post (`fly logs -a jared-status-hub`).
