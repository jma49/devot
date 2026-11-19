import Foundation

/// The rows' excerpts and headlines, from the core through the page for the rows about to show
/// (docs/specs/iphone-screens.md, Excerpt cache). Both are kept for the body version they were
/// read at, so an edited note's are read again and an unchanged one's never are.
@MainActor
final class ExcerptCache {
    /// `MAX_EXCERPT_IDS` in src-tauri/src/screens/message.rs.
    static let maxIds = 60

    weak var bridge: (any SettingsBridge)?
    /// The notes whose excerpts just arrived.
    var onExcerpts: ([String]) -> Void = { _ in }
    private final class Entry: NSObject {
        let excerpt: String
        let headline: String
        init(excerpt: String, headline: String) {
            self.excerpt = excerpt
            self.headline = headline
        }
    }

    private let cache = NSCache<NSString, Entry>()
    private var asking: Set<String> = []

    init(bridge: (any SettingsBridge)?) {
        self.bridge = bridge
        cache.countLimit = 4000
    }

    private static func key(_ row: NoteRow) -> String { "\(row.id)#\(row.bodyVersion)" }

    /// The excerpt, empty when the note has none, or nil until it has been read.
    func excerpt(_ row: NoteRow) -> String? {
        cache.object(forKey: Self.key(row) as NSString)?.excerpt
    }

    /// The body's first line, which names a note with no title, or nil until it has been read.
    func headline(_ row: NoteRow) -> String? {
        cache.object(forKey: Self.key(row) as NSString)?.headline
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
        let lines = value["headlines"]?.object ?? [:]
        for (row, key) in zip(rows, keys) {
            let entry = Entry(excerpt: found[row.id]?.string ?? "", headline: lines[row.id]?.string ?? "")
            cache.setObject(entry, forKey: key as NSString)
        }
        onExcerpts(rows.map(\.id))
    }
}
