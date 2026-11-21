import UIKit

/// A tab's one stack, laid out in columns at a wide regular width (docs/specs/iphone-screens.md,
/// Columns). The stack's order stays the record a route, a launch and a save read: a change of
/// layout moves screens between the columns' stacks, without animation, and never makes or drops one.
final class NoteColumns: UIViewController {
    /// The first column, and the only one at one column: the tab's own navigation stack.
    let stack: UINavigationController
    /// The Library's list beside it, with three columns.
    let lists = UINavigationController()
    /// The note's column.
    let notes = UINavigationController()
    let allowsThree: Bool
    private(set) var layout: ColumnLayout = .one
    /// The lists slid away so the note has the width; only while a note shows beside them.
    private(set) var leadingHidden = false
    /// Screens are moving between the columns' stacks: one in none of them has not left the tab.
    private(set) var rearranging = false
    var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
    /// The layout changed, or the lists were hidden or shown.
    var onChange: (() -> Void)?
    /// The note's column was left empty: the page may let its note go.
    var onEmptied: (() -> Void)?
    private let noNote = ColumnPlaceholder(text: L10n.phoneColumnsNoNote())
    private let noList = ColumnPlaceholder(text: L10n.phoneColumnsNoList())
    private let edges = [UIView(), UIView()]

    static let widths = ColumnLayout.Widths(
        twoColumns: Tokens.Size.padTwoColumns, threeColumns: Tokens.Size.padThreeColumns,
        sidebar: Tokens.Size.padSidebarWidth, list: Tokens.Size.padListWidth)

