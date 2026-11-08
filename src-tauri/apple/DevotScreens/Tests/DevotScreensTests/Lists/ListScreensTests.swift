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
}
