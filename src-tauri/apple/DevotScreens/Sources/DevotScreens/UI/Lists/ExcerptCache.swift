import Foundation

/// The rows' excerpts, from the core through the page for the rows about to show
/// (docs/specs/iphone-screens.md, Excerpt cache). An excerpt is kept for the body version it was
/// read at, so an edited note's is read again and an unchanged one never is.
@MainActor
final class ExcerptCache {
    /// `MAX_EXCERPT_IDS` in src-tauri/src/screens/message.rs.
    static let maxIds = 60

    weak var bridge: (any SettingsBridge)?
    /// The notes whose excerpts just arrived.
    var onExcerpts: ([String]) -> Void = { _ in }
    private let cache = NSCache<NSString, NSString>()
    private var asking: Set<String> = []

    init(bridge: (any SettingsBridge)?) {
        self.bridge = bridge
        cache.countLimit = 4000
    }

    private static func key(_ row: NoteRow) -> String { "\(row.id)#\(row.bodyVersion)" }

    /// The excerpt, empty when the note has none, or nil until it has been read.
    func excerpt(_ row: NoteRow) -> String? {
        cache.object(forKey: Self.key(row) as NSString) as String?
    }

    func want(_ rows: [NoteRow]) {
        var seen = Set<String>()
        let missing = rows.filter { row in
            let key = Self.key(row)
            return excerpt(row) == nil && !asking.contains(key) && seen.insert(key).inserted
        }
        guard let bridge, !missing.isEmpty else { return }
        for start in stride(from: 0, to: missing.count, by: Self.maxIds) {
            let chunk = Array(missing[start..<min(start + Self.maxIds, missing.count)])
            let keys = chunk.map(Self.key)
            asking.formUnion(keys)
            bridge.request(.excerpts, ["ids": .array(chunk.map { .string($0.id) })]) { [weak self] outcome in
                self?.answered(chunk, keys: keys, outcome)
            }
        }
    }

    private func answered(_ rows: [NoteRow], keys: [String], _ outcome: Outcome) {
        asking.subtract(keys)
        guard case .ok(let value) = outcome, let found = value["excerpts"]?.object else {
            let code = if case .failed(let code) = outcome { code } else { "E_SCREENS_MESSAGE_INVALID" }
            bridge?.log(.warn, "W_PHONE_EXCERPTS_FAILED code=\(code)")
            return
        }
        for (row, key) in zip(rows, keys) {
            cache.setObject((found[row.id]?.string ?? "") as NSString, forKey: key as NSString)
        }
        onExcerpts(rows.map(\.id))
    }
}
