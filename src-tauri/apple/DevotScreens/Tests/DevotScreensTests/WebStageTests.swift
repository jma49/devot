import UIKit
import WebKit
import XCTest

@testable import DevotScreens

/// Records what spike S1 measured on a device: a move never takes the view out of its window and
/// never changes its size.
final class RecordingWebView: WKWebView {
    var leftWindow = 0
    var resized = 0
    /// Whether UIKit animated each move, one entry per new superview.
    var movesAnimated: [Bool] = []

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        movesAnimated.append(UIView.areAnimationsEnabled)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { leftWindow += 1 }
    }

    override var frame: CGRect {
        didSet { if oldValue.size != frame.size { resized += 1 } }
    }
}

@MainActor
final class WebStageTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func shownWindow(_ root: UIViewController) throws -> UIWindow {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.window = window
        return window
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    /// UIKit leaves a view out of the accessibility tree when it or a superview hides its elements.
    private func reachableByVoiceOver(_ view: UIView) -> Bool {
        !sequence(first: view, next: \.superview).contains { $0.accessibilityElementsHidden }
    }

    func testTheStageIsOnePointThatClipsAndStaysVisible() {
        let stage = WebStage()
        XCTAssertEqual(stage.bounds.size, CGSize(width: 1, height: 1))
        XCTAssertTrue(stage.clipsToBounds)
        XCTAssertEqual(stage.alpha, 1)
        XCTAssertFalse(stage.isHidden)
    }

    func testMovesKeepTheWebViewInItsWindowAtTheWindowsSize() throws {
        let root = UIViewController()
        let window = try shownWindow(root)
        let webView = RecordingWebView(frame: window.bounds)
        root.view.addSubview(webView)
        let host = WebViewHost(webView: webView)
        host.windowSize(window.bounds.size)
        root.view.addSubview(host.stage)
        let first = UIView(frame: window.bounds)
        let second = UIView(frame: window.bounds)
        root.view.addSubview(first)
        root.view.addSubview(second)
        webView.resized = 0

        for _ in 0..<20 {
            for container in [host.stage, first, second] {
                XCTAssertTrue(host.move(into: container))
                root.view.layoutIfNeeded()
                XCTAssertTrue(webView.superview === container)
                XCTAssertTrue(webView.window === window)
                XCTAssertEqual(webView.bounds.size, window.bounds.size)
            }
        }
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(webView.resized, 0)
    }

    func testRefusesAContainerOutsideTheWebViewsWindow() throws {
        let root = UIViewController()
        let window = try shownWindow(root)
        let webView = RecordingWebView(frame: window.bounds)
        root.view.addSubview(webView)
        let host = WebViewHost(webView: webView)
        XCTAssertFalse(host.move(into: UIView()))
        XCTAssertTrue(webView.superview === root.view)
        XCTAssertEqual(webView.leftWindow, 0)
    }

    func testFollowsTheWindowWhenItsSizeChanges() {
        let webView = RecordingWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let host = WebViewHost(webView: webView)
        host.windowSize(CGSize(width: 844, height: 390))
        XCTAssertEqual(webView.bounds.size, CGSize(width: 844, height: 390))
        host.windowSize(.zero)
        XCTAssertEqual(webView.bounds.size, CGSize(width: 844, height: 390))
    }

