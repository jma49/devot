import DevotScreens
import XCTest

/// `devot://` links and a relaunch in the installed app (docs/specs/iphone-screens.md, Routes and
/// Restoration), on the welcome example, whose ID is fixed.
@MainActor
final class DeepLinkTests: XCTestCase {
    private var app: XCUIApplication!
    private let example = URL(string: "devot://note/00000000-0000-7000-8000-000000000012")!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: waitLimit(120)))
    }

    /// The note's own bar, told from a list's by its Info button.
    private var noteBar: XCUIElement {
        app.navigationBars.containing(NSPredicate(format: "label == %@", L10n.phoneInfoTitle())).firstMatch
    }

    private func keepScreen(_ step: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = step
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testANoteLinkOpensTheNoteOverTheNotesList() {
        app.open(example)
        XCTAssertTrue(noteBar.waitForExistence(timeout: waitLimit(30)), "the link lands in the editor")
        keepScreen("linked note")
        noteBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars[L10n.phoneTabNotes()].waitForExistence(timeout: waitLimit(10)), "Back lands on Notes")
    }

    func testTheStackComesBackAfterTheAppLeftTheFrontAndWasRelaunched() {
        app.open(example)
        XCTAssertTrue(noteBar.waitForExistence(timeout: waitLimit(30)))
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: waitLimit(10)) || app.wait(for: .runningBackgroundSuspended, timeout: waitLimit(10)))
        // The record reaches the preferences store a moment after the app leaves; a kill before that reads as a crash.
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "the app stays in the background")], timeout: waitLimit(5))
        app.terminate()
        app.launch()
        XCTAssertTrue(noteBar.waitForExistence(timeout: waitLimit(120)), "the note is on top again")
        keepScreen("restored note")
        noteBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars[L10n.phoneTabNotes()].waitForExistence(timeout: waitLimit(10)))
    }
}
