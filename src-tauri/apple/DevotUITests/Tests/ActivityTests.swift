import DevotScreens
import XCTest

/// The native Activity tab in the installed app: the heatmap's summary, the week's choice and an audit.
@MainActor
final class ActivityTests: XCTestCase {
    func testTheWeeksChoiceReplacesTheFiguresAndTheScreenPassesTheAccessibilityAudit() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        let bar = app.tabBars.firstMatch
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(bar.waitForExistence(timeout: waitLimit(120)))
        let tab = bar.buttons[L10n.phoneTabActivity()]
        XCTAssertTrue(tab.waitForExistence(timeout: waitLimit(10)))
        tab.tap()
        let list = app.collectionViews["activity.list"]
        XCTAssertTrue(list.waitForExistence(timeout: waitLimit(10)))
        XCTAssertTrue(list.images.firstMatch.waitForExistence(timeout: waitLimit(30)), "the figures are read and the heatmap drawn")
        let last = list.buttons[L10n.phoneActivityWeekLast()]
        XCTAssertTrue(last.waitForExistence(timeout: waitLimit(5)))
        last.tap()
        XCTAssertTrue(last.wait(for: \.isSelected, toEqual: true, timeout: waitLimit(5)))
        XCTAssertTrue(list.staticTexts[L10n.phoneActivityWordsLast()].waitForExistence(timeout: waitLimit(5)))
        XCTAssertTrue(list.staticTexts[L10n.phoneActivityRankedLast()].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Activity, last week"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        // Contrast is left out: the heatmap's lightest shades are pictures, not text, and the
        // audit measures the rows under the tab bar against its glass.
        try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.contrast)) { issue in
            if let element = issue.element, bar.frame.insetBy(dx: -1, dy: -1).contains(element.frame) { return true }
            print("audit issue: \(issue.compactDescription) on \(issue.element.map { "\($0.elementType.rawValue) '\($0.label)'" } ?? "-")")
            return false
        }
    }
}
