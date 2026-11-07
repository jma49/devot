import UIKit

/// A tab's root: it holds the web view while its tab's list is shown.
final class WebTabScreen: WebHolderScreen {
    let screenTab: Tab
    private let onAppear: (Tab) -> Void
    /// Asks the page to let the note go and calls back once the list is painted again.
    var hideEditor: ((@escaping () -> Void) -> Void)?
    /// How long the list's still waits for the page before it goes regardless.
    var hideTimeout: TimeInterval = 0.4
    private var hiding = 0

    init(tab: Tab, host: WebViewHost, onAppear: @escaping (Tab) -> Void) {
        self.screenTab = tab
        self.onAppear = onAppear
        super.init(host: host)
        navigationItem.backButtonDisplayMode = .minimal
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        view = webContainer
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = false
    }

    /// A hand-back still waiting on the page is given up: a push now keeps the still for itself.
    override func viewWillDisappear(_ animated: Bool) {
        hiding += 1
        super.viewWillDisappear(animated)
    }

    override func appeared() {
        onAppear(screenTab)
    }

    /// The still of the list stays over the page until the page has drawn the list again.
    override func tookWebView() {
        guard let hideEditor else { return dropSnapshot() }
        if let still = snapshot { view.bringSubviewToFront(still) }
        hiding += 1
        let turn = hiding
        let done = { [weak self] in
            guard let self, hiding == turn else { return }
            hiding += 1
            dropSnapshot()
        }
        hideEditor(done)
        DispatchQueue.main.asyncAfter(deadline: .now() + hideTimeout, execute: done)
    }
}

/// The page lays itself out by the window's safe area, as without the system bar. The tab bar's
/// inset can reach this view through its superview, which a negative additional inset cannot take
/// back on every iOS, so the view reports the window's insets and its subviews derive theirs from it.
final class WindowSafeAreaView: UIView {
    var willLeaveWindow: (() -> Void)?

    override var safeAreaInsets: UIEdgeInsets {
        window?.safeAreaInsets ?? super.safeAreaInsets
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        if newWindow == nil, window != nil { willLeaveWindow?() }
        super.willMove(toWindow: newWindow)
    }
}
