import Accelerate

/// **Plays audio faster without raising its pitch** (WSOLA), for the live mic's catch-up (`LiveListen`).
/// watchOS has no time stretch of its own (AVAudioUnitTimePitch, Varispeed and the mixer's `rate` are
/// all unavailable there), and a plain resample at 20% fast lifts voices about three semitones.
///
/// The audio is cut into 20ms frames that overlap by half and are laid back down at the normal spacing
/// while being read further apart, so less time passes in the output than in the input. Each frame is
/// read from wherever within ±5ms lines up best with the one before it, which is what keeps the joins
/// from buzzing. At speed 1 the frames are read at exactly their own spacing and the windows sum to
/// one, so the audio comes out unchanged, 10ms late.
struct Stretch {
    private static let n = 480          // 20ms at 24 kHz
    private static let hop = n / 2
    private static let seek = 120       // ±5ms

    /// A periodic Hann window: two of them overlapping by half sum to exactly one.
    private let window: [Float] = (0..<n).map { 0.5 - 0.5 * cos(2 * .pi * Float($0) / Float(n)) }
    private var input: [Float] = []
    /// Where the next frame would start at the current speed, in `input`.
    private var nominal: Double = 0
    /// Where the previous frame started, or nil before the first.
    private var last: Int?
    /// The previous frame's second half, which the next frame's first half is added onto.
    private var tail = [Float](repeating: 0, count: hop)

    mutating func reset() { self = Stretch() }

    /// Takes `samples`, returns what is ready to play at `speed` (1 is as recorded).
    mutating func process(_ samples: UnsafeBufferPointer<Float>, speed: Double) -> [Float] {
        input.append(contentsOf: samples)
        var out: [Float] = []
        while true {
            var start = Int(nominal)
            if let last, speed == 1 {
                start = last + Self.hop
                nominal = Double(start)
            } else if let last {
                guard start + Self.seek + Self.n <= input.count else { break }
                start = bestMatch(around: start, to: last + Self.hop)
            }
            guard start + Self.n <= input.count else { break }
            input.withUnsafeBufferPointer { inp in
                window.withUnsafeBufferPointer { w in
                    for i in 0..<Self.hop { out.append(tail[i] + inp[start + i] * w[i]) }
                    for i in 0..<Self.hop { tail[i] = inp[start + Self.hop + i] * w[Self.hop + i] }
                }
            }
            last = start
            nominal += Double(Self.hop) * speed
        }
        // Keep what the next frame can still reach: its search window, and the continuation it is matched to.
        let keep = min(Int(nominal) - Self.seek, last.map { $0 + Self.hop } ?? 0)
        if keep > 0 {
            input.removeFirst(keep)
            nominal -= Double(keep)
            last = last.map { $0 - keep }
        }
        return out
    }

    /// The start within ±`seek` of `around` whose first half best matches the half starting at `natural`
    /// (what would have followed the previous frame), by normalised correlation.
    private func bestMatch(around: Int, to natural: Int) -> Int {
        input.withUnsafeBufferPointer { inp in
            let base = inp.baseAddress!
            let len = vDSP_Length(Self.hop)
            var best = around, score = -Float.infinity
            for c in max(0, around - Self.seek)...(around + Self.seek) {
                var dot: Float = 0, energy: Float = 0
                vDSP_dotpr(base + c, 1, base + natural, 1, &dot, len)
                vDSP_svesq(base + c, 1, &energy, len)
                let s = dot / (energy + 1e-9).squareRoot()
                if s > score { score = s; best = c }
            }
            return best
        }
    }
}
