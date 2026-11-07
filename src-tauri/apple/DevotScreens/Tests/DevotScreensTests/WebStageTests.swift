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

        for tab in TabModel.tabs + TabModel.tabs.reversed() {
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
