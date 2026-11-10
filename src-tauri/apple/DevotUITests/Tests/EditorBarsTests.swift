import DevotScreens
import XCTest

/// The note's native bars in the installed app (design/motion.md, Bottom toolbar and the keyboard,
/// Formatting bar on the keyboard, Find bar): each test types into a new note of its own.
@MainActor
final class EditorBarsTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: waitLimit(120)))
        let notes = app.tabBars.firstMatch.buttons[L10n.phoneTabNotes()]
        XCTAssertTrue(notes.waitForExistence(timeout: waitLimit(10)))
        notes.tap()
    }

    private var noteBar: XCUIElement {
        app.navigationBars.containing(NSPredicate(format: "label == %@", L10n.phoneInfoTitle())).firstMatch
    }
    private var keyboard: XCUIElement { app.keyboards.firstMatch }
    private var formatting: XCUIElement { app.otherElements["devot.formatting"] }
    private var findBar: XCUIElement { app.otherElements["devot.find"] }
    /// Stands for the bottom toolbar: iOS 27 lists a screen-wide toolbar element even while the bar is hidden.
    private var findButton: XCUIElement { app.toolbars.buttons[L10n.phoneNoteFind()] }

    private func keepScreen(_ step: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = step
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The tree the query saw, for a check that fails while the screen looks right.
    private func keepHierarchy(_ step: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = step
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// New Note with the keyboard up, and a line typed so Back keeps it.
    private func newNote(typing text: String) {
        let newNote = app.navigationBars.buttons[L10n.noteListNewNote()]
        XCTAssertTrue(newNote.waitForExistence(timeout: waitLimit(30)))
        XCTAssertTrue(waitUntil { newNote.isHittable })
        newNote.tap()
        XCTAssertTrue(noteBar.waitForExistence(timeout: waitLimit(10)), "New Note pushes the editor")
        XCTAssertTrue(app.otherElements["editor.cover"].waitForNonExistence(timeout: waitLimit(5)))
        XCTAssertTrue(keyboard.waitForExistence(timeout: waitLimit(5)), "the body takes the caret")
        app.typeText(text)
    }

    /// #885: the first key typed scrolled the caret's line under the navigation bar.
    func testTheLineTypedStaysBetweenTheNavigationBarAndTheKeyboard() {
        let line = "The caret stays in view"
        newNote(typing: line)
        XCTAssertTrue(formatting.waitForExistence(timeout: waitLimit(5)))
        let typed = app.webViews.firstMatch.staticTexts
            .containing(NSPredicate(format: "label CONTAINS %@", line)).firstMatch
        XCTAssertTrue(typed.waitForExistence(timeout: waitLimit(5)), "the line typed is on the page")
        let inView = waitUntil {
            typed.frame.minY >= noteBar.frame.maxY - 1 && typed.frame.maxY <= formatting.frame.minY + 1
        }
        if !inView { keepScreen("line typed out of view") }
        XCTAssertTrue(inView, "the line typed shows between the navigation bar and the formatting bar")
    }

    func testTheFormattingBarRidesTheKeyboardAndHideKeyboardLowersIt() {
        newNote(typing: "Bars ride the keyboard")
        XCTAssertTrue(formatting.waitForExistence(timeout: waitLimit(5)), "the formatting bar is up with the keyboard")
        XCTAssertTrue(waitUntil { formatting.frame.maxY <= keyboard.frame.minY + 1 }, "it sits above the keyboard")
        XCTAssertTrue(waitUntil { !findButton.exists || !findButton.isHittable }, "the bottom toolbar steps aside")
        let bold = formatting.buttons[L10n.formatBold()]
        XCTAssertTrue(bold.exists)
        XCTAssertGreaterThanOrEqual(bold.frame.height, 44)
        keepScreen("the formatting bar on the keyboard")

        formatting.buttons[L10n.phoneNoteHideKeyboard()].tap()
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: waitLimit(5)), "Hide Keyboard lowers the keyboard")
        XCTAssertTrue(formatting.waitForNonExistence(timeout: waitLimit(5)), "the bar goes with it")
        let returned = waitUntil { findButton.exists && findButton.isHittable }
        if !returned { keepHierarchy("the toolbar after Hide Keyboard") }
        XCTAssertTrue(returned, "the bottom toolbar returns")
        keepScreen("the keyboard lowered")
    }

    func testADragDownThroughTheKeyboardDismissesIt() {
        newNote(typing: "Drag the keyboard away")
        XCTAssertTrue(formatting.waitForExistence(timeout: waitLimit(5)))
        let window = app.windows.firstMatch.frame
        let top = keyboard.frame.minY
        let start = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: window.midX, dy: max(window.minY + 160, top - 220)))
        start.press(
            forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: window.midX, dy: window.maxY - 4)),
            withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: waitLimit(5)), "the keyboard follows the drag down")
        keepScreen("dragged away")
    }

    func testFindShowsTheCountAsYouType() {
        newNote(typing: "cat dog cat bird cat")
        formatting.buttons[L10n.phoneNoteHideKeyboard()].tap()
        XCTAssertTrue(waitUntil { findButton.exists && findButton.isHittable })
        findButton.tap()
        XCTAssertTrue(findBar.waitForExistence(timeout: waitLimit(5)), "the find bar takes the formatting bar's place")
        XCTAssertFalse(formatting.exists)
        let field = findBar.textFields.firstMatch
        // typeText below fails unless the field has the keyboard's focus.
        XCTAssertTrue(keyboard.waitForExistence(timeout: waitLimit(5)), "the find field takes the keyboard")
        field.typeText("cat")
        let count = findBar.staticTexts[L10n.phoneFindCount(current: "1", total: "3")]
        XCTAssertTrue(count.waitForExistence(timeout: waitLimit(5)), "the count follows the query")
        findBar.buttons[L10n.phoneFindNext()].tap()
        XCTAssertTrue(findBar.staticTexts[L10n.phoneFindCount(current: "2", total: "3")].waitForExistence(timeout: waitLimit(5)))
        keepScreen("find counts")
        findBar.buttons[L10n.phoneFindClose()].tap()
        XCTAssertTrue(findBar.waitForNonExistence(timeout: waitLimit(5)))
    }

    func testMoveToTrashFromMoreLeavesTheNoteAndOffersTheUndoToast() {
        newNote(typing: "Trash me from the menu")
        noteBar.buttons[L10n.noteMore()].tap()
        let trash = app.buttons[L10n.noteMoveToTrash()]
        XCTAssertTrue(trash.waitForExistence(timeout: waitLimit(5)), "More lists Move to Trash")
        keepScreen("the More menu")
        trash.tap()
        XCTAssertTrue(noteBar.waitForNonExistence(timeout: waitLimit(10)), "the trashed note is left")
        let toast = app.otherElements["devot.toast"]
        XCTAssertTrue(toast.waitForExistence(timeout: waitLimit(5)), "the trash offers an undo")
        XCTAssertTrue(app.staticTexts[L10n.phoneToastTrashed()].exists)
        keepScreen("the undo toast")
    }
}
