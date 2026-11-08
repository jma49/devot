import UIKit
import XCTest

@testable import DevotScreens

/// A pan whose travel and speed the test sets.
private final class StubPan: UIPanGestureRecognizer {
    var travel = CGPoint.zero
    var speed = CGPoint.zero
    private var stubbed = UIGestureRecognizer.State.possible
    override var state: UIGestureRecognizer.State {
        get { stubbed }
        set { stubbed = newValue }
    }
    override func translation(in view: UIView?) -> CGPoint { travel }
    override func velocity(in view: UIView?) -> CGPoint { speed }
}

private final class Timers {
    final class Item {
        let delay: TimeInterval
        let body: @MainActor () -> Void
        var cancelled = false
        init(delay: TimeInterval, body: @escaping @MainActor () -> Void) {
            self.delay = delay
            self.body = body
        }
    }

    var items: [Item] = []
    var live: [Item] { items.filter { !$0.cancelled } }
}

@MainActor
final class ToastPresenterTests: XCTestCase {
    private var window: UIWindow?
    private var host: UIViewController!
    private var presenter: ToastPresenter!
    private var timers: Timers!
    private var announced: [String] = []
    private var voiceOverOnToast = false
    private var barTop: CGFloat? = 700
    private var undone: [String] = []

    override func setUp() async throws {
        announced = []
        undone = []
        voiceOverOnToast = false
        barTop = 700
        timers = Timers()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        host = UIViewController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        host.view.layoutIfNeeded()
        presenter = ToastPresenter()
        presenter.attach(to: host.view)
        presenter.barTop = { [unowned self] in barTop }
        presenter.reduceMotion = { false }
        presenter.announce = { [unowned self] in announced.append($0) }
        presenter.holdsFocus = { [unowned self] _ in voiceOverOnToast }
        presenter.schedule = { [unowned self] delay, body in
            let item = Timers.Item(delay: delay, body: body)
            timers.items.append(item)
            return { item.cancelled = true }
        }
    }

    override func tearDown() async throws {
        presenter.dismissNow()
        window?.isHidden = true
        window = nil
    }

    private func toast(_ kind: UndoToast.Kind = .trashed, _ name: String = "first") -> UndoToast {
        UndoToast(kind: kind) { [unowned self] in undone.append(name) }
    }

    private func shown(file: StaticString = #filePath, line: UInt = #line) throws -> ToastView {
        try XCTUnwrap(presenter.current, file: file, line: line)
    }

