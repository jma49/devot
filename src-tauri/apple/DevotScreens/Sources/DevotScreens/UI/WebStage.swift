import UIKit
import WebKit

/// Where the web view waits between two screens: one clipped point, so it stays in the window.
/// Clipping hides the page from the eye only, so the stage also takes it out of the accessibility tree.
final class WebStage: UIView {
    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        clipsToBounds = true
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { nil }
}

/// Moves the one web view between screens. WebKit drops its layers when the view leaves the window
/// and relayouts the page when its size changes (spike S1), so a move never does either.
@MainActor
final class WebViewHost {
    let webView: WKWebView
    let stage = WebStage()
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
    }

    func windowSize(_ size: CGSize) {
        guard size != .zero, size != self.size else { return }
        self.size = size
        webView.frame = CGRect(origin: webView.frame.origin, size: size)
    }
}
