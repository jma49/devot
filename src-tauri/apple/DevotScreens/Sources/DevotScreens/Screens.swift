import UIKit
import WebKit

enum LogLevel: UInt8 {
    case info = 0
    case warn = 1
    case error = 2
}

/// Rust's side of the bridge; tests stand in for it.
protocol RustSide {
    func call(_ request: UInt64, _ json: Data)
    /// A code, then IDs as `key=value`: Rust refuses anything else.
    func log(_ level: LogLevel, _ line: String)
}

/// The native screens of the one window, and the requests they wait on.
@MainActor
final class Screens: SettingsBridge {
    static var shared: Screens?

    /// Set with the launch argument `-DevotScreensOff YES`; the app then keeps the web shell.
    static let killSwitch = "DevotScreensOff"

    let root: ScreensRootController
    var onNotice: ((NoticeKind, [String: JSONValue]) -> Void)?
    private let rust: any RustSide
    private var nextID: UInt64 = 1
    private var waiting: [UInt64: (Outcome) -> Void] = [:]
    private var tabModel = TabModel()
    /// Whether the page shows a note in its editor host, so a list taking the web view back asks it to let go.
    private var editorShown = false
    let selectionFeedback: UISelectionFeedbackGenerator

    private init(rust: any RustSide, webView: WKWebView) {
        self.rust = rust
        let root = ScreensRootController(webView: webView)
        self.root = root
        selectionFeedback = UISelectionFeedbackGenerator(view: root.tabs.view)
        root.log = { [rust] in rust.log($0, $1) }
        root.tabs.onAppear = { [weak self] tab in
            guard let self else { return }
            run(tabModel.appeared(tab))
        }
        root.tabs.onReselect = { [weak self] tab in
            guard let self else { return }
            let effects = tabModel.reselected(tab)
            if !effects.isEmpty {
                selectionFeedback.prepare()
                selectionFeedback.selectionChanged()
            }
            run(effects)
        }
        root.tabs.settings.bridge = self
        root.tabs.settings.hideEditor = { [weak self] done in self?.hideEditor(done) }
        for tab in TabModel.tabs {
            root.tabs.screen(tab)?.hideEditor = { [weak self] done in self?.hideEditor(done) }
        }
    }

    /// Checks what Rust handed over and attaches the root, or answers nil. Tao's window may not be
    /// up yet: containment needs none.
    static func attach(
        webView: AnyObject, root: AnyObject, rust: any RustSide, defaults: UserDefaults = .standard
    ) -> Screens? {
        if defaults.bool(forKey: killSwitch) {
            rust.log(.info, "I_SCREENS_SWITCHED_OFF")
            return nil
        }
        guard let webView = webView as? WKWebView, let root = root as? UIViewController else {
            rust.log(.warn, "W_SCREENS_INSTALL_REFUSED reason=class")
            return nil
        }
        let screens = Screens(rust: rust, webView: webView)
        UIView.performWithoutAnimation { screens.root.attach(to: root) }
        #if DEBUG
            SpikeHarness.startIfAsked(screens: screens, webView: webView, defaults: defaults)
        #endif
        return screens
    }

    var waitingCount: Int { waiting.count }

    func request(_ op: Op, _ args: [String: JSONValue] = [:], done: @escaping (Outcome) -> Void) {
        send({ .request(id: $0, op: op, args: args) }, done: done)
    }

    /// A request Rust answers itself, without the page.
    func direct(_ op: DirectOp, _ args: [String: JSONValue] = [:], done: @escaping (Outcome) -> Void) {
        send({ .direct(id: $0, op: op, args: args) }, done: done)
    }

    func log(_ level: LogLevel, _ line: String) {
        rust.log(level, line)
    }

    private func send(_ message: (UInt64) -> Message, done: @escaping (Outcome) -> Void) {
        let id = nextID
        nextID += 1
        guard let json = try? message(id).json() else {
            done(.failed("E_SCREENS_MESSAGE_INVALID"))
            return
        }
        waiting[id] = done
        rust.call(id, json)
    }

    func replied(_ request: UInt64, _ json: Data?) {
        guard let done = waiting.removeValue(forKey: request) else {
            rust.log(.warn, "W_SCREENS_REPLY_UNMATCHED id=\(request)")
            return
        }
        guard let json, case .reply(request, let outcome)? = try? Message(json: json) else {
            rust.log(.warn, "W_SCREENS_REPLY_INVALID id=\(request)")
            done(.failed("E_SCREENS_MESSAGE_INVALID"))
            return
        }
        done(outcome)
    }

    func delivered(_ json: Data?) {
        guard let json, case .notice(let kind, let fields)? = try? Message(json: json) else {
            rust.log(.warn, "W_SCREENS_NOTICE_INVALID")
            return
        }
        if kind == .settingsOpen {
            openSettings(fields)
            return
        }
        if kind == .syncChanged || kind == .syncPairing {
            root.tabs.settings.store.heard(kind)
            return
        }
        if routeEditorNotice(kind, fields) { return }
        guard kind == .tabsState else {
            onNotice?(kind, fields)
            return
        }
        guard let state = TabModel.PageState(fields) else {
            rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=tabs.state")
            return
        }
        run(tabModel.pageState(tab: state.tab, barHidden: state.barHidden, attention: state.attention))
    }

