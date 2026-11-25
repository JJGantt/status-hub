import SwiftUI

/// Watchset's page in the app: counting reps, and recording a set without counting it (how new
/// reference recordings get made).
public struct WatchsetPage: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                NavigationLink {
                    SessionView()
                } label: {
                    Label("Count reps", systemImage: "figure.strengthtraining.traditional")
                }
                NavigationLink {
                    CaptureView()
                } label: {
                    Label("Record a set", systemImage: "waveform.path.ecg")
                }
            }
            .navigationTitle("Watchset")
        }
        // A recording that could not be sent waits on the watch; opening the page tries again.
        .onAppear { CaptureUploader.flush() }
    }
}
