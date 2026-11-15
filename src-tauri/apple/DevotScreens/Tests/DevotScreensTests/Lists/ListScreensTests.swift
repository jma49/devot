import UIKit
import XCTest

@testable import DevotScreens

/// The list screens' bars in a window: what they offer and what they leave behind.
@MainActor
final class ListScreensTests: XCTestCase {
    private var window: UIWindow?
    private var bridge: FakeBridge!
    private var context: ListContext!

    override func setUp() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        bridge = FakeBridge()
        context = ListContext()
        context.bridge = bridge
        context.reduceMotion = { true }
        context.gate.perform = { [unowned self] in context.perform($0) }
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func shown(_ root: UIViewController) -> UINavigationController {
        let navigation = UINavigationController(rootViewController: root)
        window?.rootViewController = navigation
        window?.makeKeyAndVisible()
        navigation.view.layoutIfNeeded()
        return navigation
    }

    func testTheLibraryOffersNewNotebookThroughTheGate() throws {
        let library = LibraryScreen(tab: .library, context: context)
        _ = shown(library)
        library.loadViewIfNeeded()
        let labels = (library.navigationItem.rightBarButtonItems ?? []).compactMap(\.accessibilityLabel)
        XCTAssertEqual(labels, [L10n.noteListNewNote(), L10n.bookNew()])
        bridge.sent.removeAll()
        library.newNotebook()
        XCTAssertEqual(bridge.ops, [Op.bookCreate.rawValue])
    }

    func testLeavingAListWhileSelectingPutsItsToolbarAway() throws {
        let navigation = shown(UIViewController())
        let list = NoteListScreen(title: "Work", view: .all, tab: .library, context: context, isRoot: false)
        navigation.pushViewController(list, animated: false)
        navigation.view.layoutIfNeeded()
        list.loadViewIfNeeded()
        list.select(true)
        XCTAssertFalse(navigation.isToolbarHidden)
        navigation.popViewController(animated: false)
        navigation.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertTrue(navigation.isToolbarHidden)
        XCTAssertFalse(list.collection.isEditing)
    }

    private func rowFrames(regular: Bool, appearance: UICollectionLayoutListConfiguration.Appearance) -> (rows: [CGRect], readable: CGRect, bounds: CGRect) {
        let screen = UIViewController()
        let collection = UICollectionView(frame: .zero, collectionViewLayout: .readableList(.init(appearance: appearance)))
        let rows = UICollectionView.CellRegistration<UICollectionViewListCell, Int> { cell, _, item in
            var content = cell.defaultContentConfiguration()
            content.text = "\(item)"
            cell.contentConfiguration = content
        }
        let data = UICollectionViewDiffableDataSource<Int, Int>(collectionView: collection) { collection, path, item in
            collection.dequeueConfiguredReusableCell(using: rows, for: path, item: item)
        }
        var snapshot = NSDiffableDataSourceSnapshot<Int, Int>()
        snapshot.appendSections([0])
        snapshot.appendItems([1, 2, 3])
        data.apply(snapshot, animatingDifferences: false)
        screen.view = collection
        screen.traitOverrides.horizontalSizeClass = regular ? .regular : .compact
        window?.frame = CGRect(x: 0, y: 0, width: 1194, height: 834)
        window?.rootViewController = screen
        window?.makeKeyAndVisible()
        collection.layoutIfNeeded()
        let frames = collection.visibleCells.map(\.frame)
        return (frames, collection.readableContentGuide.layoutFrame, collection.bounds)
    }

    func testAtARegularWidthAListKeepsToTheReadableWidth() {
        for appearance in [UICollectionLayoutListConfiguration.Appearance.plain, .insetGrouped] {
            let shown = rowFrames(regular: true, appearance: appearance)
            XCTAssertEqual(shown.rows.count, 3)
            XCTAssertLessThan(shown.readable.width, shown.bounds.width - 100)
            for row in shown.rows {
                XCTAssertGreaterThanOrEqual(row.minX + 0.5, shown.readable.minX, "\(appearance) \(row)")
                XCTAssertLessThanOrEqual(row.maxX - 0.5, shown.readable.maxX, "\(appearance) \(row)")
            }
        }
    }

    func testAtACompactWidthAPlainListStillSpansTheScreen() {
        let shown = rowFrames(regular: false, appearance: .plain)
        XCTAssertEqual(shown.rows.count, 3)
        XCTAssertTrue(shown.rows.allSatisfy { $0.width == shown.bounds.width })
    }
}
