import UIKit

/// The system tab bar: icons only, each tab a navigation stack, and the system's Search circle
/// after them. Every tab is native; the web view shows only in a note's screen.
final class DevotTabBarController: UITabBarController, UITabBarControllerDelegate {
    var onAppear: ((Tab) -> Void)?
    /// A key command of the whole app, from a hardware keyboard.
    var onKey: ((AppKey) -> Void)?
    var onReselect: ((Tab) -> Void)?
    let settings: SettingsScreens
    let lists = ListContext()
    let toasts = ToastPresenter()
    private(set) var search: SearchScreen!
    private(set) var searchTab: UISearchTab!
    private(set) var listRoots: [Tab: ListScreen] = [:]
    private(set) var navigations: [Tab: UINavigationController] = [:]
    /// The tabs whose stack lays out in columns at a wide regular width: an iPad's.
    private(set) var columns: [Tab: NoteColumns] = [:]
    /// An iPad's Notes and Library show their lists beside the note; tests turn it on for an iPhone.
    static var usesColumns = UIDevice.current.userInterfaceIdiom == .pad
    private(set) var items: [Tab: UITab] = [:]
    private var pageHidesBar = false

    init() {
        settings = SettingsScreens()
        super.init(nibName: nil, bundle: nil)
        for tab in TabModel.tabs + [.search] { navigations[tab] = navigation(tab) }
        if Self.usesColumns {
            for tab in [Tab.notes, .library] { columns[tab] = makeColumns(tab) }
        }
        var shown: [UITab] = TabModel.tabs.map { tab in
            let content: UIViewController = columns[tab] ?? navigations[tab]!
            let item = UITab(title: "", image: UIImage(systemName: TabModel.symbol(tab)), identifier: tab.rawValue) { _ in
                content
            }
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
        return Self.bottomBarTop(view.convert(tabBar.bounds, from: tabBar), in: view.bounds)
    }

    /// Nil for a bar slid off the bottom, or for an iPad's, which runs along the top.
    static func bottomBarTop(_ bar: CGRect, in bounds: CGRect) -> CGFloat? {
        bar.minY < bounds.maxY - 1 && bar.minY > bounds.midY ? bar.minY : nil
    }

    private func makeColumns(_ tab: Tab) -> NoteColumns {
        let navigation = navigations[tab]!
        let made = NoteColumns(stack: navigation, allowsThree: tab == .library)
        made.reduceMotion = { [weak self] in self?.lists.reduceMotion() ?? false }
        made.onChange = { [weak self, weak made] in
            self?.followBar()
            (made?.notes.topViewController as? EditorScreen)?.showColumnsItem()
        }
        made.onEmptied = { [weak self] in self?.lists.hideEditor {} }
        if let library = listRoots[tab] as? LibraryScreen {
            library.push = { [weak made] in made?.openList($0) }
        }
        return made
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

    /// The stack a note opens on in a tab: the note's column while it shows beside the lists.
    func noteStack(_ tab: Tab) -> UINavigationController? {
        columns[tab]?.noteStack ?? navigations[tab]
    }

    var shownNoteStack: UINavigationController? {
        selected.flatMap(noteStack)
    }

    /// Every screen of a tab, in stack order, whichever columns they show in.
    func controllers(_ tab: Tab) -> [UIViewController] {
        columns[tab]?.controllers ?? navigations[tab]?.viewControllers ?? []
    }

    func setControllers(_ tab: Tab, _ stack: [UIViewController], animated: Bool) {
        if let columns = columns[tab] { return columns.setControllers(stack, animated: animated) }
        guard let navigation = navigations[tab], navigation.viewControllers != stack else { return }
        navigation.setViewControllers(stack, animated: animated)
    }

    /// The size a note opens at in the shown tab: its column's beside the lists, else the window's.
    func restingPageSize(_ window: CGSize) -> CGSize {
        guard let columns = selected.flatMap({ columns[$0] }), columns.showsNotesBeside else { return window }
        return CGSize(width: columns.noteWidth(in: window.width), height: window.height)
    }

    /// Screens are moving between a tab's columns: one in none of them has not left.
    var rearranging: Bool {
        columns.values.contains { $0.rearranging }
    }

    /// Whether `screen` is the note shown beside its lists.
    func showsBeside(_ screen: UIViewController) -> Bool {
        columns.values.contains { $0.showsBeside(screen) }
    }

    private func tab(of item: UITab) -> Tab? {
        items.first { $0.value === item }?.key
    }

    func select(_ tab: Tab) {
        guard let item = items[tab], item !== selectedTab else { return }
        selectedTab = item
        followBar()
    }

    func hideBarForPage(_ hidden: Bool) {
        pageHidesBar = hidden
        followBar()
    }

    /// The page hides the bar only over a note's screen: a tab it sends the person to from a note
    /// keeps the bar, or nothing would lead back. In an iPad's columns a note pushed over its list
    /// takes the bar away, as a push in a tab's own stack does, and a note beside its lists keeps it.
    func followBar() {
        let onNote = shownNoteStack?.topViewController is EditorScreen
        let hidden: Bool
        if let shown = selected.flatMap({ columns[$0] }) {
            hidden = onNote && !shown.showsNotesBeside
        } else {
            hidden = onNote && pageHidesBar
        }
        if isTabBarHidden != hidden { setTabBarHidden(hidden, animated: true) }
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

enum AppKey {
    case newNote, today, search, settings
}

extension DevotTabBarController {
    /// The app's own keys, which every screen inherits, named in the list a held Command shows.
    override var keyCommands: [UIKeyCommand]? {
        guard presentedViewController == nil else { return [] }
        return [
            UIKeyCommand(title: L10n.noteListNewNote(), action: #selector(newNoteKey), input: "n", modifierFlags: .command),
            UIKeyCommand(
                title: L10n.commandOpenToday(), action: #selector(todayKey), input: "t", modifierFlags: [.command, .alternate]),
            UIKeyCommand(
                title: L10n.commandSearchAll(), action: #selector(searchKey), input: "f", modifierFlags: [.command, .shift]),
            UIKeyCommand(title: L10n.phoneKeySettings(), action: #selector(settingsKey), input: ",", modifierFlags: .command),
        ]
    }

    @objc private func newNoteKey() { onKey?(.newNote) }
    @objc private func todayKey() { onKey?(.today) }
    @objc private func searchKey() { onKey?(.search) }
    @objc private func settingsKey() { onKey?(.settings) }

    /// The Search tab with its field taking the keys, as choosing the tab does.
    func startSearch() {
        searchTab.automaticallyActivatesSearch = true
        select(.search)
    }
}
