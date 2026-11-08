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

    func testTheUndoToastSitsAboveTheBarAndTheListsOfferItTheirUndoableWrites() {
        let tabs = controller()
        tabs.loadViewIfNeeded()
        XCTAssertTrue(tabs.lists.undoToasts === tabs.toasts)
        tabs.toasts.offer(UndoToast(kind: .trashed) {})
        tabs.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        tabs.view.layoutIfNeeded()
        let toast = tabs.toasts.current
        XCTAssertTrue(toast?.superview === tabs.view)
        tabs.toasts.dismissNow()
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

    func testNotesLibraryAndSettingsAreNativeUnderLargeTitlesAndActivityIsAWebScreenUnderAHiddenBar() throws {
        let tabs = controller()
        for (index, tab) in TabModel.tabs.enumerated() {
            let navigation = try XCTUnwrap(tabs.viewControllers?[index] as? UINavigationController)
            switch tab {
            case .settings:
                XCTAssertTrue(navigation === tabs.settings.navigation)
                XCTAssertFalse(navigation.isNavigationBarHidden)
                XCTAssertTrue(navigation.navigationBar.prefersLargeTitles)
                XCTAssertTrue(navigation.viewControllers.first === tabs.settings.root)
                XCTAssertNil(tabs.screen(tab))
            case .notes, .library:
                let root = try XCTUnwrap(tabs.listRoots[tab])
                XCTAssertTrue(navigation.viewControllers.first === root)
                XCTAssertFalse(navigation.isNavigationBarHidden)
                XCTAssertTrue(navigation.navigationBar.prefersLargeTitles)
                XCTAssertEqual(root.navigationItem.largeTitleDisplayMode, .always)
                XCTAssertEqual(root.navigationItem.title, tab == .notes ? L10n.phoneTabNotes() : L10n.phoneTabLibrary())
                XCTAssertTrue(tab == .notes ? root is NoteListScreen : root is LibraryScreen)
                XCTAssertNil(tabs.screen(tab))
            default:
                XCTAssertTrue(navigation.isNavigationBarHidden)
                XCTAssertTrue(navigation.viewControllers.first === tabs.screen(tab))
            }
        }
    }

    func testNewNoteIsTheListsComposeItemWithItsMenuBesideTheFilter() throws {
        let tabs = controller()
        let notes = try XCTUnwrap(tabs.listRoots[.notes])
        notes.loadViewIfNeeded()
        let items = try XCTUnwrap(notes.navigationItem.rightBarButtonItems)
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[0].accessibilityLabel, L10n.noteListNewNote())
        XCTAssertNotNil(items[0].primaryAction)
        XCTAssertEqual(
            items[0].menu?.children.map(\.title),
            [L10n.noteListNewNote(), L10n.phoneListNewNoteIn(), L10n.phoneListFromTemplate()])
        XCTAssertEqual(items[2].accessibilityLabel, L10n.phoneFilterLabel())
        let filters = try XCTUnwrap(items[2].menu?.children.compactMap { $0 as? UIMenu }.first { $0.options.contains(.singleSelection) })
        XCTAssertEqual(filters.children.map(\.title), StatusFilter.allCases.map(\.name))
        let library = try XCTUnwrap(tabs.listRoots[.library])
        library.loadViewIfNeeded()
        XCTAssertEqual(library.navigationItem.rightBarButtonItem?.accessibilityLabel, L10n.noteListNewNote())
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
