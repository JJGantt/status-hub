import SwiftUI
import WatchKit

/// Inline markdown (bold, italics, code) renders; anything else stays as written.
func inlineMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
}

/// A reply's opening for the line under a title: its markdown syntax gone and none of the bold, code
/// or link styling kept, so it reads as one quiet run of text.
func snippet(_ s: String) -> AttributedString {
    var a = inlineMarkdown(s)
    a.inlinePresentationIntent = nil
    a.link = nil
    return a
}

/// The row a recording shows under its page: two buttons of one size, the lock on the left and Cancel
/// on the right. The lock appears only on a recording that ends itself at the silence after speech,
/// and holds it open until a press sends it; without it, Cancel keeps its place and the left half is
/// empty. The stop control at the bottom edge is what says a recording is under way.
///
/// Until it is locked, the lock holds double tap, so the gesture that started the recording locks it
/// and the next one — back on the bottom control — sends it.
struct RecordingBar: View {
    let cancel: () -> Void
    @ObservedObject private var capture = Capture.shared
    @Environment(\.onScreen) private var onScreen

    var body: some View {
        HStack(spacing: 8) {
            if capture.endsOnSilence {
                Button(action: capture.toggleLock) {
                    Image(systemName: capture.locked ? "lock.fill" : "lock.open")
                        .frame(maxWidth: .infinity)
                }
                .tint(capture.locked ? .orange : .gray)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .handGestureShortcut(.primaryAction, isEnabled: onScreen && capture.lockHoldsDoubleTap)
            } else {
                Color.clear.frame(maxWidth: .infinity, maxHeight: 0)
            }
            Button(action: cancel) {
                Text("Cancel").lineLimit(1).frame(maxWidth: .infinity)
            }
            .tint(.red)
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }
}

/// One step of a running turn, as the machine running it reports it: a tool call, or what the model
/// said between two of them (`thought`).
struct ActivityLine: Equatable {
    let text: String
    let thought: Bool
}

/// A running turn's steps, oldest first. A tool call is one grey line; a thought is read in full.
struct ActivityLines: View {
    let lines: [ActivityLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                if line.thought {
                    Text(inlineMarkdown(line.text))
                        .font(.system(size: 12))
                        .foregroundColor(Color(white: 0.78))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(line.text)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.gray)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// The control every page puts under double tap, at the bottom edge: a mic that records, a stop that
/// sends, and on home the state of the microphone drawn in the same spot. **Double tap always starts a
/// prompt** — scrolling is a finger or the crown, never the gesture. It never disappears, and it gives
/// the gesture up in one case only: to the recording bar's lock while a command records unlocked
/// (`holdsDoubleTap`), so exactly one binding is live at any moment.
struct BottomControl: View {
    /// `glyph` is home's: the state of the microphone and the command drawn in this same spot, since
    /// that page has one indicator and it is here.
    enum Mode: Equatable { case record, stop, glyph(String, Color), working }

    /// How much room the control needs at the foot of a page, so text does not run under it.
    static let height: CGFloat = 34

    let mode: Mode
    let enabled: Bool
    /// False while the recording bar's lock holds double tap instead.
    var holdsDoubleTap = true
    let action: () -> Void
    /// Held rather than pressed. Home engages always-on listening this way, since the press records.
    var onHold: (() -> Void)?
    /// Home's control is the page's only one and its state indicator, so it takes a target worth
    /// hitting; a conversation page's sits under text and stays small.
    var big = false
    @Environment(\.onScreen) private var onScreen
    /// A hold has just fired, so the press that ends it is not also acted on.
    @State private var held = false

    var body: some View {
        // A full-height column reaching past the safe area puts the control on the screen's physical
        // bottom edge in either scroll frame. Its empty top takes no touches, so taps reach the page.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            ZStack(alignment: .bottom) {
                Button(action: { if held { held = false } else { action() } }) {
                    Group {
                        if mode == .working {
                            ProgressView().controlSize(big ? .small : .mini)
                        } else {
                            Image(systemName: symbol)
                                .font(.system(size: big ? 20 : 15, weight: .semibold))
                                .foregroundColor(colour)
                        }
                    }
                    .opacity(enabled ? 1 : 0.4)
                    .frame(width: big ? 110 : 44, height: big ? 34 : 18)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // A Button's own gesture swallows `onLongPressGesture` on watchOS, so the hold runs
                // beside it and cancels the press it ends.
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                    held = true
                    onHold?()
                })
                // Live only while the page is the one showing and the lock is not holding the gesture:
                // every page stays alive in the TabView, and two live bindings leave the system to pick.
                .handGestureShortcut(.primaryAction, isEnabled: onScreen && enabled && holdsDoubleTap)
                .disabled(!enabled)
                .padding(.bottom, 9)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
    }

    private var symbol: String {
        switch mode {
        case .record: "mic.fill"
        case .stop: "stop.fill"
        case .glyph(let name, _): name
        case .working: ""
        }
    }

    private var colour: Color {
        switch mode {
        case .stop: .red
        case .glyph(_, let colour): colour
        default: .gray
        }
    }
}

extension EnvironmentValues {
    /// Whether the page this view is on is the one showing. Every page of the app stays alive side by
    /// side in the TabView, so a control that binds double tap asks this first.
    @Entry var onScreen: Bool = true
}

/// The scrolling both conversation pages share, so the bottom control and the double-tap handover
/// cannot differ between them. Scrolling is his finger or the crown; the gesture is the prompt's.
struct PagedScroll<Content: View>: View {
    /// What a log line calls this page: "chat" or "session".
    let name: String
    let recording: Bool
    /// Whether a recording may start now — not while the page is waiting on a command or a send.
    var canRecord = true
    /// The recording bar's lock holds double tap for now (`Capture.lockHoldsDoubleTap`).
    var lockHoldsDoubleTap = false
    /// Starts a recording, or sends the one under way.
    let record: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                content()
                Color.clear.frame(height: 1).id("tail")
            }
            .padding(.horizontal, 8)
            .padding(.bottom, BottomControl.height)
        }
        .scrollIndicators(.never)
        .overlay {
            BottomControl(mode: recording ? .stop : .record, enabled: recording || canRecord,
                          holdsDoubleTap: !lockHoldsDoubleTap, action: press)
        }
        .background(Color.black.ignoresSafeArea())
    }

    private func press() {
        Hub.log("control", ["view": name, "mode": recording ? "stop" : "record"])
        record()
    }
}
