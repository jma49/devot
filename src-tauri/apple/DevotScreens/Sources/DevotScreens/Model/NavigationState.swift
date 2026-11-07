/// The tabs, in the tab bar's order.
public enum Tab: String, CaseIterable, Codable, CodingKeyRepresentable, Sendable {
    case notes
    case library
    case activity
    case settings
    case search
}

/// A screen pushed onto a tab's stack.
public enum Route: Codable, Equatable, Sendable {
    case notebook(id: String)
    case note(id: String)
    case pane(String)
}

/// Which tab is selected and what each tab has pushed, kept across launches.
public struct NavigationState: Codable, Equatable, Sendable {
    public private(set) var tab: Tab = .notes
    public private(set) var stacks: [Tab: [Route]] = [:]

    public init() {}

    /// The selected tab keeps the stack it had.
    public mutating func select(_ tab: Tab) {
        self.tab = tab
    }

    public mutating func push(_ route: Route) {
        stacks[tab, default: []].append(route)
    }

    /// At a tab's root this does nothing.
    public mutating func pop() {
        guard stacks[tab]?.popLast() != nil else { return }
        if stacks[tab]?.isEmpty == true { stacks[tab] = nil }
    }

    public var top: Route? { stacks[tab]?.last }
}
