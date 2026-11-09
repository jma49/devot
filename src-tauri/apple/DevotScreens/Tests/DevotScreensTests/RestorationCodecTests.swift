import UIKit
import XCTest

@testable import DevotScreens

private let note = "01970000-0000-7000-8000-0000000000d1"
private let other = "01970000-0000-7000-8000-0000000000d2"
private let book = "01970000-0000-7000-8000-0000000000e1"
private let saved = Date(timeIntervalSince1970: 1_800_000_000)

/// The record a launch restores from (docs/specs/iphone-screens.md, Restoration).
final class RestorationCodecTests: XCTestCase {
    private let record = Restoration(
        tab: .library,
        stacks: [
            .notes: [.editor(noteId: note)],
            .library: [.list(.book(book), .all), .editor(noteId: other)],
            .settings: [.pane("sync")],
        ],
        firstVisible: [.notes: note],
        newNotes: [Restoration.NewNote(id: other, bookId: book), Restoration.NewNote(id: note, bookId: nil)],
        savedAt: saved)

    func testAVersionOneRecordReadsBackAsItWasWritten() throws {
        let data = try XCTUnwrap(record.encoded())
        XCTAssertEqual(Restoration.decode(data), record)
        let fields = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(fields["v"] as? Int, 1)
    }

    func testARecordOfAnotherVersionOrThatDoesNotReadStartsAfresh() throws {
        var fields = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(record.encoded())) as? [String: Any])
        fields["v"] = 2
        XCTAssertNil(Restoration.decode(try JSONSerialization.data(withJSONObject: fields)))
        XCTAssertNil(Restoration.decode(Data("{\"v\":1}".utf8)))
        XCTAssertNil(Restoration.decode(Data("not json".utf8)))
        XCTAssertNil(Restoration.decode(nil))
    }

    func testACrashOrMoreThanEightHoursAwayStartsAtTheDefaultTab() {
        XCTAssertEqual(record.restorable(at: saved.addingTimeInterval(7 * 3600), crashed: false), record)
        XCTAssertNil(record.restorable(at: saved.addingTimeInterval(8 * 3600 + 1), crashed: false))
        XCTAssertNil(record.restorable(at: saved.addingTimeInterval(60), crashed: true))
        XCTAssertNil(record.restorable(at: saved.addingTimeInterval(-3600), crashed: false), "a clock set back")
    }

    func testAnEditorWhoseNoteIsGoneEndsItsStackThere() {
        XCTAssertEqual(record.editorIds, [note, other])
        let cut = record.cut(live: [note])
        XCTAssertEqual(cut.stacks[.notes], [.editor(noteId: note)])
        XCTAssertEqual(cut.stacks[.library], [.list(.book(book), .all)])
        XCTAssertEqual(cut.stacks[.settings], [.pane("sync")])
        XCTAssertEqual(Restoration.cut([.editor(noteId: other), .trash], live: []), [])
    }

    func testTheRecordHoldsKindsAndIdsOnly() throws {
        let data = try XCTUnwrap(record.encoded())
        var strings: Set<String> = []
        func collect(_ value: JSONValue) {
            switch value {
            case .string(let text): strings.insert(text)
            case .array(let values): values.forEach(collect)
            case .object(let fields): fields.values.forEach(collect)
            case .null, .bool, .number: break
            }
        }
        collect(try JSONDecoder().decode(JSONValue.self, from: data))
        XCTAssertEqual(strings, [note, other, book, "library", "all", "sync"])
    }
}

/// The record written as the app leaves the front, and the stacks a launch rebuilds from it.
@MainActor
final class RestoreFlowTests: XCTestCase {
    private var harness: ScreensHarness?
    private var defaults: UserDefaults!

    override func setUp() async throws {
        defaults = try freshDefaults()
    }

    override func tearDown() async throws {
        harness?.close()
        harness = nil
    }

    private func launch(after record: Restoration?, crashed: Bool = false, shownFirst: Bool = false) throws
        -> ScreensHarness
    {
        if let record { defaults.set(record.encoded(), forKey: Restoration.key) }
        defaults.set(crashed, forKey: Restoration.runningKey)
        let harness = try ScreensHarness(defaults: defaults, shownFirst: shownFirst)
        self.harness = harness
        return harness
    }

    private func saved() throws -> Restoration {
        try XCTUnwrap(Restoration.decode(defaults.data(forKey: Restoration.key)))
    }

