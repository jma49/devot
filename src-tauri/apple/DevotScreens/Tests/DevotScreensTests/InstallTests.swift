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

    private func shownRoot() throws -> UIViewController {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.window = window
        return root
    }

    func testAttachesAnEmptyRootThatLetsEveryTouchThrough() throws {
        let root = try shownRoot()
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        XCTAssertTrue(root.children.contains(screens.root))
        XCTAssertTrue(screens.root.view.superview === root.view)
        root.view.layoutIfNeeded()
        XCTAssertEqual(screens.root.view.frame, root.view.bounds)
        XCTAssertNil(screens.root.view.hitTest(CGPoint(x: 10, y: 10), with: nil))
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

    func testRefusesARootWithoutAWindow() {
        let rust = FakeRust()
        let root = UIViewController()
        root.loadViewIfNeeded()
        XCTAssertNil(Screens.attach(webView: WKWebView(), root: root, rust: rust, defaults: defaults))
        XCTAssertEqual(rust.lines, ["W_SCREENS_INSTALL_REFUSED reason=no-window"])
    }

    func testAnswersEachRequestByItsIDAndDropsAnUnmatchedReply() throws {
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: WKWebView(), root: try shownRoot(), rust: rust, defaults: defaults))
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
            Screens.attach(webView: WKWebView(), root: try shownRoot(), rust: rust, defaults: defaults))
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
}
