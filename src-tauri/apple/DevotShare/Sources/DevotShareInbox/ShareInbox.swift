import Foundation

/// The folder in the App Group container where the extension leaves shares for the app. It holds
/// no key and no database: only the items, each whole in its own file, with complete file
/// protection, out of backups and never synced.
public struct ShareInbox: Sendable {
    public static let appGroup = "group.io.github.jma49.devot"
    static let folderName = "ShareInbox"
    /// Shares waiting at once; the sheet refuses more until the app has drained them.
    public static let capacity = 50
    static let suffix = ".json"
    static let tempPrefix = "."
    /// A temp file this old was left by an extension that stopped mid-write.
    static let staleTemp: TimeInterval = 60 * 60

    public let folder: URL

    public init(folder: URL) {
        self.folder = folder
    }

    /// The inbox in the App Group's container, or nil when the build has no App Group.
    public static func shared() -> ShareInbox? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            .map { ShareInbox(folder: $0.appending(path: folderName, directoryHint: .isDirectory)) }
    }

    /// Writes the item whole: to a temp file, then renamed, so the app never reads half of one.
    @discardableResult
    public func write(_ item: ShareItem) throws(ShareError) -> URL {
        let data = try item.encoded()
        try prepare()
        guard pending().count < Self.capacity else { throw ShareError("E_SHARE_INBOX_FULL") }
        let temp = folder.appending(path: Self.tempPrefix + item.id + ".tmp")
        let final = folder.appending(path: item.id + Self.suffix)
        do {
            try data.write(to: temp, options: [.withoutOverwriting, .completeFileProtection])
            try FileManager.default.moveItem(at: temp, to: final)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw ShareError("E_SHARE_WRITE_FAILED")
        }
        return final
    }

    /// Writes what the Add to Devot action was given, as the Share Extension would have.
    @discardableResult
    public func add(title: String, text: String, url: String?) throws(ShareError) -> ShareItem {
        let link = url?.trimmingCharacters(in: .whitespacesAndNewlines)
        let item = ShareItem(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines), text: text,
            url: link?.isEmpty == false ? link : nil, images: [])
        if let code = item.problem() { throw ShareError(code) }
        try write(item)
        return item
    }

    /// The items waiting, oldest first: their names are UUIDv7s.
    public func pending() -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))) ?? []
        return names
            .filter { $0.hasSuffix(Self.suffix) && !$0.hasPrefix(Self.tempPrefix) }
            .sorted()
            .map { folder.appending(path: $0) }
    }

    public func read(_ file: URL) throws(ShareError) -> ShareItem {
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        guard size <= ShareItem.maxFileBytes else { throw ShareError("E_SHARE_TOO_LARGE") }
        guard let data = try? Data(contentsOf: file) else { throw ShareError("E_SHARE_FILE_UNREADABLE") }
        let item = try ShareItem.decoded(data)
        guard file.lastPathComponent == item.id + Self.suffix else { throw ShareError("E_SHARE_ID_INVALID") }
        return item
    }

    public func remove(_ file: URL) {
        try? FileManager.default.removeItem(at: file)
    }

    /// Removes the temp files an interrupted extension left behind.
    public func sweep(now: Date = Date()) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))) ?? []
        for name in names where name.hasPrefix(Self.tempPrefix) {
            let file = folder.appending(path: name)
            let made = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let made, now.timeIntervalSince(made) > Self.staleTemp { remove(file) }
        }
    }

    private func prepare() throws(ShareError) {
        do {
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            var folder = folder
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try folder.setResourceValues(values)
        } catch {
            throw ShareError("E_SHARE_INBOX_UNAVAILABLE")
        }
    }
}
