import Foundation

/// One share waiting in the inbox: what the extension's sheet held when Post was tapped. The page
/// makes a note of it with `share.capture`, so its limits are the bridge's
/// (src-tauri/src/screens/message.rs) and a valid item is never refused for its shape.
public struct ShareItem: Codable, Equatable, Sendable {
    public struct Image: Codable, Equatable, Sendable {
        public let name: String
        /// JPEG bytes, base64 in the file as in the bridge's message.
        public let data: Data

        public init(name: String, data: Data) {
            self.name = name
            self.data = data
        }
    }

    public static let version = 1
    public static let maxTitleChars = 1_000
    public static let maxTextChars = 100_000
    public static let maxURLChars = 2_048
    public static let maxImages = 4
    public static let maxImageNameChars = 200
    /// The whole file; the bridge's message wraps the same fields and stays under its 4 MiB.
    public static let maxFileBytes = 3 * 1024 * 1024

    public let v: Int
    /// A UUIDv7, so the inbox sorts oldest first and the page can tell a share it already made.
    public let id: String
    public let title: String
    public let text: String
    public let url: String?
    public let images: [Image]

    public init(id: String = ShareItem.newId(), title: String, text: String, url: String?, images: [Image]) {
        v = Self.version
        self.id = id
        self.title = title
        self.text = text
        self.url = url
        self.images = images
    }

    /// The first problem's code, or nil for an item the inbox may keep.
    public func problem() -> String? {
        if v != Self.version { return "E_SHARE_VERSION" }
        if !Self.isNoteId(id) { return "E_SHARE_ID_INVALID" }
        if title.count > Self.maxTitleChars { return "E_SHARE_TITLE_TOO_LONG" }
        if text.count > Self.maxTextChars { return "E_SHARE_TEXT_TOO_LONG" }
        if let url, !Self.isWebURL(url) { return "E_SHARE_URL_INVALID" }
        if images.count > Self.maxImages { return "E_SHARE_IMAGES_TOO_MANY" }
        for image in images {
            let name = image.name
            if name.isEmpty || name.count > Self.maxImageNameChars
                || name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
                || !Self.isJPEG(image.data)
            {
                return "E_SHARE_IMAGE_INVALID"
            }
        }
        let empty = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && url == nil && images.isEmpty
        return empty ? "E_SHARE_EMPTY" : nil
    }

    /// The file's bytes, or the code that keeps it out of the inbox.
    public func encoded() throws(ShareError) -> Data {
        if let code = problem() { throw ShareError(code) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else { throw ShareError("E_SHARE_ENCODE_FAILED") }
        guard data.count <= Self.maxFileBytes else { throw ShareError("E_SHARE_TOO_LARGE") }
        return data
    }

    public static func decoded(_ data: Data) throws(ShareError) -> ShareItem {
        guard data.count <= maxFileBytes else { throw ShareError("E_SHARE_TOO_LARGE") }
        guard let item = try? JSONDecoder().decode(ShareItem.self, from: data) else {
            throw ShareError("E_SHARE_FILE_UNREADABLE")
        }
        if let code = item.problem() { throw ShareError(code) }
        return item
    }

    /// An http or https link with nothing in it that the bridge refuses.
    public static func isWebURL(_ text: String) -> Bool {
        let web = text.hasPrefix("https://") || text.hasPrefix("http://")
        let clean = !text.unicodeScalars.contains {
            $0.properties.generalCategory == .control || $0.properties.isWhitespace
        }
        return web && clean && text.count <= maxURLChars
    }

    static func isJPEG(_ data: Data) -> Bool {
        data.count >= 3 && data.prefix(3).elementsEqual([0xFF, 0xD8, 0xFF])
    }

    /// The Rust side's check: a lower-case, hyphenated version 7 UUID.
    public static func isNoteId(_ id: String) -> Bool {
        guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else { return false }
        return uuid.uuid.6 >> 4 == 7 && uuid.uuid.8 >> 6 == 0b10
    }

    /// A UUIDv7: 48 bits of Unix milliseconds, then random bits.
    public static func newId(now: Date = Date()) -> String {
        var bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max) }
        let ms = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        for i in 0..<6 { bytes[i] = UInt8(truncatingIfNeeded: ms >> (8 * (5 - UInt64(i)))) }
        bytes[6] = 0x70 | (bytes[6] & 0x0F)
        bytes[8] = 0x80 | (bytes[8] & 0x3F)
        let uuid = UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
        return uuid.uuidString.lowercased()
    }
}

/// A code, never content, so it can go to the log as it is.
public struct ShareError: Error, Equatable, Sendable {
    public let code: String

    public init(_ code: String) {
        self.code = code
    }
}
