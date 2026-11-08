import Foundation

/// The screens a launch rebuilds (docs/specs/iphone-screens.md, Restoration): the selected tab,
/// each kept tab's stack, the first note a list showed, and the untouched new notes to discard.
/// IDs and kinds only, never a title or any other note text.
struct Restoration: Codable, Equatable, Sendable {
    static let key = "devot.phone.screens"
    /// Set while the app is in front, so a launch that finds it set follows a crash.
    static let runningKey = "devot.phone.running"
    static let version = 1
    static let maxAge: TimeInterval = 8 * 60 * 60
    /// The tabs whose stacks are kept; Activity and Search start at their roots.
    static let tabs: [Tab] = [.notes, .library, .settings]

    struct NewNote: Codable, Equatable, Sendable {
        let id: String
        let bookId: String?
    }

    private(set) var v = Restoration.version
    var tab: Tab
    var stacks: [Tab: [ScreenRoute]]
    var firstVisible: [Tab: String]
    var newNotes: [NewNote]
    /// Seconds since 1970.
    var savedAt: Double

    init(
        tab: Tab, stacks: [Tab: [ScreenRoute]] = [:], firstVisible: [Tab: String] = [:], newNotes: [NewNote] = [],
        savedAt: Date
    ) {
        self.tab = tab
        self.stacks = stacks
        self.firstVisible = firstVisible
        self.newNotes = newNotes
        self.savedAt = savedAt.timeIntervalSince1970
    }

    private struct Versioned: Decodable {
        let v: Int
    }

    /// Nil for a record of another version, or one that does not read: the launch starts afresh.
    static func decode(_ data: Data?) -> Restoration? {
        guard let data, (try? JSONDecoder().decode(Versioned.self, from: data))?.v == version else { return nil }
        return try? JSONDecoder().decode(Restoration.self, from: data)
    }

    func encoded() -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try? encoder.encode(self)
    }

    /// Nil after a crash, or once the record is more than eight hours old (or from the future).
    func restorable(at now: Date, crashed: Bool) -> Restoration? {
        let age = now.timeIntervalSince1970 - savedAt
        guard !crashed, age >= -60, age <= Restoration.maxAge else { return nil }
        return self
    }

    /// The editors the stacks name, for the read that says which notes are still there.
    var editorIds: [String] {
        Restoration.tabs.flatMap { tab in
            (stacks[tab] ?? []).compactMap { if case .editor(let id) = $0 { id } else { nil } }
        }
    }

    /// Each stack ends below the first editor whose note is no longer a live one.
    func cut(live: Set<String>) -> Restoration {
        var kept = self
        for (tab, stack) in stacks {
            kept.stacks[tab] = Restoration.cut(stack, live: live)
        }
        return kept
    }

    static func cut(_ stack: [ScreenRoute], live: Set<String>) -> [ScreenRoute] {
        Array(
            stack.prefix { route in
                guard case .editor(let id) = route else { return true }
                return live.contains(id)
            })
    }
}
