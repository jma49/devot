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

    /// The root is taller than the screen: a row under the tab bar is scrolled up to before it is tapped.
    private func row(_ title: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        let bar = app.tabBars.firstMatch
        for _ in 0..<4 where !(row.exists && row.frame.maxY <= bar.frame.minY) {
            app.collectionViews.firstMatch.swipeUp()
        }
        return row
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
        continueAfterFailure = true
        let bar = app.tabBars.firstMatch.frame
        let allowed = { (issue: XCUIAccessibilityAuditIssue) -> Bool in
            let element = issue.element
            let type = element?.elementType
            let frame = element?.frame ?? .null
            // The chevron keeps the system's fixed disclosure size, as UIKit's own does.
            if issue.auditType == .dynamicType && type == .image { return true }
            // The system's search field, which the app does not draw.
            if issue.auditType == .textClipped && type == .searchField { return true }
            // The system's bar button: its frame is 36 pt, but its glass platter takes touches over 44 by 44.
            if issue.auditType == .hitRegion && type == .button && element?.label == L10n.phoneSettingsPair() {
                return true
            }
            // Rows scroll under the system's glass tab bar, which the audit measures them against.
            if issue.auditType == .contrast && frame.intersects(bar) { return true }
            print("audit issue: \(issue.compactDescription) on \(type.map { "\($0.rawValue)" } ?? "-") '\(element?.label ?? "")' \(frame)")
            return false
        }
        // Contrast runs alone: audited with the rest, a row under the tab bar comes without its element.
        try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.contrast), allowed)
        try app.performAccessibilityAudit(for: .contrast, allowed)
    }
}
