// swift-tools-version: 6.0
import PackageDescription

// The iPhone's Share Extension (docs/specs/share-extension.md). DevotShareInbox is the inbox both
// sides read: the extension writes it, the app's native screens drain it. DevotShare is the
// extension's compose sheet; only the extension links it.
let package = Package(
    name: "DevotShare",
    defaultLocalization: "en",
    platforms: [.iOS("26.0")],
    products: [
        .library(name: "DevotShareInbox", targets: ["DevotShareInbox"]),
        .library(name: "DevotShare", targets: ["DevotShare"]),
    ],
    targets: [
        .target(name: "DevotShareInbox"),
        .target(
            name: "DevotShare",
            dependencies: ["DevotShareInbox"],
            resources: [.process("Generated/Localizable.xcstrings")]
        ),
    ]
)
