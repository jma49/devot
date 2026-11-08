import Foundation

/// Any JSON value: the arguments, results and notice fields that Rust checks field by field.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    subscript(key: String) -> JSONValue? {
        guard case .object(let fields) = self else { return nil }
        return fields[key]
    }

    var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var bool: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var number: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    var array: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var object: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    /// A whole number that a `Double` holds exactly and an ID can be.
    var id: UInt64? {
        guard case .number(let value) = self, value >= 0, value <= 9_007_199_254_740_991,
            value.rounded(.towardZero) == value
        else { return nil }
        return UInt64(value)
    }
}

public enum Op: String, CaseIterable, Sendable {
    case ping
    case excerpts
    case search
    case noteCreate = "note.create"
    case noteDiscard = "note.discard"
    case tabsShow = "tabs.show"
    case tabsPopToRoot = "tabs.popToRoot"
    case settingsNotebooks = "settings.notebooks"
    case editorShow = "editor.show"
    case editorPrepare = "editor.prepare"
    case editorHide = "editor.hide"
    case editorSetMode = "editor.setMode"
    case editorInfo = "editor.info"
    case glassGet = "glass.get"
    case glassSet = "glass.set"
    case editorFocus = "editor.focus"
    case notesBatch = "notes.batch"
    case trashEmpty = "trash.empty"
    case bookCreate = "book.create"
    case templateCreate = "template.create"
    case templateApply = "template.apply"
    case noteText = "note.text"
    case noteComplete = "note.complete"
    case noteUndoStatus = "note.undoStatus"
}

public enum NoticeKind: String, CaseIterable, Sendable {
    case notesChanged = "notes.changed"
    case editorTitle = "editor.title"
    case tabsState = "tabs.state"
    case settingsOpen = "settings.open"
    case navOpenNote = "nav.openNote"
    case navBack = "nav.back"
    case editorReady = "editor.ready"
    case editorMode = "editor.mode"
    case editorScroll = "editor.scroll"
    case noteNew = "note.new"
    case booksChanged = "books.changed"
    case tagsChanged = "tags.changed"
    case savedSearchesChanged = "savedSearches.changed"
    /// Rust's own: the sync snapshot changed.
    case syncChanged = "sync.changed"
    /// Rust's own: a pairing on show through iCloud may have moved on.
    case syncPairing = "sync.pairing"
    /// Rust's own: the licence changed.
    case licenceChanged = "licence.changed"
}

public enum Outcome: Equatable, Sendable {
    case ok(JSONValue)
    case failed(String)
}

public struct MessageError: Error, Equatable {
    public let code: String
}

/// The bridge's envelope (docs/specs/iphone-screens.md, Message envelope). Swift checks the
/// envelope only; Rust checks every field.
public enum Message: Equatable, Sendable {
    case request(id: UInt64, op: Op, args: [String: JSONValue])
    case direct(id: UInt64, op: DirectOp, args: [String: JSONValue])
    case reply(id: UInt64, outcome: Outcome)
    case notice(NoticeKind, fields: [String: JSONValue])

    static let version = 1.0
    static let maxBytes = 4 << 20

    public init(json: Data) throws {
        guard json.count <= Message.maxBytes else { throw MessageError(code: "E_SCREENS_MESSAGE_TOO_LARGE") }
        guard case .object(var fields)? = try? JSONDecoder().decode(JSONValue.self, from: json) else {
            throw MessageError.invalid
        }
        guard case .number(let version)? = fields.removeValue(forKey: "v") else { throw MessageError.invalid }
        guard version == Message.version else { throw MessageError(code: "E_SCREENS_VERSION_UNSUPPORTED") }
        if fields["op"] != nil {
            self = try Message.request(fields)
        } else if fields["ok"] != nil {
            self = try Message.reply(fields)
        } else if case .string(let name)? = fields.removeValue(forKey: "notice") {
            guard let kind = NoticeKind(rawValue: name) else { throw MessageError(code: "E_SCREENS_NOTICE_UNKNOWN") }
            self = .notice(kind, fields: fields)
        } else {
            throw MessageError.invalid
        }
    }

    private static func request(_ fields: [String: JSONValue]) throws -> Message {
        guard Set(fields.keys) == ["id", "op", "args"], let id = fields["id"]?.id,
            case .string(let name)? = fields["op"], case .object(let args)? = fields["args"]
        else { throw MessageError.invalid }
        if let op = Op(rawValue: name) { return .request(id: id, op: op, args: args) }
        if let op = DirectOp(rawValue: name) { return .direct(id: id, op: op, args: args) }
        throw MessageError(code: "E_SCREENS_OP_UNKNOWN")
    }

    private static func reply(_ fields: [String: JSONValue]) throws -> Message {
        guard let id = fields["id"]?.id, case .bool(let ok)? = fields["ok"] else { throw MessageError.invalid }
        if ok, Set(fields.keys) == ["id", "ok", "result"], let result = fields["result"] {
            return .reply(id: id, outcome: .ok(result))
        }
        if !ok, Set(fields.keys) == ["id", "ok", "code"], case .string(let code)? = fields["code"] {
            return .reply(id: id, outcome: .failed(code))
        }
        throw MessageError.invalid
    }

    public func json() throws -> Data {
        var fields: [String: JSONValue] = ["v": .number(Message.version)]
        switch self {
        case .request(let id, let op, let args):
            fields["id"] = .number(Double(id))
            fields["op"] = .string(op.rawValue)
            fields["args"] = .object(args)
        case .direct(let id, let op, let args):
            fields["id"] = .number(Double(id))
            fields["op"] = .string(op.rawValue)
            fields["args"] = .object(args)
        case .reply(let id, .ok(let result)):
            fields["id"] = .number(Double(id))
            fields["ok"] = .bool(true)
            fields["result"] = result
        case .reply(let id, .failed(let code)):
            fields["id"] = .number(Double(id))
            fields["ok"] = .bool(false)
            fields["code"] = .string(code)
        case .notice(let kind, let rest):
            fields.merge(rest) { kept, _ in kept }
            fields["notice"] = .string(kind.rawValue)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(JSONValue.object(fields))
    }
}

extension MessageError {
    static let invalid = MessageError(code: "E_SCREENS_MESSAGE_INVALID")
}
