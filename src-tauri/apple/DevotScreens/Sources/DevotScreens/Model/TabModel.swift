/// Which tab the system bar and the page each show, and what to do so they agree. Search is
/// native alone: the page has no tab for it, so it is neither told of it nor followed away from it.
struct TabModel {
    /// The tabs the page knows; the system bar adds Search after them.
    static let tabs: [Tab] = [.notes, .library, .activity, .settings]

    enum Effect: Equatable {
        case show(Tab)
        case popToRoot(Tab)
        case select(Tab)
        case hideBar(Bool)
        case badge(Bool)
    }

    /// The fields of a `tabs.state` notice.
    struct PageState: Equatable {
        let tab: Tab
        let barHidden: Bool
        let attention: Bool

        init(tab: Tab, barHidden: Bool, attention: Bool) {
            self.tab = tab
            self.barHidden = barHidden
            self.attention = attention
        }

        init?(_ fields: [String: JSONValue]) {
            guard case .string(let name)? = fields["tab"], let tab = Tab(rawValue: name),
                TabModel.tabs.contains(tab), case .bool(let barHidden)? = fields["barHidden"],
                case .bool(let attention)? = fields["attention"]
            else { return nil }
            self.init(tab: tab, barHidden: barHidden, attention: attention)
        }
    }

    private(set) var selected: Tab = .library
    private var shown: Tab?
    private var unanswered = 0
    private var barHidden = false
    private var attention = false

    mutating func appeared(_ tab: Tab) -> [Effect] {
        selected = tab
        guard tab != shown, tab != .search else { return [] }
        shown = tab
        unanswered += 1
        return [.show(tab)]
    }

    func reselected(_ tab: Tab) -> [Effect] {
        tab == selected && tab != .search ? [.popToRoot(tab)] : []
    }

    mutating func showAnswered() {
        unanswered = max(0, unanswered - 1)
    }

    /// The page's tab is stale while a `tabs.show` is unanswered, so it is followed only after.
    mutating func pageState(tab: Tab, barHidden: Bool, attention: Bool) -> [Effect] {
        var effects: [Effect] = []
        if barHidden != self.barHidden {
            self.barHidden = barHidden
            effects.append(.hideBar(barHidden))
        }
        if attention != self.attention {
            self.attention = attention
            effects.append(.badge(attention))
        }
        guard unanswered == 0 else { return effects }
        let moved = tab != shown
        shown = tab
        if tab != selected, moved || selected != .search {
            selected = tab
            effects.append(.select(tab))
        }
        return effects
    }

    static func badgeValue(_ on: Bool) -> String? {
        on ? "!" : nil
    }

    /// The outline symbol; the selected tab takes its `.fill` variant, as `design/icons/symbols.json` lists.
    static func symbol(_ tab: Tab) -> String {
        switch tab {
        case .notes: "doc.text"
        case .library: "folder"
        case .activity: "chart.bar"
        case .settings: "gearshape"
        case .search: "magnifyingglass"
        }
    }
}
