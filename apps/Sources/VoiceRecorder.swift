#if os(iOS)
import SwiftUI
import AVFoundation

// Native voice capture for the StatusHub app: records REAL audio (no web MediaRecorder, no VAD
// auto-stop — you stop it, so long/pausey commands work) and POSTs it straight to the hub's
// /api/voice-command, the exact same Whisper + worker pipeline the web FAB uses. Auth via X-Hub-Token.
@MainActor
final class VoiceRecorder: NSObject, ObservableObject {
    enum Phase: Equatable { case idle, recording, uploading, sent, notHeard, failed }
    @Published var phase: Phase = .idle
    @Published var elapsed: TimeInterval = 0

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var timer: Timer?

    var isRecording: Bool { phase == .recording }

    func toggle() { phase == .recording ? stopAndSend() : start() }

    private func start() {
        elapsed = 0
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                granted ? self.begin() : (self.phase = .failed)
            }
        }
    }

    private func begin() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("cmd-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16_000,          // Whisper's rate; small files even for long clips
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.record()
            recorder = rec
            fileURL = url
            phase = .recording
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let r = self.recorder else { return }
                    self.elapsed = r.currentTime
                }
            }
        } catch { phase = .failed }
    }

    private func stopAndSend() {
        timer?.invalidate(); timer = nil
        recorder?.stop(); recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let url = fileURL else { phase = .idle; return }
        phase = .uploading
        Task { await upload(url) }
    }

    private func upload(_ url: URL) async {
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { phase = .failed; return }
        var comps = URLComponents(string: Auth.host + "/api/voice-command")!
        comps.queryItems = [URLQueryItem(name: "client_now", value: Self.localNow())]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("audio/m4a", forHTTPHeaderField: "Content-Type")
        if let tok = Auth.token() { req.setValue(tok, forHTTPHeaderField: "X-Hub-Token") }
        req.httpBody = data
        do {
            let (respData, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let enqueued = (try? JSONSerialization.jsonObject(with: respData) as? [String: Any])?["enqueued"] as? Bool ?? false
            if code == 200 { phase = enqueued ? .sent : .notHeard } else { phase = .failed }
        } catch { phase = .failed }
        // auto-reset the transient result back to idle
        let settle = phase
        try? await Task.sleep(nanoseconds: 2_800_000_000)
        if phase == settle { phase = .idle }
    }

    static func localNow() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date())
    }
}

// Floating native record button overlaid on the hub. Tap to start, tap to stop + send.
struct RecorderButton: View {
    @StateObject private var rec = VoiceRecorder()

    private var label: String? {
        switch rec.phase {
        case .recording: return String(format: "%d:%02d", Int(rec.elapsed) / 60, Int(rec.elapsed) % 60)
        case .uploading: return "Sending…"
        case .sent: return "Sent ✓"
        case .notHeard: return "Didn’t catch that"
        case .failed: return "Try again"
        case .idle: return nil
        }
    }

    var body: some View {
        VStack {
            Spacer()
            if let label {
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(rec.phase == .failed || rec.phase == .notHeard ? Color(red: 0.94, green: 0.51, blue: 0.42) : Color.white.opacity(0.9))
                    .padding(.bottom, 6)
            }
            Button(action: { rec.toggle() }) {
                ZStack {
                    Circle()
                        .fill(rec.isRecording ? Color(red: 0.85, green: 0.23, blue: 0.19)
                                              : Color(red: 0.16, green: 0.19, blue: 0.24))
                        .frame(width: 72, height: 72)
                        .shadow(color: .black.opacity(0.5), radius: 12, y: 4)
                        .overlay(Circle().stroke(rec.isRecording ? Color.white.opacity(0.35) : Color.white.opacity(0.08), lineWidth: 2))
                    switch rec.phase {
                    case .recording:
                        RoundedRectangle(cornerRadius: 5).fill(.white).frame(width: 26, height: 26)
                    case .uploading:
                        ProgressView().tint(.white)
                    default:
                        Image(systemName: "mic.fill")
                            .font(.system(size: 27))
                            .foregroundStyle(Color(red: 0.77, green: 0.71, blue: 0.98))
                    }
                }
            }
            .buttonStyle(.plain)
            .padding(.bottom, 26)
        }
        .allowsHitTesting(true)
    }
}
#endif
