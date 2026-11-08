import Foundation

/// The Search tab's query, scope and results (docs/specs/iphone-screens.md, Search). Typing searches
/// once it pauses; a scope, a recent search or a suggestion searches at once; results replace the
/// list when they arrive, and an answer to an older search is dropped.
@MainActor
final class SearchModel {
    enum Scope: String, CaseIterable, Sendable {
        case all
        case titles

        var name: String {
            switch self {
            case .all: L10n.phoneSearchScopeAll()
            case .titles: L10n.phoneSearchScopeTitles()
            }
        }
    }

    /// A found note, with the body around the first searched word when the core found one there.
    struct Hit: Decodable, Hashable, Sendable {
        let note: NoteRow
        let excerpt: String?

        private enum Keys: String, CodingKey { case excerpt }

        init(from decoder: any Decoder) throws {
            note = try NoteRow(from: decoder)
            excerpt = try decoder.container(keyedBy: Keys.self).decodeIfPresent(String.self, forKey: .excerpt)
        }
    }

    struct Results: Equatable, Sendable {
        let query: String
        let hits: [Hit]
        let capped: Bool
    }

    private struct Answer: Decodable {
        let rows: [Hit]
        let capped: Bool
    }

    static let pause: TimeInterval = 0.12

    private let bridge: () -> (any SettingsBridge)?
    /// Runs the work after a delay, and answers what cancels it.
    var after: (TimeInterval, @escaping @MainActor () -> Void) -> () -> Void = { delay, work in
        let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        return { item.cancel() }
    }
    var onResults: () -> Void = {}
    private(set) var query = ""
    private(set) var scope = Scope.all
    private(set) var results: Results?
    private var cancelPause: (() -> Void)?
    private var asked = 0

    init(bridge: @escaping () -> (any SettingsBridge)?) {
        self.bridge = bridge
    }

    func type(_ text: String) {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != query else { return }
        query = next
        guard !next.isEmpty else { return clear() }
        searchAfterPause()
    }

    func run(_ text: String) {
        query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return clear() }
        search()
    }

    func choose(_ scope: Scope) {
        guard scope != self.scope else { return }
        self.scope = scope
        if !query.isEmpty { search() }
    }

    func notesChanged() {
        if !query.isEmpty { searchAfterPause() }
    }

    private func clear() {
        cancelPause?()
        cancelPause = nil
        asked += 1
        results = nil
        onResults()
    }

    private func searchAfterPause() {
        cancelPause?()
        cancelPause = after(Self.pause) { [weak self] in self?.search() }
    }

    private func search() {
        cancelPause?()
        cancelPause = nil
        guard let bridge = bridge() else { return }
        asked += 1
        let request = asked
        let query = query
        bridge.request(.search, ["query": .string(query), "scope": .string(scope.rawValue)]) { [weak self] outcome in
            guard let self, request == asked else { return }
            switch outcome {
            case .ok(let value):
                guard let answer = value.decoded(Answer.self) else {
                    return bridge.log(.warn, "W_PHONE_SEARCH_FAILED code=E_SCREENS_MESSAGE_INVALID")
                }
                results = Results(query: query, hits: answer.rows, capped: answer.capped)
                onResults()
            case .failed(let code):
                bridge.log(.warn, "W_PHONE_SEARCH_FAILED code=\(code)")
            }
        }
    }
}
