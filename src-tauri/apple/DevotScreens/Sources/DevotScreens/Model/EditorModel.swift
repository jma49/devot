/// The page's two ways of showing a note.
enum NoteMode: String, Sendable {
    case edit
    case preview

    var other: NoteMode { self == .edit ? .preview : .edit }

    /// The toggle shows the mode a tap switches to, as `design/icons/symbols.json` lists it.
    var toggleSymbol: String {
        switch other {
        case .edit: "pencil"
        case .preview: "eye"
        }
    }
}

/// When the cover over a note just pushed fades: once the push has drawn a frame and the page has
/// painted the note, or when the page is too slow, whichever comes first; once per raise.
struct CoverModel {
    private(set) var waiting = false
    private var framed = false
    private var painted = false

    mutating func raise() {
        waiting = true
        framed = false
        painted = false
    }

    mutating func firstFrame() -> Bool {
        framed = true
        return settle()
    }

    mutating func ready() -> Bool {
        painted = true
        return settle()
    }

    mutating func timedOut() -> Bool {
        guard waiting else { return false }
        waiting = false
        return true
    }

    private mutating func settle() -> Bool {
        guard waiting, framed, painted else { return false }
        waiting = false
        return true
    }
}

/// What the page says of the note an editor screen shows (`editor.note`): what its More menu,
/// pickers and Note Info show.
struct EditorNote: Equatable, Sendable {
    let id: String
    let bookId: String?
    let status: String
    let pinned: Bool
    let tagIds: [String]
    let createdAt: Double
    let updatedAt: Double

    init(
        id: String, bookId: String?, status: String, pinned: Bool, tagIds: [String], createdAt: Double,
        updatedAt: Double
    ) {
        self.id = id
        self.bookId = bookId
        self.status = status
        self.pinned = pinned
        self.tagIds = tagIds
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init?(_ fields: [String: JSONValue]) {
        guard let id = fields["id"]?.string, let status = fields["status"]?.string,
            let pinned = fields["pinned"]?.bool, let tagIds = fields["tagIds"]?.array,
            let createdAt = fields["createdAt"]?.number, let updatedAt = fields["updatedAt"]?.number
        else { return nil }
        let bookId = fields["bookId"]
        if let bookId, bookId.string == nil, bookId != .null { return nil }
        self.init(
            id: id, bookId: bookId?.string, status: status, pinned: pinned, tagIds: tagIds.compactMap(\.string),
            createdAt: createdAt, updatedAt: updatedAt)
    }
}

/// Note Info's figures (`note.info`).
struct NoteInfo: Equatable, Sendable {
    struct Link: Equatable, Sendable {
        let id: String
        let title: String
    }

    let words: Int
    let characters: Int
    let readingMinutes: Int
    let revisions: Int
    let backlinks: [Link]
    /// Nil for a note without front matter, or one the page answered in a shape Swift cannot read.
    let frontMatter: FrontMatter?

    init?(_ value: JSONValue) {
        guard let words = value["words"]?.number, let characters = value["characters"]?.number,
            let minutes = value["readingMinutes"]?.number, let revisions = value["revisions"]?.number
        else { return nil }
        self.words = Int(words)
        self.characters = Int(characters)
        readingMinutes = Int(minutes)
        self.revisions = Int(revisions)
        backlinks = (value["backlinks"]?.array ?? []).compactMap { link in
            guard let id = link["id"]?.string else { return nil }
            return Link(id: id, title: link["title"]?.string ?? "")
        }
        frontMatter = value["frontMatter"].flatMap(FrontMatter.init)
    }
}

/// The note's front matter as Note Info shows it (`frontMatterView` in src/core/preview).
enum FrontMatter: Equatable, Sendable {
    struct Chip: Equatable, Sendable {
        let name: String
        /// A tag colour's name, or a `#` colour Swift draws as an uncoloured tag.
        let color: String?
    }

    enum Value: Equatable, Sendable {
        case text(String)
        case chips([Chip])
    }

    enum Field: String, Equatable, Sendable {
        case title
        case status
        case tags
    }

    /// The note's own value, and what Apply sets: nil when the front matter names nothing the note can take.
    struct Difference: Equatable, Sendable {
        let field: Field
        let badge: String
        let value: String?
    }

    struct Row: Equatable, Sendable {
        let key: String
        let value: Value
        let difference: Difference?
    }

    case properties([Row])
    /// YAML that is not a map of keys, as written.
    case yaml(String)

    init?(_ value: JSONValue) {
        switch value["kind"]?.string {
        case "yaml":
            guard let yaml = value["yaml"]?.string else { return nil }
            self = .yaml(yaml)
        case "properties":
            guard let rows = value["rows"]?.array else { return nil }
            let read = rows.compactMap(Self.row)
            guard read.count == rows.count else { return nil }
            self = .properties(read)
        default:
            return nil
        }
    }

    private static func row(_ row: JSONValue) -> Row? {
        guard let key = row["key"]?.string, let shown = row["value"] else { return nil }
        let value: Value
        switch shown["kind"]?.string {
        case "text":
            guard let text = shown["text"]?.string else { return nil }
            value = .text(text)
        case "chips":
            guard let chips = shown["chips"]?.array else { return nil }
            let read = chips.compactMap { chip in chip["name"]?.string.map { Chip(name: $0, color: chip["color"]?.string) } }
            guard read.count == chips.count else { return nil }
            value = .chips(read)
        default:
            return nil
        }
        guard let difference = row["difference"] else { return Row(key: key, value: value, difference: nil) }
        guard let field = difference["field"]?.string.flatMap(Field.init), let badge = difference["badge"]?.string
        else { return nil }
        let applied = difference["value"]
        if let applied, applied != .null, applied.string == nil { return nil }
        return Row(key: key, value: value, difference: Difference(field: field, badge: badge, value: applied?.string))
    }
}
