import UIKit
import WebKit
import XCTest

@testable import DevotScreens

private let first = "01970000-0000-7000-8000-000000000001"
private let second = "01970000-0000-7000-8000-000000000002"

/// Stands in for the page: what each screen asked of it.
@MainActor
private final class FakePage {
    var shown: [String] = []
    var modes: [NoteMode] = []
    var infos = 0
    var hides: [() -> Void] = []
    var appeared: [Tab] = []

    var actions: EditorActions {
        EditorActions(
            show: { [unowned self] in shown.append($0) },
            setMode: { [unowned self] in modes.append($0) },
            info: { [unowned self] in infos += 1 },
            appeared: { [unowned self] in appeared.append($0) })
    }
}

/// A back swipe the test holds part way and then lets go or turns back, as a finger would.
@MainActor
private final class HeldPop: NSObject, UINavigationControllerDelegate, UIViewControllerAnimatedTransitioning {
    let interaction = UIPercentDrivenInteractiveTransition()

    func navigationController(
        _ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
        from fromVC: UIViewController, to toVC: UIViewController
    ) -> (any UIViewControllerAnimatedTransitioning)? {
        operation == .pop ? self : nil
    }

    func navigationController(
        _ navigationController: UINavigationController,
        interactionControllerFor animationController: any UIViewControllerAnimatedTransitioning
    ) -> (any UIViewControllerInteractiveTransitioning)? {
        animationController === self ? interaction : nil
    }

    func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval { 0.3 }

    func animateTransition(using context: any UIViewControllerContextTransitioning) {
        guard let from = context.view(forKey: .from), let to = context.view(forKey: .to),
            let revealed = context.viewController(forKey: .to)
        else { return }
        to.frame = context.finalFrame(for: revealed)
        context.containerView.insertSubview(to, belowSubview: from)
        UIView.animate(withDuration: 0.3) {
            from.transform = CGAffineTransform(translationX: from.bounds.width, y: 0)
        } completion: { _ in
            from.transform = .identity
            context.completeTransition(!context.transitionWasCancelled)
        }
    }
}

@MainActor
final class EditorScreenTests: XCTestCase {
    private var window: UIWindow?
    private var page: FakePage!
    private var webView: RecordingWebView!
    private var host: WebViewHost!
    private var list: WebTabScreen!
    private var navigation: UINavigationController!

    override func setUp() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        self.window = window
        page = FakePage()
        webView = RecordingWebView(frame: window.bounds)
        host = WebViewHost(webView: webView)
        host.windowSize(window.bounds.size)
        window.addSubview(host.stage)
        host.stage.addSubview(webView)
        list = WebTabScreen(tab: .notes, host: host) { _ in }
        list.hideEditor = { [unowned self] done in page.hides.append(done) }
        list.hideTimeout = 10
        navigation = UINavigationController(rootViewController: list)
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        settle()
        webView.resized = 0
        webView.leftWindow = 0
        webView.movesAnimated = []
        page.hides = []
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    /// Lets queued appearance, layout and the system's push or pop run to their end.
    private func settle(_ seconds: TimeInterval = 0.05) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func editor(_ noteId: String, title: String = "Plans", coverTimeout: TimeInterval = 10)
        -> EditorScreen
    {
        EditorScreen(
            noteId: noteId, title: title, tab: .notes, host: host, actions: page.actions,
            coverTimeout: coverTimeout)
    }

    private func push(_ screen: EditorScreen) {
        navigation.pushViewController(screen, animated: true)
        settle(1)
    }

    func testAPushMovesTheWebViewIntoTheEditorWithoutLeavingTheWindowOrResizing() throws {
        XCTAssertTrue(webView.superview === list.view)
        let screen = editor(first)
        push(screen)
        XCTAssertTrue(webView.isDescendant(of: screen.view))
        XCTAssertTrue(host.holder === screen)
        XCTAssertEqual(webView.bounds.size, window?.bounds.size)
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(webView.resized, 0)
        XCTAssertTrue(webView.superview === screen.webContainer)
        XCTAssertEqual(page.shown, [first])
        XCTAssertNotNil(list.snapshot, "the list under the slide is a still")
        XCTAssertTrue(screen.hidesBottomBarWhenPushed)
        XCTAssertFalse(try XCTUnwrap(navigation.interactiveContentPopGestureRecognizer).isEnabled)
        XCTAssertFalse(navigation.isNavigationBarHidden)
        XCTAssertEqual(list.navigationItem.backButtonDisplayMode, .minimal)
    }

