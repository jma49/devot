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
final class Screens {
    static var shared: Screens?

    /// Set with the launch argument `-DevotScreensOff YES`; the app then keeps the web shell.
    static let killSwitch = "DevotScreensOff"

    let root: ScreensRootController
    var onNotice: ((NoticeKind, [String: JSONValue]) -> Void)?
    private let rust: any RustSide
    private var nextID: UInt64 = 1
    private var waiting: [UInt64: (Outcome) -> Void] = [:]
    private var tabModel = TabModel()
    private let selection = UISelectionFeedbackGenerator()

    private init(rust: any RustSide, webView: WKWebView) {
        self.rust = rust
        root = ScreensRootController(webView: webView)
        root.log = { [weak self] in self?.rust.log($0, $1) }
        root.tabs.onAppear = { [weak self] tab in
            guard let self else { return }
            run(tabModel.appeared(tab))
        }
        root.tabs.onReselect = { [weak self] tab in
            guard let self else { return }
            let effects = tabModel.reselected(tab)
            if !effects.isEmpty { selection.selectionChanged() }
            run(effects)
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
        return screens
    }

    var waitingCount: Int { waiting.count }

    func request(_ op: Op, _ args: [String: JSONValue] = [:], done: @escaping (Outcome) -> Void) {
        let id = nextID
        nextID += 1
        guard let json = try? Message.request(id: id, op: op, args: args).json() else {
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
