import DevotScreens
import XCTest

/// A note pushed over the Notes list in the installed app: its cover, the back swipe, a link to
/// another note, and the welcome example's diagrams and math drawn on the device.
@MainActor
final class EditorTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 120))
    }

    private var page: XCUIElement { app.webViews.firstMatch }
    private var tabBar: XCUIElement { app.tabBars.firstMatch }
    private var noteBar: XCUIElement { app.navigationBars.firstMatch }
    /// A note hides the tab bar, which may then be gone from the tree, where `isHittable` would fail.
    private var tabBarShown: Bool { tabBar.exists && tabBar.isHittable }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    /// A drag from 2 pt inside the left edge, where only the system's back swipe starts.
    private func edgeSwipe(by distance: CGFloat, velocity: XCUIGestureVelocity) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: 2, dy: 0))
        start.press(
            forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: distance, dy: 0)),
            withVelocity: velocity, thenHoldForDuration: 0.2)
    }

    private func scrollUntil(_ found: () -> Bool, swipes: Int = 30) -> Bool {
        for _ in 0..<swipes where !found() {
            page.swipeUp(velocity: .slow)
        }
        return found()
    }

    private func openExample() {
        let row = page.staticTexts[L10n.welcomeExampleTitle()].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(noteBar.waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["editor.cover"].waitForNonExistence(timeout: 5), "the cover fades")
        XCTAssertTrue(waitUntil { !tabBarShown }, "the note hides the tab bar")
    }

    func testANoteSlidesInAndTheBackSwipeTakesItAwayOrTurnsBack() throws {
        openExample()

        edgeSwipe(by: 60, velocity: .slow)
        XCTAssertTrue(noteBar.waitForExistence(timeout: 5), "a swipe turned back keeps the note")
        XCTAssertFalse(tabBarShown)

        edgeSwipe(by: app.frame.width * 0.8, velocity: .fast)
        XCTAssertTrue(waitUntil { tabBarShown })
        XCTAssertTrue(noteBar.waitForNonExistence(timeout: 5))

        openExample()
    }

    func testALinkPushesTheLinkedNoteAndBackReturnsToTheFirst() throws {
        openExample()
        let link = page.links[L10n.welcomeTitle()].firstMatch
        XCTAssertTrue(scrollUntil { link.exists && link.isHittable })
        link.tap()
        XCTAssertTrue(link.waitForNonExistence(timeout: 10), "the welcome note replaced the example")
        XCTAssertTrue(noteBar.exists)

        edgeSwipe(by: app.frame.width * 0.8, velocity: .fast)
        XCTAssertTrue(link.waitForExistence(timeout: 10), "back on the example")
        XCTAssertTrue(noteBar.exists)
        XCTAssertFalse(tabBarShown)
    }

    func testTheExampleDrawsEveryDiagramAndFormula() throws {
        openExample()
        let diagrams = page.images.matching(NSPredicate(format: "label BEGINSWITH %@", L10n.mermaidLabel()))
        // Mermaid, PlantUML and Markmap in the example's Diagrams section.
        XCTAssertTrue(scrollUntil { diagrams.count >= 3 }, "found \(diagrams.count) diagrams")
        XCTAssertEqual(diagrams.count, 3)

        func shown(_ text: String) -> Int {
            page.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).count
        }
        // The display block's integral sign exists only once temml has turned the TeX into MathML.
        XCTAssertGreaterThan(shown("\u{222B}"), 0, "the display formula is drawn")
        XCTAssertEqual(shown("\\int"), 0, "no display formula left as TeX")
        XCTAssertEqual(shown("mc^2"), 0, "no inline formula left as TeX")
    }
}
