import UIKit
import WebKit
import XCTest

@testable import DevotScreens

final class FakeRust: RustSide {
    var calls: [(UInt64, Data)] = []
    var lines: [String] = []

    func call(_ request: UInt64, _ json: Data) { calls.append((request, json)) }
    func log(_ level: LogLevel, _ line: String) { lines.append(line) }
}

@MainActor
final class InstallTests: XCTestCase {
    private var window: UIWindow?
    private var defaults: UserDefaults!

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "InstallTests")
        defaults.removePersistentDomain(forName: "InstallTests")
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        defaults.removePersistentDomain(forName: "InstallTests")
    }

    private func show(_ root: UIViewController) throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.window = window
    }

    private func shownRoot() throws -> UIViewController {
        let root = UIViewController()
        try show(root)
        return root
    }

    /// Lets queued appearance and layout run, as the next turn of the main run loop would.
    private func settle() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    private func sent(_ rust: FakeRust) throws -> [Message] {
        try rust.calls.map { try Message(json: $0.1) }
    }

    /// The tab requests, without the reads Settings sends as it shows.
    private func tabRequests(_ rust: FakeRust) throws -> [Message] {
        try sent(rust).filter {
            if case .request(_, let op, _) = $0 { op.rawValue.hasPrefix("tabs.") } else { false }
        }
    }

    /// The tab requests by name and tab, whatever their IDs after the reads the screens send as they show.
    private func tabShows(_ rust: FakeRust) throws -> [String] {
        try tabRequests(rust).compactMap {
            if case .request(_, let op, let args) = $0 { "\(op.rawValue) \(args["tab"]?.string ?? "")" } else { nil }
        }
    }

    func testAttachesTheTabBarOverTheWebViewAndShowsThePageLibrary() throws {
        let root = try shownRoot()
        let webView = WKWebView(frame: root.view.bounds)
        root.view.addSubview(webView)
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: root, rust: rust, defaults: defaults))
        root.view.layoutIfNeeded()
        settle()
        XCTAssertTrue(root.children.contains(screens.root))
        XCTAssertTrue(screens.root.view.superview === root.view)
        XCTAssertEqual(screens.root.view.frame, root.view.bounds)
        XCTAssertTrue(screens.root.children.contains(screens.root.tabs))
        XCTAssertTrue(webView.superview === screens.root.tabs.screen(.library)?.view)
        let middle = CGPoint(x: root.view.bounds.midX, y: root.view.bounds.midY)
        XCTAssertEqual(screens.root.view.hitTest(middle, with: nil)?.isDescendant(of: webView), true)
        XCTAssertEqual(try tabShows(rust), ["tabs.show library"])
    }

    func testMakesTaosWindowKeyOnceItsSceneIsActive() throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        XCTAssertEqual(scene.activationState, .foregroundActive)
        let other = UIWindow(windowScene: scene)
        other.rootViewController = UIViewController()
        other.makeKeyAndVisible()
        defer { other.isHidden = true }
        let root = UIViewController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = root
        window.isHidden = false
        self.window = window
        XCTAssertFalse(window.isKeyWindow)
        let rust = FakeRust()
        _ = try XCTUnwrap(Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        root.view.layoutIfNeeded()
        settle()
        XCTAssertTrue(window.isKeyWindow)
        XCTAssertEqual(rust.lines, ["I_SCREENS_WINDOW_KEY"])
    }

    func testTellsThePageAboutATabTappedAgainAndFollowsTheTabsItReports() throws {
        let root = try shownRoot()
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        root.view.layoutIfNeeded()
        settle()
        screens.replied(1, try Message.reply(id: 1, outcome: .ok(.object([:]))).json())
        let tabs = screens.root.tabs
        XCTAssertTrue(screens.selectionFeedback.view === tabs.view)
        _ = tabs.tabBarController(tabs, shouldSelect: try XCTUnwrap(tabs.selectedViewController))
        let popped = try XCTUnwrap(rust.calls.last?.0)
        XCTAssertEqual(try sent(rust).last, .request(id: popped, op: .tabsPopToRoot, args: ["tab": .string("library")]))
        screens.replied(popped, try Message.reply(id: popped, outcome: .ok(.object([:]))).json())

        screens.delivered(Data(#"{"v":1,"notice":"tabs.state","tab":"settings","barHidden":false,"attention":true}"#.utf8))
        settle()
        XCTAssertEqual(tabs.selectedIndex, TabModel.tabs.firstIndex(of: .settings))
        XCTAssertEqual(tabs.viewControllers?[3].tabBarItem.badgeValue, "!")
        XCTAssertEqual(try tabRequests(rust).count, 2)

        screens.delivered(Data(#"{"v":1,"notice":"tabs.state","tab":"settings","barHidden":true,"attention":true}"#.utf8))
        XCTAssertTrue(tabs.isTabBarHidden)
        XCTAssertEqual(rust.lines, [])
    }

    func testTheKillSwitchKeepsTheWebShell() throws {
        let root = try shownRoot()
        defaults.set(true, forKey: Screens.killSwitch)
        let rust = FakeRust()
        XCTAssertNil(Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        XCTAssertTrue(root.children.isEmpty)
        XCTAssertEqual(rust.lines, ["I_SCREENS_SWITCHED_OFF"])
    }

    func testRefusesObjectsOfAnotherClass() throws {
        let root = try shownRoot()
        let rust = FakeRust()
        XCTAssertNil(Screens.attach(webView: UIView(), root: root, rust: rust, defaults: defaults))
        XCTAssertNil(Screens.attach(webView: WKWebView(), root: UIView(), rust: rust, defaults: defaults))
        XCTAssertEqual(rust.lines, Array(repeating: "W_SCREENS_INSTALL_REFUSED reason=class", count: 2))
    }

    func testAttachesBeforeTheWindowIsUpAndFollowsItWhenItIs() throws {
        let rust = FakeRust()
        let root = UIViewController()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        XCTAssertNil(root.view.window)
        XCTAssertTrue(root.children.contains(screens.root))
        XCTAssertTrue(screens.root.view.superview === root.view)
        XCTAssertEqual(rust.calls.count, 0)
        try show(root)
        root.view.layoutIfNeeded()
        settle()
        XCTAssertEqual(screens.root.view.frame, root.view.bounds)
        XCTAssertNotNil(screens.root.view.window)
        XCTAssertEqual(try tabShows(rust), ["tabs.show library"])
        XCTAssertEqual(rust.lines, [])
    }

    func testAnswersEachRequestByItsIDAndDropsAnUnmatchedReply() throws {
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: UIViewController(), rust: rust, defaults: defaults))
        var outcomes: [Outcome] = []
        screens.request(.ping) { outcomes.append($0) }
        screens.request(.noteCreate, ["title": .string("Plans")]) { outcomes.append($0) }
        XCTAssertEqual(rust.calls.map(\.0), [1, 2])
        let sent = try Message(json: rust.calls[1].1)
        XCTAssertEqual(sent, .request(id: 2, op: .noteCreate, args: ["title": .string("Plans")]))

        screens.replied(2, try Message.reply(id: 2, outcome: .failed("E_LICENCE_REQUIRED")).json())
        screens.replied(1, try Message.reply(id: 1, outcome: .ok(.object([:]))).json())
        screens.replied(1, try Message.reply(id: 1, outcome: .ok(.null)).json())
        XCTAssertEqual(outcomes, [.failed("E_LICENCE_REQUIRED"), .ok(.object([:]))])
        XCTAssertEqual(rust.lines, ["W_SCREENS_REPLY_UNMATCHED id=1"])
        XCTAssertEqual(screens.waitingCount, 0)
    }

    func testFailsARequestWhoseReplyCarriesAnotherID() throws {
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: UIViewController(), rust: rust, defaults: defaults))
        var outcomes: [Outcome] = []
        screens.request(.ping) { outcomes.append($0) }
        screens.replied(1, try Message.reply(id: 9, outcome: .ok(.null)).json())
        XCTAssertEqual(outcomes, [.failed("E_SCREENS_MESSAGE_INVALID")])
    }

    func testHandsOnANoticeAndDropsAnythingElse() throws {
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: try shownRoot(), rust: rust, defaults: defaults))
        var notices: [NoticeKind] = []
        screens.onNotice = { kind, _ in notices.append(kind) }
        screens.delivered(Data(#"{"v":1,"notice":"notes.changed","rev":3,"ids":[]}"#.utf8))
        screens.delivered(Data(#"{"v":1,"id":1,"ok":true,"result":null}"#.utf8))
        screens.delivered(nil)
        XCTAssertEqual(notices, [.notesChanged])
        XCTAssertEqual(rust.lines, Array(repeating: "W_SCREENS_NOTICE_INVALID", count: 2))
    }

    func testThePagesEnterLicenseKeyOpensTheNativeLicensePageOverTheSettingsRoot() throws {
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: try shownRoot(), rust: rust, defaults: defaults))
        settle()
        screens.delivered(Data(#"{"v":1,"notice":"settings.open","pane":"licence","focusKey":true}"#.utf8))
        settle()
        let tabs = screens.root.tabs
        XCTAssertEqual(tabs.selectedIndex, TabModel.tabs.firstIndex(of: .settings))
        XCTAssertEqual(tabs.settings.navigation.viewControllers.count, 2)
        XCTAssertTrue(tabs.settings.navigation.viewControllers.first === tabs.settings.root)
        XCTAssertEqual(try tabShows(rust), ["tabs.show library", "tabs.show settings"])
        XCTAssertTrue(try sent(rust).contains { if case .direct(_, .licenceGet, _) = $0 { true } else { false } })
        screens.delivered(Data(#"{"v":1,"notice":"settings.open","pane":"sync"}"#.utf8))
        XCTAssertEqual(rust.lines.last, "W_SCREENS_NOTICE_INVALID notice=settings.open")
    }

    func testSettingsReadsGoToRustAsDirectRequestsAndComeBackByID() throws {
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: try shownRoot(), rust: rust, defaults: defaults))
        var outcome: Outcome?
        screens.direct(.licenceGet) { outcome = $0 }
        let id = try XCTUnwrap(rust.calls.last?.0)
        XCTAssertEqual(try sent(rust).last, .direct(id: id, op: .licenceGet, args: [:]))
        screens.replied(id, try Message.reply(id: id, outcome: .failed("E_LICENCE_KEYCHAIN")).json())
        XCTAssertEqual(outcome, .failed("E_LICENCE_KEYCHAIN"))
    }

    func testOnceShownTheThemeIsReadAndThePageGetsThisIPhonesGlass() throws {
        let rust = FakeRust()
        let root = UIViewController()
        _ = try XCTUnwrap(Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        XCTAssertEqual(rust.calls.count, 0)
        try show(root)
        root.view.layoutIfNeeded()
        settle()
        let ops = try sent(rust).compactMap { message -> String? in
            switch message {
            case .direct(_, let op, _): op.rawValue
            case .request(_, let op, _): op.rawValue
            default: nil
            }
        }
        XCTAssertTrue(ops.contains("direct.editorSettings.get"))
        XCTAssertTrue(ops.contains("glass.get") || ops.contains("glass.set"))
    }
}
