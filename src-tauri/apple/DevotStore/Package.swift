// swift-tools-version: 6.0
import PackageDescription

// StoreKit 2 behind a C ABI for the iPhone app (docs/adr/0014). Its tests need StoreKit Test,
// which runs only inside an app, so they live in TestHost/ rather than in a test target here.
let package = Package(
    name: "DevotStore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "DevotStore", targets: ["DevotStore"])],
    targets: [.target(name: "DevotStore")]
)
