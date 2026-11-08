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
    var hides: [() -> Void] = []
    var appeared: [Tab] = []
    var asked: [(op: Op, args: [String: JSONValue])] = []
    var answers: [Op: JSONValue] = [:]
    var writes: [WriteIntent] = []
    var opened: [String] = []
    var trashes: [(id: String, leave: @MainActor () -> Void)] = []

    var actions: EditorActions {
        var actions = EditorActions(
            show: { [unowned self] id, _ in shown.append(id) },
            setMode: { [unowned self] in modes.append($0) },
            appeared: { [unowned self] in appeared.append($0) })
        actions.page = { [unowned self] op, args, done in
            asked.append((op, args))
            done(.ok(answers[op] ?? .object([:])))
        }
        actions.ask = { [unowned self] in writes.append($0) }
        actions.write = { [unowned self] in writes.append($0) }
        actions.open = { [unowned self] id, _ in opened.append(id) }
        actions.trash = { [unowned self] id, leave in trashes.append((id, leave)) }
        return actions
    }

    func ops(_ op: Op) -> [[String: JSONValue]] { asked.filter { $0.op == op }.map(\.args) }
}

/// Takes first responder without raising the system keyboard, so a test posts the keyboard's frames itself.
final class QuietResponder: UIView {
    override var canBecomeFirstResponder: Bool { true }
}

