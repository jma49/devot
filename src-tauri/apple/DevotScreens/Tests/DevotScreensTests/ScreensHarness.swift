import UIKit
import XCTest

@testable import DevotScreens

/// The screens attached to a window with a stand-in web view and Rust, for the flows that need
/// both a stack and the bridge.
@MainActor
final class ScreensHarness {
    let window: UIWindow
    let rust = FakeRust()
    let screens: Screens
    private var answered = Set<UInt64>()

    /// `shownFirst` puts tao's root in the window before the screens attach, as the app does.
    init(defaults: UserDefaults, shownFirst: Bool = false) throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        let tao = UIViewController()
        let webView = RecordingWebView()
        tao.view.addSubview(webView)
        if shownFirst {
            window.rootViewController = tao
            window.makeKeyAndVisible()
        }
        screens = try XCTUnwrap(Screens.attach(webView: webView, root: tao, rust: rust, defaults: defaults))
        window.rootViewController = tao
        window.makeKeyAndVisible()
        webView.frame = window.bounds
        tao.view.layoutIfNeeded()
    }

    func close() {
        screens.root.tabs.presentedViewController?.dismiss(animated: false)
        window.endEditing(true)
        settle(0.5)
        window.isHidden = true
    }

    func settle(_ seconds: TimeInterval = 0.05) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func settle(
        until condition: () throws -> Bool, timeout: TimeInterval = 30, file: StaticString = #filePath,
        line: UInt = #line
    ) rethrows {
        let deadline = Date().addingTimeInterval(timeout)
        while try !condition(), Date() < deadline { settle(0.02) }
        if try !condition() { XCTFail("waited \(timeout) s and the condition never held", file: file, line: line) }
    }

    func navigation(_ tab: Tab) -> UINavigationController {
        screens.root.tabs.navigations[tab]!
    }

    func deliver(_ json: String) {
        screens.delivered(Data(json.utf8))
    }

    private func sent() -> [(UInt64, Message)] {
        rust.calls.compactMap { id, json in (try? Message(json: json)).map { (id, $0) } }
    }

    func requests() -> [(op: Op, args: [String: JSONValue])] {
        sent().compactMap { _, message in
            guard case .request(_, let op, let args) = message else { return nil }
            return (op, args)
        }
    }

    func directs() -> [(op: DirectOp, args: [String: JSONValue])] {
        sent().compactMap { _, message in
            guard case .direct(_, let op, let args) = message else { return nil }
            return (op, args)
        }
    }

    /// Answers the oldest unanswered call that matches.
    func answer(_ matches: (Message) -> Bool, _ outcome: Outcome, file: StaticString = #filePath, line: UInt = #line) {
        guard let (id, _) = sent().first(where: { !answered.contains($0.0) && matches($0.1) }) else {
            return XCTFail("nothing waits for that answer", file: file, line: line)
        }
        answered.insert(id)
        screens.replied(id, try? Message.reply(id: id, outcome: outcome).json())
    }

    func answer(_ op: Op, _ outcome: Outcome, file: StaticString = #filePath, line: UInt = #line) {
        answer({ if case .request(_, op, _) = $0 { true } else { false } }, outcome, file: file, line: line)
    }

    /// The live notes' titles, for the titles read a route or a launch asks for.
    func answerTitles(_ titles: [String: String], file: StaticString = #filePath, line: UInt = #line) {
        let rows = titles.sorted { $0.key < $1.key }.map { JSONValue.object(["id": .string($0.key), "title": .string($0.value)]) }
        answer(
            { if case .direct(_, .listsTitles, _) = $0 { true } else { false } }, .ok(.array(rows)), file: file,
            line: line)
    }

    /// Whatever else waits gets an empty vault's answer.
    func answerAll() {
        for (id, json) in rust.calls where !answered.contains(id) {
            answered.insert(id)
            screens.replied(id, try? Message.reply(id: id, outcome: .ok(FakeRust.emptyAnswer(json))).json())
        }
    }
}
