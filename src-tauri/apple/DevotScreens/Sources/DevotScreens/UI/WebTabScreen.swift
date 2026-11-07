import UIKit

/// A tab's root: it holds the web view while its tab is shown.
final class WebTabScreen: UIViewController {
    let screenTab: Tab
    private let host: WebViewHost
    private let onAppear: (Tab) -> Void

    init(tab: Tab, host: WebViewHost, onAppear: @escaping (Tab) -> Void) {
        self.screenTab = tab
        self.host = host
        self.onAppear = onAppear
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        view = WindowSafeAreaView()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    /// The first callback that guarantees a window, which a move needs.
    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        host.move(into: view)
        onAppear(screenTab)
    }

    /// The tab bar takes this view out of the window once another tab shows.
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if host.webView.superview === view { host.rest() }
    }
}

/// The page lays itself out by the window's safe area, as without the system bar. The tab bar's
/// inset can reach this view through its superview, which a negative additional inset cannot take
/// back on every iOS, so the view reports the window's insets and its subviews derive theirs from it.
final class WindowSafeAreaView: UIView {
    override var safeAreaInsets: UIEdgeInsets {
        window?.safeAreaInsets ?? super.safeAreaInsets
    }
}
