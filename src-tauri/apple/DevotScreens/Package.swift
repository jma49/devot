// swift-tools-version: 6.0
import PackageDescription

// The iPhone's native screens around the web editor (docs/specs/iphone-screens.md), behind a C ABI
// as DevotStore is. UIKit needs an app with a window, so the tests live in TestHost/.
let package = Package(
    name: "DevotScreens",
    defaultLocalization: "en",
    platforms: [.iOS("26.0")],
    products: [.library(name: "DevotScreens", targets: ["DevotScreens"])],
    targets: [
        .target(
            name: "DevotScreens",
            resources: [.process("Generated/Localizable.xcstrings"), .process("Resources/Brand.xcassets")]
        )
    ]
)
