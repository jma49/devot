import UIKit
import UIKit.UIGestureRecognizerSubclass
import XCTest

@testable import DevotScreens

/// The accessibility audit grows the text size over what shows and fails text that leaves the screen.
/// These drive the pane's own place keeper, as SettingsHosting wires it.
@MainActor
final class AppearanceTextSizeTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func show() throws -> (UIWindow, UICollectionView) {
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
        let list = try XCTUnwrap(pane.view.firstSubview(of: UICollectionView.self))
        XCTAssertTrue(pane.placeKeeper?.list === list)
        return (window, list)
    }

    private func settle() {
        for _ in 0..<20 { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
    }

    /// Scrolls as a finger does: the list's own pan begins, the list moves, and the pan ends.
    private func drag(_ list: UICollectionView, to offset: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        let pan = list.panGestureRecognizer
        pan.state = .began
        // The pan's action, which makes the list dragging, comes on the run loop's next turn.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertTrue(list.isDragging, file: file, line: line)
        list.contentOffset.y = (list.contentOffset.y + offset) / 2
        list.contentOffset.y = offset
        pan.state = .ended
        settle()
    }

    private func grow(_ window: UIWindow, to size: UIContentSizeCategory) {
        window.traitOverrides.preferredContentSizeCategory = size
        settle()
    }

    /// How far below the list's visible top an element's top is.
    private func shownAt(_ list: UICollectionView, kind: String?, _ path: IndexPath) throws -> CGFloat {
        let content = CGRect(origin: .zero, size: list.contentSize).insetBy(dx: 0, dy: -list.bounds.height)
        let attributes = try XCTUnwrap(
            list.collectionViewLayout.layoutAttributesForElements(in: content)?
                .first { $0.indexPath == path && $0.representedElementKind == kind })
        return attributes.frame.minY - list.contentOffset.y - list.adjustedContentInset.top
    }

    /// The list learns its rows' heights as they show, so it takes a few drags to get there.
    private func drag(_ list: UICollectionView, bringing path: IndexPath, kind: String?, to place: CGFloat) throws {
        for _ in 0..<3 {
            drag(list, to: list.contentOffset.y + (try shownAt(list, kind: kind, path)) - place)
        }
        XCTAssertEqual(try shownAt(list, kind: kind, path), place, accuracy: 1)
    }

    private func assertKeepsItsPlace(
        kind: String?, _ path: IndexPath, file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let (window, list) = try show()
        let place: CGFloat = 40
        try drag(list, bringing: path, kind: kind, to: place)
        for size in [UIContentSizeCategory.extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge] {
            grow(window, to: size)
            XCTAssertEqual(try shownAt(list, kind: kind, path), place, accuracy: 1, "\(size.rawValue)", file: file, line: line)
        }
    }

    func testTheThemesFooterKeepsItsPlaceAsTheTextGrows() throws {
        try assertKeepsItsPlace(kind: UICollectionView.elementKindSectionFooter, IndexPath(item: 0, section: 1))
    }

    /// Text's third row, after the samples and Text Size.
    func testPreviewFontSizeKeepsItsPlaceAsTheTextGrows() throws {
        try assertKeepsItsPlace(kind: nil, IndexPath(item: 2, section: 3))
    }

    /// A pane is not pinned to its foot, which would push the rows at the top of the screen under the bar.
    func testAtThePanesFootTheFirstRowOnTheScreenKeepsItsPlace() throws {
        let (window, list) = try show()
        for _ in 0..<3 {
            drag(list, to: list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
        }
        let shown = list.contentOffset.y + list.adjustedContentInset.top
        let first = try XCTUnwrap(
            list.collectionViewLayout.layoutAttributesForElements(in: CGRect(x: 0, y: shown, width: 402, height: 300))?
                .filter { $0.representedElementCategory != .decorationView && $0.frame.minY >= shown }
                .min { $0.frame.minY < $1.frame.minY })
        let place = first.frame.minY - shown
        for size in [UIContentSizeCategory.extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge] {
            grow(window, to: size)
            XCTAssertEqual(
                try shownAt(list, kind: first.representedElementKind, first.indexPath), place, accuracy: 1, "\(size.rawValue)")
        }
    }

    /// Rows learn their heights as a scroll brings them in, and the list settles by itself.
    func testWithoutATextSizeChangeTheListIsLeftWhereItSettles() throws {
        let (_, list) = try show()
        drag(list, to: list.contentOffset.y + 300)
        list.contentOffset.y += 100
        let settled = list.contentOffset.y
        list.contentSize.height += 1
        XCTAssertEqual(list.contentOffset.y, settled, accuracy: 0.5)
    }

    /// Once the reader scrolls on from a text size change, the list is theirs again and settles by itself.
    func testAScrollAfterATextSizeChangeIsNotPulledBack() throws {
        let (window, list) = try show()
        let footer = IndexPath(item: 0, section: 1)
        try drag(list, bringing: footer, kind: UICollectionView.elementKindSectionFooter, to: 40)
        grow(window, to: .accessibilityMedium)
        let read = list.contentOffset.y + 250
        drag(list, to: read)
        XCTAssertEqual(list.contentOffset.y, read, accuracy: 0.5)
        list.contentOffset.y += 100
        let settled = list.contentOffset.y
        list.contentSize.height += 1
        XCTAssertEqual(list.contentOffset.y, settled, accuracy: 0.5)
    }
}
