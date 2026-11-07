import UIKit
import WebKit

/// A child of tao's root view controller, pinned to all its edges, that hosts the tab bar over the
/// web view tao made.
final class ScreensRootController: UIViewController {
    let host: WebViewHost
    let tabs: DevotTabBarController
    var log: ((LogLevel, String) -> Void)?

    init(webView: WKWebView) {
        host = WebViewHost(webView: webView)
        tabs = DevotTabBarController(host: host)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.addSubview(host.stage)
        addChild(tabs)
        tabs.view.frame = view.bounds
        tabs.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(tabs.view)
        tabs.didMove(toParent: self)
        NotificationCenter.default.addObserver(
            self, selector: #selector(sceneActivated), name: UIScene.didActivateNotification, object: nil)
    }

    func attach(to parent: UIViewController) {
        parent.addChild(self)
        let host = parent.view!
        view.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: host.topAnchor),
            view.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            view.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
        ])
        didMove(toParent: parent)
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        makeWindowKey()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let window = view.window { host.windowSize(window.bounds.size) }
    }

    @objc private func sceneActivated(_ notification: Notification) {
        if notification.object as? UIScene === view.window?.windowScene { makeWindowKey() }
    }

    /// Tao's window is not the scene's key window after launch (spike S2), and a field in a window
    /// that is not key takes focus without raising the keyboard.
    private func makeWindowKey() {
        guard let window = view.window, !window.isKeyWindow,
            window.windowScene?.activationState == .foregroundActive
        else { return }
        window.makeKey()
        log?(.info, "I_SCREENS_WINDOW_KEY")
    }
}
