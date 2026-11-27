# Watchset

The rep counter's watch feature, as a Swift package the Status Hub watch app shows as a page
(`WatchsetPage`). One switch covers the whole workout: the watch streams device motion, recognises a
set when one starts, counts it live with a haptic and a spoken number per rep, closes it when it ends,
reports the count, uploads the raw recording, and goes back to watching for the next set.

The counter itself is the private package `JJGantt/Workset-Algorithms` (product `RepCounter`), pinned
by commit in `Package.swift` and fetched over SSH. `../SessionCore` is the loop around it, free of the
counter so it tests anywhere: `cd ../SessionCore && swift test`.

## What the app provides

`WatchsetHost`, installed once at launch, is everything this package needs from its app:

| | |
|---|---|
| `hold` / `release` | the workout session. watchOS lets one app hold a workout at a time and it must be an actively collecting one, or the app is suspended on wrist-down and most of a set's samples are lost. The app's workout hold provides it (`Watch/WorkoutHold.swift`) |
| `request` | the `workset` routes, authenticated as the app. Status Hub sends them to the hub (`/api/workset/*`), which forwards them to the data layer's `workset` edge function with the device token |
| `audioInUse` | true while the app holds the audio session (a recording, a spoken reply). The rep tones then play inside it, and `Feedback` neither reconfigures nor releases it |
| `log` | the app's log. `WatchsetHost.fail` sends a line with `level: error`, which the hub reports as a failure: a set report, an edit, the armed-watcher read, a recording that could not be queued or was refused, the rep sounds. A capture upload with no connection is a plain `capture-upload-retry`, because the queue resends it |

`KeepAlive.shared.update(holding:)` is how the app tells the screens whether the session is holding;
**NOT PROTECTED** shows whenever it is not.

## Behaviour

- **Capture.** `CaptureManager` reads device motion at 100 Hz in `xMagneticNorthZVertical`, so yaw is
  an absolute heading, plus CoreMotion's activity classification (recorded, gates nothing: real sets
  have logged `walking` at high confidence).
- **Reporting.** `SetReporter` posts each finished set (reps, time, algorithm) as a report. The exercise
  and weight are not chosen on the watch: the rep watcher arms them and a database trigger attaches them.
  With nothing armed the report is kept and never becomes a logged set. The badge says what is armed,
  `not logging` when nothing is, and `can't reach server` when the question itself failed.
- **Minimum set length.** A detected set under **6 reps** is not logged (Stop applies the same rule).
  Short real sets are entered by hand; the manual path exists so the automatic one can be strict.
- **Add** enters a count on the crown through the same path (algorithm `manual`), offered only between
  sets so one piece of lifting cannot become two logged sets. **Repeat** logs the last count again.
  **Discard** rejects the set being counted without stopping the session. **+ / −** and **✕** edit the
  report (only one from the last two hours), which edits the training log.
- **Recordings.** Every recognised set is saved as a CSV and uploaded to
  `workset-captures/workset/sensor_capture/<session>/motion.csv`. It is written to disk first
  (`watchset-pending/`) and leaves the queue only on a 2xx or a 409 (already stored); the queue is
  retried on the next upload and when the page appears. A discarded or too-short set still uploads,
  marked `app_cancelled,1`, as a labelled false positive.
- **Every capture carries its verdict**: the app's count, the algorithm version and where each rep was
  counted. **Its `count` field stays 0**, because that is the field the tooling reads as ground truth.
  The CSV is all numeric (the loader floats every column).
- **Feedback.** A haptic and a pre-rendered number (`Resources/n1.wav` to `n50.wav`) per rep, the
  `locked` tone when a set locks on. Files rather than speech synthesis, because a synthesiser's first
  utterance starts late on a beat the lifter can feel.
- **Small-range movements** (shrugs, calf raises) barely move the wrist and are not counted.
