import DevotScreens
import XCTest

/// New Note from the Notes list in the installed app: the editor pushed with the keyboard up, the
/// untouched note gone again on Back, and the Pro sheet instead of the editor while locked.
@MainActor
final class NewNoteTests: XCTestCase {
    private var app: XCUIApplication!

    private func launch(_ arguments: [String] = []) {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launchArguments = arguments
        app.launch()
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 120))
        let notes = app.tabBars.firstMatch.buttons[L10n.phoneTabNotes()]
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        notes.tapOnceHittable()
    }

    /// The note's own bar, told from a list's by its Info button.
    private var noteBar: XCUIElement {
        app.navigationBars.containing(NSPredicate(format: "label == %@", L10n.phoneInfoTitle())).firstMatch
    }
    private var newNote: XCUIElement { app.navigationBars.buttons[L10n.noteListNewNote()] }

    /// The native list's cells: its section heads and one row per listed note.
    private var rows: XCUIElementQuery { app.collectionViews.firstMatch.cells }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    private func keepScreen(_ step: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = step
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testNewNotePushesTheEditorWithTheKeyboardUpAndBackLeavesNoEmptyNote() {
        launch()
        XCTAssertTrue(newNote.waitForExistence(timeout: 30), "the Notes list offers New Note")
        XCTAssertTrue(waitUntil { rows.count > 0 }, "the welcome example is listed")
        let listed = rows.count
        newNote.tap()
        XCTAssertTrue(noteBar.waitForExistence(timeout: 10), "New Note pushes the editor")
        XCTAssertTrue(app.otherElements["editor.cover"].waitForNonExistence(timeout: 5), "the cover fades")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "the body takes the caret")
        keepScreen("the new note")
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        keepScreen("the new note settled")
        noteBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(noteBar.waitForNonExistence(timeout: 10), "Back returns to the list")
        XCTAssertTrue(waitUntil({ rows.count == listed }, timeout: 10), "the untouched note is not kept")
        keepScreen("back on the list")
    }

    func testALockedNewNoteShowsTheProSheetAndNoEditor() throws {
        launch(["-DevotLicenceFixture", "K1"])
        XCTAssertTrue(newNote.waitForExistence(timeout: 30), "the Notes list offers New Note")
        XCTAssertTrue(waitUntil { newNote.isHittable })
        newNote.tap()
        let title = app.staticTexts[L10n.phonePurchaseEnded()]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the Pro sheet rises")
        XCTAssertFalse(noteBar.exists, "no editor is pushed")
        XCTAssertFalse(app.otherElements["editor.cover"].exists)
        keepScreen("the Pro sheet")
        let enterKey = app.buttons[L10n.phonePurchaseEnterKey()]
        let notNow = app.buttons[L10n.phoneProNotNow()]
        // A partial-height sheet is drawn scaled to its inset width, the system's controls in it too, so a
        // target is measured in the sheet's own points, once the sheet has come to rest.
        let sheet = app.scrollViews.containing(.button, identifier: L10n.phoneProNotNow()).firstMatch
        var last = CGRect.null
        _ = waitUntil {
            defer { last = sheet.frame }
            return sheet.frame == last
        }
        let scale = sheet.frame.width / app.windows.firstMatch.frame.width
        XCTAssertGreaterThan(scale, 0.9, "the sheet is drawn near full size")
        for button in [enterKey, notNow] {
            XCTAssertTrue(button.exists, button.label)
            XCTAssertGreaterThanOrEqual(button.frame.height / scale, 44, button.label)
        }
        // Contrast is left out: the filled action is the shared sheet button on the accent, which the
        // purchase sheet uses too, measured over the list the sheet's material lets through.
        try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.contrast)) { issue in
            let element = issue.element
            // The lens's symbol keeps its fixed size, as the purchase sheet's does.
            if issue.auditType == .dynamicType && element?.elementType == .image { return true }
            // The list's text shows dimmed through the modal sheet, hidden from VoiceOver while the sheet is up.
            if issue.auditType == .elementDetection && element == nil { return true }
            // The audit measures a line at its unscaled size against the scaled sheet's frames, a
            // different one each run; the kept screenshot shows every line whole.
            if issue.auditType == .textClipped && scale < 1 && sheet.frame.contains(element?.frame ?? .null) {
                return true
            }
            print("audit issue: \(issue.auditType.rawValue) \(issue.compactDescription) on \(element.map { "\($0.elementType.rawValue)" } ?? "-") '\(element?.label ?? "")'")
            return false
        }
        notNow.tap()
        XCTAssertTrue(title.waitForNonExistence(timeout: 5), "Not Now closes the sheet")
        XCTAssertFalse(noteBar.exists, "nothing runs after Not Now")
    }
}
