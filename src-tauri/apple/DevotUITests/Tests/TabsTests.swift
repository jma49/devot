import DevotScreens
import XCTest

/// The installed Devot app (scripts/ci/iphone-ui-tests.sh), with its native tab bar over the page.
@MainActor
final class TabsTests: XCTestCase {
    func testSwitchesEveryTabAndTheTabBarPassesTheAccessibilityAudit() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        let bar = app.tabBars.firstMatch
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(bar.waitForExistence(timeout: 120))
        let names = [L10n.phoneTabNotes(), L10n.phoneTabActivity(), L10n.phoneTabSettings(), L10n.phoneTabLibrary()]
        for name in names {
            let item = bar.buttons[name]
            XCTAssertTrue(item.waitForExistence(timeout: 10), name)
            item.tap()
            XCTAssertTrue(item.wait(for: \.isSelected, toEqual: true, timeout: 10), name)
        }
        // The bar is this test's; the page inside the web view is not audited here.
        try app.performAccessibilityAudit { issue in
            guard let element = issue.element else { return true }
            return !bar.frame.insetBy(dx: -1, dy: -1).contains(element.frame)
        }
    }
}
