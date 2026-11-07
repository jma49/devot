import UIKit
import WebKit
import XCTest

@testable import DevotScreens

@MainActor
final class TabBarTests: XCTestCase {
    private func controller() -> DevotTabBarController {
        DevotTabBarController(host: WebViewHost(webView: WKWebView()))
    }

    func testFourIconOnlyTabsNamedForVoiceOverAndTheLargeContentViewer() throws {
        let tabs = controller()
        let items = try XCTUnwrap(tabs.viewControllers).map(\.tabBarItem)
        let names = [L10n.phoneTabNotes(), L10n.phoneTabLibrary(), L10n.phoneTabActivity(), L10n.phoneTabSettings()]
        XCTAssertEqual(items.map { $0?.title }, [nil, nil, nil, nil])
        XCTAssertEqual(items.map { $0?.accessibilityLabel }, names)
        for item in items {
            XCTAssertNotNil(item?.image)
            XCTAssertNotNil(item?.selectedImage)
            XCTAssertNotNil(item?.largeContentSizeImage)
        }
        XCTAssertEqual(tabs.selectedIndex, TabModel.tabs.firstIndex(of: .library))
    }

    func testTheSymbolsAreTheWebTabBarsWithTheirFilledVariantWhenSelected() {
        XCTAssertEqual(TabModel.tabs.map(TabModel.symbol), ["doc.text", "folder", "chart.bar", "gearshape"])
        for tab in TabModel.tabs {
            XCTAssertNotNil(UIImage(systemName: TabModel.symbol(tab)))
            XCTAssertNotNil(UIImage(systemName: TabModel.symbol(tab) + ".fill"))
        }
    }

    func testTheSystemBarNeverMinimisesAndTintsOnlyTheSelectedItemInTheAccent() {
        let tabs = controller()
        XCTAssertEqual(tabs.tabBarMinimizeBehavior, .never)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            XCTAssertEqual(
                tabs.tabBar.tintColor.resolvedColor(with: traits),
                Tokens.Color.accentText.resolvedColor(with: traits))
        }
    }

    func testEveryTabRootIsAWebScreenUnderAHiddenNavigationBar() throws {
        let tabs = controller()
        for (index, tab) in TabModel.tabs.enumerated() {
            let navigation = try XCTUnwrap(tabs.viewControllers?[index] as? UINavigationController)
            XCTAssertTrue(navigation.isNavigationBarHidden)
            XCTAssertTrue(navigation.viewControllers.first === tabs.screen(tab))
        }
    }

    func testReportsOnlyTheSelectedTabTappedAgain() throws {
        let tabs = controller()
        var reselected: [Tab] = []
        tabs.onReselect = { reselected.append($0) }
        let selected = try XCTUnwrap(tabs.selectedViewController)
        let other = try XCTUnwrap(tabs.viewControllers?.first)
        XCTAssertTrue(tabs.tabBarController(tabs, shouldSelect: selected))
        XCTAssertTrue(tabs.tabBarController(tabs, shouldSelect: other))
        XCTAssertEqual(reselected, [.library])
    }

    func testSettingsShowsTheMarkAndSaysWhyWhenTheLicenceNeedsAttention() throws {
        let tabs = controller()
        let settings = try XCTUnwrap(tabs.viewControllers?[3].tabBarItem)
        XCTAssertNil(settings.badgeValue)
        tabs.setAttention(true)
        XCTAssertEqual(settings.badgeValue, "!")
        XCTAssertEqual(settings.accessibilityValue, L10n.phoneBadgeAttention())
        tabs.setAttention(false)
        XCTAssertNil(settings.badgeValue)
        XCTAssertNil(settings.accessibilityValue)
    }
}
