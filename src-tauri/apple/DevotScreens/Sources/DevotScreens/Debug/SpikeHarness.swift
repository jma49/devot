#if DEBUG
import GameController
import OSLog
import QuartzCore
import UIKit
import WebKit

struct SpikeError: Error {
    let code: String
}

/// Runs the spike that `-DevotSpike` names (docs/specs/iphone-screens.md, Spikes) and writes its
/// report to Documents/spikes/<spike>.json. It reaches the page's probes
/// (src/renderer/src/phone/screens/spikes.ts) with `callAsyncJavaScript`, a way into the page that
/// only a debug build has; the bridge spike times the bridge itself.
@MainActor
final class SpikeHarness {
    private static var running: SpikeHarness?
    private static let log = Logger(subsystem: "io.github.jma49.devot", category: "spikes")

    private let spike: Spike
    private let screens: Screens
    private let webView: WKWebView
    private let keyboard = KeyboardWatch()

    private init(spike: Spike, screens: Screens, webView: WKWebView) {
        self.spike = spike
        self.screens = screens
        self.webView = webView
    }

    static func startIfAsked(screens: Screens, webView: AnyObject, defaults: UserDefaults) {
        switch Spike.asked(in: defaults) {
        case .notAsked:
            return
        case .unknown:
            log.error("E_SPIKE_UNKNOWN")
        case .asked(let spike):
            guard let webView = webView as? WKWebView else { return }
            let harness = SpikeHarness(spike: spike, screens: screens, webView: webView)
            running = harness
            Task { await harness.run() }
        }
    }

    /// Note IDs of the shape Rust accepts that no note has.
    nonisolated static func syntheticNoteIDs(_ count: Int) -> [String] {
        (0..<count).map { String(format: "0192f000-0000-7000-8000-%012lx", $0) }
    }

    private func run() async {
        let startedAt = Date()
        let name = spike.rawValue
        let file = URL.documentsDirectory.appending(path: "spikes/\(name).json")
        try? FileManager.default.removeItem(at: file)
        Self.log.info("I_SPIKE_START spike=\(name, privacy: .public)")
        let results: any SpikeResults
        do {
            try await waitForPage()
            switch spike {
            case .reparenting: results = try await reparent()
            case .keyboard: results = try await keyboardAfterNativeTap()
            case .bridge: results = try await bridge()
            case .scroller: results = try await scroller()
            case .barTint: results = await barTint()
            }
        } catch let error as SpikeError {
            results = FailedRun(code: error.code)
        } catch {
            results = FailedRun(code: "E_SPIKE_PAGE_FAILED")
        }
        let report = SpikeReport(
            spike: spike, environment: .current, startedAt: startedAt, results: results)
        do {
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try report.json().write(to: file, options: .atomic)
            let pass = results.pass.map { String($0) } ?? "null"
            Self.log.info("I_SPIKE_DONE spike=\(name, privacy: .public) pass=\(pass, privacy: .public)")
        } catch {
            Self.log.error("E_SPIKE_WRITE_FAILED spike=\(name, privacy: .public)")
        }
    }

    // MARK: The page

    private struct Empty: Decodable {}
    private struct Ready: Decodable { let ready: Bool }

    private func page<Answer: Decodable>(_ name: String, _ args: [String: Double] = [:]) async throws
        -> Answer
    {
        let encoded = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
        let answer = try await webView.callAsyncJavaScript(
            "return JSON.stringify(await window.__devotSpikes.call(name, JSON.parse(args)))",
            arguments: ["name": name, "args": encoded], in: nil, contentWorld: .page)
        guard let text = answer as? String else { throw SpikeError(code: "E_SPIKE_PAGE_ANSWER") }
        return try JSONDecoder().decode(Answer.self, from: Data(text.utf8))
    }

    private func send(_ name: String, _ args: [String: Double] = [:]) async throws {
        let _: Empty = try await page(name, args)
    }

