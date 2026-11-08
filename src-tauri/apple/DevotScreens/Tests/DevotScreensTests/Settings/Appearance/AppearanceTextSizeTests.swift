import UIKit
import XCTest

@testable import DevotScreens

/// The accessibility audit grows the text size over what shows and fails text that leaves the screen.
@MainActor
final class AppearanceTextSizeTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func show() throws -> (UIWindow, SettingsHosting<AppearancePane>, UICollectionView) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        // Short enough for the pane's last rows to scroll to the top of the screen.
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 480)
        let pane = SettingsHosting(
            title: L10n.settingsPaneAppearance(),
            AppearancePane(
                store: SettingsStore(), themes: ThemeStore(), glass: GlassStyleStore(),
                router: SettingsRouter { _ in UIViewController() }, addFont: {}))
        window.rootViewController = UINavigationController(rootViewController: pane)
        window.makeKeyAndVisible()
        self.window = window
        settle()
        return (window, pane, try XCTUnwrap(pane.view.firstSubview(of: UICollectionView.self)))
    }

    private func settle() {
        for _ in 0..<20 { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
    }

    /// How far below the list's visible top an element's top is.
    private func shownAt(_ list: UICollectionView, kind: String?, _ path: IndexPath) throws -> CGFloat {
        let layout = list.collectionViewLayout
        let attributes = try XCTUnwrap(
            kind.flatMap { layout.layoutAttributesForSupplementaryView(ofKind: $0, at: path) }
                ?? layout.layoutAttributesForItem(at: path))
        return attributes.frame.minY - list.contentOffset.y - list.adjustedContentInset.top
    }

    private func assertKeepsItsPlace(
        kind: String?, _ path: IndexPath, file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let (window, pane, list) = try show()
        XCTAssertTrue(pane.placeKeeper?.list === list, file: file, line: line)
        var reading = true
        let keeper = PlaceKeeper(list) { _ in reading }
        let place: CGFloat = 40
        // The list learns its rows' heights as they show, so it takes a few steps to get there.
        for _ in 0..<3 {
            list.setContentOffset(
                CGPoint(x: 0, y: list.contentOffset.y + (try shownAt(list, kind: kind, path)) - place), animated: false)
            settle()
        }
        reading = false
        XCTAssertEqual(try shownAt(list, kind: kind, path), place, accuracy: 1, file: file, line: line)
        for size in [UIContentSizeCategory.extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge] {
            window.traitOverrides.preferredContentSizeCategory = size
            settle()
            XCTAssertEqual(try shownAt(list, kind: kind, path), place, accuracy: 1, "\(size.rawValue)", file: file, line: line)
        }
        withExtendedLifetime(keeper) {}
    }

    func testTheThemesFooterKeepsItsPlaceAsTheTextGrows() throws {
        try assertKeepsItsPlace(kind: UICollectionView.elementKindSectionFooter, IndexPath(item: 0, section: 1))
    }

    /// Text's third row, after the samples and Text Size.
    func testPreviewFontSizeKeepsItsPlaceAsTheTextGrows() throws {
        try assertKeepsItsPlace(kind: nil, IndexPath(item: 2, section: 3))
    }
}
