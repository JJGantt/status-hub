import AVFoundation
import WatchKit

/// **Reads a session's reply aloud**, on the watch, with the system's own voice — no synthesis machine,
/// no audio sent anywhere. On when `session_speech` is on (the hub's Settings, and the Speak control in
/// Control Center); then a reply to a follow-up sent FROM the watch is spoken as it lands, and the
/// follow-up carries `Sessions.spokenFormat` so the reply is written to be heard.
///
/// **The always-on listener stands aside while it speaks** (`Capture.hush`) — otherwise it transcribes
/// the watch's own voice as a command — and picks the microphone back up when the speaking ends. It is
/// paused, not switched off. Starting a recording stops the speaking at once: his voice wins.
@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = Speaker()
    static let key = "session_speech"
    /// Whether session replies are spoken. Kept here between launches, and brought up to date from the
    /// hub whenever the app comes to the front (`WatchSettings`).
    static var enabled: Bool { UserDefaults.standard.bool(forKey: key) }

    private let synth = AVSpeechSynthesizer()

    override init() {
        super.init()
        synth.delegate = self
    }

    func speak(_ reply: String) {
        // The reply is asked for in plain speech, but markdown can still slip in; what is SAID is the
        // text with its syntax gone.
        let words = String(snippet(reply).characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        synth.stopSpeaking(at: .immediate)
        Capture.shared.hush(true)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        let u = AVSpeechUtterance(string: words)
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        Hub.log("speak", ["chars": words.count])
        synth.speak(u)
    }

    /// Stops mid-sentence: a recording is starting, and his voice comes first.
    func stop() {
        guard synth.isSpeaking else { return }
        synth.stopSpeaking(at: .immediate)
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }

    /// The audio session goes back and the listener, if it was on, takes the microphone again. The
    /// recorder claims its own category every time it starts, so nothing has to be restored here.
    private func finished() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Capture.shared.hush(false)
    }

    /// Flips the setting — the Speak control's action — on the watch at once and on the hub, and taps
    /// the wrist up for on and down for off, since nothing on screen says which it now is.
    static func toggle() {
        let on = !enabled
        UserDefaults.standard.set(on, forKey: key)
        WKInterfaceDevice.current().play(on ? .directionUp : .directionDown)
        if !on { shared.stop() }
        Task { await Hub.putSetting(key, on ? "1" : "0") }
    }

}