    /// Until the page has its probes and its core, and answers the bridge.
    private func waitForPage() async throws {
        for _ in 0..<240 {
            if webView.window != nil, let answer: Ready = try? await page("ready"), answer.ready,
                case .ok = await ask(.ping).outcome
            {
                return
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw SpikeError(code: "E_SPIKE_PAGE_TIMEOUT")
    }

    /// One request over the bridge, timed from the send to the reply on the main thread.
    private func ask(_ op: Op, _ args: [String: JSONValue] = [:]) async -> (outcome: Outcome, ms: Double) {
        let start = CACurrentMediaTime()
        let outcome = await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
            let answer = Answer(continuation)
            let timeout = Task {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                answer.resume(.failed("E_SPIKE_TIMEOUT"))
            }
            screens.request(op, args) { outcome in
                timeout.cancel()
                answer.resume(outcome)
            }
        }
        return (outcome, (CACurrentMediaTime() - start) * 1000)
    }

    // MARK: Moving the web view

    private struct Home {
        let view: UIView
        let index: Int
        let frame: CGRect
        let mask: UIView.AutoresizingMask
    }

    private func home() throws -> Home {
        guard let view = webView.superview, let index = view.subviews.firstIndex(of: webView) else {
            throw SpikeError(code: "E_SPIKE_NO_SUPERVIEW")
        }
        return Home(view: view, index: index, frame: webView.frame, mask: webView.autoresizingMask)
    }

    /// With `addSubview` alone, so the web view's window is never nil, and at the size it had.
    private func move(into container: UIView) {
        let size = webView.bounds.size
        container.addSubview(webView)
        webView.frame = CGRect(origin: .zero, size: size)
    }

    private func moveHome(_ home: Home) {
        home.view.insertSubview(webView, at: min(home.index, home.view.subviews.count))
        webView.frame = home.frame
        webView.autoresizingMask = home.mask
    }

    private func showChild(_ screen: UIViewController) {
        let parent = screens.root
        parent.addChild(screen)
        screen.view.frame = parent.view.bounds
        screen.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        parent.view.addSubview(screen.view)
        screen.didMove(toParent: parent)
    }

    private func removeChild(_ screen: UIViewController) {
        screen.willMove(toParent: nil)
        screen.view.removeFromSuperview()
        screen.removeFromParent()
    }

    /// Over the full screen, so tao's view, and the web view's window with it, stay where they are.
    private func present(_ controller: UIViewController) async {
        controller.modalPresentationStyle = .overFullScreen
        let presenter = screens.root.parent ?? screens.root
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            presenter.present(controller, animated: false) { continuation.resume() }
        }
    }

    // MARK: S1

    private func reparent() async throws -> ReparentingResults {
        let home = try home()
        let size = webView.bounds.size
        let screen = SpikeScreen()
        showChild(screen)
        defer {
            moveHome(home)
            removeChild(screen)
        }
        try await send("s1Start", ["intervalMs": 100])
        var sizeChanges = 0
        func settle(_ view: UIView) async throws {
            view.layoutIfNeeded()
            if webView.bounds.size != size { sizeChanges += 1 }
            try await Task.sleep(for: .milliseconds(50))
            if webView.bounds.size != size { sizeChanges += 1 }
        }
        let moves = 200
        for _ in 0..<moves {
            move(into: screen.view)
            try await settle(screen.view)
            moveHome(home)
            try await settle(home.view)
        }
        let watch: PageWatch = try await page("s1Stop")
        try await send("cleanup")
        return ReparentingResults(moves: moves, sizeChanges: sizeChanges, page: watch)
    }

    // MARK: S2

