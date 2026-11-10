import DevotScreens
import XCTest

/// The installed Devot app (scripts/ci/iphone-ui-tests.sh), with its native tab bar over the page.
@MainActor
final class TabsTests: XCTestCase {
    // Temporary probe, removed before this pull request merges: the set-up is async as in the
    // classes whose failed tests were never run again, and the probe fails on its first run only.
    override func setUp() async throws {}

    func testProbeFailsOnItsFirstRun() {
        continueAfterFailure = false
        let marker = NSTemporaryDirectory() + "devot-retry-probe"
        if !FileManager.default.fileExists(atPath: marker) {
            FileManager.default.createFile(atPath: marker, contents: nil)
            XCTFail("probe: the first run fails")
        }
    }

    func testSwitchesEveryTabAndTheTabBarPassesTheAccessibilityAudit() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        let bar = app.tabBars.firstMatch
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(bar.waitForExistence(timeout: waitLimit(120)))
        let names = [L10n.phoneTabNotes(), L10n.phoneTabActivity(), L10n.phoneTabSettings(), L10n.phoneTabLibrary()]
        for name in names {
            let item = bar.buttons[name]
            XCTAssertTrue(item.waitForExistence(timeout: waitLimit(10)), name)
            item.tapOnceHittable()
            XCTAssertTrue(item.wait(for: \.isSelected, toEqual: true, timeout: waitLimit(10)), name)
        }
        // The bar is this test's; the page inside the web view is not audited here.
        try app.performAccessibilityAudit { issue in
            guard let element = issue.element else { return true }
            return !bar.frame.insetBy(dx: -1, dy: -1).contains(element.frame)
        }
    }
}
