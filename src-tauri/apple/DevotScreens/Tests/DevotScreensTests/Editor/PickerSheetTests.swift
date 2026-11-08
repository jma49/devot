import UIKit
import XCTest

@testable import DevotScreens

/// design/motion.md, Sheets: the editor's pickers stand at medium and large with a grabber and a
/// close item, and write only when a row is picked.
@MainActor
final class PickerSheetTests: XCTestCase {
    private var writes: [WriteIntent] = []
    private var library: LibraryContents?

    private let counts = LibraryCounts(all: 3, pinned: 0, active: 0, onHold: 0, completed: 0, templates: 0, trash: 0)

    override func setUp() async throws {
        writes = []
        library = LibraryContents(
            counts: counts,
            books: [
                LibraryBook(id: "b1", name: "Work", parentId: nil, icon: nil, iconColor: nil, count: 2),
                LibraryBook(id: "b2", name: "Plans", parentId: "b1", icon: nil, iconColor: nil, count: 1),
            ],
            tags: [
                LibraryTag(id: "t1", name: "draft", color: nil, count: 1),
                LibraryTag(id: "t2", name: "ideas", color: nil, count: 0),
            ],
            savedSearches: [])
    }

    private var context: PickerContext {
        PickerContext(
            write: { [unowned self] in writes.append($0) }, library: { [unowned self] in $0(library) },
            haptics: Haptics(make: HapticRecorder().make))
    }

    private func note(book: String? = "b1", status: String = "active", tags: [String] = ["t1"]) -> EditorNote {
        EditorNote(id: "n1", bookId: book, status: status, pinned: false, tagIds: tags, createdAt: 1, updatedAt: 2)
    }

    func testASheetStandsAtMediumAndLargeWithAGrabberAndACloseItem() throws {
        let content = UIViewController()
        let wrapped = PickerSheet.wrap(content)
        XCTAssertEqual(wrapped.viewControllers, [content])
        XCTAssertEqual(wrapped.modalPresentationStyle, .pageSheet)
        let sheet = try XCTUnwrap(wrapped.sheetPresentationController)
        XCTAssertEqual(sheet.detents.map(\.identifier), [.medium, .large])
        XCTAssertTrue(sheet.prefersGrabberVisible)
        XCTAssertTrue(sheet.prefersScrollingExpandsWhenScrolledToEdge)
        XCTAssertNotNil(content.navigationItem.rightBarButtonItem)
    }

    func testStatusTicksTheNotesStatusAndWritesOnlyAnotherOne() throws {
        let list = NotePickers.status(note: note(), context: context)
        XCTAssertEqual(list.rows.filter(\.on).map(\.title), [NoteStatus.active.name])
        XCTAssertTrue(writes.isEmpty, "opening a picker writes nothing")
        list.pick(try XCTUnwrap(NoteStatus.allCases.firstIndex(of: .active)))
        XCTAssertTrue(writes.isEmpty)
        let completed = try XCTUnwrap(NoteStatus.allCases.firstIndex(of: .completed))
        list.pick(completed)
        XCTAssertEqual(writes, [.batch(ids: ["n1"], change: .status(.completed))])
    }

    func testNotebookListsNoNotebookThenEachBookIndentedAndMovesOnlyToAnother() {
        let list = NotePickers.notebook(note: note(), context: context)
        XCTAssertEqual(list.rows.map(\.title), [L10n.phoneNoNotebook(), "Work", "Plans"])
        XCTAssertEqual(list.rows.map(\.depth), [0, 0, 1])
        XCTAssertEqual(list.rows.map(\.on), [false, true, false])
        list.pick(1)
        XCTAssertTrue(writes.isEmpty)
        list.pick(2)
        list.pick(0)
        XCTAssertEqual(writes, [.batch(ids: ["n1"], change: .book("b2")), .batch(ids: ["n1"], change: .book(nil))])
    }

    func testTagsToggleEachTagAndAFilterWithANewNameMakesTheTag() {
        let picker = NotePickers.tags(note: note(), context: context)
        picker.loadViewIfNeeded()
        XCTAssertEqual(picker.rows.map(\.title), ["draft", "ideas"])
        XCTAssertEqual(picker.rows.map(\.on), [true, false])
        picker.pick(0)
        picker.pick(1)
        XCTAssertEqual(
            writes, [.batch(ids: ["n1"], change: .removeTag("t1")), .batch(ids: ["n1"], change: .putTag("t2"))])
        picker.noteChanged(note(tags: ["t2"]))
        XCTAssertEqual(picker.rows.map(\.on), [false, true])
        picker.filter("Draft")
        XCTAssertEqual(picker.rows.map(\.title), ["draft"], "an existing name offers no new tag")
        picker.filter("trip")
        XCTAssertEqual(picker.rows.first?.title, L10n.tagPickCreate(name: "trip"))
        picker.pick(0)
        XCTAssertEqual(writes.last, .addTag(noteId: "n1", name: "trip"))
        XCTAssertEqual(picker.search.searchBar.text, "")
    }

    func testAPickPlaysThePickerHapticAndASingleChoiceClosesTheSheetFirst() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let presenter = UIViewController()
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let recorder = HapticRecorder()
        var context = context
        context.haptics = Haptics(make: recorder.make)
        let list = NotePickers.status(note: note(), context: context)
        PickerSheet.present(list, from: presenter)
        let deadline = Date().addingTimeInterval(10)
        while presenter.presentedViewController == nil || presenter.presentedViewController?.isBeingPresented == true,
            Date() < deadline
        {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        list.pick(try XCTUnwrap(NoteStatus.allCases.firstIndex(of: .onHold)))
        XCTAssertEqual(recorder.log, ["selection.prepare", "selection.occurred"])
        XCTAssertTrue(writes.isEmpty, "the write waits for the sheet to close")
        while presenter.presentedViewController != nil, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertEqual(writes, [.batch(ids: ["n1"], change: .status(.onHold))])
    }
}
