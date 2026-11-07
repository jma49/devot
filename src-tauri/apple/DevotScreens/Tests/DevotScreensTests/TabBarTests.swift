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

    func testSettingsIsNativeUnderALargeTitleAndTheOtherTabsAreWebScreensUnderAHiddenBar() throws {
        let tabs = controller()
        for (index, tab) in TabModel.tabs.enumerated() {
            let navigation = try XCTUnwrap(tabs.viewControllers?[index] as? UINavigationController)
            if tab == .settings {
                XCTAssertTrue(navigation === tabs.settings.navigation)
                XCTAssertFalse(navigation.isNavigationBarHidden)
                XCTAssertTrue(navigation.navigationBar.prefersLargeTitles)
                XCTAssertTrue(navigation.viewControllers.first === tabs.settings.root)
                XCTAssertNil(tabs.screen(tab))
            } else {
                XCTAssertTrue(navigation.isNavigationBarHidden)
                XCTAssertTrue(navigation.viewControllers.first === tabs.screen(tab))
            }
        }
    }

    func testTheSettingsRootSearchesAndPairs() throws {
        let root = controller().settings.root!
        let search = try XCTUnwrap(root.navigationItem.searchController)
        XCTAssertFalse(search.obscuresBackgroundDuringPresentation)
        XCTAssertEqual(search.searchBar.placeholder, L10n.settingsSearch())
        XCTAssertEqual(root.navigationItem.title, L10n.settingsTitle())
        XCTAssertEqual(root.navigationItem.rightBarButtonItem?.accessibilityLabel, L10n.phoneSettingsPair())
    }

    func testOpeningAPageFromElsewhereSelectsTheSettingsTab() throws {
        let tabs = controller()
        tabs.settings.router.inFront = { false }
        tabs.settings.router.open(.licence(.focusKey))
        XCTAssertEqual(tabs.selectedIndex, TabModel.tabs.firstIndex(of: .settings))
        XCTAssertEqual(tabs.settings.navigation.viewControllers.count, 2)
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
