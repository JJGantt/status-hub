import Foundation
import AVFoundation
import WatchKit

/// What the wrist and the ear get told, and nothing else.
///
/// Counting is useless if you have to look at the watch to know it counted. The
/// point of the feedback is that a set can be done with your eyes anywhere else.
///
/// Haptic and sound fire together deliberately. On Apple Watch a haptic already
/// carries its own audio cue unless the watch is silenced, so these are not
/// independent channels — the tone rides alongside to make the event unmistakable
/// in a noisy gym.
@MainActor
final class Feedback {

    /// The set was recognised. This lands with several reps already counted and
    /// announces them at once, so it has to be clearly distinct from a single rep
    /// tick — otherwise there is no way to tell "that was the first count" from "that
    /// was one more".
    /// Two rising notes against the rep tick's single blip.
    func locked() {
        WKInterfaceDevice.current().play(.success)
        play(locked_)
    }

    /// One more rep: a tap on the wrist and the number said aloud.
    ///
    /// The number is a pre-rendered file rather than live speech synthesis, because
    /// `AVSpeechSynthesizer`'s first utterance has unpredictable startup latency and
    /// this fires on a beat the lifter can feel. Files decode in microseconds and
    /// play the instant the rep is counted.
    ///
    /// Counting starts at five. Four is the lock-on chime — by then the algorithm
    /// has established the cycle and announced the first four reps together, so
    /// speaking "four" would be announcing a number that was already true. Past the
    /// last rendered number it falls back to the tick, which is honest: a tap that
    /// means "one more" rather than a wrong number.
    func rep(_ n: Int) {
        WKInterfaceDevice.current().play(.click)
        if let spoken = number(n) { play(spoken) } else { play(rep_) }
    }

    /// The set closed and the count is final.
    func setEnded() {
        WKInterfaceDevice.current().play(.stop)
    }

    // MARK: - audio

    private var rep_: AVAudioPlayer?
    private var locked_: AVAudioPlayer?
    private var ready = false
    /// Loaded on demand and kept: a set revisits the same handful of numbers, and
    /// loading 50 files up front would cost launch time for words most sets never
    /// reach.
    private var spokenCache: [Int: AVAudioPlayer] = [:]

    init() {
        rep_ = load("rep")
        locked_ = load("locked")
    }

    private func number(_ n: Int) -> AVAudioPlayer? {
        if let p = spokenCache[n] { return p }
        guard let p = load("n\(n)") else { return nil }
        spokenCache[n] = p
        return p
    }

    private func load(_ name: String) -> AVAudioPlayer? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "wav", subdirectory: "Resources"),
              let p = try? AVAudioPlayer(contentsOf: url) else {
            WatchsetHost.fail("rep-sound-failed", ["sound": name, "error": "not loaded"]); return nil
        }
        p.prepareToPlay()          // decode up front; the first rep should not be late
        return p
    }

    /// Activated lazily on first use rather than at launch: claiming the audio
    /// session before there is anything to play would interrupt whatever the user is
    /// listening to for the whole session, for nothing.
    ///
    /// The app shares the audio session (voice commands record, replies are spoken). While it is
    /// using it the tones play inside its session as configured; otherwise this claims `.playback`.
    /// Checked on every play, because the app deactivates the session when a recording or a reply
    /// ends, which would otherwise leave every later rep silent.
    private func activate() {
        if WatchsetHost.current?.audioInUse() == true { return }
        let s = AVAudioSession.sharedInstance()
        // `.playback` so a counted rep is still audible with the watch silenced, and
        // `.mixWithOthers` because people lift to music and ducking it every few
        // seconds would be worse than saying nothing.
        do {
            if !ready || s.category != .playback {
                try s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            }
            try s.setActive(true, options: [])
        } catch {
            WatchsetHost.fail("rep-sound-failed", ["error": String(describing: error).prefix(120).description])
        }
        ready = true
    }

    private func play(_ player: AVAudioPlayer?) {
        guard let p = player else { return }
        activate()
        p.currentTime = 0
        p.play()
    }

    /// Hand the audio route back when the workout ends.
    func release() {
        guard ready else { return }
        ready = false
        if WatchsetHost.current?.audioInUse() == true { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
