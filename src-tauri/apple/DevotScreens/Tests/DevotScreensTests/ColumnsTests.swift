import UIKit
import XCTest

@testable import DevotScreens

private let first = "01970000-0000-7000-8000-0000000000c1"
private let second = "01970000-0000-7000-8000-0000000000c2"
private let made = "01970000-0000-7000-8000-0000000000c3"

private let widths = ColumnLayout.Widths(twoColumns: 960, threeColumns: 1280, sidebar: 300, list: 360)

/// Which columns a width gets and which screens go in each (docs/specs/iphone-screens.md, Columns).
final class ColumnLayoutTests: XCTestCase {
    func testAWideRegularWidthGetsColumnsAndANarrowOrCompactOneTheStack() {
        XCTAssertEqual(ColumnLayout.fitting(width: 1366, regular: false, allowsThree: true, widths: widths), .one)
        XCTAssertEqual(ColumnLayout.fitting(width: 834, regular: true, allowsThree: true, widths: widths), .one)
        XCTAssertEqual(ColumnLayout.fitting(width: 960, regular: true, allowsThree: true, widths: widths), .two)
        XCTAssertEqual(ColumnLayout.fitting(width: 1194, regular: true, allowsThree: true, widths: widths), .two)
        XCTAssertEqual(ColumnLayout.fitting(width: 1366, regular: true, allowsThree: true, widths: widths), .three)
        XCTAssertEqual(ColumnLayout.fitting(width: 1366, regular: true, allowsThree: false, widths: widths), .two)
    }

    func testTheNotesOnTopGoLastAndWithThreeColumnsTheRootGoesFirst() {
        let stack = ["library", "book", "tag", "note", "link"]
        let isNote = { (name: String) in name == "note" || name == "link" }
        XCTAssertEqual(ColumnLayout.one.split(stack, isNote: isNote), [stack])
        XCTAssertEqual(ColumnLayout.two.split(stack, isNote: isNote), [["library", "book", "tag"], ["note", "link"]])
        XCTAssertEqual(
            ColumnLayout.three.split(stack, isNote: isNote), [["library"], ["book", "tag"], ["note", "link"]])
        XCTAssertEqual(ColumnLayout.three.split(["library"], isNote: isNote), [["library"], [], []])
        XCTAssertEqual(
            ColumnLayout.two.split(["notes", "note", "list"], isNote: isNote), [["notes", "note", "list"], []],
            "only the notes on top go beside")
    }

    func testTheNoteTakesTheWidthTheLeadingColumnsLeave() {
        XCTAssertEqual(ColumnLayout.one.columnWidths(total: 1024, widths: widths), [1024])
        XCTAssertEqual(ColumnLayout.two.columnWidths(total: 1024, widths: widths), [360, 664])
        XCTAssertEqual(ColumnLayout.three.columnWidths(total: 1366, widths: widths), [300, 360, 706])
    }
}

/// An iPad's Notes and Library in columns, with a stand-in web view and Rust.
@MainActor
final class ColumnsTests: XCTestCase {
    private var harness: ScreensHarness!

    override func setUp() async throws {
        harness = try ScreensHarness(defaults: try freshDefaults(), columns: true)
        resize(CGSize(width: 1366, height: 1024))
        harness.answerAll()
    }

    override func tearDown() async throws {
        harness.close()
        harness = nil
    }

    private var tabs: DevotTabBarController { harness.screens.root.tabs }
    private var host: WebViewHost { harness.screens.root.host }

    private func columns(_ tab: Tab) throws -> NoteColumns {
        try XCTUnwrap(tabs.columns[tab])
    }

    private func resize(_ size: CGSize, regular: Bool = true) {
        harness.window.frame = CGRect(origin: .zero, size: size)
        harness.screens.root.traitOverrides.horizontalSizeClass = regular ? .regular : .compact
        harness.window.layoutIfNeeded()
        harness.settle()
        harness.window.layoutIfNeeded()
    }

    private func showNotes() throws -> NoteColumns {
        tabs.select(.notes)
        harness.settle()
        harness.window.layoutIfNeeded()
        harness.answerAll()
        return try columns(.notes)
    }

    private func open(_ id: String, _ title: String) {
        tabs.lists.open(id, title)
        harness.settle()
        harness.answerAll()
    }