    /// The first device runs left the keyboard down with the field first responder, so this run also
    /// records UIKit's state at each step and, if the keyboard stays down, makes the window key
    /// (tao's scene-less window may join its scene without becoming its key window) and asks again.
    private func keyboardAfterNativeTap() async throws -> KeyboardResults {
        let home = try home()
        let screen = SpikeScreen()
        let field = screen.field
        keyboard.start(field: field)
        defer {
            webView.endEditing(true)
            _ = field.resignFirstResponder()
            keyboard.stop()
            moveHome(home)
            removeChild(screen)
        }
        var snapshots = [snapshot("start", field)]
        let activation = await waitUntilActive()
        try await Task.sleep(for: .milliseconds(500))
        snapshots.append(snapshot("active", field))
        try await send("s2Mount")
        let became = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            screen.arriving = { [unowned self] in
                self.move(into: screen.view)
                screen.view.sendSubviewToBack(self.webView)
            }
            screen.appeared = { [unowned self] in
                snapshots.append(self.snapshot("appearing", field))
                let became = field.becomeFirstResponder()
                snapshots.append(self.snapshot("appeared", field))
                continuation.resume(returning: became)
            }
            showChild(screen)
        }
        await nextTurn()
        snapshots.append(snapshot("appearedNextTurn", field))
        let retried = !field.isFirstResponder
        let becameOnRetry = retried ? field.becomeFirstResponder() : nil
        await keyboard.wait(up: true)
        snapshots.append(snapshot("waited", field))
        let nativeField = became && field.isFirstResponder && keyboard.up

        var madeKey = false
        var upAfterMakeKey: Bool?
        var refocused = false
        var becameOnRefocus: Bool?
        if !keyboard.up {
            if let window = field.window, !window.isKeyWindow {
                madeKey = true
                window.makeKey()
                await nextTurn()
                await keyboard.wait(up: true, ms: 1000)
                upAfterMakeKey = keyboard.up
                snapshots.append(snapshot("madeKey", field))
            }
            if !keyboard.up {
                refocused = true
                _ = field.resignFirstResponder()
                await nextTurn()
                becameOnRefocus = field.becomeFirstResponder()
                await keyboard.wait(up: true)
                snapshots.append(snapshot("refocused", field))
            }
        }
        let upForTries = keyboard.up

