import DevotScreens
import XCTest

/// The installed app's native Settings (scripts/ci/iphone-ui-tests.sh).
@MainActor
final class SettingsTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        launch()
    }

    private func launch(_ arguments: [String] = []) {
        app.terminate()
        app.launchArguments = arguments
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
            L10n.settingsPaneGeneral(), L10n.settingsPaneAppearance(), L10n.settingsPaneEditing(),
            L10n.settingsPanePreview(), L10n.settingsPaneAi(), L10n.settingsPaneLicence(),
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

    private func openAppearance() {
        row(L10n.settingsPaneAppearance()).tap()
        XCTAssertTrue(app.navigationBars[L10n.settingsPaneAppearance()].waitForExistence(timeout: 10))
    }

    /// Scrolls the pane until `element` shows whole between the bars, down the pane or back up it.
    private func scrolled(to element: XCUIElement, back: Bool = false) -> XCUIElement {
        let list = app.collectionViews.firstMatch
        for _ in 0..<6 where !(element.exists && element.isHittable && clearOfTheBars(scrolled: false).contains(element.frame)) {
            if back { list.swipeDown(velocity: .slow) } else { list.swipeUp(velocity: .slow) }
        }
        XCTAssertTrue(element.exists)
        return element
    }

    private func transparency() -> XCUIElement {
        scrolled(to: app.sliders[L10n.phoneAppearanceTransparency()])
    }

    private static func signed(_ value: Int) -> String {
        value.formatted(.number.sign(strategy: .always(includingZero: false)))
    }

    private static func number(_ value: String?) -> Int? {
        value.flatMap { Int($0.replacingOccurrences(of: "+", with: "")) }
    }

    /// The slider's value once it has held still for a second. `adjust` returns while the app is
    /// still moving the thumb and before it handles the lift, so a value read at once can be one
    /// the drag passes on its way.
    private func settled(_ slider: XCUIElement) -> Int? {
        var value = slider.value as? String
        var still = 0
        for _ in 0..<40 where still < 4 {
            Thread.sleep(forTimeInterval: 0.25)
            let now = slider.value as? String
            still = now == value ? still + 1 : 0
            value = now
        }
        XCTAssertEqual(still, 4, "the slider did not settle")
        return Self.number(value)
    }

    /// Drags the slider towards `value`, nudging it where the drag lands off: a drag lands within a few
    /// steps of its target, not on it, except at the ends.
    private func drag(_ slider: XCUIElement, to value: Int) {
        var shown = settled(slider)
        for _ in 0..<3 where shown != value {
            let position = slider.normalizedSliderPosition + CGFloat(value - (shown ?? 0)) / 200
            slider.adjust(toNormalizedSliderPosition: min(max(position, 0), 1))
            shown = settled(slider)
        }
    }

    func testAThemeCardRingsBothOfItsSwatches() {
        openAppearance()
        let ember = L10n.appearanceSettingsThemeEmber()
        let card = scrolled(to: app.buttons[ember])
        let light = app.buttons[L10n.phoneSettingsAppearanceThemeLight(theme: ember)]
        let dark = app.buttons[L10n.phoneSettingsAppearanceThemeDark(theme: ember)]
        // The card's middle is between its swatches; its name is the card's alone.
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
        XCTAssertTrue(light.wait(for: \.isSelected, toEqual: true, timeout: 5))
        XCTAssertTrue(dark.wait(for: \.isSelected, toEqual: true, timeout: 5))
        XCTAssertTrue(card.isSelected)
        let standard = scrolled(to: app.buttons[L10n.appearanceSettingsThemeDefault()], back: true)
        standard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
        XCTAssertTrue(light.wait(for: \.isSelected, toEqual: false, timeout: 5))
        XCTAssertFalse(dark.isSelected)
    }

    func testGlassTransparencyIsKeptAcrossALaunch() {
        openAppearance()
        let slider = transparency()
        slider.adjust(toNormalizedSliderPosition: 0)
        XCTAssertEqual(settled(slider), -100)
        launch()
        openAppearance()
        let kept = transparency()
        XCTAssertEqual(kept.value as? String, Self.signed(-100))
        // A drag's last value can come just after the lift: the app closes at once, inside the debounce
        // that lost it in CI.
        kept.adjust(toNormalizedSliderPosition: 1)
        launch()
        openAppearance()
        XCTAssertEqual(transparency().value as? String, Self.signed(100))
        drag(transparency(), to: 0)
    }

    func testUnderReduceTransparencyTheGlassSliderIsLockedAndSaysWhy() {
        launch([LaunchArgument.reduceTransparency])
        openAppearance()
        XCTAssertFalse(transparency().isEnabled)
        XCTAssertTrue(app.staticTexts[L10n.phoneSettingsAppearanceTransparencyReduced()].exists)
    }

    private struct Element: Hashable, CustomStringConvertible {
        let type: XCUIElement.ElementType
        let label: String
        var description: String { "\(type.rawValue) '\(label)'" }
    }

    /// An issue on a control the system draws, which the app does not.
    private static func systemControl(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        let type = issue.element?.elementType
        // The chevron keeps the system's fixed disclosure size, as UIKit's own does.
        if issue.auditType == .dynamicType && type == .image { return true }
        if issue.auditType == .textClipped && type == .searchField { return true }
        // Its frame is 36 pt but it takes touches over the full target (SettingsRootScreenTests).
        if issue.auditType == .hitRegion && type == .button && issue.element?.label == L10n.phoneSettingsPair() {
            return true
        }
        return false
    }

    /// Under the navigation bar, once the list scrolls beneath it, its scroll edge effect and the shadow of
    /// Pair a Device's glass shade the page to 33 pt below the bar's frame (iOS 26.5 screenshot: the page
    /// differs from its colour down to y = 148 with the bar's foot at 116); at the top nothing is under it.
    private static let navigationEdgeEffect: CGFloat = 33

    /// The screen between the two bars' edge effects.
    private func clearOfTheBars(scrolled: Bool) -> CGRect {
        let screen = app.windows.firstMatch.frame
        let top = app.navigationBars.firstMatch.frame.maxY + (scrolled ? Self.navigationEdgeEffect : 0)
        let bottom = app.tabBars.firstMatch.frame.minY - Tokens.Size.phoneTabEdge
        return CGRect(x: screen.minX, y: top, width: screen.width, height: bottom - top)
    }

    /// What the list shows, by label and place, to tell whether a swipe moved it.
    private func listed() throws -> [String] {
        var shown: [String] = []
        func walk(_ snapshot: any XCUIElementSnapshot) {
            if !snapshot.label.isEmpty { shown.append("\(snapshot.label) \(snapshot.frame)") }
            snapshot.children.forEach(walk)
        }
        walk(try app.collectionViews.firstMatch.snapshot())
        return shown
    }

    /// Drags the list up by about half a screen from its left margin, where no slider takes the
    /// touch, and holds before the lift so the list does not fling past a part of the pane.
    private func halfAPageUp() {
        let list = app.collectionViews.firstMatch
        let from = list.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.7))
        let to = list.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.25))
        from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
    }

    /// Swipes up until a swipe moves nothing the list shows.
    private func scrollToTheFoot() throws {
        var last = try listed()
        for _ in 0..<8 {
            app.collectionViews.firstMatch.swipeUp()
            let now = try listed()
            if now == last { return }
            last = now
        }
        XCTFail("the list did not reach its foot")
    }

    /// Audits what shows and returns the elements whose contrast fails over a system bar or its edge effect,
    /// which the audit measures against the bar's glass; every other issue fails.
    private func audit(clear: CGRect) throws -> Set<Element> {
        var overABar: Set<Element> = []
        let handle = { (issue: XCUIAccessibilityAuditIssue) -> Bool in
            if Self.systemControl(issue) { return true }
            let element = issue.element
            let frame = element?.frame ?? .null
            // An element is found again by its type and label, so one without a label cannot be deferred.
            if issue.auditType == .contrast, let element, !element.label.isEmpty, !frame.isNull, !clear.contains(frame) {
                overABar.insert(Element(type: element.elementType, label: element.label))
                print("audit issue over a bar: \(issue.compactDescription) on \(element.elementType.rawValue) '\(element.label)' \(frame)")
                return true
            }
            print("audit issue: \(issue.compactDescription) on \(element.map { "\($0.elementType.rawValue)" } ?? "-") '\(element?.label ?? "")' \(frame)")
            print("audit issue detail: \(issue.detailedDescription)")
            return false
        }
        // Contrast runs alone: audited with the rest, a row under the tab bar comes without its element.
        try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.contrast), handle)
        try app.performAccessibilityAudit(for: .contrast, handle)
        return overABar
    }

    /// The elements that show whole between the bars.
    private func shownClear(_ clear: CGRect) throws -> Set<Element> {
        var shown: Set<Element> = []
        func walk(_ snapshot: any XCUIElementSnapshot) {
            if !snapshot.label.isEmpty && !snapshot.frame.isEmpty && clear.contains(snapshot.frame) {
                shown.insert(Element(type: snapshot.elementType, label: snapshot.label))
            }
            snapshot.children.forEach(walk)
        }
        walk(try app.snapshot())
        return shown
    }

    func testTheSettingsRootPassesTheAccessibilityAudit() throws {
        continueAfterFailure = true
        var overABar: Set<Element> = []
        var auditedClear: Set<Element> = []
        // At the top, then at the foot of the list, where the last rows show above the tab bar.
        for foot in [false, true] {
            if foot { try scrollToTheFoot() }
            let clear = clearOfTheBars(scrolled: foot)
            auditedClear.formUnion(try shownClear(clear))
            overABar.formUnion(try audit(clear: clear))
        }
        XCTAssertEqual(overABar.subtracting(auditedClear), [], "audited only over a system bar")
    }

    func testTheAppearancePanePassesTheAccessibilityAudit() throws {
        continueAfterFailure = true
        openAppearance()
        var overABar: Set<Element> = []
        var auditedClear: Set<Element> = []
        // The top, then half a screen further down each time, until a drag moves nothing.
        var last: [String] = []
        for page in 0..<12 {
            if page > 0 { halfAPageUp() }
            let now = try listed()
            if now == last { break }
            last = now
            let clear = clearOfTheBars(scrolled: page > 0)
            auditedClear.formUnion(try shownClear(clear))
            overABar.formUnion(try audit(clear: clear))
        }
        XCTAssertEqual(overABar.subtracting(auditedClear), [], "audited only over a system bar")
    }
}