    func testALaunchRebuildsTheLastStacksBeforeItsFirstFrame() throws {
        let record = Restoration(
            tab: .notes,
            stacks: [.notes: [.editor(noteId: note)], .library: [.trash], .settings: [.pane("sync")]],
            savedAt: Date())
        let harness = try launch(after: record)
        let editor = try XCTUnwrap(harness.navigation(.notes).topViewController as? EditorScreen)
        XCTAssertEqual(editor.noteId, note)
        XCTAssertTrue(harness.navigation(.library).topViewController is TrashScreen)
        XCTAssertEqual(harness.navigation(.settings).topViewController?.restorationIdentifier, "sync")
        XCTAssertEqual(harness.screens.root.tabs.selected, .notes)
        XCTAssertEqual(harness.screens.lastStackAnimated, false)
        XCTAssertFalse(harness.directs().contains { $0.op == .listsTitles }, "Rust takes requests once the install returns")
        harness.settle(until: {
            harness.requests().contains { $0.op == .tabsShow } && harness.directs().contains { $0.op == .listsTitles }
        })
        XCTAssertTrue(
            harness.requests().contains { $0.op == .tabsShow && $0.args == ["tab": .string("notes")] },
            "the page is told the restored tab")
        XCTAssertEqual(harness.directs().last { $0.op == .listsTitles }?.args, ["ids": .array([.string(note)])])
        harness.answerTitles([note: "Plans"])
        XCTAssertEqual(editor.cover.title, "Plans")
        XCTAssertEqual(harness.navigation(.notes).viewControllers.count, 2)
    }

    func testWhatTheRestoredScreensAskWaitsUntilRustsInstallHasReturned() throws {
        let record = Restoration(tab: .notes, stacks: [.notes: [.editor(noteId: note)]], savedAt: Date())
        let harness = try launch(after: record, shownFirst: true)
        XCTAssertTrue(harness.rust.calls.isEmpty, "Rust refuses every call until the install returns")
        harness.settle(until: {
            let ops = harness.requests().map(\.op)
            return ops.contains(.tabsShow) && ops.contains(.editorShow)
        })
    }

    func testARestoredEditorWhoseNoteIsGoneIsCutFromItsStack() throws {
        let record = Restoration(tab: .notes, stacks: [.notes: [.editor(noteId: note)]], savedAt: Date())
        let harness = try launch(after: record)
        harness.settle(until: { harness.directs().contains { $0.op == .listsTitles } })
        harness.answerTitles([:])
        XCTAssertEqual(harness.navigation(.notes).viewControllers.count, 1)
    }

    func testALaunchAfterACrashStartsAtTheLibrary() throws {
        let record = Restoration(tab: .notes, stacks: [.notes: [.editor(noteId: note)]], savedAt: Date())
        let harness = try launch(after: record, crashed: true)
        XCTAssertEqual(harness.navigation(.notes).viewControllers.count, 1)
        XCTAssertEqual(harness.screens.root.tabs.selected, .library)
        XCTAssertTrue(defaults.bool(forKey: Restoration.runningKey), "set again until this launch leaves the front")
    }

    func testTheLastLaunchsUntouchedNewNotesAreDiscardedAsTheyWereMade() throws {
        let record = Restoration(
            tab: .library, newNotes: [Restoration.NewNote(id: note, bookId: book)], savedAt: Date())
        let harness = try launch(after: record)
        harness.settle(until: { harness.requests().contains { $0.op == .noteDiscard } })
        let discard = try XCTUnwrap(harness.requests().first { $0.op == .noteDiscard })
        XCTAssertEqual(discard.args, ["noteId": .string(note), "made": .object(["bookId": .string(book)])])
    }

    func testANewNoteIsKeptOnlyOnceSomethingChangedInIt() throws {
        let harness = try launch(after: nil)
        harness.settle()
        harness.answerAll()
        harness.deliver(#"{"v":1,"notice":"note.new","bookId":"\#(book)"}"#)
        harness.answer(.noteCreate, .ok(.object(["id": .string(note), "rev": .number(3)])))
        harness.screens.save()
        var record = try saved()
        XCTAssertEqual(record.stacks[.library], [])
        XCTAssertEqual(record.newNotes, [Restoration.NewNote(id: note, bookId: book)])
        XCTAssertEqual(record.tab, .library)

        harness.deliver(#"{"v":1,"notice":"notes.changed","rev":4,"ids":["\#(note)"]}"#)
        harness.screens.save()
        record = try saved()
        XCTAssertEqual(record.stacks[.library], [.editor(noteId: note)])
        XCTAssertEqual(record.newNotes, [])
    }
}
