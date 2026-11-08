import UIKit

/// A note list's rows, read from Rust (`direct.lists.notes`) and read again when the page reports
/// a change (docs/specs/iphone-screens.md, List feed). It decides what the list shows and redraws;
/// the screen only applies it.
@MainActor
final class NoteListDataSource {
    enum Section: String, CaseIterable, Hashable, Sendable {
        case pinned
        case recent
        case completed

        var name: String {
            switch self {
            case .pinned: L10n.sidebarPinned()
            case .recent: L10n.phoneListRecent()
            case .completed: L10n.statusCompleted()
            }
        }
    }

    struct Layout: Equatable {
        var sections: [Section] = []
        var ids: [Section: [String]] = [:]
    }

    struct Update: Equatable {
        let layout: Layout
        /// Rows still listed whose content may have changed.
        let reconfigured: Set<String>
        let animated: Bool
        /// The first page read again from scratch: the list redraws it whole.
        let reloaded: Bool
        let selected: String?
    }

    /// `PAGE_ROWS` and `MAX_PAGE_ROWS` in src-tauri/src/screens/lists.rs.
    static let pageRows = 200
    static let maxRows = 1000

    private enum Read: Int, Comparable {
        case none
        case more
        case refresh
        case reload

        static func < (a: Read, b: Read) -> Bool { a.rawValue < b.rawValue }
    }

    weak var bridge: (any SettingsBridge)?
    let view: ListView
    private(set) var status: StatusFilter
    var onUpdate: (Update) -> Void = { _ in }
    var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }

    private var order: [String] = []
    private var rows: [String: NoteRow] = [:]
    private(set) var total = 0
    private(set) var loaded = false
    /// Its screen asked for the rows; a list nobody shows reads nothing.
    private(set) var wanted = false
    private(set) var layout = Layout()
    private var lastRev: Double?
    private var reading = false
    private var next = Read.none
    private var named: Set<String> = []
    private var selecting: String?

    init(view: ListView, status: StatusFilter = .all, bridge: (any SettingsBridge)?) {
        self.view = view
        self.status = status
        self.bridge = bridge
    }

    func row(_ id: String) -> NoteRow? { rows[id] }

    var count: Int { order.count }

    var hasMore: Bool { order.count < total }

    func load() {
        wanted = true
        read(.reload)
    }

    func filter(_ status: StatusFilter) {
        guard status != self.status else { return }
        self.status = status
        read(.reload)
    }

    func loadMore() {
        guard loaded, hasMore else { return }
        read(.more)
    }

    /// `notes.changed`: the named rows are read again in place; a skipped notice, or a change too
    /// large to name, reads the first page again.
    func changed(rev: Double, ids: [String], all: Bool) {
        if let last = lastRev, rev <= last { return }
        let skipped = all || lastRev.map { rev > $0 + 1 } ?? false
        lastRev = rev
        named.formUnion(ids)
        guard loaded || reading else { return }
        read(skipped ? .reload : .refresh)
    }

    /// The page reported a change it could not attribute (a sync, a launch): read everything again.
    func reload() { read(.reload) }

    /// A new note's row, left untouched, goes before the pop that reveals it draws a frame.
    func removeUntouched(_ id: String) {
        guard rows.removeValue(forKey: id) != nil else { return }
        order.removeAll { $0 == id }
        total = max(0, total - 1)
        publish(reconfigured: [], animated: false, reloaded: false)
    }

    /// The note this list just made, drawn under the editor's cover and selected, so the pop's
    /// deselection marks it.
    func quietly(selecting id: String) {
        selecting = id
        read(.refresh)
    }

    private func read(_ kind: Read) {
        guard let bridge else { return }
        guard !reading else {
            next = max(next, kind)
            return
        }
        reading = true
        let asked = named
        named = []
        let offset = kind == .more ? order.count : 0
        let limit =
            switch kind {
            case .refresh: min(max(order.count, Self.pageRows), Self.maxRows)
            default: Self.pageRows
            }
        let args: [String: JSONValue] = [
            "view": view.json, "status": .string(status.rawValue), "offset": .number(Double(offset)),
            "limit": .number(Double(limit)),
        ]
        bridge.direct(.listsNotes, args) { [weak self] outcome in
            self?.answered(kind, asked: asked, outcome)
        }
    }

    private func answered(_ kind: Read, asked: Set<String>, _ outcome: Outcome) {
        reading = false
        switch outcome {
        case .ok(let value):
            if let page = value.decoded(NotePage.self) {
                take(page, kind, asked: asked)
            } else {
                named.formUnion(asked)
                bridge?.log(.warn, "W_PHONE_LIST_READ_FAILED code=E_SCREENS_MESSAGE_INVALID")
            }
        case .failed(let code):
            named.formUnion(asked)
            bridge?.log(.warn, "W_PHONE_LIST_READ_FAILED code=\(code)")
        }
        let queued = next
        next = .none
        if queued != .none { read(queued) }
    }

    private func take(_ page: NotePage, _ kind: Read, asked: Set<String>) {
        let first = !loaded
        let previous = rows
        if kind == .more {
            for row in page.rows where rows[row.id] == nil {
                order.append(row.id)
                rows[row.id] = row
            }
        } else {
            order = []
            rows = [:]
            for row in page.rows where rows[row.id] == nil {
                order.append(row.id)
                rows[row.id] = row
            }
        }
        total = page.total
        loaded = true
        let edited = page.rows.filter { row in previous[row.id].map { $0 != row } ?? false }.map(\.id)
        let reconfigured = Set(edited).union(asked).filter { rows[$0] != nil }
        let quiet = selecting != nil
        let selected = selecting.flatMap { rows[$0] == nil ? nil : $0 }
        selecting = nil
        publish(
            reconfigured: reconfigured, animated: !first && !quiet && !reduceMotion(),
            reloaded: kind == .reload && !first, selected: selected)
    }

    private func publish(reconfigured: Set<String>, animated: Bool, reloaded: Bool, selected: String? = nil) {
        var ids: [Section: [String]] = [:]
        for id in order {
            guard let row = rows[id] else { continue }
            ids[section(row), default: []].append(id)
        }
        layout = Layout(sections: Section.allCases.filter { ids[$0] != nil }, ids: ids)
        onUpdate(
            Update(layout: layout, reconfigured: reconfigured, animated: animated, reloaded: reloaded, selected: selected))
    }

    private func section(_ row: NoteRow) -> Section {
        if view == .templates { return .recent }
        if row.pinned { return .pinned }
        return row.status == NoteStatus.completed.rawValue ? .completed : .recent
    }
}
