import UIKit

/// The system tab bar: icons only, each tab a navigation stack, and the system's Search circle
/// after them. Every tab is native; the web view shows only in a note's screen.
final class DevotTabBarController: UITabBarController, UITabBarControllerDelegate {
    var onAppear: ((Tab) -> Void)?
    var onReselect: ((Tab) -> Void)?
    let settings: SettingsScreens
    let lists = ListContext()
    let toasts = ToastPresenter()
    private(set) var search: SearchScreen!
    private(set) var searchTab: UISearchTab!
    private(set) var listRoots: [Tab: ListScreen] = [:]
    private(set) var navigations: [Tab: UINavigationController] = [:]
    private(set) var items: [Tab: UITab] = [:]

    init() {
        settings = SettingsScreens()
        super.init(nibName: nil, bundle: nil)
        for tab in TabModel.tabs + [.search] { navigations[tab] = navigation(tab) }
        var shown: [UITab] = TabModel.tabs.map { tab in
            let navigation = navigations[tab]!
            let item = UITab(title: "", image: UIImage(systemName: TabModel.symbol(tab)), identifier: tab.rawValue) { _ in
                navigation
            }
            // UITab.selectedImage first appears in the iOS 27 SDK (Swift 6.4); CI builds with the iOS 26 SDK.
            #if compiler(>=6.4)
                if #available(iOS 26.1, *) { item.selectedImage = UIImage(systemName: TabModel.symbol(tab) + ".fill") }
            #endif
            item.accessibilityLabel = Self.name(tab)
            item.accessibilityIdentifier = tab.rawValue
            items[tab] = item
            return item
        }
        let searchNavigation = navigations[.search]!
        searchTab = UISearchTab { _ in searchNavigation }
        searchTab.automaticallyActivatesSearch = true
        searchTab.accessibilityLabel = Self.name(.search)
        searchTab.accessibilityIdentifier = Tab.search.rawValue
        items[.search] = searchTab
        shown.append(searchTab)
        tabs = shown
        settings.router.selectTab = { [weak self] in self?.select(.settings) }
        selectedTab = items[.library]
        delegate = self
        tabBarMinimizeBehavior = .never
        followTheme { [weak self] in self?.tabBar.tintColor = Tokens.Color.accentText }
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        toasts.attach(to: view)
        toasts.barTop = { [weak self] in self?.visibleBarTop }
        lists.undoToasts = toasts
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        toasts.hostDidLayout()
    }

    /// The tab bar's top edge, or nil while a pushed screen has taken the bar away.
    private var visibleBarTop: CGFloat? {
        guard !tabBar.isHidden, tabBar.alpha > 0 else { return nil }
        let top = view.convert(tabBar.bounds, from: tabBar).minY
        return top < view.bounds.maxY - 1 ? top : nil
    }

    private func navigation(_ tab: Tab) -> UINavigationController {
        guard let root = listRoot(tab) else {
            settings.onTabAppear = { [weak self] in self?.onAppear?(.settings) }
            return settings.navigation
        }
        listRoots[tab] = root
        root.onAppear = { [weak self] in self?.onAppear?($0) }
        let navigation = UINavigationController(rootViewController: root)
        navigation.navigationBar.prefersLargeTitles = true
        navigation.view.backgroundColor = Tokens.Color.phoneBackground
        if let library = root as? LibraryScreen {
            library.push = { [weak navigation] in navigation?.pushViewController($0, animated: true) }
            library.openSearch = { [weak self] in self?.openSearch($0) }
        }
        return navigation
    }

    static func name(_ tab: Tab) -> String {
        switch tab {
        case .notes: L10n.phoneTabNotes()
        case .library: L10n.phoneTabLibrary()
        case .activity: L10n.phoneTabActivity()
        case .settings: L10n.phoneTabSettings()
        case .search: L10n.phoneTabSearch()
        }
    }

    private func listRoot(_ tab: Tab) -> ListScreen? {
        switch tab {
        case .notes: return NoteListScreen(title: L10n.phoneTabNotes(), view: .all, tab: .notes, context: lists, isRoot: true)
        case .library: return LibraryScreen(tab: .library, context: lists)
        case .search:
            search = SearchScreen(context: lists)
            return search
        case .activity: return ActivityScreen(context: lists)
        case .settings: return nil
        }
    }

    var selected: Tab? {
        selectedTab.flatMap(tab(of:))
    }

    var shownNavigation: UINavigationController? {
        selected.flatMap { navigations[$0] }
    }

    private func tab(of item: UITab) -> Tab? {
        items.first { $0.value === item }?.key
    }

    func select(_ tab: Tab) {
        guard let item = items[tab], item !== selectedTab else { return }
        selectedTab = item
    }

    /// A saved search from the Library: the Search tab at its root, run without raising the keyboard.
    /// The keyboard stays down until the person next chooses the Search tab themselves.
    func openSearch(_ query: String) {
        searchTab.automaticallyActivatesSearch = false
        navigations[.search]?.popToRootViewController(animated: false)
        select(.search)
        search.show(query: query)
    }

    func setAttention(_ on: Bool) {
        guard let item = items[.settings] else { return }
        item.badgeValue = TabModel.badgeValue(on)
        item.accessibilityValue = on ? L10n.phoneBadgeAttention() : nil
    }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        if tab === searchTab { searchTab.automaticallyActivatesSearch = true }
        if tab === selectedTab, let shown = self.tab(of: tab) { onReselect?(shown) }
        return true
    }
}
