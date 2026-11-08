import SwiftUI
import UIKit

/// The Settings tab's stack: tells the tab bar when the tab shows, whatever page is on top.
final class SettingsNavigationController: UINavigationController {
    var onAppear: () -> Void = {}

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        onAppear()
    }
}

/// The native Settings: its stack, the snapshots its pages read, and the sheets they open.
@MainActor
final class SettingsScreens {
    let store = SettingsStore()
    let query = SettingsQuery()
    let router: SettingsRouter
    let navigation: SettingsNavigationController
    private(set) var root: SettingsRootScreen!
    private let host: WebViewHost
    /// The tab shows, whatever page is on top.
    var onTabAppear: () -> Void = {}
    /// Lets a note the page shows go and calls back once it has, so a web pane never shows the note.
    var hideEditor: (@escaping () -> Void) -> Void = { $0() }

    var bridge: (any SettingsBridge)? {
        get { store.bridge }
        set { store.bridge = newValue }
    }

    init(host: WebViewHost) {
        self.host = host
        router = SettingsRouter { _ in UIViewController() }
        navigation = SettingsNavigationController()
        navigation.navigationBar.prefersLargeTitles = true
        navigation.view.backgroundColor = Tokens.Color.phoneBackground
        router.navigation = navigation
        router.make = { [unowned self] in controller($0) }
        let actions = SettingsActions(
            open: { [weak self] in self?.router.push($0) },
            showTrial: { [weak self] in self?.showTrial(endsAt: $0) },
            showMacKey: { [weak self] in self?.showMacKey() })
        root = SettingsRootScreen(store: store, query: query, actions: actions)
        root.onPair = { [weak self] in self?.router.push(.sync(anchor: .pairing)) }
        root.onAppear = { [weak self] in self?.store.load() }
        navigation.onAppear = { [weak self] in
            guard let self else { return }
            onTabAppear()
            if navigation.topViewController !== root { store.load() }
        }
        navigation.setViewControllers([root], animated: false)
    }

    func controller(_ page: SettingsPage) -> UIViewController {
        switch page {
        case .general:
            SettingsHosting(title: L10n.settingsPaneGeneral(), GeneralPane(store: store, router: router))
        case .appearance:
            web("appearance", L10n.settingsPaneAppearance())
        case .editing:
            SettingsHosting(title: L10n.settingsPaneEditing(), EditingPane(store: store, router: router))
        case .preview:
            SettingsHosting(title: L10n.settingsPanePreview(), PreviewPane(store: store))
        case .sync(let anchor):
            web("sync", L10n.settingsPaneSync(), anchor: anchor)
        case .ai:
            SettingsHosting(title: L10n.settingsPaneAi(), AiPane(store: store) { [weak self] in self?.buy() })
        case .licence(let entry):
            SettingsHosting(
                title: L10n.settingsPaneLicence(),
                LicencePane(store: store, entry: entry) { [weak self] in self?.buy() })
        }
    }

    private func web(_ pane: String, _ title: String, anchor: PaneAnchor? = nil) -> UIViewController {
        WebPaneScreen(
            pane: pane, anchor: anchor, title: title, host: host,
            show: { [weak self] pane, anchor, shown in
                var args: [String: JSONValue] = ["pane": .string(pane)]
                if let anchor { args["anchor"] = .string(anchor.rawValue) }
                self?.hideEditor { [weak self] in
                    self?.store.bridge?.request(.settingsShowPane, args) { outcome in
                        if case .failed(let code) = outcome {
                            self?.store.log("W_PHONE_SETTINGS_PANE_FAILED pane=\(pane) code=\(code)")
                        }
                        shown()
                    }
                }
            },
            left: { [weak self] in
                self?.store.bridge?.request(.tabsPopToRoot, ["tab": .string(Tab.settings.rawValue)]) { outcome in
                    if case .failed(let code) = outcome {
                        self?.store.log("W_PHONE_SETTINGS_PANE_LEAVE_FAILED pane=\(pane) code=\(code)")
                    }
                }
            })
    }

    /// The App Store build buys in the purchase sheet; a direct build at the licence site.
    func buy() {
        guard store.licence?.soldOnAppStore == true else {
            UIApplication.shared.open(Licence.buyURL)
            return
        }
        if store.products.isEmpty { store.loadProducts() }
        present(
            PurchaseSheet(
                store: store,
                close: { [weak self] in self?.dismissSheet() },
                enterKey: { [weak self] in
                    self?.dismissSheet()
                    self?.router.open(.licence(.focusKey))
                }))
    }

    private func showTrial(endsAt: Date) {
        present(
            TrialSheet(endsAt: endsAt, store: store.licence?.soldOnAppStore == true) { [weak self] in
                self?.dismissSheet()
            })
    }

    private func showMacKey() {
        present(
            MacKeySheet(
                store: store,
                done: { [weak self] in self?.dismissSheet() },
                share: { [weak self] key in self?.share(key) }))
    }

    private func share(_ key: String) {
        guard let sheet = navigation.presentedViewController else { return }
        let activity = UIActivityViewController(activityItems: MacKeyShare.items(key: key), applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = sheet.view
        sheet.present(activity, animated: true)
    }

    private func present(_ content: some View) {
        navigation.presentedViewController?.dismiss(animated: false)
        navigation.present(ContentSheetController(content), animated: true)
    }

    private func dismissSheet() {
        navigation.presentedViewController?.dismiss(animated: true)
    }
}