    /// The page's Pro sheet, Enter License Key, opens License here rather than its own Settings.
    private func openSettings(_ fields: [String: JSONValue]) {
        guard fields["pane"]?.string == "licence" else {
            rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=settings.open")
            return
        }
        let focusKey = fields["focusKey"]?.bool ?? false
        root.tabs.settings.router.open(.licence(focusKey ? .focusKey : .plain))
    }

    private func run(_ effects: [TabModel.Effect]) {
        for effect in effects {
            switch effect {
            case .show(let tab): ask(.tabsShow, tab, answered: true)
            case .popToRoot(let tab): ask(.tabsPopToRoot, tab, answered: false)
            case .select(let tab): root.tabs.select(tab)
            case .hideBar(let hidden): root.tabs.setTabBarHidden(hidden, animated: true)
            case .badge(let on): root.tabs.setAttention(on)
            }
        }
    }

    /// The notices that drive the editor screen; false for any other kind.
    private func routeEditorNotice(_ kind: NoticeKind, _ fields: [String: JSONValue]) -> Bool {
        switch kind {
        case .navOpenNote:
            guard case .string(let id)? = fields["noteId"], case .string(let title)? = fields["title"] else {
                return invalid(kind)
            }
            openNote(id, title: title)
        case .navBack:
            guard let navigation = shownNavigation, navigation.topViewController is EditorScreen,
                navigation.transitionCoordinator == nil
            else { return true }
            navigation.popViewController(animated: true)
        case .editorReady:
            guard case .string(let id)? = fields["noteId"] else { return invalid(kind) }
            (root.host.holder as? EditorScreen)?.ready(id)
        case .editorMode:
            guard case .string(let id)? = fields["noteId"], case .string(let name)? = fields["mode"],
                let mode = NoteMode(rawValue: name)
            else { return invalid(kind) }
            for screen in editorScreens where screen.noteId == id { screen.showMode(mode) }
        case .editorTitle:
            guard case .string(let id)? = fields["id"], case .string(let title)? = fields["title"] else {
                return invalid(kind)
            }
            for screen in editorScreens where screen.noteId == id { screen.retitle(title) }
        case .editorScroll:
            guard case .bool(let visible)? = fields["titleVisible"] else { return invalid(kind) }
            (root.host.holder as? EditorScreen)?.titleVisible(visible)
        default:
            return false
        }
        return true
    }

    private func invalid(_ kind: NoticeKind) -> Bool {
        rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=\(kind.rawValue)")
        return true
    }

    private var shownNavigation: UINavigationController? {
        root.tabs.selectedViewController as? UINavigationController
    }

    private var editorScreens: [EditorScreen] {
        (root.tabs.viewControllers ?? []).compactMap { $0 as? UINavigationController }
            .flatMap(\.viewControllers).compactMap { $0 as? EditorScreen }
    }

    /// Pushed at once on the shown tab; a second tap while a push runs, or on the note already shown, does nothing.
    private func openNote(_ id: String, title: String) {
        guard let navigation = shownNavigation, navigation.transitionCoordinator == nil,
            (navigation.topViewController as? EditorScreen)?.noteId != id
        else { return }
        let screen = EditorScreen(
            noteId: id, title: title, tab: tabModel.selected, host: root.host, actions: editorActions)
        navigation.pushViewController(screen, animated: true)
    }

    private var editorActions: EditorActions {
        EditorActions(
            show: { [weak self] id in
                self?.editorShown = true
                self?.askEditor(.editorShow, ["noteId": .string(id)])
            },
            setMode: { [weak self] mode in self?.askEditor(.editorSetMode, ["mode": .string(mode.rawValue)]) },
            info: { [weak self] in self?.askEditor(.editorInfo) },
            appeared: { [weak self] tab in
                guard let self else { return }
                run(tabModel.appeared(tab))
            })
    }

    private func hideEditor(_ done: @escaping () -> Void) {
        guard editorShown else { return done() }
        editorShown = false
        askEditor(.editorHide, done: done)
    }

    private func askEditor(_ op: Op, _ args: [String: JSONValue] = [:], done: (() -> Void)? = nil) {
        request(op, args) { [weak self] outcome in
            if case .failed(let code) = outcome {
                self?.rust.log(.warn, "W_SCREENS_EDITOR_FAILED op=\(op.rawValue) code=\(code)")
            }
            done?()
        }
    }

    private func ask(_ op: Op, _ tab: Tab, answered: Bool) {
        request(op, ["tab": .string(tab.rawValue)]) { [weak self] outcome in
            guard let self else { return }
            if answered { tabModel.showAnswered() }
            if case .failed(let code) = outcome {
                rust.log(.warn, "W_SCREENS_TAB_FAILED op=\(op.rawValue) code=\(code)")
            }
        }
    }
}
