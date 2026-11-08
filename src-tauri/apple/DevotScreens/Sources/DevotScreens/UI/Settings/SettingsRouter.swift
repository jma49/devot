import UIKit

/// How the License page opens: as it is, with its key field focused, or with a key filled in that
/// waits for the owner's Add.
enum LicenceEntry: Equatable {
    case plain
    case focusKey
    case prefill(String)
}

/// A place a pane opens scrolled to.
enum PaneAnchor: String, Equatable {
    case pairing
}

/// A page under the Settings root.
enum SettingsPage: Equatable {
    case general
    case appearance
    case editing
    case preview
    case sync(anchor: PaneAnchor?)
    case ai
    case licence(LicenceEntry)

    init?(pane: String) {
        switch pane {
        case "general": self = .general
        case "appearance": self = .appearance
        case "editing": self = .editing
        case "preview": self = .preview
        case "sync": self = .sync(anchor: nil)
        case "ai": self = .ai
        case "licence": self = .licence(.plain)
        default: return nil
        }
    }

    /// The name `init(pane:)` reads, which a restored stack keeps.
    var pane: String {
        switch self {
        case .general: "general"
        case .appearance: "appearance"
        case .editing: "editing"
        case .preview: "preview"
        case .sync: "sync"
        case .ai: "ai"
        case .licence: "licence"
        }
    }
}

/// Pushes Settings' pages, and opens one from elsewhere over the Settings root so Back always
/// lands there.
@MainActor
final class SettingsRouter {
    weak var navigation: UINavigationController?
    var make: (SettingsPage) -> UIViewController
    var selectTab: () -> Void = {}
    /// A stack set while the app is in the background is not animated.
    var inFront: () -> Bool = { UIApplication.shared.applicationState == .active }

    init(make: @escaping (SettingsPage) -> UIViewController) {
        self.make = make
    }

    func push(_ page: SettingsPage) {
        push(make(page))
    }

    func push(_ controller: UIViewController) {
        navigation?.pushViewController(controller, animated: true)
    }

    func open(_ page: SettingsPage) {
        guard let navigation, let root = navigation.viewControllers.first else { return }
        selectTab()
        navigation.presentedViewController?.dismiss(animated: false)
        navigation.setViewControllers([root, make(page)], animated: inFront())
    }
}
