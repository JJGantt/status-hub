import AVFoundation

/// The last `capacity` samples of audio, oldest overwritten first. A fixed array and a write index, so
/// holding minutes of audio costs one allocation and nothing per buffer: 16 kHz mono floats are 64 KB a
/// second, so two minutes is about 7.7 MB.
///
/// Pure on purpose — no watch API — so `tools/test-rewind.swift` compiles it on the Mac and checks the
/// wrap-around without a device (`docs/REWIND.md`).
struct RewindBuffer {
    let capacity: Int
    private var samples: [Float]
    /// Where the next sample goes.
    private var next = 0
    /// How many samples it holds: grows to `capacity` and stays there.
    private(set) var count = 0

    init(capacity: Int) {
        self.capacity = max(1, capacity)
        samples = [Float](repeating: 0, count: self.capacity)
    }

    mutating func append(_ input: UnsafeBufferPointer<Float>) {
        guard var base = input.baseAddress else { return }
        var left = input.count
        // More than the whole ring in one go: only its tail can survive.
        if left > capacity {
            base += left - capacity
            left = capacity
        }
        samples.withUnsafeMutableBufferPointer { ring in
            while left > 0 {
                let run = min(left, capacity - next)
                (ring.baseAddress! + next).update(from: base, count: run)
                base += run
                left -= run
                next = (next + run) % capacity
                count = min(capacity, count + run)
            }
        }
    }

    mutating func append(_ input: [Float]) {
        input.withUnsafeBufferPointer { append($0) }
    }

    /// What it holds, oldest first.
    func snapshot() -> [Float] {
        guard count == capacity else { return Array(samples[0..<count]) }
        return Array(samples[next...] + samples[..<next])
    }
}

enum RewindAudio {
    /// Writes mono float samples to an .m4a at the same settings as every other clip the watch sends
    /// (`Sink.open` in Recorder.swift), so the hub's Whisper hears a rewind exactly as it hears a command.
    static func writeM4A(_ samples: [Float], rate: Double, to url: URL) throws {
        let file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: rate,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
        let chunk = 16_384
        var at = 0
        while at < samples.count {
            let n = min(chunk, samples.count - at)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(n))
            else { throw CocoaError(.fileWriteUnknown) }
            buffer.frameLength = AVAudioFrameCount(n)
            samples.withUnsafeBufferPointer { src in
                buffer.floatChannelData![0].update(from: src.baseAddress! + at, count: n)
            }
            try file.write(from: buffer)
            at += n
        }
    }
}
