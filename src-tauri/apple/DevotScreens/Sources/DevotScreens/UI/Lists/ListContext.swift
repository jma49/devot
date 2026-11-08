import UIKit

/// What every native list shares: the bridge, the gate, the excerpts, the Library's last read and
/// the writes the gate lets through (docs/specs/iphone-screens.md, Lists).
@MainActor
final class ListContext {
    weak var bridge: (any SettingsBridge)? {
        didSet {
            excerpts.bridge = bridge
            if libraryWanted, library == nil { readLibrary() }
            for source in sources() {
                source.bridge = bridge
                if source.wanted, !source.loaded { source.load() }
            }
        }
    }
    var gate = ProGate { nil }
    var haptics = Haptics()
    let excerpts = ExcerptCache(bridge: nil)
    private(set) var library: LibraryContents?
    /// Pushes a note's editor on the shown tab.
    var open: (_ id: String, _ title: String) -> Void = { _, _ in }
    /// Asks the page to let the note go once a list shows again after a pop.
    var hideEditor: (@escaping () -> Void) -> Void = { $0() }
    /// New notes left untouched whose editor is in no stack any more.
    var untouchedNewNotes: () -> [String] = { [] }
    var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }

    private struct Watcher {
        weak var object: AnyObject?
        let changed: (Change) -> Void
    }

    enum Change {
        case notes(rev: Double, ids: [String], all: Bool)
        case library(LibraryContents)
        case trash
        case excerpts([String])
    }

    init() {
        excerpts.onExcerpts = { [weak self] in self?.tell(.excerpts($0)) }
    }

    private var watchers: [Watcher] = []
    private var weakSources: [WeakSource] = []
    private var readingLibrary = false
    private var libraryAgain = false
    private var libraryWanted = false

    private struct WeakSource {
        weak var source: NoteListDataSource?
    }

    func source(_ view: ListView, status: StatusFilter = .all) -> NoteListDataSource {
        let source = NoteListDataSource(view: view, status: status, bridge: bridge)
        source.reduceMotion = { [weak self] in self?.reduceMotion() ?? false }
        weakSources.removeAll { $0.source == nil }
        weakSources.append(WeakSource(source: source))
        return source
    }

    private func sources() -> [NoteListDataSource] { weakSources.compactMap(\.source) }

    func watch(_ object: AnyObject, _ changed: @escaping (Change) -> Void) {
        watchers.removeAll { $0.object == nil }
        watchers.append(Watcher(object: object, changed: changed))
    }

    private func tell(_ change: Change) {
        watchers.removeAll { $0.object == nil }
        for watcher in watchers { watcher.changed(change) }
    }

    /// `notes.changed`: every list reads its rows again, the Library its counts, the Trash its notes.
    func notesChanged(rev: Double, ids: [String], all: Bool) {
        for source in sources() { source.changed(rev: rev, ids: ids, all: all) }
        tell(.notes(rev: rev, ids: ids, all: all))
        tell(.trash)
        if libraryWanted { readLibrary() }
    }

    /// `books.changed`, `tags.changed` and `savedSearches.changed`.
    func libraryChanged() {
        if libraryWanted { readLibrary() }
    }

    func readLibrary() {
        libraryWanted = true
        guard let bridge else { return }
        guard !readingLibrary else {
            libraryAgain = true
            return
        }
        readingLibrary = true
        bridge.direct(.listsLibrary, [:]) { [weak self] outcome in
            guard let self else { return }
            readingLibrary = false
            switch outcome {
            case .ok(let value):
                if let read = value.decoded(LibraryContents.self) {
                    library = read
                    tell(.library(read))
                } else {
                    bridge.log(.warn, "W_PHONE_LIBRARY_READ_FAILED code=E_SCREENS_MESSAGE_INVALID")
                }
            case .failed(let code):
                bridge.log(.warn, "W_PHONE_LIBRARY_READ_FAILED code=\(code)")
            }
            if libraryAgain {
                libraryAgain = false
                readLibrary()
            }
        }
    }

    /// A write the user picked from a menu or the selection bar: it feels once the gate lets it through.
    /// A swipe action goes to the gate directly, as the system plays its own haptic for it.
    func ask(_ intent: WriteIntent) {
        if case .batch(_, let change) = intent, let event = HapticEvent(change), !gate.locked() {
            haptics.play(event)
        }
        gate.require(intent)
    }

    /// A menu is about to open, or the selection bar to show: bar items give no touch-down to prepare on.
    func prepareHaptics() {
        haptics.prepare(.listAction)
        haptics.prepare(.statusChange)
    }

    /// A list write the gate let through; false for one this context does not run.
    @discardableResult
    func perform(_ intent: WriteIntent) -> Bool {
        switch intent {
        case .newNote:
            return false
        case .batch(let ids, let change):
            write(.notesBatch, ["ids": .array(ids.map(JSONValue.string)), "change": change.json]) { [weak self] result in
                let failed = result["failed"]?.array ?? []
                guard let self, !failed.isEmpty else { return }
                let codes = failed.compactMap { $0["code"]?.string }
                if let locked = codes.first(where: Self.locks) { return gate.refused(code: locked) }
                bridge?.log(.warn, "W_PHONE_BATCH_FAILED count=\(failed.count) code=\(codes.first ?? "")")
            }
        case .emptyTrash:
            write(.trashEmpty, [:]) { _ in }
        case .newTemplate:
            write(.templateCreate, [:]) { [weak self] made in
                if let id = made["id"]?.string { self?.open(id, "") }
            }
        case .fromTemplate(let templateId, let bookId):
            var args: [String: JSONValue] = ["templateId": .string(templateId)]
            if let bookId { args["bookId"] = .string(bookId) }
            write(.templateApply, args) { [weak self] made in
                if let id = made["id"]?.string { self?.open(id, "") }
            }
        }
        return true
    }

    private static func locks(_ code: String) -> Bool {
        code == ProGate.required || code == ProGate.unreadable
    }

    private func write(_ op: Op, _ args: [String: JSONValue], done: @escaping (JSONValue) -> Void) {
        guard let bridge else { return }
        bridge.request(op, args) { [weak self] outcome in
            switch outcome {
            case .ok(let result):
                done(result)
            case .failed(let code):
                guard let self else { return }
                if Self.locks(code) { return gate.refused(code: code) }
                bridge.log(.warn, "W_PHONE_LIST_WRITE_FAILED op=\(op.rawValue) code=\(code)")
            }
        }
    }

    /// The note's Markdown for the share sheet, read through the page.
    func text(_ id: String, done: @escaping (_ title: String, _ markdown: String) -> Void) {
        bridge?.request(.noteText, ["noteId": .string(id)]) { [weak self] outcome in
            switch outcome {
            case .ok(let note):
                done(note["title"]?.string ?? "", note["markdown"]?.string ?? "")
            case .failed(let code):
                self?.bridge?.log(.warn, "W_PHONE_SHARE_FAILED code=\(code)")
            }
        }
    }
}