    private func eventually(_ what: String, timeout: TimeInterval = 3, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("never: \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testItRisesSixtyPointsOverTwoTenthsOnTheEnterCurveAndTheGlassComesAfterTheRise() async throws {
        presenter.offer(toast())
        let view = try shown()
        XCTAssertEqual(Tokens.Size.phoneToastRise, 60)
        XCTAssertEqual(presenter.rise?.state, .active)
        XCTAssertNil(view.glass.effect, "UIKit may not install glass on a moving host")
        let rise = try XCTUnwrap(presenter.rise)
        XCTAssertEqual(rise.duration, Tokens.Duration.phoneEnter)
        let curve = try XCTUnwrap(rise.timingParameters as? UICubicTimingParameters)
        XCTAssertEqual(curve.controlPoint1, CGPoint(x: 0.33, y: 1))
        XCTAssertEqual(curve.controlPoint2, CGPoint(x: 0.68, y: 1))
        try await eventually("the glass is on") { view.glass.effect != nil }
        let glass = try XCTUnwrap(view.glass.effect as? UIGlassEffect)
        XCTAssertFalse(glass.isInteractive)
        XCTAssertEqual(view.alpha, 1)
        XCTAssertEqual(view.transform, .identity)
    }

    func testItSitsEightPointsAboveTheTabBarBetweenTheKeylinesAndIsAtLeast48High() throws {
        presenter.offer(toast())
        let view = try shown()
        host.view.layoutIfNeeded()
        let safe = host.view.safeAreaLayoutGuide.layoutFrame
        XCTAssertEqual(view.center.y + view.bounds.height / 2, 700 - Tokens.Size.phoneToastGap, accuracy: 0.5)
        XCTAssertEqual(view.center.x - view.bounds.width / 2, safe.minX + Tokens.Size.phoneScreenEdge, accuracy: 0.5)
        XCTAssertEqual(view.center.x + view.bounds.width / 2, safe.maxX - Tokens.Size.phoneScreenEdge, accuracy: 0.5)
        XCTAssertEqual(view.bounds.height, Tokens.Size.phoneToast, accuracy: 0.5)
    }

    func testWithNoTabBarItSitsAboveTheSafeAreaAndFollowsTheBarWhenItReturns() throws {
        barTop = nil
        presenter.offer(toast())
        let view = try shown()
        host.view.layoutIfNeeded()
        let safeBottom = host.view.safeAreaLayoutGuide.layoutFrame.maxY
        XCTAssertEqual(view.center.y + view.bounds.height / 2, safeBottom - Tokens.Size.phoneToastGap, accuracy: 0.5)
        barTop = 600
        presenter.hostDidLayout()
        host.view.layoutIfNeeded()
        XCTAssertEqual(view.center.y + view.bounds.height / 2, 600 - Tokens.Size.phoneToastGap, accuracy: 0.5)
    }

    func testTheUndoPillReachesA44PointTarget() throws {
        presenter.offer(toast())
        let view = try shown()
        host.view.layoutIfNeeded()
        XCTAssertGreaterThanOrEqual(view.undo.bounds.height, Tokens.Size.phoneTarget)
        XCTAssertGreaterThanOrEqual(view.undo.bounds.width, Tokens.Size.phoneTarget)
        XCTAssertEqual(view.undo.configuration?.title, L10n.phoneToastUndo())
    }

    func testItAnnouncesItsMessageAndNamesWhatItIs() throws {
        presenter.offer(toast(.trashed))
        presenter.offer(toast(.completed))
        XCTAssertEqual(announced, [L10n.phoneToastTrashed(), L10n.phoneToastCompleted()])
        let view = try shown()
        XCTAssertEqual(view.accessibilityElements?.count, 2)
        XCTAssertEqual(view.label.text, L10n.phoneToastCompleted())
    }

    func testASecondActionReplacesTheWordsInPlaceAndTakesTheUndoOverWithAFreshFourSeconds() throws {
        presenter.offer(toast(.trashed, "trash"))
        let view = try shown()
        XCTAssertEqual(view.label.text, L10n.phoneToastTrashed())
        let firstTimer = try XCTUnwrap(timers.live.first)
        presenter.offer(toast(.completed, "complete"))
        XCTAssertTrue(try shown() === view, "the same toast, not a second one")
        XCTAssertEqual(host.view.subviews.compactMap { $0 as? ToastView }.count, 1)
        XCTAssertEqual(view.label.text, L10n.phoneToastCompleted())
        XCTAssertEqual(view.kind, .completed)
        XCTAssertTrue(firstTimer.cancelled)
        XCTAssertEqual(timers.live.map(\.delay), [Tokens.Duration.phoneToast])
        view.undo.sendActions(for: .touchUpInside)
        XCTAssertEqual(undone, ["complete"], "the first action stays done")
    }

    func testItFadesOutAfterFourSecondsOverTheExitTimeAndGoes() async throws {
        presenter.offer(toast())
        let view = try shown()
        XCTAssertEqual(timers.live.map(\.delay), [4])
        timers.live[0].body()
        XCTAssertNil(presenter.current)
        try await eventually("it is gone") { view.superview == nil }
        XCTAssertEqual(Tokens.Duration.phoneExit, 0.15)
    }

    func testItStaysWhileVoiceOverIsOnItAndKeepsWaiting() async throws {
        presenter.offer(toast())
        let view = try shown()
        voiceOverOnToast = true
        timers.live[0].body()
        XCTAssertTrue(presenter.current === view)
        XCTAssertEqual(timers.live.count, 1, "it waits another four seconds")
        voiceOverOnToast = false
        timers.live[0].body()
        XCTAssertNil(presenter.current)
        try await eventually("it is gone") { view.superview == nil }
    }

    func testUndoRunsOnceAndTakesTheToastAway() async throws {
        presenter.offer(toast())
        let view = try shown()
        view.undo.sendActions(for: .touchUpInside)
        view.undo.sendActions(for: .touchUpInside)
        XCTAssertEqual(undone, ["first"])
        XCTAssertNil(presenter.current)
        XCTAssertTrue(timers.live.isEmpty)
        try await eventually("it is gone") { view.superview == nil }
    }

    func testReduceMotionCrossfadesInPlace() async throws {
        presenter.reduceMotion = { true }
        presenter.offer(toast())
        let view = try shown()
        XCTAssertEqual(view.transform, .identity, "it never moves")
        XCTAssertEqual(presenter.rise?.duration, Tokens.Duration.phoneCrossfade)
        try await eventually("it is up") { view.alpha == 1 && view.glass.effect != nil }
        XCTAssertEqual(view.transform, .identity)
    }

    // MARK: The drag

    private func drag(_ view: ToastView, to x: CGFloat, speed: CGFloat = 0, end: Bool = true) -> StubPan {
        let pan = StubPan()
        view.addGestureRecognizer(pan)
        pan.travel = CGPoint(x: x, y: 2)
        pan.speed = CGPoint(x: speed, y: 0)
        pan.state = .began
        presenter.panned(pan)
        pan.state = .changed
        presenter.panned(pan)
        if end {
            pan.state = .ended
            presenter.panned(pan)
        }
        return pan
    }

    func testAPanBeginsOnlyWhenTheFirstTravelWentSideways() throws {
        presenter.offer(toast())
        let view = try shown()
        let pan = StubPan()
        view.addGestureRecognizer(pan)
        pan.travel = CGPoint(x: 11, y: 3)
        XCTAssertTrue(presenter.gestureRecognizerShouldBegin(pan))
        pan.travel = CGPoint(x: 3, y: 11)
        XCTAssertFalse(presenter.gestureRecognizerShouldBegin(pan))
    }

    func testTheToastFollowsTheFingerAndHoldsItsTimerWhileDragged() throws {
        presenter.offer(toast())
        let view = try shown()
        let timer = try XCTUnwrap(timers.live.first)
        _ = drag(view, to: 46, end: false)
        XCTAssertEqual(view.transform.tx, 46)
        XCTAssertEqual(view.transform.ty, 0)
        XCTAssertTrue(timer.cancelled)
        XCTAssertTrue(timers.live.isEmpty)
    }

    func testLetGoShortOfAQuarterItSettlesBackAndTheTimerStartsAgain() async throws {
        presenter.offer(toast())
        let view = try shown()
        _ = drag(view, to: 40, speed: -200)
        try await eventually("it is back") { view.transform.tx == 0 && !self.timers.live.isEmpty }
        XCTAssertTrue(presenter.current === view)
        XCTAssertEqual(timers.live.map(\.delay), [4])
    }

    func testLetGoPastAQuarterItFliesAwayAndItsUndoGoesWithIt() async throws {
        presenter.offer(toast())
        let view = try shown()
        _ = drag(view, to: view.bounds.width * 0.4)
        XCTAssertNil(presenter.current)
        try await eventually("it is gone") { view.superview == nil }
        XCTAssertEqual(undone, [])
    }

    func testAFlickInTheDirectionOfTheDragTakesItAway() async throws {
        presenter.offer(toast())
        let view = try shown()
        _ = drag(view, to: -12, speed: -900)
        XCTAssertNil(presenter.current)
        try await eventually("it is gone") { view.superview == nil }
    }
}
