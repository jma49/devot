import DevotScreens
import XCTest

/// The native Notes list in the installed app: a row's swipe actions and the undo toast a trash offers.
@MainActor
final class ListsTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 120))
        let notes = app.tabBars.firstMatch.buttons[L10n.phoneTabNotes()]
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        notes.tapOnceHittable()
    }

    private var row: XCUIElement {
        app.collectionViews.cells.containing(NSPredicate(format: "label == %@", L10n.welcomeTitle())).firstMatch
    }

    private var pinned: Bool { (row.value as? String)?.contains(L10n.sidebarPinned()) ?? false }

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

    /// A slow drag across half the row uncovers its actions without the full swipe's action.
    private func uncover(leading: Bool) {
        let from = leading ? 0.15 : 0.85
        let to = leading ? 0.6 : 0.4
        row.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.5)).press(
            forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.5)),
            withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    private func tapAction(_ name: String) {
        let action = app.buttons[name]
        XCTAssertTrue(action.waitForExistence(timeout: 5), "the swipe uncovers \(name)")
        keepScreen("\(name) uncovered")
        action.tap()
    }

    /// The welcome note starts pinned; the test leaves it as it found it.
    func testTheLeadingSwipeTogglesThePinAndBack() {
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the welcome note is listed")
        let was = pinned
        for (name, now) in [(was ? L10n.noteUnpin() : L10n.phoneActionPin(), !was), (was ? L10n.phoneActionPin() : L10n.noteUnpin(), was)] {
            uncover(leading: true)
            tapAction(name)
            XCTAssertTrue(waitUntil({ pinned == now }, timeout: 10), "\(name) changes the row's value")
        }
    }

    /// The toast stays only `motion.duration.phone-toast`, too short for an accessibility audit.
    func testATrashFromTheSwipeIsOfferedBackAndUndoRestoresTheRow() {
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the welcome note is listed")
        uncover(leading: false)
        tapAction(L10n.phoneActionTrash())
        let toast = app.otherElements["devot.toast"]
        XCTAssertTrue(toast.waitForExistence(timeout: 5), "the trash offers an undo")
        XCTAssertTrue(app.staticTexts[L10n.phoneToastTrashed()].exists)
        XCTAssertTrue(row.waitForNonExistence(timeout: 5), "the row leaves the list")
        keepScreen("the undo toast")
        let undo = app.buttons["devot.toast.undo"]
        XCTAssertTrue(undo.isHittable)
        undo.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Undo puts the note back")
        XCTAssertTrue(toast.waitForNonExistence(timeout: 5), "the toast goes once taken")
        keepScreen("the note restored")
    }
}
