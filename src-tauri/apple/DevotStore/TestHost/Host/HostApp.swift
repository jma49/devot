import SwiftUI

// StoreKit Test runs only inside an app; the tests are hosted in this empty one.
@main
struct HostApp: App {
    var body: some Scene {
        WindowGroup { EmptyView() }
    }
}
