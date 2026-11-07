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

    private func show() throws -> (UIWindow, UINavigationController, SettingsRootScreen) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        // Shorter than the root's list, so it scrolls.
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 600)
        let root = SettingsRootScreen(store: SettingsStore(), query: SettingsQuery(), actions: SettingsActions())
        let navigation = UINavigationController(rootViewController: root)
        navigation.navigationBar.prefersLargeTitles = true
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        self.window = window
        navigation.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        return (window, navigation, root)
    }

    private func foot(_ list: UIScrollView) -> CGFloat {
        list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height
    }

    /// Lets SwiftUI lay the list out at the new text size.
    private func settle(_ list: UIScrollView) {
        var last = list.contentSize
        for _ in 0..<20 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            if list.contentSize == last { return }
            last = list.contentSize
        }
    }

    /// A larger text size seen from the foot leaves the build footer in view, as the list would keep its
    /// offset and push the footer off the screen.
    func testALargerTextSizeAtTheFootKeepsTheFootInView() throws {
        let (window, _, root) = try show()
        let list = try XCTUnwrap(views(in: root.view).compactMap { $0 as? UICollectionView }.first)
        XCTAssertGreaterThan(foot(list), 0)
        list.setContentOffset(CGPoint(x: 0, y: foot(list)), animated: false)
        let before = list.contentSize.height
        window.traitOverrides.preferredContentSizeCategory = .accessibilityLarge
        settle(list)
        XCTAssertGreaterThan(list.contentSize.height, before)
        XCTAssertEqual(list.contentOffset.y, foot(list), accuracy: 1)
    }

    func testALargerTextSizeAtTheTopLeavesTheListAtTheTop() throws {
        let (window, _, root) = try show()
        let list = try XCTUnwrap(views(in: root.view).compactMap { $0 as? UICollectionView }.first)
        let top = list.contentOffset.y
        window.traitOverrides.preferredContentSizeCategory = .accessibilityLarge
        settle(list)
        XCTAssertEqual(list.contentOffset.y, top, accuracy: 1)
    }

    /// The accessibility audit measures the bar button by its 36 pt frame; touches are what count.
    func testPairADeviceTakesTouchesOverAWholeTarget() throws {
        let (window, navigation, root) = try show()

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
