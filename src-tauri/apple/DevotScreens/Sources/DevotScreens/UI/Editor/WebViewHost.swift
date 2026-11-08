import UIKit
import WebKit

/// Moves the one web view between screens. WebKit drops its layers when the view leaves the window
/// and relayouts the page when its size changes (spike S1), so a move never does either.
@MainActor
final class WebViewHost {
    let webView: WKWebView
    let stage = WebStage()
    /// The screen the web view is in, or nil while it rests on the stage.
    weak var holder: WebHolderScreen?
    /// The screen a pop is revealing, which takes the web view once the pop is done.
    weak var waiting: WebHolderScreen?
    /// The bottom inset the page was sent last (`editor.insets`); the page sets 0 itself on a hide.
    var footInset: CGFloat = 0
    private var size: CGSize?

    init(webView: WKWebView) {
        self.webView = webView
    }

    /// With `addSubview` alone, so the web view's window is never nil on the way.
    @discardableResult
    func move(into container: UIView) -> Bool {
        guard let window = webView.window, container.window === window else { return false }
        if webView.superview !== container { container.addSubview(webView) }
        webView.autoresizingMask = []
        webView.frame = CGRect(origin: .zero, size: size ?? webView.bounds.size)
        return true
    }

    func rest() {
        move(into: stage)
        holder = nil
    }

    func windowSize(_ size: CGSize) {
        guard size != .zero, size != self.size else { return }
        self.size = size
        webView.frame = CGRect(origin: webView.frame.origin, size: size)
    }
}

/// A screen that shows the one web view while it is on top of its stack (design-motion-glass §4).
/// A screen being covered keeps a still of the page. A screen being revealed by a pop takes the
/// live view only once the pop is done, so a back swipe the finger turns back changes nothing.
class WebHolderScreen: UIViewController {
    let host: WebViewHost
    private(set) var snapshot: UIView?
    private let holding = WindowSafeAreaView()

    init(host: WebViewHost) {
        self.host = host
        super.init(nibName: nil, bundle: nil)
        holding.willLeaveWindow = { [weak self] in self?.leavingWindow() }
    }

    required init?(coder: NSCoder) { nil }

    /// Where the web view goes, full bleed, reporting the window's safe area.
    var webContainer: WindowSafeAreaView { holding }

    /// The first callback that guarantees a window, which a move needs.
    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        appeared()
        guard host.holder !== self else { return }
        guard let coordinator = transitionCoordinator, !isMovingToParent,
            coordinator.viewController(forKey: .from) === host.holder
        else { return take() }
        host.waiting = self
        let started = coordinator.animate(alongsideTransition: nil) { [weak self] context in
            guard let self else { return }
            if host.waiting === self { host.waiting = nil }
            guard !context.isCancelled, host.holder !== self else { return }
            UIView.performWithoutAnimation { self.take() }
        }
        if !started { take() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard host.holder === self, !isMovingFromParent, !isBeingCovered else { return }
        host.rest()
    }

    /// A push onto this screen's stack: the incoming screen takes the web view and leaves this one a still.
    private var isBeingCovered: Bool {
        guard let navigation = navigationController,
            let incoming = transitionCoordinator?.viewController(forKey: .to)
        else { return false }
        return incoming !== self && incoming.navigationController === navigation
    }

    /// A popped screen's view leaves the window before the pop's completion runs, and a covered one
    /// can leave it before the incoming screen appears; WebKit drops the page's layers with it, so the
    /// live view goes to the revealed screen, or rests, at that moment.
    private func leavingWindow() {
        guard host.holder === self else { return }
        UIView.performWithoutAnimation {
            if isBeingCovered { leaveSnapshot() }
            if let next = host.waiting, next !== self, next.view.window != nil {
                next.take()
            } else {
                host.rest()
            }
        }
    }

    private func take() {
        let previous = host.holder
        if let previous, previous !== self, let navigation = navigationController,
            previous.navigationController === navigation, navigation.viewControllers.contains(previous)
        {
            previous.leaveSnapshot()
        }
        guard host.move(into: webContainer) else { return }
        host.holder = self
        if host.waiting === self { host.waiting = nil }
        tookWebView()
    }

    /// The page as it was drawn last, where the live view was: one composited copy, no relayout.
    private func leaveSnapshot() {
        guard snapshot == nil, host.webView.isDescendant(of: webContainer),
            let still = host.webView.snapshotView(afterScreenUpdates: false)
        else { return }
        still.frame = host.webView.frame
        webContainer.addSubview(still)
        snapshot = still
    }

    func dropSnapshot() {
        snapshot?.removeFromSuperview()
        snapshot = nil
    }

    /// Fades the still off the live page under it; a still left meanwhile is a new one.
    func fadeSnapshot(over duration: TimeInterval) {
        guard let still = snapshot else { return }
        snapshot = nil
        let fader = UIViewPropertyAnimator(
            duration: duration, timingParameters: Tokens.Easing.standard.timingParameters)
        fader.addAnimations { still.alpha = 0 }
        fader.addCompletion { _ in still.removeFromSuperview() }
        fader.startAnimation()
    }

    func appeared() {}

    func tookWebView() {}
}
