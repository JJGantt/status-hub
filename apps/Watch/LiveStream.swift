import AVFoundation
import Foundation

/// A command or follow-up STREAMED TO THE HUB WHILE IT RECORDS (`/api/voice-live`, server/lib/livestream.js).
///
/// It is also how a finished command's audio reaches the hub: `Hub.sendAudio` sends the command without
/// the clip and the hub uses what this stream delivered, uploading the clip only when the hub says the
/// stream did not arrive whole. And it covers the app dying mid-recording, which takes the clip in memory
/// with it and throws nothing anywhere. With the stream open, the watch's operating system closes the connection the moment
/// the process goes, and the hub, seeing it close without an end frame, reports the recording lost and
/// transcribes the audio it already has.
///
/// So every intended way out says so before closing: `finish` sends `E` (being sent) or `C` (cancelled),
/// and a pause or resume of the microphone sends `P` / `R`, since a paused recording sends no audio and
/// the hub must not read that silence as a dead connection.
///
/// Audio is AAC, 16 kHz mono, each packet wrapped in an ADTS header so the concatenated payloads are a
/// playable stream however early it is cut. `write` is called on the audio thread; the encoder, the
/// queue of bytes and the stream are only touched on `q`.
final class LiveStream: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let id = UUID().uuidString
    private let q = DispatchQueue(label: "live-stream")
    private var session: URLSession?
    private var task: URLSessionUploadTask?
    private var input: InputStream?
    private var output: OutputStream?
    /// Bytes encoded but not yet taken by the stream. Normally empty: the bound pair's buffer is far
    /// larger than a second of audio, so a write only falls behind when the network does.
    private var pending = Data()
    private var encoder: AVAudioConverter?
    private let pcm: AVAudioFormat
    private var closed = false
    private var finishing = false
    /// Bytes of audio dropped because the stream had fallen this far behind; logged at the end.
    private var dropped = 0
    private static let backlogCap = 512 * 1024

    /// Opens the stream for a recording whose 16 kHz mono float audio will arrive through `write`. Nil
    /// when there is no token yet or the encoder cannot be built; the recording then goes on without one.
    static func open(view: String, flow: String, format: AVAudioFormat) -> LiveStream? {
        let live = LiveStream(format: format)
        guard live.start(view: view, flow: flow) else { return nil }
        return live
    }

    private init(format: AVAudioFormat) {
        pcm = format
        super.init()
    }

    private func start(view: String, flow: String) -> Bool {
        var aac = AudioStreamBasicDescription(mSampleRate: pcm.sampleRate, mFormatID: kAudioFormatMPEG4AAC,
                                              mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 1024,
                                              mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard let out = AVAudioFormat(streamDescription: &aac), let encoder = AVAudioConverter(from: pcm, to: out),
              var r = try? Hub.liveRequest("/api/voice-live?id=\(id)&view=\(view)&flow=\(flow)") else {
            Hub.log("live-failed", ["why": "setup"])
            return false
        }
        encoder.bitRate = 32_000
        self.encoder = encoder
        var i: InputStream?
        var o: OutputStream?
        Stream.getBoundStreams(withBufferSize: Self.backlogCap, inputStream: &i, outputStream: &o)
        guard let i, let o else { return false }
        input = i
        output = o
        o.open()
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        // The idle limit covers a long pause, when nothing is sent: it is the watch's own give-up, and the
        // hub reads a drop while paused as a stalled network rather than a lost recording.
        r.timeoutInterval = 900
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 900
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.uploadTask(withStreamedRequest: r)
        self.task = task
        task.resume()
        Hub.log("live-open", ["id": id, "view": view, "flow": flow])
        return true
    }

    /// One buffer of the recording, on the audio thread. Copied, since the caller reuses it.
    func write(_ buffer: AVAudioPCMBuffer) {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength),
              let src = buffer.floatChannelData?[0], let dst = copy.floatChannelData?[0] else { return }
        copy.frameLength = buffer.frameLength
        dst.update(from: src, count: Int(buffer.frameLength))
        q.async { self.encode(copy) }
    }

    /// The microphone was taken (`P`) or given back (`R`).
    func mark(paused: Bool) { q.async { self.send(paused ? "P" : "R", Data()) } }

    /// The recording ended on purpose: `E` when it is being sent, `C` when it was thrown away. Then the
    /// body is closed, once everything queued has been taken.
    func finish(cancelled: Bool) {
        q.async {
            guard !self.finishing else { return }
            self.finishing = true
            self.send(cancelled ? "C" : "E", Data())
            self.closeWhenDrained(tries: 0)
        }
    }

    private func encode(_ buffer: AVAudioPCMBuffer) {
        guard let encoder, !finishing, !closed else { return }
        var fed = false
        while true {
            let out = AVAudioCompressedBuffer(format: encoder.outputFormat, packetCapacity: 8,
                                              maximumPacketSize: max(encoder.maximumOutputPacketSize, 1536))
            var error: NSError?
            let status = encoder.convert(to: out, error: &error) { _, state in
                if fed { state.pointee = .noDataNow; return nil }
                fed = true
                state.pointee = .haveData
                return buffer
            }
            if status == .error { Hub.log("live-failed", ["why": "encode", "error": error.map { "\($0)" } ?? ""]); return }
            for p in 0..<Int(out.packetCount) {
                guard let d = out.packetDescriptions?[p] else { continue }
                let bytes = Data(bytes: out.data.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize))
                send("A", Self.adts(Int(d.mDataByteSize)) + bytes)
            }
            if status != .haveData { break }
        }
    }

    /// One frame: type, big-endian length, payload.
    private func send(_ type: Character, _ payload: Data) {
        guard !closed else { return }
        if type == "A" && pending.count > Self.backlogCap { dropped += payload.count; return }
        var len = UInt32(payload.count).bigEndian
        pending.append(type.asciiValue!)
        pending.append(Data(bytes: &len, count: 4))
        pending.append(payload)
        drain()
    }

    private func drain() {
        guard let output, !pending.isEmpty, output.hasSpaceAvailable else { return }
        let n = pending.withUnsafeBytes { output.write($0.bindMemory(to: UInt8.self).baseAddress!, maxLength: pending.count) }
        if n > 0 { pending.removeFirst(n) }
    }

    /// Up to three seconds for the network to take what is still queued, then the body is closed
    /// regardless: the end frame normally went with the first write.
    private func closeWhenDrained(tries: Int) {
        drain()
        if !pending.isEmpty && tries < 60 {
            q.asyncAfter(deadline: .now() + 0.05) { self.closeWhenDrained(tries: tries + 1) }
            return
        }
        if !pending.isEmpty || dropped > 0 { Hub.log("live-behind", ["id": id, "unsent": pending.count, "dropped": dropped]) }
        output?.close()
        closed = true
        session?.finishTasksAndInvalidate()
    }

    // ADTS header for AAC-LC, 16 kHz (sampling index 8), one channel.
    private static func adts(_ packet: Int) -> Data {
        let len = packet + 7
        let profile = 1, freq = 8, chan = 1   // profile is the object type minus one: LC = 2 - 1
        return Data([0xFF, 0xF1,
                     UInt8((profile << 6) | (freq << 2) | (chan >> 2)),
                     UInt8(((chan & 3) << 6) | (len >> 11)),
                     UInt8((len >> 3) & 0xFF),
                     UInt8(((len & 7) << 5) | 0x1F),
                     0xFC])
    }

    // MARK: URLSessionTaskDelegate

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    needNewBodyStream completionHandler: @escaping @Sendable (InputStream?) -> Void) {
        // Asked once for the body. Asked again (a retry), the stream cannot be rewound: no body, and the
        // task fails, which is logged below.
        q.async {
            let stream = self.input
            self.input = nil
            completionHandler(stream)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        q.async {
            let early = !self.finishing
            self.closed = true
            self.output?.close()
            // A stream that ended before the recording did is the stream failing, not the recording:
            // the hub refuses it as the command's audio and the clip goes up instead, but nothing would
            // notice this one dying now.
            Hub.log(early ? "live-dropped" : "live-done", ["id": self.id, "status": code,
                                                          "error": error.map { String(describing: $0).prefix(120).description } ?? ""])
        }
    }
}
