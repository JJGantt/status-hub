// swift-tools-version:6.0
import PackageDescription

// Watchset: the rep counter's watch feature (motion capture, the session loop, feedback, reporting
// and its screens), run inside the Status Hub watch app. The app supplies the workout session, the
// network and the log through `WatchsetHost`; this package holds none of its own.
let package = Package(
    name: "Watchset",
    platforms: [.watchOS(.v11)],
    products: [.library(name: "Watchset", targets: ["Watchset"])],
    dependencies: [
        // The rep counter, from a private package. ~/repos/Workset/Interface/RepCounter.swiftinterface
        // is its public surface.
        // Pinned by commit: the 1.1.0 tag was moved once, and a moved tag fails SwiftPM's fingerprint check.
        // c22c9a9 is what that tag names now.
        .package(url: "git@github.com:JJGantt/Workset-Algorithms.git", revision: "c22c9a96932c178e7b4e1d8776ff40f219bd6e18"),
        // The session loop around the counter, kept free of it so it tests anywhere.
        .package(path: "../SessionCore"),
    ],
    targets: [
        .target(
            name: "Watchset",
            dependencies: [
                .product(name: "RepCounter", package: "Workset-Algorithms"),
                .product(name: "SessionCore", package: "SessionCore"),
            ],
            // Pre-rendered rep numbers (n1-n50) and the two tones, played by `Feedback`.
            resources: [.copy("Resources")]
        ),
    ]
)