    func testEachWebTabTakesTheWebViewAndEachNativeListRestsItWithoutResizingIt() throws {
        let webView = RecordingWebView()
        let rust = FakeRust()
        let tao = UIViewController()
        tao.view.addSubview(webView)
        let screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: tao, rust: rust, defaults: try freshDefaults()))
        let window = try shownWindow(tao)
        webView.frame = window.bounds
        tao.view.layoutIfNeeded()
        webView.resized = 0
        let tabs = screens.root.tabs

        let shown = TabModel.tabs.filter { $0 != .settings }
        XCTAssertNotNil(tabs.screen(.activity))
        for tab in shown + shown.reversed() {
            tabs.select(tab)
            tabs.view.layoutIfNeeded()
            XCTAssertEqual(webView.bounds.size, window.bounds.size, "\(tab)")
            guard let screen = tabs.screen(tab) else {
                XCTAssertNotNil(tabs.listRoots[tab], "\(tab)")
                XCTAssertTrue(webView.superview === screens.root.host.stage, "\(tab)")
                XCTAssertFalse(reachableByVoiceOver(webView), "\(tab)")
                continue
            }
            XCTAssertTrue(webView.superview === screen.view, "\(tab)")
            XCTAssertEqual(screen.view.safeAreaInsets, window.safeAreaInsets, "\(tab)")
            XCTAssertEqual(webView.safeAreaInsets, window.safeAreaInsets, "\(tab)")
        }
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(webView.resized, 0)
    }

    private func requests(_ rust: FakeRust, _ op: Op) throws -> [(UInt64, [String: JSONValue])] {
        try rust.calls.compactMap { call in
            if case .request(let id, let sent, let args) = try Message(json: call.1), sent == op { (id, args) } else { nil }
        }
    }

    func testTheNativeSettingsAndItsPanesLeaveTheWebViewAtRest() throws {
        let webView = RecordingWebView()
        let rust = FakeRust()
        let tao = UIViewController()
        tao.view.addSubview(webView)
        let screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: tao, rust: rust, defaults: try freshDefaults()))
        let window = try shownWindow(tao)
        webView.frame = window.bounds
        tao.view.layoutIfNeeded()
        webView.resized = 0
        let tabs = screens.root.tabs
        XCTAssertTrue(webView.superview === screens.root.host.stage, "the native Library shows first")
        XCTAssertFalse(reachableByVoiceOver(webView))
        tabs.select(.settings)
        // iOS 26.5 can swap in the selected tab's view a turn later.
        waitUntil { tabs.settings.navigation.viewIfLoaded?.window != nil }
        XCTAssertTrue(webView.superview === screens.root.host.stage)
        XCTAssertFalse(reachableByVoiceOver(webView))

        for pane in [SettingsPage.sync(anchor: nil), .appearance] {
            tabs.settings.navigation.pushViewController(tabs.settings.controller(pane), animated: false)
            tabs.view.layoutIfNeeded()
            XCTAssertTrue(webView.superview === screens.root.host.stage, "\(pane)")
            XCTAssertFalse(reachableByVoiceOver(webView), "\(pane)")
            tabs.settings.navigation.popViewController(animated: false)
            tabs.view.layoutIfNeeded()
        }
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(webView.resized, 0)
        XCTAssertTrue(try requests(rust, .tabsPopToRoot).isEmpty)
    }

    func testPairADeviceOpensTheNativeSyncPaneWithoutAskingThePage() throws {
        let webView = RecordingWebView()
        let rust = FakeRust()
        let tao = UIViewController()
        tao.view.addSubview(webView)
        let screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: tao, rust: rust, defaults: try freshDefaults()))
        _ = try shownWindow(tao)
        let tabs = screens.root.tabs
        tabs.select(.settings)
        waitUntil { tabs.settings.navigation.viewIfLoaded?.window != nil }
        tabs.settings.root.onPair()
        tabs.view.layoutIfNeeded()
        let pane = try XCTUnwrap(tabs.settings.navigation.topViewController)
        XCTAssertEqual(pane.navigationItem.title, L10n.settingsPaneSync())
        XCTAssertFalse(webView.superview === pane.view)
    }

    /// The bar's inset may reach a screen through its superview, which a negative additional inset
    /// cannot take back; the page still sees the window's safe area.
    func testAScreenUnderAContainerThatAddsTheBarsInsetKeepsTheWindowsSafeArea() throws {
        let container = UIViewController()
        container.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 0, bottom: 49, right: 0)
        let window = try shownWindow(container)
        let webView = RecordingWebView(frame: window.bounds)
        container.view.addSubview(webView)
        let screen = WebTabScreen(tab: .notes, host: WebViewHost(webView: webView)) { _ in }
        container.addChild(screen)
        screen.view.frame = container.view.bounds
        container.view.addSubview(screen.view)
        screen.didMove(toParent: container)
        container.view.layoutIfNeeded()
        XCTAssertNotEqual(container.view.safeAreaInsets, window.safeAreaInsets)
        XCTAssertTrue(webView.superview === screen.view)
        XCTAssertEqual(screen.view.safeAreaInsets, window.safeAreaInsets)
        XCTAssertEqual(webView.safeAreaInsets, window.safeAreaInsets)
    }
}

@MainActor
func freshDefaults() throws -> UserDefaults {
    let defaults = try XCTUnwrap(UserDefaults(suiteName: "WebStageTests"))
    defaults.removePersistentDomain(forName: "WebStageTests")
    return defaults
}
