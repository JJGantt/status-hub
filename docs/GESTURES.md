# Custom wrist gestures: what is possible

Research notes for building gestures of our own on the watch: single, double and triple tap, and
others, recognised from the motion sensors. Nothing here is built yet.

## What the system gives a third-party app

- **Double tap, as one button.** `handGestureShortcut(.primaryAction)` is the only hook. The app
  never sees the gesture itself, only that its primary button was pressed. `CommandBorder` already
  uses it (`docs/WATCH.md` § Double tap, and scrolling).
- **Wrist flick (watchOS 26, Series 9 / 10 / Ultra 2): no API.** The system uses it to dismiss, and
  apps can only simulate it in UI tests (`XCUIDevice.perform(handGesture: .flick)`).
- **AssistiveTouch's pinch, double pinch, clench and double clench** are reserved for the
  accessibility feature. An app cannot receive them.

So anything beyond one double tap has to be our own recogniser running on raw motion data.

## What Apple's double tap actually reads

The S9 / S10 Neural Engine runs a model over the accelerometer, the gyroscope **and the optical heart
sensor**, which sees the change in blood flow as the fingers press together. An app cannot read the
optical sensor at anything like that rate; HealthKit gives heart-rate samples, not the raw PPG. **A
recogniser of ours is IMU-only.**

Whether that is enough: Apple's own research says yes. Xu, Laput et al., *Enabling Hand Gesture
Customization on Wrist-Worn Devices* (CHI 2022, arXiv 2203.15239) uses accelerometer and gyroscope
only and reaches 95.7% cross-user accuracy at 0.6 false positives per hour of everyday wear. Its
few-shot step adds a new gesture from 3-5 examples (83-87%) without degrading the existing ones.

## The sensor APIs, and the catch in each

| API | rate | latency | runs when |
|---|---|---|---|
| `CMMotionManager` device motion / accelerometer | up to 100 Hz | per sample | while the app is running: foreground, or background under a workout session or another background mode |
| `CMBatchedSensorManager` (watchOS 10+, Series 8 / Ultra and later) | 800 Hz accel, 200 Hz device motion | **one batch per second** | only during an active `HKWorkoutSession` |

The 800 Hz stream sounds like the answer for taps, which are short sharp impulses, but it arrives a
second late, which is too slow for a gesture that has to feel like a button. Use it to collect
training data, and recognise live at 100 Hz.

**Recognition only runs while our app runs.** There is no way to watch for a gesture system-wide,
behind other apps or on the watch face, the way Apple's double tap does. The ways to keep the app
alive with the wrist down are a workout session (shows as a workout, costs battery) or a background
mode the app already holds for another reason (the always-on microphone here). Whether CoreMotion
keeps delivering under the microphone mode alone has not been measured.

## Prior work worth reusing

- **In these repos.** `GolfTracker-SwingDetection` already streams 800 Hz accelerometer under a
  workout session and uploads it to Supabase (`SwingDetectionManager+RawAccel.swift`,
  `WorkoutManager.swift`). `Workset` records device motion through `CaptureManager.swift` and keeps
  the app alive with `WorkoutKeepAlive.swift`. Data capture is a solved problem here.
- **Doublepoint** (Finnish startup) is the commercial state of the art: WowMouse on Apple Watch and
  Wear OS detects thumb-to-index pinch from the IMU. The detection engine is proprietary and
  licensed. Their open `touch-sdk` packages (Python, JS) only consume events from their watch app over
  Bluetooth, so there is no recogniser to lift.
- **Research.** Serendipity (Wen et al., CHI 2016): pinch, tap, rub, squeeze and wave from a stock
  smartwatch IMU, with per-gesture accuracy in the 80s (83% for pinch, as SonarWatch cites it). ViWatch (UVA): finger gestures from a stock IMU,
  about 97% over a week across 100+ people. ViBand (Laput, CMU, UIST 2016): taps, flicks and taps on
  different parts of the hand, but it needs the accelerometer at 4 kHz through a modified kernel,
  which is not possible on watchOS.
- **No open-source Apple Watch tap recogniser was found.** Create ML's Activity Classifier is
  Apple's path to train one from labelled motion windows into a Core ML model that runs on the watch.

## How a first version would go

1. **Record.** A capture mode that logs 100 Hz device motion (plus 800 Hz under a workout session)
   while single, double and triple taps are performed and labelled, and hours of ordinary wear as
   negatives.
2. **Try the simple detector first.** A tap is an impulse: high-pass the acceleration and threshold
   the spike. Single / double / triple is then counting impulses inside a window of about 400 ms,
   the same timing logic the system uses. Only if the impulse detector cannot separate taps from
   ordinary movement does it become an ML problem.
3. **Measure false positives per hour on the negatives**, the number Apple's paper reports. That is
   what decides whether it is usable, not accuracy on the positives.
