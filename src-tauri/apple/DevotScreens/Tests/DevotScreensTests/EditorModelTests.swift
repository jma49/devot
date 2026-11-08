import XCTest

@testable import DevotScreens

final class EditorModelTests: XCTestCase {
    func testTheToggleShowsTheModeItSwitchesTo() {
        XCTAssertEqual(NoteMode.edit.toggleSymbol, "eye")
        XCTAssertEqual(NoteMode.preview.toggleSymbol, "pencil")
        XCTAssertEqual(NoteMode.edit.other, .preview)
    }

    func testTheCoverFadesOnceThePushHasDrawnAndThePageHasPainted() {
        var cover = CoverModel()
        cover.raise()
        XCTAssertFalse(cover.ready())
        XCTAssertTrue(cover.firstFrame())
        XCTAssertFalse(cover.ready())
        XCTAssertFalse(cover.timedOut())

        cover.raise()
        XCTAssertFalse(cover.firstFrame())
        XCTAssertTrue(cover.ready())
    }

    func testTheCoverFadesAnywayWhenThePageIsSlow() {
        var cover = CoverModel()
        XCTAssertFalse(cover.timedOut())
        cover.raise()
        XCTAssertTrue(cover.timedOut())
        XCTAssertFalse(cover.firstFrame())
        XCTAssertFalse(cover.ready())
    }

    func testTheEditorsNoteFactsReadFromTheNoticeAndRefuseAMalformedNotebook() {
        let fields: [String: JSONValue] = [
            "id": .string("n1"), "bookId": .null, "status": .string("active"), "pinned": .bool(true),
            "tagIds": .array([.string("t1")]), "createdAt": .number(1), "updatedAt": .number(2),
        ]
        XCTAssertEqual(
            EditorNote(fields),
            EditorNote(id: "n1", bookId: nil, status: "active", pinned: true, tagIds: ["t1"], createdAt: 1, updatedAt: 2))
        var wrong = fields
        wrong["bookId"] = .number(3)
        XCTAssertNil(EditorNote(wrong))
        wrong = fields
        wrong["pinned"] = nil
        XCTAssertNil(EditorNote(wrong))
    }

    func testNoteInfoReadsItsFiguresAndBacklinks() {
        let info = NoteInfo(
            .object([
                "words": .number(12), "characters": .number(60), "readingMinutes": .number(1), "revisions": .number(3),
                "backlinks": .array([.object(["id": .string("n2"), "title": .string("Plans")])]),
            ]))
        XCTAssertEqual(info?.words, 12)
        XCTAssertEqual(info?.backlinks, [NoteInfo.Link(id: "n2", title: "Plans")])
        XCTAssertNil(NoteInfo(.object([:])))
    }
}
