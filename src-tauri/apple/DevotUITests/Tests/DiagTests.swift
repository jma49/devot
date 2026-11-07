import DevotScreens
import XCTest

@MainActor
final class DiagTests: XCTestCase {
    func testDiagNil() throws {
        continueAfterFailure = true
        let app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        for flag in ["none", "nosample", "nosampletitle", "nocaps", "nopics"] {
            app.terminate()
            app.launchEnvironment = ["DEVOTDIAG": flag]
            app.launch()
            let bar = app.tabBars.firstMatch
            XCTAssertTrue(bar.waitForExistence(timeout: 120))
            bar.buttons[L10n.phoneTabSettings()].tap()
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", L10n.settingsPaneAppearance())).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.tap()
            XCTAssertTrue(app.navigationBars[L10n.settingsPaneAppearance()].waitForExistence(timeout: 10))
            var counts: [String: Int] = [:]
            for step in 0..<2 {
                if step > 0 { app.collectionViews.firstMatch.swipeUp(velocity: .slow) }
                guard app.state == .runningForeground else { counts["\(step):DEAD"] = 1; break }
                try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/private/tmp/claude-501/-Users-jinchengma-Code-personal-devot/3b354df8-81cd-4df7-8990-7398c1adc0b4/scratchpad/shot776-\(step).png"))
                for type in [XCUIAccessibilityAuditType.dynamicType, .textClipped] {
                    try app.performAccessibilityAudit(for: type) { issue in
                        if issue.element == nil { counts["\(step):only-\(type.rawValue)", default: 0] += 1 }
                        return true
                    }
                }
                try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.contrast)) { issue in
                    let key = issue.element.map { "'\($0.label)'" } ?? (issue.detailedDescription.contains("AccessibilityNode") ? "node" : "nil")
                    counts["\(step):\(issue.compactDescription.prefix(14)) \(key)", default: 0] += 1
                    return true
                }
            }
            print("DIAGNIL \(flag) \(counts.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " | "))")
        }
    }
}
