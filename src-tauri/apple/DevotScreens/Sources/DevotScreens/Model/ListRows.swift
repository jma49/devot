import Foundation

/// A note's list row as Rust reads it (`NoteSummary`; tests/fixtures/screens/rows.json).
struct NoteRow: Decodable, Hashable, Sendable {
    let id: String
    let title: String
    let createdAt: Double
    let updatedAt: Double
    let bookId: String?
    let status: String
    let pinned: Bool
    let tagIds: [String]
    let bodyVersion: Int
}

struct NotePage: Decodable, Equatable, Sendable {
    let rows: [NoteRow]
    let total: Int
}

struct LibraryCounts: Decodable, Equatable, Sendable {
    let all: Int
    let pinned: Int
    let active: Int
    let onHold: Int
    let completed: Int
    let templates: Int
    let trash: Int
}

/// A notebook in the Library's order: each one after its parent.
struct LibraryBook: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let parentId: String?
    let icon: String?
    let iconColor: String?
    let count: Int
}

struct LibraryTag: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let color: String?
    let count: Int
}

struct LibrarySearch: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let query: String
}

struct LibraryContents: Decodable, Equatable, Sendable {
    let counts: LibraryCounts
    let books: [LibraryBook]
    let tags: [LibraryTag]
    let savedSearches: [LibrarySearch]

    /// How deep each notebook sits, its parent's depth plus one.
    var depths: [String: Int] {
        var found: [String: Int] = [:]
        for book in books { found[book.id] = book.parentId.flatMap { found[$0] }.map { $0 + 1 } ?? 0 }
        return found
    }
}

struct TrashedRow: Decodable, Hashable, Sendable {
    let id: String
    let title: String
    let deletedAt: Double
    let bookId: String?
}

/// Which notes a list shows (`View` in src-tauri/src/screens/lists.rs).
enum ListView: Hashable, Sendable {
    case all
    case pinned
    case book(String)
    case tag(String)
    case templates

    var json: JSONValue {
        switch self {
        case .all: .object(["kind": .string("all")])
        case .pinned: .object(["kind": .string("pinned")])
        case .book(let id): .object(["kind": .string("book"), "id": .string(id)])
        case .tag(let id): .object(["kind": .string("tag"), "id": .string(id)])
        case .templates: .object(["kind": .string("templates")])
        }
    }
}

enum StatusFilter: String, CaseIterable, Sendable {
    case all
    case active
    case onHold = "on_hold"
    case completed

    var name: String {
        switch self {
        case .all: L10n.phoneFilterAll()
        case .active: L10n.statusActive()
        case .onHold: L10n.statusOnHold()
        case .completed: L10n.statusCompleted()
        }
    }
}

/// The statuses a note can take (`NOTE_STATUSES` in src/core), in the order menus list them.
enum NoteStatus: String, CaseIterable, Sendable {
    case none
    case active
    case onHold = "on_hold"
    case completed
    case dropped

    var name: String {
        switch self {
        case .none: L10n.statusNone()
        case .active: L10n.statusActive()
        case .onHold: L10n.statusOnHold()
        case .completed: L10n.statusCompleted()
        case .dropped: L10n.statusDropped()
        }
    }

    /// design/phone.md, Status marks.
    var symbol: String {
        switch self {
        case .none: "circle.dashed"
        case .active: "circle"
        case .onHold: "pause.circle"
        case .completed: "checkmark.circle.fill"
        case .dropped: "xmark.circle"
        }
    }
}

/// One change to a set of notes (`Change` in src-tauri/src/screens/message.rs).
enum NoteChange: Equatable, Sendable {
    case book(String?)
    case status(NoteStatus)
    case pinned(Bool)
    case putTag(String)
    case removeTag(String)
    case trash
    case restore
    case purge

    var json: JSONValue {
        switch self {
        case .book(let id): .object(["kind": .string("book"), "bookId": id.map(JSONValue.string) ?? .null])
        case .status(let status): .object(["kind": .string("status"), "status": .string(status.rawValue)])
        case .pinned(let pinned): .object(["kind": .string("pinned"), "pinned": .bool(pinned)])
        case .putTag(let id): .object(["kind": .string("putTag"), "tagId": .string(id)])
        case .removeTag(let id): .object(["kind": .string("removeTag"), "tagId": .string(id)])
        case .trash: .object(["kind": .string("trash")])
        case .restore: .object(["kind": .string("restore")])
        case .purge: .object(["kind": .string("purge")])
        }
    }
}

extension JSONValue {
    func decoded<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
