import Foundation

@testable import DevotScreens

extension FakeRust {
    /// What an empty vault answers: no rows for a list read, an empty Library, `request` for the rest.
    static func emptyAnswer(_ json: Data, request: JSONValue = .object([:])) -> JSONValue {
        guard case .direct(_, let op, _)? = try? Message(json: json) else { return request }
        switch op {
        case .listsNotes: return .object(["rows": .array([]), "total": .number(0)])
        case .listsTrash: return .array([])
        case .listsLibrary:
            let counts = ["all", "pinned", "active", "onHold", "completed", "templates", "trash"]
            return .object([
                "counts": .object(Dictionary(uniqueKeysWithValues: counts.map { ($0, JSONValue.number(0)) })),
                "books": .array([]), "tags": .array([]), "savedSearches": .array([]),
            ])
        default: return request
        }
    }
}
