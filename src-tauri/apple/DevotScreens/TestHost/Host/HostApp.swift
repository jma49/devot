import SwiftUI

// UIKit's tests need an app with a window scene; they are hosted in this empty one.
@main
struct HostApp: App {
    var body: some Scene {
        WindowGroup { EmptyView() }
    }
}