/// A back swipe the test holds part way and then lets go or turns back, as a finger would.
@MainActor
final class HeldPop: NSObject, UINavigationControllerDelegate, UIViewControllerAnimatedTransitioning {
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
        KeyboardTracker.latest = nil
    }

    /// Posts the system's keyboard frame change: a keyboard `height` tall at the window's foot, or gone off it.
    private func postKeyboard(covering height: CGFloat) throws {
        let window = try XCTUnwrap(window)
        let shown = height > 0 ? height : 336
        let frame = CGRect(
            x: 0, y: window.bounds.height - (height > 0 ? height : 0), width: window.bounds.width, height: shown)
        NotificationCenter.default.post(
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil,
            userInfo: [
                UIResponder.keyboardFrameEndUserInfoKey: NSValue(
                    cgRect: window.convert(frame, to: window.screen.coordinateSpace)),
                UIResponder.keyboardAnimationDurationUserInfoKey: NSNumber(value: 0.25),
                UIResponder.keyboardAnimationCurveUserInfoKey: NSNumber(value: 7),
            ])
        settle()
    }

    /// Lets queued appearance, layout and the system's push or pop run to their end.
    private func settle(_ seconds: TimeInterval = 0.05) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// Runs the run loop until the condition holds or the timeout passes, for timers that fire after the transition.
    private func settle(
        until condition: () -> Bool, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            settle(0.02)
        }
        if !condition() { XCTFail("waited \(timeout) s and the condition never held", file: file, line: line) }
    }

    /// Runs the run loop until the navigation controller's push or pop, interactive or not, has finished.
    /// A slow runner stretches the animation, so this waits on the transition itself, not a fixed delay.
    private func settleTransition(
        _ nav: UINavigationController? = nil, timeout: TimeInterval = 30, file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let nav = nav ?? navigation!
        settle()
        var finished = nav.transitionCoordinator == nil
        nav.transitionCoordinator?.animate(alongsideTransition: nil) { _ in finished = true }
        let deadline = Date().addingTimeInterval(timeout)
        while !finished, Date() < deadline {
            settle(0.02)
        }
        if !finished { XCTFail("waited \(timeout) s and the transition never finished", file: file, line: line) }
        settle()
    }

    /// Runs the run loop until a tab switch has ended: the shown tab's stack is in the window and the
    /// one left has gone from it. iOS 26.5 can finish the switch, and so the lists' `viewDidAppear`, turns later.
    private func settleTabSwitch(
        _ tabs: DevotTabBarController, from: Tab, to: Tab, file: StaticString = #filePath, line: UInt = #line
    ) {
        settle(
            until: {
                tabs.navigations[to]?.viewIfLoaded?.window != nil && tabs.navigations[from]?.viewIfLoaded?.window == nil
                    && tabs.transitionCoordinator == nil
            }, file: file, line: line)
        settle()
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
        settleTransition()
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
        settleTransition()
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
        settleTransition()
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
        settleTransition()
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
        settleTransition()
        settle(until: { list.snapshot == nil })
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
        settleTransition()
        XCTAssertTrue(webView.isDescendant(of: one.view))
        let still = try XCTUnwrap(one.snapshot, "the revealed note keeps its still until the page has drawn it")
        XCTAssertTrue(one.webContainer.subviews.last === still)
        XCTAssertFalse(one.cover.waiting, "no blank cover over a note the still already shows")
        XCTAssertEqual(page.shown, [first, second, first])
        XCTAssertTrue(page.hides.isEmpty)
        XCTAssertEqual(webView.leftWindow, 0)

        one.ready(second)
        XCTAssertNotNil(one.snapshot, "another note's paint")
        one.ready(first)
        XCTAssertNil(one.snapshot)
        settle(0.5)
        XCTAssertNil(still.superview)
    }

    func testARevealedNotesStillGoesAnywayWhenThePageIsSlow() throws {
        let one = editor(first, coverTimeout: 0.2)
        push(one)
        one.ready(first)
        push(editor(second, title: "Second"))
        navigation.popViewController(animated: true)
        settleTransition()
        settle(until: { one.snapshot == nil })
        XCTAssertNil(one.snapshot)
        XCTAssertTrue(webView.isDescendant(of: one.view))
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
        screen.showNote(facts(first))
        screen.showInfo()
        XCTAssertEqual(page.ops(.noteInfo).first?["noteId"], .string(first))
        settle(until: { screen.presentedViewController is ContentSheetController })
        XCTAssertEqual(screen.navigationItem.backButtonDisplayMode, .minimal)
    }

    private func facts(_ id: String, pinned: Bool = false, status: String = "none") -> EditorNote {
        EditorNote(id: id, bookId: nil, status: status, pinned: pinned, tagIds: [], createdAt: 1, updatedAt: 2)
    }

    func testTheBarsCarryMoreModeAndInfoAndTheToolbarBackForwardFindAndAI() throws {
        let screen = editor(first)
        push(screen)
        XCTAssertEqual(screen.navigationItem.rightBarButtonItems, [screen.moreItem, screen.modeItem, screen.infoItem])
        XCTAssertEqual(screen.moreItem.accessibilityLabel, L10n.noteMore())
        XCTAssertFalse(navigation.isToolbarHidden)
        let items = try XCTUnwrap(screen.toolbarItems)
        XCTAssertEqual(items.count, 5)
        XCTAssertEqual(
            Array(items.prefix(3)), [screen.backItem, screen.forwardItem, screen.findItem],
            "Back, Forward and Find stand together, so the system draws them on one glass")
        XCTAssertFalse([screen.backItem, screen.forwardItem, screen.findItem, screen.aiItem].contains(items[3]))
        XCTAssertEqual(items[4], screen.aiItem, "a flexible space sets AI apart on its own glass")
        XCTAssertFalse(screen.forwardItem.isEnabled)
        screen.showMode(.preview)
        XCTAssertTrue(screen.aiItem.isHidden)
        screen.showMode(.edit)
        XCTAssertFalse(screen.aiItem.isHidden)
    }

    func testTheMoreMenuNamesEachActionAndTicksTheNotesStatus() throws {
        let screen = editor(first)
        push(screen)
        XCTAssertTrue(screen.moreMenu().isEmpty, "no menu before the page has said what the note is")
        screen.showNote(facts(first, pinned: true, status: "active"))
        let titles = screen.moreMenu().compactMap { $0 as? UIMenu }.flatMap(\.children).map(\.title)
        XCTAssertEqual(
            titles,
            [
                L10n.noteUnpin(), L10n.phoneStatus(), L10n.noteMenuMove(), L10n.phoneNoteTags(), L10n.phoneActionShare(),
                L10n.phoneNoteFind(), L10n.noteMenuDuplicate(), L10n.noteMoveToTrash(),
            ])
        let statuses = try XCTUnwrap(
            screen.moreMenu().compactMap { $0 as? UIMenu }.flatMap(\.children).compactMap { $0 as? UIMenu }.first)
        XCTAssertEqual(statuses.children.compactMap { ($0 as? UIAction)?.state == .on ? $0.title : nil }, [NoteStatus.active.name])
        XCTAssertTrue(page.writes.isEmpty, "a menu writes nothing until an item is chosen")
    }

    func testForwardOpensTheNotePoppedLastOffTheScreen() {
        let one = editor(first)
        push(one)
        push(editor(second, title: "Second"))
        navigation.popViewController(animated: true)
        settleTransition()
        XCTAssertTrue(one.forwardItem.isEnabled)
        XCTAssertEqual(one.forward?.id, second)
    }

    func testFindSwapsInItsBarAndShowsTheCountOfTheLatestQuery() {
        let screen = editor(first)
        push(screen)
        page.answers[.editorFind] = .object(["total": .number(3), "current": .number(1), "capped": .bool(false)])
        screen.startFind()
        XCTAssertTrue(screen.finding)
        XCTAssertEqual(screen.findBar.alpha, 1)
        XCTAssertEqual(screen.formattingBar.alpha, 0)
        XCTAssertTrue(navigation.isToolbarHidden)
        screen.findBar.field.text = "cat"
        screen.findBar.field.sendActions(for: .editingChanged)
        XCTAssertEqual(page.ops(.editorFind).last, ["action": .string("search"), "query": .string("cat")])
        XCTAssertEqual(screen.findBar.count.text, L10n.phoneFindCount(current: "1", total: "3"))
        screen.closeFind()
        XCTAssertEqual(page.ops(.editorFind).last, ["action": .string("close")])
        XCTAssertEqual(screen.findBar.alpha, 0)
    }

    func testTheToolbarHidesInsideTheKeyboardsOwnAnimationAndThePageGetsTheInsetsAtOnce() throws {
        let screen = editor(first)
        push(screen)
        var animations: [(TimeInterval, UIView.AnimationOptions)] = []
        var hiddenInside: Bool?
        screen.keyboard.animate = { [unowned self] duration, options, changes in
            animations.append((duration, options))
            changes()
            hiddenInside = navigation.isToolbarHidden
        }
        let responder = QuietResponder()
        webView.addSubview(responder)
        XCTAssertTrue(responder.becomeFirstResponder())
        let window = try XCTUnwrap(screen.view.window)
        let height: CGFloat = 336
        let frame = CGRect(x: 0, y: window.bounds.height - height, width: window.bounds.width, height: height)
        let screenFrame = window.convert(frame, to: window.screen.coordinateSpace)
        screen.keyboard.keyboardWillChange([
            UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: screenFrame),
            UIResponder.keyboardAnimationDurationUserInfoKey: NSNumber(value: 0.25),
            UIResponder.keyboardAnimationCurveUserInfoKey: NSNumber(value: 7),
        ])
        XCTAssertEqual(animations.count, 1)
        XCTAssertEqual(animations.first?.0, 0.25)
        XCTAssertEqual(animations.first?.1, UIView.AnimationOptions(rawValue: 7 << 16))
        XCTAssertEqual(hiddenInside, true)
        XCTAssertEqual(screen.formattingBar.alpha, 1)
        let insets = try XCTUnwrap(page.ops(.editorInsets).last)
        let bottom = height + Tokens.Size.phoneTarget + Tokens.Size.phoneSheetInset
        XCTAssertEqual(insets["bottom"], .number(Double(bottom)))
        XCTAssertEqual(insets["duration"], .number(0.25))
        XCTAssertEqual(insets["curve"], .number(7))
        XCTAssertEqual(webView.scrollView.contentInset.bottom, bottom)
        XCTAssertEqual(webView.scrollView.keyboardDismissMode, .interactive)
        XCTAssertTrue(screen.contentScrollView(for: .top) === webView.scrollView)
    }

    func testAKeyboardRaisedForASheetOverTheNoteLeavesTheBarsAndTheInsets() throws {
        let screen = editor(first)
        push(screen)
        let sheet = UIViewController()
        let field = QuietResponder()
        sheet.view.addSubview(field)
        screen.present(sheet, animated: false)
        settle(until: { screen.presentedViewController === sheet && !sheet.isBeingPresented })
        XCTAssertTrue(field.becomeFirstResponder())
        let sent = page.ops(.editorInsets).count
        try postKeyboard(covering: 336)
        XCTAssertFalse(screen.keyboardUp)
        XCTAssertFalse(navigation.isToolbarHidden)
        XCTAssertEqual(screen.formattingBar.alpha, 0)
        XCTAssertEqual(page.ops(.editorInsets).count, sent, "the page's foot stays as it was")
        XCTAssertEqual(webView.scrollView.contentInset.bottom, 0)
        field.resignFirstResponder()
        sheet.dismiss(animated: false)
    }

    func testANoteShownAgainTakesTheKeyboardAsItIsNowNotAsItWasWhenCovered() throws {
        let one = editor(first)
        push(one)
        let responder = QuietResponder()
        webView.addSubview(responder)
        XCTAssertTrue(responder.becomeFirstResponder())
        try postKeyboard(covering: 336)
        XCTAssertTrue(one.keyboardUp)
        XCTAssertTrue(navigation.isToolbarHidden)
        push(editor(second, title: "Second"))
        responder.resignFirstResponder()
        try postKeyboard(covering: 0)
        navigation.popViewController(animated: true)
        settleTransition()
        XCTAssertTrue(host.holder === one)
        XCTAssertFalse(one.keyboardUp)
        XCTAssertFalse(navigation.isToolbarHidden)
        XCTAssertEqual(one.formattingBar.alpha, 0)
        XCTAssertEqual(webView.scrollView.contentInset.bottom, 0)
        XCTAssertEqual(page.ops(.editorInsets).last?["bottom"], .number(0))
    }

    func testTheFindBarKeepsItsRoomAtTheFootWhileTheKeyboardIsDown() {
        let screen = editor(first)
        push(screen)
        let sent = page.ops(.editorInsets).count
        screen.startFind()
        let bar = Tokens.Size.phoneTarget + Tokens.Size.phoneSheetInset
        XCTAssertEqual(page.ops(.editorInsets).dropFirst(sent).first?["bottom"], .number(Double(bar)))
        screen.closeFind()
        settle()
        XCTAssertEqual(page.ops(.editorInsets).last?["bottom"], .number(0))
        XCTAssertEqual(webView.scrollView.contentInset.bottom, 0)
    }

    func testMoveToTrashLeavesTheNoteOnlyOnceItIsInTheTrash() throws {
        let screen = editor(first)
        push(screen)
        screen.showNote(facts(first))
        screen.trash()
        XCTAssertEqual(page.trashes.map(\.id), [first])
        settle()
        XCTAssertTrue(navigation.topViewController === screen, "a write still under way, refused or failed leaves the note")
        page.trashes[0].leave()
        settleTransition()
        XCTAssertTrue(navigation.topViewController === list)
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
            for (id, json) in rust.calls.dropFirst(answered) {
                screens.replied(id, try Message.reply(id: id, outcome: .ok(FakeRust.emptyAnswer(json))).json())
            }
            answered = rust.calls.count
        }
        try answerAll()

        screens.delivered(Data(#"{"v":1,"notice":"nav.openNote","noteId":"\#(first)","title":"Plans"}"#.utf8))
        settleTransition(try XCTUnwrap(tabs.selectedViewController as? UINavigationController))
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
        settleTabSwitch(tabs, from: .library, to: .notes)
        XCTAssertTrue(webView.superview === screens.root.host.stage)
        XCTAssertTrue(try requests().contains(.editorHide))
        try answerAll()
        tabs.select(.library)
        settleTabSwitch(tabs, from: .notes, to: .library)
        XCTAssertTrue(webView.isDescendant(of: screen.view))
        XCTAssertEqual(try requests().filter { $0 == .editorShow }.count, 2)

        screens.delivered(Data(#"{"v":1,"notice":"nav.back"}"#.utf8))
        settleTransition(navigation)
        XCTAssertTrue(navigation.topViewController === tabs.listRoots[.library])
        XCTAssertTrue(webView.superview === screens.root.host.stage)
        XCTAssertEqual(webView.leftWindow, 0)
        XCTAssertEqual(rust.lines.filter { $0.hasPrefix("W_") }, [])
    }
}
