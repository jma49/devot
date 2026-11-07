import UIKit
import XCTest

@testable import DevotScreens

@MainActor
final class SettingsRouterTests: XCTestCase {
    private final class Recording: UINavigationController {
        var animations: [Bool] = []

        override func setViewControllers(_ viewControllers: [UIViewController], animated: Bool) {
            animations.append(animated)
            super.setViewControllers(viewControllers, animated: false)
        }
    }

    private final class Page: UIViewController {
        let page: SettingsPage

        init(_ page: SettingsPage) {
            self.page = page
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { nil }
    }

    private func router(inFront: Bool) -> (SettingsRouter, Recording, UIViewController) {
        let root = UIViewController()
        let navigation = Recording(rootViewController: root)
        let router = SettingsRouter { Page($0) }
        router.navigation = navigation
        router.inFront = { inFront }
        return (router, navigation, root)
    }

    func testOpeningAPageFromElsewhereSelectsTheTabAndPutsItOverTheRootSoBackLandsThere() throws {
        let (router, navigation, root) = router(inFront: true)
        var selected = 0
        router.selectTab = { selected += 1 }
        router.push(.editing)
        router.open(.licence(.focusKey))
        XCTAssertEqual(selected, 1)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertTrue(navigation.viewControllers.first === root)
        XCTAssertEqual((navigation.viewControllers.last as? Page)?.page, .licence(.focusKey))
        XCTAssertEqual(navigation.animations.last, true)
    }

    func testAStackSetInTheBackgroundIsNotAnimated() {
        let (router, navigation, _) = router(inFront: false)
        router.open(.licence(.plain))
        XCTAssertEqual(navigation.animations.last, false)
    }

    func testEveryPaneNameOpensItsPageAndAnUnknownOneNothing() {
        XCTAssertEqual(SettingsPage(pane: "licence"), .licence(.plain))
        XCTAssertEqual(SettingsPage(pane: "sync"), .sync)
        XCTAssertNil(SettingsPage(pane: "keyboard"))
    }
}
