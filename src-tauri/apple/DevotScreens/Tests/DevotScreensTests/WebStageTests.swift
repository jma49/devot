import UIKit
import WebKit
import XCTest

@testable import DevotScreens

/// Records what spike S1 measured on a device: a move never takes the view out of its window and
/// never changes its size.
final class RecordingWebView: WKWebView {
    var leftWindow = 0
    var resized = 0

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

    func testEachTabTakesTheWebViewWithoutResizingIt() throws {
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

        let web = TabModel.tabs.filter { $0 != .settings }
        for tab in web + web.reversed() {
            tabs.select(tab)
            tabs.view.layoutIfNeeded()
            let screen = try XCTUnwrap(tabs.screen(tab))
            XCTAssertTrue(webView.superview === screen.view, "\(tab)")
            XCTAssertEqual(webView.bounds.size, window.bounds.size, "\(tab)")
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

    func testTheNativeSettingsRestsTheWebViewAndAWebPaneTakesItUnderTheBarOnceThePageShowsThePane() throws {
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
        tabs.select(.settings)
        tabs.view.layoutIfNeeded()
        XCTAssertTrue(webView.superview === screens.root.host.stage)

        tabs.settings.navigation.pushViewController(tabs.settings.controller(.appearance), animated: false)
        tabs.view.layoutIfNeeded()
        let pane = try XCTUnwrap(tabs.settings.navigation.topViewController as? WebPaneScreen)
        let asked = try XCTUnwrap(try requests(rust, .settingsShowPane).last)
        XCTAssertEqual(asked.1, ["pane": .string("appearance")])
        XCTAssertTrue(webView.superview === screens.root.host.stage)

        screens.replied(asked.0, try Message.reply(id: asked.0, outcome: .ok(.object([:]))).json())
        XCTAssertTrue(webView.superview === pane.view)
        XCTAssertEqual(webView.bounds.size, window.bounds.size)
        XCTAssertGreaterThan(webView.safeAreaInsets.top, window.safeAreaInsets.top)
        XCTAssertTrue(try requests(rust, .tabsPopToRoot).isEmpty)

        tabs.settings.navigation.popViewController(animated: false)
        tabs.view.layoutIfNeeded()
        XCTAssertTrue(webView.superview === screens.root.host.stage)
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(webView.resized, 0)
        XCTAssertEqual(try requests(rust, .tabsPopToRoot).map(\.1), [["tab": .string("settings")]])
    }

    func testPairADeviceOpensSyncAtItsPairingOnceAndAnAnswerAfterLeavingMovesNothing() throws {
        let webView = RecordingWebView()
        let rust = FakeRust()
        let tao = UIViewController()
        tao.view.addSubview(webView)
        let screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: tao, rust: rust, defaults: try freshDefaults()))
        _ = try shownWindow(tao)
        let tabs = screens.root.tabs
        tabs.select(.settings)
        tabs.view.layoutIfNeeded()
        let router = tabs.settings.router
        let make = router.make
        var made: [SettingsPage] = []
        let navigation = tabs.settings.navigation
        router.make = { made.append($0); return UIViewController() }
        router.navigation = nil
        tabs.settings.root.onPair()
        XCTAssertEqual(made, [.sync(anchor: .pairing)])
        router.make = make
        router.navigation = navigation
        navigation.setViewControllers([tabs.settings.root, make(.sync(anchor: .pairing))], animated: false)
        tabs.view.layoutIfNeeded()
        let pane = try XCTUnwrap(tabs.settings.navigation.topViewController as? WebPaneScreen)
        let shows = { try self.requests(rust, .settingsShowPane) }
        XCTAssertEqual(try shows().last?.1, ["pane": .string("sync"), "anchor": .string("pairing")])

        tabs.select(.library)
        tabs.view.layoutIfNeeded()
        let late = try XCTUnwrap(try shows().last)
        screens.replied(late.0, try Message.reply(id: late.0, outcome: .ok(.object([:]))).json())
        XCTAssertFalse(webView.superview === pane.view)

        tabs.select(.settings)
        tabs.view.layoutIfNeeded()
        XCTAssertEqual(try shows().last?.1, ["pane": .string("sync")])
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
