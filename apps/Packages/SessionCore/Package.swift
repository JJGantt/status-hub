// swift-tools-version:6.0
import PackageDescription

// The session loop the watch app runs, with the rep counter abstracted away so it
// builds and tests anywhere — including CI, which cannot fetch the private counter.
let package = Package(
    name: "SessionCore",
    platforms: [.watchOS(.v11), .iOS(.v18), .macOS(.v14)],
    products: [.library(name: "SessionCore", targets: ["SessionCore"])],
    targets: [
        .target(name: "SessionCore"),
        .testTarget(name: "SessionCoreTests", dependencies: ["SessionCore"]),
    ]
)
