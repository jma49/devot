import UIKit
import XCTest

@testable import DevotScreens

/// The notebook menus' choices: what is ticked and what a tap writes (design/phone.md, Note list rows).
@MainActor
final class ListMenusTests: XCTestCase {
    private let work = "01970000-0000-7000-8000-0000000000b1"
    private let child = "01970000-0000-7000-8000-0000000000b2"

    private func contents() throws -> LibraryContents {
        let book = { (id: String, name: String, parent: String?) -> JSONValue in
            .object([
                "id": .string(id), "name": .string(name), "parentId": parent.map(JSONValue.string) ?? .null,
                "icon": .null, "iconColor": .null, "count": .number(1),
            ])
        }
        let value = JSONValue.object([
            "counts": .object([
                "all": .number(0), "pinned": .number(0), "active": .number(0), "onHold": .number(0),
                "completed": .number(0), "templates": .number(0), "trash": .number(0),
            ]),
            "books": .array([book(work, "Work", nil), book(child, "Plans", work)]),
            "tags": .array([]),
            "savedSearches": .array([]),
        ])
        return try XCTUnwrap(value.decoded(LibraryContents.self))
    }

    func testOneNoteTicksItsNotebookAndChoosingItAgainWritesNothing() throws {
        let choices = ListMenus.notebookChoices(try contents(), for: .note(in: work))
        XCTAssertEqual(choices.map(\.book), [nil, work, child])
        XCTAssertEqual(choices.map(\.on), [false, true, false])
        XCTAssertEqual(choices.map(\.depth), [0, 0, 1])
        XCTAssertEqual(choices.filter(\.writes).map(\.book), [nil, child])
    }

    func testAnUnfiledNoteTicksNoNotebook() throws {
        let choices = ListMenus.notebookChoices(try contents(), for: .note(in: nil))
        XCTAssertEqual(choices.first?.title, L10n.phoneNoNotebook())
        XCTAssertEqual(choices.first?.on, true)
        XCTAssertFalse(try XCTUnwrap(choices.first).writes)
    }

    func testSeveralNotesTickNothingAndNoNotebookMovesThemOut() throws {
        let choices = ListMenus.notebookChoices(try contents(), for: .notes)
        XCTAssertEqual(choices.map(\.on), [false, false, false])
        XCTAssertEqual(choices.filter(\.writes).map(\.book), [nil, work, child])
    }

    func testANewNoteChoosesOnlyANotebook() throws {
        let choices = ListMenus.notebookChoices(try contents(), for: .newNote)
        XCTAssertEqual(choices.map(\.book), [work, child])
        XCTAssertTrue(choices.allSatisfy(\.writes))
    }
}