    func testANoteOpensBesideItsListAndTheNextOneTakesItsPlace() throws {
        let notes = try showNotes()
        XCTAssertEqual(notes.layout, .two)
        open(first, "First")
        let one = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        XCTAssertEqual(one.noteId, first)
        XCTAssertTrue(notes.stack.topViewController is NoteListScreen, "the list stays where it was")
        harness.settle(until: { self.host.holder === one })
        XCTAssertEqual(host.webView.bounds.width, notes.notes.view.bounds.width, "the page is the column's width")
        XCTAssertLessThan(host.webView.bounds.width, harness.window.bounds.width)
        XCTAssertFalse(tabs.isTabBarHidden, "the tabs stay beside a note")
        let bar = notes.notes.navigationBar
        XCTAssertEqual(
            one.webContainer.convert(one.webContainer.bounds, to: nil).minY + harness.window.safeAreaInsets.top,
            bar.convert(bar.bounds, to: nil).minY, accuracy: 0.5, "the page keeps its bar's room where the bar is")

        open(second, "Second")
        let two = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        XCTAssertEqual(two.noteId, second)
        XCTAssertEqual(notes.notes.viewControllers.count, 1, "a note from the list takes the place of the one shown")
        XCTAssertEqual(tabs.controllers(.notes).count, 2)
        XCTAssertFalse(
            harness.requests().contains { $0.op == .editorHide }, "the list beside the note never lets it go")
    }

    func testANarrowerWindowStacksTheNoteOverItsListAndAWiderOneSetsItBesideAgain() throws {
        let notes = try showNotes()
        let list = try XCTUnwrap(notes.stack.topViewController)
        let room = list.view.safeAreaInsets
        open(first, "First")
        let one = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        XCTAssertFalse(one.hidesBottomBarWhenPushed, "the tabs follow the bar, never a push")

        resize(CGSize(width: 834, height: 1194))
        XCTAssertEqual(notes.layout, .one)
        XCTAssertTrue(notes.stack.topViewController === one, "the same screen, on top of the one stack")
        XCTAssertNil(notes.notes.parent)
        harness.settle(until: { self.host.holder === one })
        XCTAssertEqual(host.webView.bounds.width, 834)
        harness.settle(until: { self.tabs.isTabBarHidden })

        resize(CGSize(width: 1366, height: 1024))
        XCTAssertEqual(notes.layout, .two)
        XCTAssertTrue(notes.notes.topViewController === one)
        XCTAssertTrue(notes.stack.topViewController is NoteListScreen)
        harness.settle(until: { self.host.holder === one && !self.tabs.isTabBarHidden })
        harness.settle(until: { list.view.safeAreaInsets == room }, timeout: 5)
        XCTAssertFalse(harness.requests().contains { $0.op == .noteDiscard })
    }

    func testACompactWidthKeepsTheOneStackHoweverWideTheWindow() throws {
        resize(CGSize(width: 1366, height: 1024), regular: false)
        let notes = try showNotes()
        XCTAssertEqual(notes.layout, .one)
        open(first, "First")
        XCTAssertTrue(notes.stack.topViewController is EditorScreen)
    }

