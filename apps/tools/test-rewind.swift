// Tests the watch's rewind ring and its encode, on the Mac, with no device (docs/REWIND.md):
//
//   cd apps && swiftc -parse-as-library -o /tmp/test-rewind Watch/RewindBuffer.swift tools/test-rewind.swift && /tmp/test-rewind
//
// With HUB_TOKEN set (a machine's hub token, TV_TOKEN) it also sends a spoken sentence through the ring to the hub's dry transcription,
// the same request a grab makes, and checks the words come back.
import AVFoundation
import Foundation

@main
struct TestRewind {
    static var failures = 0

    static func check(_ ok: Bool, _ what: String) {
        print(ok ? "ok   " : "FAIL ", what)
        if !ok { failures += 1 }
    }

    static func main() async {
        ring()
        randomized()
        await encodeAndTranscribe()
        print(failures == 0 ? "all passed" : "\(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func ring() {
        var r = RewindBuffer(capacity: 5)
        check(r.snapshot().isEmpty, "empty ring holds nothing")
        r.append([1, 2, 3])
        check(r.snapshot() == [1, 2, 3], "partial fill, oldest first")
        r.append([4, 5])
        check(r.snapshot() == [1, 2, 3, 4, 5], "exactly full")
        r.append([6, 7])
        check(r.snapshot() == [3, 4, 5, 6, 7], "wraps, dropping the oldest")
        r.append([8, 9, 10, 11, 12, 13, 14])
        check(r.snapshot() == [10, 11, 12, 13, 14], "an append longer than the ring keeps its tail")
        check(r.count == 5, "count stays at capacity")
        var z = RewindBuffer(capacity: 0)
        z.append([1, 2])
        check(z.snapshot() == [2], "capacity under 1 is clamped to 1")
    }

    /// Thousands of random-sized appends against the obvious model: keep everything, take the tail.
    static func randomized() {
        var gen = SystemRandomNumberGenerator()
        for capacity in [1, 7, 4096, 16_000] {
            var r = RewindBuffer(capacity: capacity)
            var model: [Float] = []
            var next: Float = 0
            var ok = true
            for _ in 0..<2000 {
                let n = Int.random(in: 0...(capacity * 2), using: &gen)
                let chunk = (0..<n).map { _ in next += 1; return next }
                r.append(chunk)
                model.append(contentsOf: chunk)
                if model.count > capacity { model.removeFirst(model.count - capacity) }
                if r.snapshot() != model { ok = false; break }
            }
            check(ok, "random appends match the model at capacity \(capacity)")
        }
    }

    static func encodeAndTranscribe() async {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("test-rewind-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let sentence = "The blue heron is standing in the marsh by the dock"
        let aiff = dir.appendingPathComponent("said.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-o", aiff.path, sentence]
        do { try say.run(); say.waitUntilExit() } catch { check(false, "say ran: \(error)"); return }
        guard let speech = readMono16k(aiff) else { check(false, "read the spoken sentence"); return }

        // A minute of noise first, then the sentence, in the 4096-ish chunks the tap delivers, through a
        // ring smaller than all of it: what comes out has to be the sentence, not the noise before it.
        let rate = 16_000.0
        let seconds = Double(speech.count) / rate + 1
        var r = RewindBuffer(capacity: Int(seconds * rate))
        let noise = (0..<Int(60 * rate)).map { _ in Float.random(in: -0.001...0.001) }
        for chunk in stride(from: 0, to: noise.count, by: 4096) { r.append(Array(noise[chunk..<min(chunk + 4096, noise.count)])) }
        for chunk in stride(from: 0, to: speech.count, by: 4096) { r.append(Array(speech[chunk..<min(chunk + 4096, speech.count)])) }
        let held = r.snapshot()
        check(Array(held.suffix(speech.count)) == speech, "the ring's tail is the sentence")

        let m4a = dir.appendingPathComponent("rewind.m4a")
        do { try RewindAudio.writeM4A(held, rate: rate, to: m4a) } catch { check(false, "encode: \(error)"); return }
        guard let back = try? AVAudioFile(forReading: m4a) else { check(false, "the m4a reads back"); return }
        let dur = Double(back.length) / back.fileFormat.sampleRate
        check(abs(dur - seconds) < 0.2, String(format: "the m4a is %.2fs of %.2fs", dur, seconds))

        guard let token = ProcessInfo.processInfo.environment["HUB_TOKEN"], !token.isEmpty else {
            print("skip  transcription (no HUB_TOKEN)")
            return
        }
        let host = ProcessInfo.processInfo.environment["HUB_URL"] ?? "https://jared-status-hub.fly.dev"
        var req = URLRequest(url: URL(string: "\(host)/api/voice-command?dry=1&client_msg_id=\(UUID().uuidString)&dur=\(String(format: "%.1f", seconds))&source=watch-cmd")!)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        req.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        do {
            let (data, resp) = try await URLSession.shared.upload(for: req, fromFile: m4a)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let heard = (body?["transcript"] as? String ?? "").lowercased()
            print("      heard: \(heard)")
            check(status == 200, "hub answered \(status)")
            check(heard.contains("heron") && heard.contains("marsh"), "the hub transcribed the sentence")
            check((body?["enqueued"] as? Bool) == false, "dry: nothing enqueued")
        } catch {
            check(false, "upload: \(error)")
        }
    }

    /// Any audio file as 16 kHz mono floats, the format the watch's sink feeds the ring.
    static func readMono16k(_ url: URL) -> [Float]? {
        guard let file = try? AVAudioFile(forReading: url),
              let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: file.processingFormat, to: target),
              let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: input)) != nil,
              let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(file.length) * 16_000 / file.processingFormat.sampleRate) + 1024)
        else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, let data = out.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: data, count: Int(out.frameLength)))
    }
}
