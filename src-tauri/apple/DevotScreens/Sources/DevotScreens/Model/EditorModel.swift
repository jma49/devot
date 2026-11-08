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
    }
}