    func testTheCoverStaysUntilThePageHasPaintedTheNote() {
        let screen = editor(first)
        push(screen)
        XCTAssertTrue(screen.cover.waiting)
        screen.ready(second)
        XCTAssertTrue(screen.cover.waiting, "another note's paint")
        screen.ready(first)
        XCTAssertFalse(screen.cover.waiting)
        settle(0.4)
        XCTAssertTrue(screen.cover.isHidden)
    }

    func testTheCoverFadesAnywayWhenThePageIsSlow() {
        let screen = editor(first, coverTimeout: 0.2)
        push(screen)
        XCTAssertFalse(screen.cover.waiting)
        settle(0.4)
        XCTAssertTrue(screen.cover.isHidden)
    }

    /// Starts a back swipe and holds it half way.
    private func holdBackSwipe() -> HeldPop {
        let swipe = HeldPop()
        navigation.delegate = swipe
        navigation.popViewController(animated: true)
        settle()
        swipe.interaction.update(0.5)
        settle()
        return swipe
    }

    func testACancelledBackSwipeLeavesTheWebViewAndTheKeyboardWithTheNote() throws {
        let screen = editor(first)
        push(screen)
        let field = UITextField(frame: CGRect(x: 0, y: 100, width: 200, height: 44))
        webView.addSubview(field)
        XCTAssertTrue(field.becomeFirstResponder())
        webView.movesAnimated = []

        let swipe = holdBackSwipe()
        XCTAssertTrue(webView.isDescendant(of: screen.view), "the live note slides under the finger")
        swipe.interaction.cancel()
        settle(1)
        XCTAssertTrue(navigation.topViewController === screen)
        XCTAssertTrue(webView.isDescendant(of: screen.view))
        XCTAssertTrue(field.isFirstResponder)
        XCTAssertEqual(webView.movesAnimated, [])
        XCTAssertTrue(page.hides.isEmpty)
        XCTAssertEqual(webView.leftWindow, 0)
    }

    func testACompletedPopReturnsTheWebViewWithoutAnimation() throws {
        let screen = editor(first)
        push(screen)
        webView.movesAnimated = []
        let swipe = holdBackSwipe()
        XCTAssertTrue(webView.isDescendant(of: screen.view), "the live note slides out")
        swipe.interaction.finish()
        settle(1)
        XCTAssertTrue(webView.superview === list.view)
        XCTAssertEqual(webView.movesAnimated, [false])
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(webView.resized, 0)

        let still = try XCTUnwrap(list.snapshot)
        XCTAssertTrue(list.view.subviews.last === still, "the list's still covers the page until it repaints")
        XCTAssertEqual(page.hides.count, 1)
        page.hides[0]()
        XCTAssertNil(list.snapshot)
        XCTAssertNil(still.superview)
    }

    func testTheSystemPopKeepsTheNoteInTheLeavingScreenUntilItEnds() throws {
        let screen = editor(first)
        push(screen)
        navigation.popViewController(animated: true)
        settle(0.02)
        XCTAssertTrue(webView.isDescendant(of: screen.view))
        settle(1)
        XCTAssertTrue(webView.superview === list.view)
        XCTAssertTrue(host.holder === list)
        XCTAssertTrue(navigation.isNavigationBarHidden)
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(page.hides.count, 1)
    }

    func testTheSnapshotIsDroppedWhenThePageDoesNotAnswer() throws {
        list.hideTimeout = 0.1
        push(editor(first))
        navigation.popViewController(animated: true)
        settle(1)
        XCTAssertNil(list.snapshot)
    }

    func testALinkLeavesAStillInTheFirstEditorAndShowsItAgainOnBack() throws {
        let one = editor(first)
        push(one)
        one.ready(first)
        let two = editor(second, title: "Second")
        push(two)
        XCTAssertTrue(webView.isDescendant(of: two.view))
        XCTAssertTrue(webView.superview === two.webContainer)
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertNotNil(one.snapshot)
        XCTAssertEqual(page.shown, [first, second])

        navigation.popViewController(animated: true)
        settle(1)
        XCTAssertTrue(webView.isDescendant(of: one.view))
        XCTAssertNil(one.snapshot)
        XCTAssertTrue(one.cover.waiting, "the revealed note is shown again under its cover")
        XCTAssertEqual(page.shown, [first, second, first])
        XCTAssertTrue(page.hides.isEmpty)
        XCTAssertEqual(webView.leftWindow, 0)
    }