    func testAnUntouchedNewNoteSurvivesTheColumnsMovingAroundIt() throws {
        let notes = try showNotes()
        harness.deliver(#"{"v":1,"notice":"note.new"}"#)
        let screen = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        XCTAssertTrue(screen.isNew)
        harness.answer(.noteCreate, .ok(.object(["id": .string(made), "rev": .number(3)])))
        harness.settle()

        resize(CGSize(width: 834, height: 1194))
        resize(CGSize(width: 1366, height: 1024))
        harness.answerAll()
        XCTAssertTrue(notes.notes.topViewController === screen)
        XCTAssertFalse(harness.requests().contains { $0.op == .noteDiscard }, "the note never left the tab")

        open(first, "First")
        harness.settle(until: { self.harness.requests().contains { $0.op == .noteDiscard } })
    }

    func testTodayFromAnotherTabOpensBesideTheNotesListItLaidOutNarrower() throws {
        let notes = try showNotes()
        resize(CGSize(width: 834, height: 1194))
        XCTAssertEqual(notes.layout, .one)
        tabs.select(.library)
        resize(CGSize(width: 1366, height: 1024))
        XCTAssertEqual(notes.layout, .one, "a tab out of sight keeps the layout it last had")
        harness.deliver(#"{"v":1,"notice":"route","route":"today"}"#)
        harness.answer(.noteToday, .ok(.object(["id": .string(first)])))
        harness.answerTitles([first: "2026-11-19"])
        harness.settle(until: { notes.notes.topViewController is EditorScreen }, timeout: 5)
        harness.settle()
        XCTAssertEqual((notes.notes.topViewController as? EditorScreen)?.noteId, first)
        XCTAssertTrue(notes.stack.topViewController is NoteListScreen, "the list keeps its column")
        XCTAssertEqual(notes.stack.viewControllers.count, 1)
    }

    func testTheLibraryShowsItsListBetweenItAndTheNote() throws {
        tabs.select(.library)
        harness.settle()
        let library = try columns(.library)
        XCTAssertEqual(library.layout, .three)
        let list = LibraryScreen.list(.all, .all, tab: .library, context: tabs.lists)
        library.openList(list)
        XCTAssertTrue(library.lists.topViewController === list)
        XCTAssertTrue(library.stack.topViewController is LibraryScreen)
        open(first, "First")
        XCTAssertTrue(library.notes.topViewController is EditorScreen)
        let stack = tabs.controllers(.library)
        XCTAssertEqual(stack.count, 3)
        XCTAssertTrue(stack[0] is LibraryScreen && stack[1] === list && stack[2] is EditorScreen)

        resize(CGSize(width: 1194, height: 834))
        XCTAssertEqual(library.layout, .two)
        XCTAssertTrue(library.stack.topViewController === list, "with two columns the list joins the Library's")
        XCTAssertTrue(library.notes.topViewController is EditorScreen)
    }

    func testTheListsSlideAwayForTheNoteAndComeBack() throws {
        let notes = try showNotes()
        open(first, "First")
        let one = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        harness.settle(until: { self.host.holder === one })
        one.toggleLists()
        harness.window.layoutIfNeeded()
        XCTAssertTrue(notes.leadingHidden)
        XCTAssertEqual(notes.notes.view.frame.width, harness.window.bounds.width)
        harness.settle(until: { self.host.webView.bounds.width == self.harness.window.bounds.width })
        XCTAssertEqual(one.columnsItem.accessibilityLabel, L10n.phoneColumnsShow())

        one.toggleLists()
        harness.window.layoutIfNeeded()
        XCTAssertFalse(notes.leadingHidden)
        XCTAssertEqual(notes.notes.view.frame.minX, Tokens.Size.padListWidth)
    }

    func testANoteTrashedBesideItsListLeavesTheColumnEmptyAndThePageLetsItGo() throws {
        let notes = try showNotes()
        open(first, "First")
        let one = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        notes.close(one, animated: false)
        harness.settle()
        XCTAssertTrue(notes.notes.topViewController is ColumnPlaceholder)
        XCTAssertEqual(tabs.controllers(.notes).count, 1)
        harness.settle(until: { self.harness.requests().contains { $0.op == .editorHide } })
    }

    func testTheKeysOfTheAppAndOfTheNoteAreNamedForTheListAHeldCommandShows() throws {
        let app = try XCTUnwrap(tabs.keyCommands)
        XCTAssertEqual(
            app.map { [$0.input ?? "", String($0.modifierFlags.rawValue)] },
            [
                ["n", String(UIKeyModifierFlags.command.rawValue)],
                ["t", String(UIKeyModifierFlags([.command, .alternate]).rawValue)],
                ["f", String(UIKeyModifierFlags([.command, .shift]).rawValue)],
                [",", String(UIKeyModifierFlags.command.rawValue)],
            ])
        XCTAssertTrue(app.allSatisfy { !$0.title.isEmpty })

        let notes = try showNotes()
        open(first, "First")
        let one = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        harness.settle(until: { self.host.holder === one })
        let keys = try XCTUnwrap(one.keyCommands).map(\.input)
        XCTAssertEqual(keys, ["f", "e", "i", "s"], "Find, Edit and Preview, Note Info and the lists; no Back at the root")
        one.startFind()
        XCTAssertTrue(try XCTUnwrap(one.keyCommands).contains { $0.input == UIKeyCommand.inputEscape })
        one.closeFind()
    }

    func testCommandNStartsANoteBesideTheListShown() throws {
        let notes = try showNotes()
        open(first, "First")
        tabs.onKey?(.newNote)
        harness.settle()
        let screen = try XCTUnwrap(notes.notes.topViewController as? EditorScreen)
        XCTAssertTrue(screen.isNew, "beside the list, New Note takes the shown note's place")
        XCTAssertTrue(harness.requests().contains { $0.op == .noteCreate })
    }
}
