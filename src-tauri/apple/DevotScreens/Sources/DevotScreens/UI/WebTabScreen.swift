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

    /// The page lays itself out by the window's safe area, as without the system bar.
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        guard let window = view.window else { return }
        let given = view.safeAreaInsets
        let extra = additionalSafeAreaInsets
        let wanted = UIEdgeInsets(
            top: window.safeAreaInsets.top - (given.top - extra.top),
            left: window.safeAreaInsets.left - (given.left - extra.left),
            bottom: window.safeAreaInsets.bottom - (given.bottom - extra.bottom),
            right: window.safeAreaInsets.right - (given.right - extra.right))
        if wanted != extra { additionalSafeAreaInsets = wanted }
    }
}