    init(stack: UINavigationController, allowsThree: Bool) {
        self.stack = stack
        self.allowsThree = allowsThree
        super.init(nibName: nil, bundle: nil)
        for column in [lists, notes] {
            column.view.backgroundColor = Tokens.Color.phoneBackground
            column.navigationBar.prefersLargeTitles = false
        }
        lists.setViewControllers([noList], animated: false)
        notes.setViewControllers([noNote], animated: false)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
        adopt(stack)
        for edge in edges {
            edge.isUserInteractionEnabled = false
            edge.isHidden = true
            view.addSubview(edge)
        }
        followTheme { [weak self] in
            for edge in self?.edges ?? [] { edge.backgroundColor = Tokens.Color.phoneSeparator }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        fit(width: view.bounds.width, traits: traitCollection)
        keepTabsRoom()
        place()
    }

    /// UIKit gives a container of its own the room of the tabs floating over its top only once they
    /// next hide and show, so until then its bars sit under them: the columns make up the difference.
    private func keepTabsRoom() {
        var room: CGFloat = 0
        if let tabs = tabBarController, !tabs.isTabBarHidden, view.window != nil {
            room = Self.tabsRoom(
                tabs: tabs.tabBar.convert(tabs.tabBar.bounds, to: view), in: view.bounds,
                given: view.safeAreaInsets.top - additionalSafeAreaInsets.top)
        }
        guard additionalSafeAreaInsets.top != room else { return }
        additionalSafeAreaInsets.top = room
    }

    /// The top inset to add so the safe area clears tabs floating over the top; none for tabs at the foot.
    static func tabsRoom(tabs: CGRect, in bounds: CGRect, given: CGFloat) -> CGFloat {
        guard !tabs.isEmpty, tabs.minY < bounds.midY else { return 0 }
        return max(0, tabs.maxY - bounds.minY - given)
    }

    private func fit(width: CGFloat, traits: UITraitCollection) {
        guard width > 0 else { return }
        let next = ColumnLayout.fitting(
            width: width, regular: traits.horizontalSizeClass == .regular, allowsThree: allowsThree,
            widths: Self.widths)
        if next != layout { UIView.performWithoutAnimation { rearrange(to: next) } }
    }

    /// Every screen of the tab, in stack order, the columns' empty screens left out.
    var controllers: [UIViewController] {
        switch layout {
        case .one: stack.viewControllers
        case .two: stack.viewControllers + Self.real(notes)
        case .three: stack.viewControllers + Self.real(lists) + Self.real(notes)
        }
    }

    /// The stack a note opens on: the note's column while it shows beside the lists.
    var noteStack: UINavigationController { layout == .one ? stack : notes }

    var showsNotesBeside: Bool { layout != .one }

    /// The note's column's width when the columns span `total`.
    func noteWidth(in total: CGFloat) -> CGFloat {
        leadingHidden ? total : layout.columnWidths(total: total, widths: Self.widths).last ?? total
    }

    /// Whether `screen` is the note shown beside the lists.
    func showsBeside(_ screen: UIViewController) -> Bool {
        layout != .one && notes.topViewController === screen
    }

    func setControllers(_ all: [UIViewController], animated: Bool) {
        // A tab a route or a launch fills may not have laid out at this width: a note pushed into its
        // one stack would still be moving when the columns take it, and would stay in the narrow one.
        if let window = view.window {
            window.layoutIfNeeded()
        } else if let parent {
            fit(width: parent.view.bounds.width, traits: parent.traitCollection)
        }
        guard all != controllers else { return }
        distribute(all, animated: animated)
    }

    /// A note opened from a list: beside it, the note replaces the one shown; in one stack it is pushed.
    func open(_ screen: UIViewController) {
        guard layout != .one else { return stack.pushViewController(screen, animated: true) }
        screen.hidesBottomBarWhenPushed = false
        notes.setViewControllers([screen], animated: false)
        if !reduceMotion() { Self.crossfade(notes.view) }
    }

    /// A list the Library opened: beside it, the middle column shows it alone.
    func openList(_ screen: UIViewController) {
        guard layout == .three else { return stack.pushViewController(screen, animated: true) }
        lists.setViewControllers([screen], animated: false)
        if !reduceMotion() { Self.crossfade(lists.view) }
    }

    /// A note's screen goes: popped over an earlier note, or the column left empty.
    func close(_ screen: UIViewController, animated: Bool) {
        let column = screen.navigationController
        guard let column, let at = column.viewControllers.firstIndex(of: screen) else { return }
        if at > 0 {
            if column.topViewController === screen {
                column.popViewController(animated: animated)
            } else {
                column.setViewControllers(Array(column.viewControllers[..<at]), animated: false)
            }
            return
        }
        column.setViewControllers([column === lists ? noList : noNote], animated: false)
        guard column === notes else { return }
        setLeadingHidden(false)
        onEmptied?()
    }

    func setLeadingHidden(_ hidden: Bool) {
        let next = hidden && layout != .one && notes.topViewController is EditorScreen
        guard next != leadingHidden else { return }
        leadingHidden = next
        onChange?()
        guard view.window != nil, !reduceMotion() else { return view.setNeedsLayout() }
        let animator = UIViewPropertyAnimator(
            duration: Tokens.Duration.phoneAdjust, timingParameters: Tokens.Easing.standard.timingParameters)
        animator.addAnimations { [weak self] in
            self?.view.setNeedsLayout()
            self?.view.layoutIfNeeded()
        }
        animator.startAnimation()
    }

    private static func real(_ column: UINavigationController) -> [UIViewController] {
        column.viewControllers.filter { !($0 is ColumnPlaceholder) }
    }

    private static func crossfade(_ view: UIView) {
        UIView.transition(
            with: view, duration: Tokens.Duration.phoneAdjust, options: [.transitionCrossDissolve, .allowUserInteraction],
            animations: nil)
    }

    private func rearrange(to next: ColumnLayout) {
        let all = controllers
        rearranging = true
        defer { rearranging = false }
        layout = next
        if next == .one { leadingHidden = false }
        let columns = shownColumns
        for column in [stack, lists, notes] {
            if columns.contains(column) { adopt(column) } else { release(column) }
        }
        // The lists' columns are narrow: they keep their margins, as at a compact width.
        if next == .one {
            stack.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        } else {
            stack.traitOverrides.horizontalSizeClass = .compact
        }
        lists.traitOverrides.horizontalSizeClass = .compact
        distribute(all, animated: false)
        onChange?()
    }

    /// Each screen into its column: those leaving a column go first, so no screen is ever in two.
    private func distribute(_ all: [UIViewController], animated: Bool) {
        let parts = layout.split(all) { $0 is EditorScreen }
        let columns = shownColumns
        let wasRearranging = rearranging
        rearranging = true
        defer { rearranging = wasRearranging }
        for (column, part) in zip(columns, parts) {
            let kept = column.viewControllers.filter { part.contains($0) }
            if kept.count < column.viewControllers.count { set(column, kept, animated: false) }
        }
        for column in [lists, notes] where !columns.contains(column) {
            set(column, [], animated: false)
        }
        // The tab follows the bar itself (`followBar`): a screen that hides it as it is pushed takes the
        // tabs' room out of the safe area, which a later move between columns never gives back.
        for screen in all where screen is EditorScreen {
            screen.hidesBottomBarWhenPushed = false
        }
        for (column, part) in zip(columns, parts) where column.viewControllers != part {
            set(column, part, animated: animated && column.view.window != nil)
        }
        if !(notes.topViewController is EditorScreen) { leadingHidden = false }
    }

    private func set(_ column: UINavigationController, _ screens: [UIViewController], animated: Bool) {
        let placeholder: UIViewController? = column === notes ? noNote : column === lists ? noList : nil
        let shown = screens.isEmpty ? placeholder.map { [$0] } ?? [] : screens
        guard !shown.isEmpty else { return }
        column.setViewControllers(shown, animated: animated)
    }

    private func adopt(_ column: UINavigationController) {
        guard column.parent !== self else { return }
        addChild(column)
        view.insertSubview(column.view, at: 0)
        column.didMove(toParent: self)
    }

    private func release(_ column: UINavigationController) {
        guard column.parent === self else { return }
        column.willMove(toParent: nil)
        column.view.removeFromSuperview()
        column.removeFromParent()
    }

    private func place() {
        let bounds = view.bounds
        let columns = shownColumns
        let widths = layout.columnWidths(total: bounds.width, widths: Self.widths)
        // Hidden lists slide off the leading edge at their own width rather than squeezing.
        var x: CGFloat = leadingHidden ? -widths.dropLast().reduce(0, +) : 0
        let hairline = Tokens.Size.phoneSeparator
        for (at, column) in columns.enumerated() {
            let last = at == columns.count - 1
            let width = last && leadingHidden ? bounds.width : widths[at]
            column.view.frame = CGRect(x: x, y: 0, width: width, height: bounds.height)
            x += width
            guard at < edges.count else { continue }
            edges[at].isHidden = last
            edges[at].frame = CGRect(x: x - hairline, y: 0, width: hairline, height: bounds.height)
            view.bringSubviewToFront(edges[at])
        }
        for at in columns.count..<max(columns.count, edges.count) { edges[at].isHidden = true }
    }

    private var shownColumns: [UINavigationController] {
        switch layout {
        case .one: [stack]
        case .two: [stack, notes]
        case .three: [stack, lists, notes]
        }
    }
}

/// An empty column's word: no note or no list chosen yet.
final class ColumnPlaceholder: UIViewController {
    private let text: String

    init(text: String) {
        self.text = text
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
        let label = UILabel()
        label.text = text
        label.font = UIFont.preferredFont(forTextStyle: .title3)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = Tokens.Color.phoneTextSecondary
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationController?.setToolbarHidden(true, animated: false)
    }
}
