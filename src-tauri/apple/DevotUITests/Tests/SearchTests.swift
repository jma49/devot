import DevotScreens
import XCTest

/// The native Search tab in the installed app: the search circle, a query, the Titles scope leaving a
/// body-only match out, a result opened and Back to Search as it was.
@MainActor
final class SearchTests: XCTestCase {
    private var app: XCUIApplication!

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

    func testTheSearchCircleFindsANoteThatOpensAndBackLandsInSearch() {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        let bar = app.tabBars.firstMatch
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(bar.waitForExistence(timeout: 120))
        let circle = bar.buttons[L10n.phoneTabSearch()]
        XCTAssertTrue(circle.waitForExistence(timeout: 10), "the search circle follows the tabs")
        circle.tapOnceHittable()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Search shows the system search field")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "the circle raises the keyboard")
        let title = L10n.welcomeExampleTitle()
        // A word only the welcome example's body has (src/renderer/src/welcome/markdown-example.md).
        let body = "haversine"
        field.typeText(body)
        let row = app.collectionViews.cells.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the welcome example is found by its body")
        keepScreen("found")
        let titles = app.buttons[L10n.phoneSearchScopeTitles()]
        XCTAssertTrue(titles.waitForExistence(timeout: 5), "the field offers the Titles scope")
        titles.tap()
        XCTAssertTrue(waitUntil { titles.isSelected }, "Titles is chosen")
        XCTAssertTrue(row.waitForNonExistence(timeout: 10), "a match in the body alone leaves the Titles results")
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: body.count) + title)
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the welcome example is found by its title")
        keepScreen("found by title")
        XCTAssertTrue(waitUntil { row.isHittable })
        row.tap()
        let noteBar = app.navigationBars.firstMatch
        XCTAssertTrue(waitUntil({ !field.exists || !field.isHittable }, timeout: 10), "the result pushes its note")
        XCTAssertTrue(app.otherElements["editor.cover"].waitForNonExistence(timeout: 10), "the cover fades")
        keepScreen("the note")
        noteBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Back lands in Search")
        XCTAssertTrue(waitUntil({ (field.value as? String) == title }, timeout: 5), "the query stays")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the results stay")
        keepScreen("back in Search")
    }
}
