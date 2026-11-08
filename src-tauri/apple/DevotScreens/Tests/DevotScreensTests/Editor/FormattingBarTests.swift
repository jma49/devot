import UIKit
import XCTest

@testable import DevotScreens

/// design/motion.md, Formatting bar on the keyboard: a 44 pt glass capsule and a Hide Keyboard
/// circle in one glass container, pinned to the keyboard layout guide.
@MainActor
final class FormattingBarTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        GlassStyle.transparency = { 0 }
    }

    private func pinnedBar() throws -> (FormattingBar, UIView) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let screen = UIViewController()
        window.rootViewController = screen
        window.makeKeyAndVisible()
        self.window = window
        let bar = FormattingBar()
        bar.pin(in: screen.view)
        screen.view.layoutIfNeeded()
        return (bar, screen.view)
    }

    func testTheBarRidesTheKeyboardLayoutGuideAndFollowsAnUndockedKeyboard() throws {
        let (bar, host) = try pinnedBar()
        XCTAssertTrue(host.keyboardLayoutGuide.followsUndockedKeyboard)
        let bottom = host.constraints.first { constraint in
            constraint.firstItem === bar && constraint.firstAttribute == .bottom
                && constraint.secondItem === host.keyboardLayoutGuide && constraint.secondAttribute == .top
        }
        XCTAssertEqual(bottom?.constant, -Tokens.Size.phoneSheetInset)
        XCTAssertEqual(bar.accessibilityIdentifier, "devot.formatting")
    }

    func testEveryButtonIsAFullTargetWithALabelAndTheCapsuleIsOneTargetTall() throws {
        let (bar, _) = try pinnedBar()
        XCTAssertEqual(bar.buttons.count, FormattingBar.formats.count + 2)
        for button in bar.buttons {
            XCTAssertEqual(button.bounds.size, CGSize(width: Tokens.Size.phoneTarget, height: Tokens.Size.phoneTarget))
            XCTAssertFalse(button.accessibilityLabel?.isEmpty ?? true)
        }
        let narrow = FormattingBar(frame: CGRect(x: 0, y: 0, width: 280, height: Tokens.Size.phoneTarget))
        narrow.layoutIfNeeded()
        XCTAssertEqual(
            narrow.buttons.map(\.bounds.width), Array(repeating: Tokens.Size.phoneTarget, count: narrow.buttons.count),
            "a narrow phone scrolls the row and keeps every target whole")
        XCTAssertEqual(bar.capsule.glass.bounds.height, Tokens.Size.phoneTarget)
        XCTAssertEqual(bar.circle.glass.bounds.size, CGSize(width: Tokens.Size.phoneTarget, height: Tokens.Size.phoneTarget))
        XCTAssertEqual(
            bar.circle.glass.frame.minX - bar.capsule.glass.frame.maxX, Tokens.Space.space6, accuracy: 0.5,
            "the circle keeps the container's spacing from the capsule")
        XCTAssertTrue(bar.container.effect is UIGlassContainerEffect)
        XCTAssertTrue(bar.capsule.shadow.superview === bar, "the shadow sits under the glass container")
    }

    func testEachButtonSendsItsFormatAndHideKeyboardAsksToEndEditing() throws {
        let (bar, _) = try pinnedBar()
        var sent: [String] = []
        var hidden = 0
        var accepted = 0
        bar.format = { sent.append($0) }
        bar.hideKeyboard = { hidden += 1 }
        bar.accept = { accepted += 1 }
        for button in bar.buttons { button.sendActions(for: .primaryActionTriggered) }
        XCTAssertEqual(sent, FormattingBar.formats.map(\.id))
        XCTAssertEqual(sent, ["heading", "bold", "italic", "taskList", "code", "link"])
        XCTAssertEqual(accepted, 1)
        XCTAssertEqual(hidden, 1)
    }

    func testTheGlassIsInteractiveRegularGlassAndTurnsSolidForReduceTransparency() throws {
        let (bar, _) = try pinnedBar()
        let effect = try XCTUnwrap(bar.capsule.glass.effect as? UIGlassEffect)
        XCTAssertTrue(effect.isInteractive)
        bar.applyGlass(.solid)
        XCTAssertNil(bar.capsule.glass.effect)
        XCTAssertNil(bar.circle.glass.effect)
        let traits = bar.traitCollection
        XCTAssertEqual(
            bar.capsule.glass.backgroundColor?.resolvedColor(with: traits),
            Tokens.Color.phoneGlassOpaque.resolvedColor(with: traits))
        bar.applyGlass(.clear(tint: 0.1))
        XCTAssertTrue(bar.capsule.glass.effect is UIGlassEffect)
        XCTAssertNil(bar.capsule.glass.backgroundColor)
    }

    func testGlassTransparencyMapsToSolidRegularAndClear() {
        XCTAssertEqual(GlassStyle.look(transparency: 0, reduceTransparency: false, increaseContrast: false), .regular(tint: 0))
        XCTAssertEqual(GlassStyle.look(transparency: -50, reduceTransparency: false, increaseContrast: false), .regular(tint: 0.5))
        XCTAssertEqual(GlassStyle.look(transparency: -100, reduceTransparency: false, increaseContrast: false), .solid)
        XCTAssertEqual(GlassStyle.look(transparency: 100, reduceTransparency: false, increaseContrast: false), .clear(tint: 0))
        XCTAssertEqual(GlassStyle.look(transparency: 40, reduceTransparency: false, increaseContrast: false), .clear(tint: 0.15))
        XCTAssertEqual(GlassStyle.look(transparency: 40, reduceTransparency: true, increaseContrast: false), .solid)
        XCTAssertEqual(GlassStyle.look(transparency: 40, reduceTransparency: false, increaseContrast: true), .solid)
    }

    func testTheFindBarShowsTheCountOnlyForAQueryAndStepsOnReturn() {
        let bar = FindBar()
        var steps: [Bool] = []
        var searched: [String] = []
        bar.step = { steps.append($0) }
        bar.search = { searched.append($0) }
        bar.show(FindCount(total: 3, current: 1, capped: false))
        XCTAssertTrue(bar.count.isHidden, "no count before anything is typed")
        bar.field.text = "cat"
        bar.field.sendActions(for: .editingChanged)
        XCTAssertEqual(searched, ["cat"])
        bar.show(FindCount(total: 3, current: 2, capped: false))
        XCTAssertFalse(bar.count.isHidden)
        XCTAssertEqual(bar.count.text, L10n.phoneFindCount(current: "2", total: "3"))
        XCTAssertTrue(bar.nextButton.isEnabled)
        XCTAssertFalse(bar.textFieldShouldReturn(bar.field))
        XCTAssertEqual(steps, [true])
        bar.show(.none)
        XCTAssertFalse(bar.nextButton.isEnabled)
        XCTAssertEqual(FindCount(.object(["total": .number(4), "current": .number(0)])), FindCount(total: 4, current: 0, capped: false))
        XCTAssertNil(FindCount(.object([:])))
    }
}
