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

    func testNoteInfoReadsTheFrontMatterRowsAndWhatDiffersFromTheNote() throws {
        let figures: [String: JSONValue] = [
            "words": .number(1), "characters": .number(1), "readingMinutes": .number(1), "revisions": .number(0),
        ]
        var fields = figures
        fields["frontMatter"] = .object([
            "kind": .string("properties"),
            "rows": .array([
                .object([
                    "key": .string("title"), "value": .object(["kind": .string("text"), "text": .string("Trip")]),
                    "difference": .object([
                        "field": .string("title"), "badge": .string("Note: Plans"), "value": .string("Trip"),
                    ]),
                ]),
                .object([
                    "key": .string("tags"),
                    "value": .object([
                        "kind": .string("chips"),
                        "chips": .array([.object(["name": .string("work"), "color": .string("blue")]), .object(["name": .string("x")])]),
                    ]),
                    "difference": .object(["field": .string("tags"), "badge": .string("Note: No Tags"), "value": .null]),
                ]),
            ]),
        ])
        let info = try XCTUnwrap(NoteInfo(.object(fields)))
        XCTAssertEqual(
            info.frontMatter,
            .properties([
                .init(
                    key: "title", value: .text("Trip"),
                    difference: .init(field: .title, badge: "Note: Plans", value: "Trip")),
                .init(
                    key: "tags", value: .chips([.init(name: "work", color: "blue"), .init(name: "x", color: nil)]),
                    difference: .init(field: .tags, badge: "Note: No Tags", value: nil)),
            ]))
        fields["frontMatter"] = .object(["kind": .string("yaml"), "yaml": .string("- a")])
        XCTAssertEqual(NoteInfo(.object(fields))?.frontMatter, .yaml("- a"))
        fields["frontMatter"] = .object(["kind": .string("properties"), "rows": .array([.object(["key": .string("a")])])])
        XCTAssertNil(NoteInfo(.object(fields))?.frontMatter, "rows it cannot read are left out, the figures are not")
        XCTAssertNotNil(NoteInfo(.object(fields)))
        XCTAssertNil(NoteInfo(.object(figures))?.frontMatter)
    }
}
