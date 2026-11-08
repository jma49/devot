/// What Settings' search finds: `settings/search.ts` over the same index, which
/// tests/fixtures/settings-search.json keeps in step with the page.
struct SettingsSearch {
    struct Result: Hashable {
        let pane: String
        /// The pane's own name for a pane result; the setting's name otherwise.
        let label: String
    }

    struct Section: Equatable {
        let pane: String
        let results: [Result]
    }

    /// The panes the iPhone lists, in the order of the index.
    static let phonePanes = ["general", "appearance", "editing", "preview", "sync", "ai", "licence"]

    var panes = SettingsSearch.phonePanes
    var device = SettingsIndex.Device.phone
    var limit = 12
    var label: (String) -> String = { L10n.text($0, $0) }

    static func paneLabel(_ pane: String) -> String {
        SettingsIndex.panes.first { $0.id == pane }?.label ?? pane
    }

    /// Panes and settings whose name holds every word of `query`, panes first; an empty query finds nothing.
    func results(for query: String) -> [Result] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        let matches = { (key: String) in
            let name = label(key).lowercased()
            return words.allSatisfy(name.contains)
        }
        var found = SettingsIndex.panes.filter { panes.contains($0.id) && matches($0.label) }
            .map { Result(pane: $0.id, label: $0.label) }
        for entry in SettingsIndex.entries where panes.contains(entry.pane) && (entry.only ?? device) == device {
            if matches(entry.label) { found.append(Result(pane: entry.pane, label: entry.label)) }
        }
        return Array(found.prefix(limit))
    }

    /// The results one section per pane, in the order the panes first come.
    func sections(for query: String) -> [Section] {
        var order: [String] = []
        var byPane: [String: [Result]] = [:]
        for result in results(for: query) {
            if byPane[result.pane] == nil { order.append(result.pane) }
            byPane[result.pane, default: []].append(result)
        }
        return order.map { Section(pane: $0, results: byPane[$0] ?? []) }
    }
}