    func testTheBarAsksThePageForTheOtherModeAndForInfo() {
        let screen = editor(first)
        push(screen)
        screen.showMode(.edit)
        XCTAssertEqual(screen.modeItem.accessibilityLabel, L10n.phoneNotePreview())
        screen.toggleMode()
        screen.showMode(.preview)
        XCTAssertEqual(screen.modeItem.accessibilityLabel, L10n.phoneNoteEdit())
        screen.toggleMode()
        XCTAssertEqual(page.modes, [.preview, .edit])
        screen.showInfo()
        XCTAssertEqual(page.infos, 1)
        XCTAssertEqual(screen.navigationItem.backButtonDisplayMode, .minimal)
    }

    func testTheBarTakesTheTitleOnceTheNotesOwnIsUnderIt() {
        let screen = editor(first)
        push(screen)
        XCTAssertNil(screen.navigationItem.title)
        screen.titleVisible(false)
        XCTAssertEqual(screen.navigationItem.title, "Plans")
        screen.retitle("Trip")
        XCTAssertEqual(screen.navigationItem.title, "Trip")
        XCTAssertEqual(screen.cover.title, "Trip")
        screen.titleVisible(true)
        XCTAssertNil(screen.navigationItem.title)
    }

    func testScreensPushTheNoteThePageOpensAndFollowItAcrossTabs() throws {
        window?.isHidden = true
        let tao = UIViewController()
        let webView = RecordingWebView()
        tao.view.addSubview(webView)
        let rust = FakeRust()
        let screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: tao, rust: rust, defaults: try freshDefaults()))
        let window = try XCTUnwrap(self.window)
        window.rootViewController = tao
        window.isHidden = false
        webView.frame = window.bounds
        tao.view.layoutIfNeeded()
        settle()
        let tabs = screens.root.tabs
        let requests = { try rust.calls.compactMap { call -> Op? in
            guard case .request(_, let op, _) = try Message(json: call.1) else { return nil }
            return op
        } }
        var answered = 0
        let answerAll = {
            for (id, _) in rust.calls.dropFirst(answered) {
                screens.replied(id, try Message.reply(id: id, outcome: .ok(.object([:]))).json())
            }
            answered = rust.calls.count
        }
        try answerAll()

        screens.delivered(Data(#"{"v":1,"notice":"nav.openNote","noteId":"\#(first)","title":"Plans"}"#.utf8))
        settle(1)
        let navigation = try XCTUnwrap(tabs.selectedViewController as? UINavigationController)
        let screen = try XCTUnwrap(navigation.topViewController as? EditorScreen)
        XCTAssertEqual(screen.noteId, first)
        XCTAssertTrue(webView.isDescendant(of: screen.view))
        XCTAssertEqual(try requests().last, .editorShow)
        screens.delivered(Data(#"{"v":1,"notice":"editor.ready","noteId":"\#(first)"}"#.utf8))
        XCTAssertFalse(screen.cover.waiting)
        screens.delivered(Data(#"{"v":1,"notice":"editor.mode","noteId":"\#(first)","mode":"preview"}"#.utf8))
        XCTAssertEqual(screen.modeItem.accessibilityLabel, L10n.phoneNoteEdit())
        screens.delivered(Data(#"{"v":1,"notice":"editor.title","id":"\#(first)","title":"Trip"}"#.utf8))
        screens.delivered(Data(#"{"v":1,"notice":"editor.scroll","titleVisible":false}"#.utf8))
        XCTAssertEqual(screen.navigationItem.title, "Trip")
        try answerAll()

        tabs.select(.notes)
        settle()
        XCTAssertTrue(webView.superview === tabs.screen(.notes)?.view)
        XCTAssertTrue(try requests().contains(.editorHide))
        try answerAll()
        tabs.select(.library)
        settle()
        XCTAssertTrue(webView.isDescendant(of: screen.view))
        XCTAssertEqual(try requests().filter { $0 == .editorShow }.count, 2)

        screens.delivered(Data(#"{"v":1,"notice":"nav.back"}"#.utf8))
        settle(1)
        XCTAssertTrue(navigation.topViewController === tabs.screen(.library))
        XCTAssertTrue(webView.superview === tabs.screen(.library)?.view)
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(rust.lines.filter { $0.hasPrefix("W_") }, [])
    }
}
