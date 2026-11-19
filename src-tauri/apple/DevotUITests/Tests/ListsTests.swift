import DevotScreens
import XCTest

/// The native Notes list in the installed app: a row's swipe actions and the undo toast a trash offers.
@MainActor
final class ListsTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        // The undo toast lasts 4 s, less than a loaded runner's steps from seeing it to its Undo (#1019).
        app.launchArguments = ["-" + LaunchArgument.waitScale, "\(waitScale)"]
        app.launch(stoppedAfter: self)
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: waitLimit(120)))
        let notes = app.tabBars.firstMatch.buttons[L10n.phoneTabNotes()]
        XCTAssertTrue(notes.waitForExistence(timeout: waitLimit(10)))
        notes.tapOnceHittable()
    }

    /// The row whose label, its title and excerpt, holds `text`.
    private func row(holding text: String) -> XCUIElement {
        app.collectionViews.cells.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func pinned(_ row: XCUIElement) -> Bool {
        (row.value as? String)?.contains(L10n.sidebarPinned()) ?? false
    }

    private func keepScreen(_ step: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = step
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// A slow drag across half the row uncovers its actions without the full swipe's action.
    private func uncover(_ row: XCUIElement, leading: Bool) {
        let from = leading ? 0.15 : 0.85
        let to = leading ? 0.6 : 0.4
        row.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.5)).press(
            forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.5)),
            withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    private func tapAction(_ name: String) {
        let action = app.buttons[name]
        XCTAssertTrue(action.waitForExistence(timeout: waitLimit(5)), "the swipe uncovers \(name)")
        keepScreen("\(name) uncovered")
        action.tap()
    }

    /// A note of the test's own, with a line no earlier attempt typed. The tests used the welcome
    /// note: a trash answered after its attempt had failed still landed, and left it in the Trash for
    /// every attempt after (#955). The line is typed twice: the row's excerpt starts at the body's
    /// second line, and it is how the row is found.
    private func ownNote() -> XCUIElement {
        let line = "Lists \(UUID().uuidString.prefix(8))"
        let newNote = app.navigationBars.buttons[L10n.noteListNewNote()]
        XCTAssertTrue(newNote.waitForExistence(timeout: waitLimit(30)), "the Notes list offers New Note")
        XCTAssertTrue(waitUntil { newNote.isHittable })
        newNote.tap()
        let noteBar = app.navigationBars.containing(NSPredicate(format: "label == %@", L10n.phoneInfoTitle())).firstMatch
        XCTAssertTrue(noteBar.waitForExistence(timeout: waitLimit(10)), "New Note pushes the editor")
        XCTAssertTrue(app.otherElements["editor.cover"].waitForNonExistence(timeout: waitLimit(5)), "the cover fades")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: waitLimit(5)), "the body takes the caret")
        app.typeText("\(line)\n\(line)")
        let typed = app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", line)).firstMatch
        XCTAssertTrue(typed.waitForExistence(timeout: waitLimit(5)), "the line typed is on the page")
        noteBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(noteBar.waitForNonExistence(timeout: waitLimit(10)), "Back returns to the list")
        let row = row(holding: line)
        XCTAssertTrue(row.waitForExistence(timeout: waitLimit(10)), "the note is listed")
        XCTAssertTrue(waitUntil { row.isHittable })
        return row
    }

    func testTheLeadingSwipeTogglesThePinAndBack() {
        let row = ownNote()
        XCTAssertFalse(pinned(row), "a new note starts unpinned")
        for (name, now) in [(L10n.phoneActionPin(), true), (L10n.noteUnpin(), false)] {
            uncover(row, leading: true)
            tapAction(name)
            XCTAssertTrue(waitUntil({ pinned(row) == now }, timeout: 10), "\(name) changes the row's value")
        }
    }

    /// The toast stays only `motion.duration.phone-toast`, too short for an accessibility audit.
    func testATrashFromTheSwipeIsOfferedBackAndUndoRestoresTheRow() {
        let row = ownNote()
        uncover(row, leading: false)
        tapAction(L10n.phoneActionTrash())
        let toast = app.otherElements["devot.toast"]
        XCTAssertTrue(toast.waitForExistence(timeout: waitLimit(5)), "the trash offers an undo")
        XCTAssertTrue(app.staticTexts[L10n.phoneToastTrashed()].exists)
        XCTAssertTrue(row.waitForNonExistence(timeout: waitLimit(5)), "the row leaves the list")
        keepScreen("the undo toast")
        let undo = app.buttons["devot.toast.undo"]
        XCTAssertTrue(undo.isHittable)
        undo.tap()
        XCTAssertTrue(row.waitForExistence(timeout: waitLimit(10)), "Undo puts the note back")
        XCTAssertTrue(toast.waitForNonExistence(timeout: waitLimit(5)), "the toast goes once taken")
        keepScreen("the note restored")
    }
}
