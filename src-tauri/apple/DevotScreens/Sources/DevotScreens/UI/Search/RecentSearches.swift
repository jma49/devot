import Foundation

/// This iPhone's own recent searches: search terms are note content in spirit, so they are neither
/// synced nor logged.
final class RecentSearches {
    static let key = "devot.phone.recentSearches"
    static let limit = 6
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var queries: [String] {
        let stored = defaults.array(forKey: Self.key) ?? []
        return Array(stored.compactMap { $0 as? String }.filter { !$0.isEmpty }.prefix(Self.limit))
    }

    func remember(_ query: String) {
        let clean = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let next = [clean] + queries.filter { $0 != clean }
        defaults.set(Array(next.prefix(Self.limit)), forKey: Self.key)
    }
}
