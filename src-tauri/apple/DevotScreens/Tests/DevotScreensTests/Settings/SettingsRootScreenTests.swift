import UIKit
import XCTest

@testable import DevotScreens

@MainActor
final class SettingsRootScreenTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func views(in view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(views)
    }

    /// The accessibility audit measures the bar button by its 36 pt frame; touches are what count.
    func testPairADeviceTakesTouchesOverAWholeTarget() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = SettingsRootScreen(store: SettingsStore(), query: SettingsQuery(), actions: SettingsActions())
        let navigation = UINavigationController(rootViewController: root)
        navigation.navigationBar.prefersLargeTitles = true
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        self.window = window
        navigation.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        let image = try XCTUnwrap(root.navigationItem.rightBarButtonItem?.image)
        let glyph = try XCTUnwrap(
            views(in: navigation.navigationBar).first { ($0 as? UIImageView)?.image?.isEqual(image) == true })
        let middle = { (view: UIView) in view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: window) }
        let button = try XCTUnwrap(window.hitTest(middle(glyph), with: nil))
        XCTAssertLessThanOrEqual(max(button.bounds.width, button.bounds.height), Tokens.Size.phoneTarget)
        let center = middle(button)
        let reach = Tokens.Size.phoneTarget / 2 - 1
        for dx in [-reach, reach] {
            for dy in [-reach, reach] {
                let hit = window.hitTest(CGPoint(x: center.x + dx, y: center.y + dy), with: nil)
                XCTAssertTrue(hit?.isDescendant(of: button) == true, "\(dx), \(dy): \(hit.map { "\(type(of: $0))" } ?? "nil")")
            }
        }
    }
}
