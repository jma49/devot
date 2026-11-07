import DevotScreens
import XCTest

/// The installed app's native Settings (scripts/ci/iphone-ui-tests.sh).
@MainActor
final class SettingsTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        let bar = app.tabBars.firstMatch
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(bar.waitForExistence(timeout: 120))
        bar.buttons[L10n.phoneTabSettings()].tap()
        XCTAssertTrue(app.navigationBars[L10n.settingsTitle()].waitForExistence(timeout: 10))
    }

    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars[L10n.settingsTitle()].waitForExistence(timeout: 10))
    }

    func testOpensEveryNativePaneAndComesBackToTheRoot() {
        let panes = [
            L10n.settingsPaneGeneral(), L10n.settingsPaneEditing(), L10n.settingsPanePreview(), L10n.settingsPaneAi(),
            L10n.settingsPaneLicence(),
        ]
        for pane in panes {
            let open = row(pane)
            XCTAssertTrue(open.waitForExistence(timeout: 10), pane)
            open.tap()
            XCTAssertTrue(app.navigationBars[pane].waitForExistence(timeout: 10), pane)
            back()
        }
    }

    func testASwitchChangesAndChangesBack() throws {
        row(L10n.settingsPaneEditing()).tap()
        let toggle = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", L10n.editorSettingsLineNumbers()))
            .firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        let before = try XCTUnwrap(toggle.value as? String)
        // A SwiftUI toggle in a list is a row whose knob is a switch inside it; the row's text does not toggle it.
        let knob = toggle.switches.firstMatch.exists ? toggle.switches.firstMatch : toggle
        for expected in [before == "1" ? "0" : "1", before] {
            knob.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: toggle)
            XCTAssertEqual(XCTWaiter().wait(for: [changed], timeout: 5), .completed)
        }
        back()
    }

    func testTheAppRowOpensTheTrialSheetWhileATrialRunsAndLicenseOtherwise() {
        app.descendants(matching: .any)["settings-app"].tap()
        let done = app.buttons["trial-done"]
        if done.waitForExistence(timeout: 5) {
            done.tap()
            XCTAssertTrue(done.waitForNonExistence(timeout: 10))
        } else {
            XCTAssertTrue(app.navigationBars[L10n.settingsPaneLicence()].waitForExistence(timeout: 10))
        }
    }

    func testTheSettingsRootPassesTheAccessibilityAudit() throws {
        // The chevron keeps the system's fixed disclosure size, as UIKit's own does.
        try app.performAccessibilityAudit { issue in
            issue.auditType == .dynamicType && issue.element?.elementType == .image
        }
    }
}
