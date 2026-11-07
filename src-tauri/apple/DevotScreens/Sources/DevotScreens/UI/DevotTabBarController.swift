import UIKit

/// The system tab bar: icons only, each tab a navigation stack. Settings is native; the other
/// tabs' roots hold the web view.
final class DevotTabBarController: UITabBarController, UITabBarControllerDelegate {
    var onAppear: ((Tab) -> Void)?
    var onReselect: ((Tab) -> Void)?
    let settings: SettingsScreens
    private var screens: [Tab: WebTabScreen] = [:]

    init(host: WebViewHost) {
        settings = SettingsScreens(host: host)
        super.init(nibName: nil, bundle: nil)
        viewControllers = TabModel.tabs.map { tab in
            let navigation: UINavigationController
            if tab == .settings {
                navigation = settings.navigation
                settings.onTabAppear = { [weak self] in self?.onAppear?(.settings) }
            } else {
                let screen = WebTabScreen(tab: tab, host: host) { [weak self] in self?.onAppear?($0) }
                screens[tab] = screen
                navigation = UINavigationController(rootViewController: screen)
                navigation.setNavigationBarHidden(true, animated: false)
            }
            navigation.tabBarItem = Self.item(tab)
            return navigation
        }
        settings.router.selectTab = { [weak self] in self?.select(.settings) }
        selectedIndex = TabModel.tabs.firstIndex(of: .library) ?? 0
        delegate = self
        tabBarMinimizeBehavior = .never
        followTheme { [weak self] in self?.tabBar.tintColor = Tokens.Color.accentText }
    }

    required init?(coder: NSCoder) { nil }

    /// UIBarItem has no large content title; the viewer shows the symbol and VoiceOver reads the label.
    private static func item(_ tab: Tab) -> UITabBarItem {
        let image = UIImage(systemName: TabModel.symbol(tab))
        let item = UITabBarItem(
            title: nil, image: image, selectedImage: UIImage(systemName: TabModel.symbol(tab) + ".fill"))
        item.accessibilityLabel = name(tab)
        item.largeContentSizeImage = image
        return item
    }

    private static func name(_ tab: Tab) -> String {
        switch tab {
        case .notes: L10n.phoneTabNotes()
        case .library: L10n.phoneTabLibrary()
        case .activity: L10n.phoneTabActivity()
        case .settings, .search: L10n.phoneTabSettings()
        }
    }

    func screen(_ tab: Tab) -> WebTabScreen? {
        screens[tab]
    }

    func select(_ tab: Tab) {
        guard let index = TabModel.tabs.firstIndex(of: tab), index != selectedIndex else { return }
        selectedIndex = index
    }

    func setAttention(_ on: Bool) {
        guard let index = TabModel.tabs.firstIndex(of: .settings),
            let item = viewControllers?[index].tabBarItem
        else { return }
        item.badgeValue = TabModel.badgeValue(on)
        item.accessibilityValue = on ? L10n.phoneBadgeAttention() : nil
    }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        if viewController === selectedViewController, let index = viewControllers?.firstIndex(of: viewController) {
            onReselect?(TabModel.tabs[index])
        }
        return true
    }
}