        let handOff = try await focusTry("handOff", field: field, order: .page, probe: field)
        try await reset(field)
        let handOffThenWebView = try await focusTry(
            "handOffThenWebView", field: field, order: .pageThenWebView, probe: field)
        try await reset(field)
        let webViewThenFocus = try await focusTry(
            "webViewThenFocus", field: field, order: .webViewThenPage, probe: field)
        try await reset(field)
        let caretOnly = try await focusTry("caretOnly", field: nil, order: .page, probe: field)
        try await send("cleanup")
        let diagnostics = KeyboardDiagnostics(
            activationWaitMs: activation.ms, activated: activation.active, fieldBecameFirstResponder: became,
            retriedAfterTransition: retried, fieldBecameOnRetry: becameOnRetry, madeKey: madeKey,
            keyboardUpAfterMakeKey: upAfterMakeKey, refocused: refocused, fieldBecameOnRefocus: becameOnRefocus,
            keyboardUpForTries: upForTries, snapshots: snapshots,
            tries: KeyboardDiagnostics.Tries(
                handOff: handOff.diagnostics, handOffThenWebView: handOffThenWebView.diagnostics,
                webViewThenFocus: webViewThenFocus.diagnostics, caretOnly: caretOnly.diagnostics),
            events: keyboard.events)
        return KeyboardResults(
            nativeField: nativeField, handOff: handOff.result, handOffThenWebView: handOffThenWebView.result,
            webViewThenFocus: webViewThenFocus.result, caretOnly: caretOnly.result, diagnostics: diagnostics)
    }

    private enum FocusOrder {
        case page
        case pageThenWebView
        case webViewThenPage
    }

    private func focusTry(_ name: String, field: UITextField?, order: FocusOrder, probe: UITextField)
        async throws -> (result: KeyboardTry, diagnostics: KeyboardTryDiagnostics)
    {
        var askedField = false
        var fieldBecame: Bool?
        if let field, !field.isFirstResponder {
            askedField = true
            fieldBecame = field.becomeFirstResponder()
            await keyboard.wait(up: true)
        }
        let before = snapshot("\(name).before", probe)
        keyboard.forgetDrops()
        var webViewBecame: Bool?
        if order == .webViewThenPage { webViewBecame = webView.becomeFirstResponder() }
        let upBeforeFocus = keyboard.up
        let _: PageFocus = try await page("s2Focus")
        let afterFocus = snapshot("\(name).afterFocus", probe)
        if order == .pageThenWebView { webViewBecame = webView.becomeFirstResponder() }
        try await Task.sleep(for: .milliseconds(800))
        let state: PageFocus = try await page("s2State")
        let result = KeyboardTry(
            keyboardUp: keyboard.up, keyboardDropped: keyboard.dropped,
            fieldFirstResponder: field?.isFirstResponder ?? false,
            webViewFirstResponder: holdsFirstResponder(webView), page: state)
        let diagnostics = KeyboardTryDiagnostics(
            askedField: askedField, fieldBecame: fieldBecame, webViewBecame: webViewBecame,
            keyboardUpBeforeFocus: upBeforeFocus, before: before, afterFocus: afterFocus,
            end: snapshot("\(name).end", probe))
        return (result, diagnostics)
    }

    /// Until the web view's scene is foreground-active and the app active, for at most 10 s.
    private func waitUntilActive() async -> (ms: Double, active: Bool) {
        let start = CACurrentMediaTime()
        let elapsed = { SpikeStats.rounded((CACurrentMediaTime() - start) * 1000) }
        for _ in 0..<200 {
            if UIApplication.shared.applicationState == .active,
                webView.window?.windowScene?.activationState == .foregroundActive
            {
                return (elapsed(), true)
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return (elapsed(), false)
    }

    /// After the main queue has run what is already queued on it, such as the end of a transition.
    private func nextTurn() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    private func snapshot(_ stage: String, _ field: UITextField) -> KeyboardSnapshot {
        let none = "none"
        let window = field.window ?? webView.window
        let scene = window?.windowScene
        var ancestors: [UIView] = []
        var next = field.superview
        while let view = next {
            ancestors.append(view)
            next = view.superview
        }
        let hit = field.window.flatMap { window in
            window.hitTest(field.convert(CGPoint(x: field.bounds.midX, y: field.bounds.midY), to: window), with: nil)
        }
        FirstResponderProbe.found = nil
        _ = UIApplication.shared.sendAction(
            #selector(UIResponder.devotSpikeCaptureFirstResponder(_:)), to: nil, from: nil, for: nil)
        let keyFirstResponder = FirstResponderProbe.found.map(className)
        FirstResponderProbe.found = nil
        return KeyboardSnapshot(
            stage: stage, atMs: keyboard.elapsedMs(),
            applicationState: Self.name(UIApplication.shared.applicationState),
            sceneActivationState: scene.map { Self.name($0.activationState) } ?? "noScene",
            connectedScenes: UIApplication.shared.connectedScenes.count, sceneWindows: scene?.windows.count ?? 0,
            sceneDelegate: scene?.delegate.map { className($0) } ?? none, windowClass: window.map(className) ?? none,
            windowIsKey: window?.isKeyWindow ?? false, sceneKeyWindow: scene?.keyWindow.map(className) ?? none,
            sceneKeyWindowIsFieldWindow: field.window != nil && scene?.keyWindow === field.window,
            fieldInWindow: field.window != nil, fieldFirstResponder: field.isFirstResponder,
            fieldCanBecomeFirstResponder: field.canBecomeFirstResponder, fieldEnabled: field.isEnabled,
            fieldUserInteractionEnabled: field.isUserInteractionEnabled, fieldAlpha: Double(field.alpha),
            fieldHasInputView: field.inputView != nil, fieldHasInputAccessoryView: field.inputAccessoryView != nil,
            ancestorHidden: ancestors.contains { $0.isHidden },
            ancestorTransparent: ancestors.contains { $0.alpha < 0.01 },
            hitTestView: hit.map(className) ?? none, hardwareKeyboard: GCKeyboard.coalesced != nil,
            firstResponderInWindow: window.flatMap { firstResponder(in: $0) }.map(className) ?? none,
            firstResponderOfKeyWindow: keyFirstResponder ?? none, webViewFirstResponder: holdsFirstResponder(webView),
            contentViewClass: webView.scrollView.subviews.map(className).first { $0.hasPrefix("WKContentView") } ?? none,
            keyboardUp: keyboard.up)
    }

    private func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for subview in view.subviews {
            if let found = firstResponder(in: subview) { return found }
        }
        return nil
    }

    private static func name(_ state: UIApplication.State) -> String {
        switch state {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    private static func name(_ state: UIScene.ActivationState) -> String {
        switch state {
        case .unattached: "unattached"
        case .foregroundActive: "foregroundActive"
        case .foregroundInactive: "foregroundInactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    private func reset(_ field: UITextField) async throws {
        webView.endEditing(true)
        _ = field.resignFirstResponder()
        try await send("s2Blur")
        await keyboard.wait(up: false)
    }

    private func holdsFirstResponder(_ view: UIView) -> Bool {
        view.isFirstResponder || view.subviews.contains { holdsFirstResponder($0) }
    }

    // MARK: S3

    private func bridge() async throws -> BridgeResults {
        var pings: [Double] = []
        var failedPings = 0
        for _ in 0..<1000 {
            let (outcome, ms) = await ask(.ping)
            if case .ok = outcome { pings.append(ms) } else { failedPings += 1 }
        }
        let fps = webView.window?.windowScene?.screen.maximumFramesPerSecond ?? 60
        try await send("s3ScrollStart", ["budgetMs": SpikeStats.rounded(1000 / Double(fps))])
        try await Task.sleep(for: .milliseconds(300))
        var excerpts: [Double] = []
        var failedExcerpts = 0
        var codes = Set<String>()
        let ids = JSONValue.array(Self.syntheticNoteIDs(20).map(JSONValue.string))
        for _ in 0..<60 {
            let (outcome, ms) = await ask(.excerpts, ["ids": ids])
            excerpts.append(ms)
            if case .failed(let code) = outcome {
                failedExcerpts += 1
                codes.insert(code)
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        let scroll: PageFrames = try await page("s3ScrollStop")
        try await send("cleanup")
        return BridgeResults(
            pings: Timings(ms: pings, failed: failedPings),
            excerpts: Timings(ms: excerpts, failed: failedExcerpts), excerptCodes: codes.sorted(),
            scroll: scroll)
    }

    // MARK: S4

    /// Leaves the screen up, with the page's shell hidden, for the screenshots.
    private func scroller() async throws -> ScrollerResults {
        let screen = SpikeScreen()
        screen.navigationItem.title = Spike.scroller.rawValue
        screen.toolbarItems = [UIBarButtonItem(systemItem: .flexibleSpace), UIBarButtonItem(systemItem: .compose)]
        let navigation = UINavigationController(rootViewController: screen)
        navigation.isToolbarHidden = false
        screen.arriving = { [unowned self] in self.move(into: screen.view) }
        await present(navigation)
        let scrollView = webView.scrollView
        screen.setContentScrollView(scrollView, for: .top)
        scrollView.keyboardDismissMode = .interactive
        try await send("s4Mount")
        try await Task.sleep(for: .milliseconds(800))
        let layout: PageLayout = try await page("s4Measure")
        let measure = ScrollViewMeasure(
            contentHeight: Double(scrollView.contentSize.height),
            boundsHeight: Double(scrollView.bounds.height), scrollEnabled: scrollView.isScrollEnabled,
            keyboardDismissInteractive: scrollView.keyboardDismissMode == .interactive,
            edgeEffectSet: screen.contentScrollView(for: .top) === scrollView)
        let insets = scrollView.adjustedContentInset
        let middle = try await probe(at: (scrollView.contentSize.height - scrollView.bounds.height) / 2)
        let end = try await probe(
            at: scrollView.contentSize.height + insets.top + insets.bottom - scrollView.bounds.height)
        return ScrollerResults(scrollView: measure, page: layout, middle: middle, end: end)
    }

    /// `y` and the offset it reports are measured from the top of the content, insets aside.
    private func probe(at y: CGFloat) async throws -> ScrollProbe {
        let scrollView = webView.scrollView
        let top = scrollView.adjustedContentInset.top
        scrollView.setContentOffset(CGPoint(x: 0, y: max(0, y) - top), animated: false)
        try await Task.sleep(for: .milliseconds(400))
        let page: PageScroll = try await page("s4Probe")
        return ScrollProbe(offset: Double(scrollView.contentOffset.y + top), page: page)
    }

    // MARK: Bar tint

    /// Leaves the bars up for the screenshot.
    private func barTint() async -> BarTintResults {
        let tint = Tokens.Color.phoneActionTrash.withAlphaComponent(0.5)
        let list = SpikeList()
        list.navigationItem.title = Spike.barTint.rawValue
        list.toolbarItems = [UIBarButtonItem(systemItem: .flexibleSpace), UIBarButtonItem(systemItem: .compose)]
        let navigation = UINavigationController(rootViewController: list)
        navigation.navigationBar.prefersLargeTitles = true
        navigation.isToolbarHidden = false
        navigation.tabBarItem = UITabBarItem(title: nil, image: UIImage(systemName: "note.text"), tag: 0)
        let other = UIViewController()
        other.view.backgroundColor = Tokens.Color.phoneBackground
        other.tabBarItem = UITabBarItem(title: nil, image: UIImage(systemName: "gearshape"), tag: 1)
        let tabs = UITabBarController()
        tabs.viewControllers = [navigation, other]

        let bar = UINavigationBarAppearance()
        bar.configureWithDefaultBackground()
        bar.backgroundColor = tint
        navigation.navigationBar.standardAppearance = bar
        navigation.navigationBar.scrollEdgeAppearance = bar
        navigation.navigationBar.compactAppearance = bar
        let toolbar = UIToolbarAppearance()
        toolbar.configureWithDefaultBackground()
        toolbar.backgroundColor = tint
        navigation.toolbar.standardAppearance = toolbar
        navigation.toolbar.scrollEdgeAppearance = toolbar
        navigation.toolbar.compactAppearance = toolbar
        let tabBar = UITabBarAppearance()
        tabBar.configureWithDefaultBackground()
        tabBar.backgroundColor = tint
        tabs.tabBar.standardAppearance = tabBar
        tabs.tabBar.scrollEdgeAppearance = tabBar

        await present(tabs)
        try? await Task.sleep(for: .milliseconds(500))
        return BarTintResults(
            navigationBar: navigation.navigationBar.standardAppearance.backgroundColor == tint,
            toolbar: navigation.toolbar.standardAppearance.backgroundColor == tint,
            tabBar: tabs.tabBar.standardAppearance.backgroundColor == tint)
    }
}

@MainActor
private final class Answer {
    private var continuation: CheckedContinuation<Outcome, Never>?

    init(_ continuation: CheckedContinuation<Outcome, Never>) {
        self.continuation = continuation
    }

    func resume(_ outcome: Outcome) {
        continuation?.resume(returning: outcome)
        continuation = nil
    }
}

/// A throwaway native screen that holds the web view, and a hidden field for the keyboard spike.
private final class SpikeScreen: UIViewController {
    let field = UITextField(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    /// In the window by now, so the web view moved here keeps one.
    var arriving: (() -> Void)?
    var appeared: (() -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
        field.alpha = 0
        view.addSubview(field)
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        arriving?()
        arriving = nil
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared?()
        appeared = nil
    }
}

private final class SpikeList: UITableViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 80 }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = String(indexPath.row + 1)
        cell.contentConfiguration = content
        return cell
    }
}

private func className<Object: AnyObject>(_ object: Object) -> String {
    NSStringFromClass(type(of: object))
}

@MainActor
private enum FirstResponderProbe {
    static var found: UIResponder?
}

extension UIResponder {
    @objc fileprivate func devotSpikeCaptureFirstResponder(_ sender: Any?) {
        FirstResponderProbe.found = self
    }
}

@MainActor
private final class KeyboardWatch: NSObject {
    private(set) var up = false
    /// The keyboard went down since `forgetDrops`.
    private(set) var dropped = false
    private(set) var events: [KeyboardEvent] = []
    private var origin = CACurrentMediaTime()

    private static let watched: [(Notification.Name, String)] = [
        (UIResponder.keyboardWillShowNotification, "keyboardWillShow"),
        (UIResponder.keyboardDidShowNotification, "keyboardDidShow"),
        (UIResponder.keyboardWillHideNotification, "keyboardWillHide"),
        (UIResponder.keyboardDidHideNotification, "keyboardDidHide"),
        (UIResponder.keyboardWillChangeFrameNotification, "keyboardWillChangeFrame"),
        (UIWindow.didBecomeKeyNotification, "windowBecameKey"),
        (UIWindow.didResignKeyNotification, "windowResignedKey"),
        (UIScene.didActivateNotification, "sceneActivated"),
        (UIScene.willDeactivateNotification, "sceneWillDeactivate"),
        (UIApplication.didBecomeActiveNotification, "appBecameActive"),
        (.GCKeyboardDidConnect, "hardwareKeyboardConnected"),
    ]

    func start(field: UITextField) {
        origin = CACurrentMediaTime()
        events = []
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(willShow), name: UIResponder.keyboardWillShowNotification, object: nil)
        center.addObserver(
            self, selector: #selector(willHide), name: UIResponder.keyboardWillHideNotification, object: nil)
        for (name, _) in Self.watched {
            center.addObserver(self, selector: #selector(record), name: name, object: nil)
        }
        center.addObserver(
            self, selector: #selector(record), name: UITextField.textDidBeginEditingNotification, object: field)
        center.addObserver(
            self, selector: #selector(record), name: UITextField.textDidEndEditingNotification, object: field)
    }

    func stop() {
        NotificationCenter.default.removeObserver(self)
    }

    func forgetDrops() {
        dropped = false
    }

    func elapsedMs() -> Double {
        SpikeStats.rounded((CACurrentMediaTime() - origin) * 1000)
    }

    func wait(up wanted: Bool, ms: Int = 2000) async {
        var tries = ms / 50
        while up != wanted, tries > 0 {
            tries -= 1
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    @objc private func willShow(_ notification: Notification) {
        up = true
    }

    @objc private func willHide(_ notification: Notification) {
        up = false
        dropped = true
    }

    /// At most 200, so a run that loops on a notification still writes a small report.
    @objc private func record(_ notification: Notification) {
        guard events.count < 200 else { return }
        let name: String
        switch notification.name {
        case UITextField.textDidBeginEditingNotification: name = "fieldBeganEditing"
        case UITextField.textDidEndEditingNotification: name = "fieldEndedEditing"
        default: name = Self.watched.first { $0.0 == notification.name }?.1 ?? "unknown"
        }
        events.append(KeyboardEvent(name: name, atMs: elapsedMs()))
    }
}
#endif
