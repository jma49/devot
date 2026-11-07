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
}
