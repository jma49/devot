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
