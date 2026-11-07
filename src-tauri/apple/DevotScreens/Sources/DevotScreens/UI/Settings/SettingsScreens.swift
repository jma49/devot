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
        root.onPair = { [weak self] in self?.router.push(.sync) }
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
        case .sync:
            web("sync", L10n.settingsPaneSync())
        case .ai:
            SettingsHosting(title: L10n.settingsPaneAi(), AiPane(store: store) { [weak self] in self?.buy() })
        case .licence(let entry):
            SettingsHosting(
                title: L10n.settingsPaneLicence(),
                LicencePane(store: store, entry: entry) { [weak self] in self?.buy() })
        }
    }

    private func web(_ pane: String, _ title: String) -> UIViewController {
        WebPaneScreen(pane: pane, title: title, host: host) { [weak self] pane in
            self?.store.bridge?.request(.settingsShowPane, ["pane": .string(pane)]) { outcome in
                if case .failed(let code) = outcome {
                    self?.store.log("W_PHONE_SETTINGS_PANE_FAILED pane=\(pane) code=\(code)")
                }
            }
        }
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

    private func share(_ text: String) {
        guard let sheet = navigation.presentedViewController else { return }
        let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
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
