import UIKit
import XCTest

@testable import DevotScreens

/// design/motion.md, Bottom toolbar and the keyboard: the bars move inside the keyboard's own
/// duration and curve, and the page is handed the covered height once per change.
@MainActor
final class KeyboardTrackerTests: XCTestCase {
    private var window: UIWindow?
    private var heard: [CGFloat] = []

    override func setUp() async throws {
        heard = []
        KeyboardTracker.latest = nil
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        KeyboardTracker.latest = nil
    }

    private func post(_ info: [AnyHashable: Any]) {
        NotificationCenter.default.post(
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil, userInfo: info)
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }

    private func hostedView() throws -> UIView {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let screen = UIViewController()
        window.rootViewController = screen
        window.makeKeyAndVisible()
        self.window = window
        return screen.view
    }

    private func info(covering height: CGFloat, in view: UIView, duration: Double = 0.25, curve: Int = 7) throws
        -> [AnyHashable: Any]
    {
        let window = try XCTUnwrap(view.window)
        let frame = CGRect(x: 0, y: window.bounds.height - height, width: window.bounds.width, height: height)
        return [
            UIResponder.keyboardFrameEndUserInfoKey: NSValue(
                cgRect: window.convert(frame, to: window.screen.coordinateSpace)),
            UIResponder.keyboardAnimationDurationUserInfoKey: NSNumber(value: duration),
            UIResponder.keyboardAnimationCurveUserInfoKey: NSNumber(value: curve),
        ]
    }

    func testTheCoveredHeightIsWhatTheKeyboardHidesOfTheView() {
        let view = CGRect(x: 0, y: 0, width: 400, height: 800)
        XCTAssertEqual(KeyboardChange.covered(keyboard: CGRect(x: 0, y: 464, width: 400, height: 336), view: view), 336)
        XCTAssertEqual(
            KeyboardChange.covered(keyboard: CGRect(x: 0, y: 800, width: 400, height: 336), view: view), 0,
            "a keyboard off the bottom covers nothing")
        XCTAssertEqual(
            KeyboardChange.covered(keyboard: CGRect(x: 40, y: 300, width: 300, height: 200), view: view), 0,
            "a floating keyboard covers nothing")
        XCTAssertEqual(KeyboardChange.covered(keyboard: .null, view: view), 0)
    }

    func testTheDurationAndCurveAreKeptWithinWhatThePageAccepts() {
        let change = KeyboardChange(covered: -4, duration: 9, curve: 12)
        XCTAssertEqual(change.covered, 0)
        XCTAssertEqual(change.duration, KeyboardChange.longest)
        XCTAssertEqual(change.curve, KeyboardChange.keyboardCurve)
        XCTAssertFalse(change.up)
        XCTAssertEqual(KeyboardChange(covered: 1, duration: 0.25, curve: 7).options.rawValue, 7 << 16)
    }

    func testTheBarsMoveInsideTheKeyboardsAnimationAndThePageHearsOnceAfterIt() throws {
        let view = try hostedView()
        let tracker = KeyboardTracker(view: view)
        var log: [String] = []
        var animations: [(TimeInterval, UIView.AnimationOptions)] = []
        var inside = false
        tracker.animate = { duration, options, changes in
            animations.append((duration, options))
            inside = true
            changes()
            inside = false
        }
        tracker.alongside = { change in log.append("alongside \(Int(change.covered)) inside=\(inside)") }
        tracker.changed = { change in log.append("changed \(Int(change.covered)) inside=\(inside)") }
        tracker.keyboardWillChange(try info(covering: 336, in: view, duration: 0.3, curve: 7))
        XCTAssertEqual(log, ["alongside 336 inside=true", "changed 336 inside=false"])
        XCTAssertEqual(animations.first?.0, 0.3)
        XCTAssertEqual(animations.first?.1, UIView.AnimationOptions(rawValue: 7 << 16))
        tracker.keyboardWillChange(try info(covering: 336, in: view))
        XCTAssertEqual(log.count, 2, "a frame change that covers the same height is not passed on")
        tracker.keyboardWillChange(try info(covering: 0, in: view))
        XCTAssertEqual(log.suffix(2), ["alongside 0 inside=true", "changed 0 inside=false"])
    }

    func testStoppingForgetsTheLastChangeSoTheNextAppearanceHearsTheKeyboardAgain() throws {
        let view = try hostedView()
        let tracker = KeyboardTracker(view: view)
        tracker.animate = { _, _, changes in changes() }
        var heard = 0
        tracker.changed = { _ in heard += 1 }
        tracker.start()
        tracker.keyboardWillChange(try info(covering: 300, in: view))
        tracker.stop()
        XCTAssertNil(tracker.last)
        tracker.keyboardWillChange(try info(covering: 300, in: view))
        XCTAssertEqual(heard, 2)
    }

    func testAPostedChangeReachesAStartedTrackerAndAStoppedOneStartsAgainFromTheLatest() throws {
        let view = try hostedView()
        let tracker = KeyboardTracker(view: view)
        tracker.animate = { _, _, changes in changes() }
        tracker.changed = { [unowned self] in heard.append($0.covered) }
        tracker.start()
        post(try info(covering: 300, in: view))
        XCTAssertEqual(heard, [300])
        tracker.stop()
        post(try info(covering: 280, in: view))
        XCTAssertEqual(heard, [300], "a stopped tracker hears nothing")
        tracker.start()
        tracker.sync()
        XCTAssertEqual(heard, [300, 280], "it starts again from where the keyboard is now")
        tracker.sync()
        XCTAssertEqual(heard.count, 2)
    }

    func testAKeyboardThatRisesForAnotherScreenIsIgnoredButOneGoingDownIsNot() throws {
        let view = try hostedView()
        let tracker = KeyboardTracker(view: view)
        tracker.animate = { _, _, changes in changes() }
        tracker.changed = { [unowned self] in heard.append($0.covered) }
        var owned = false
        tracker.owns = { owned }
        tracker.start()
        post(try info(covering: 300, in: view))
        XCTAssertEqual(heard, [])
        XCTAssertNil(tracker.last)
        post(try info(covering: 0, in: view))
        XCTAssertEqual(heard, [0])
        owned = true
        post(try info(covering: 300, in: view))
        XCTAssertEqual(heard, [0, 300])
    }
}
