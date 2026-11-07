import UIKit

/// A Settings pane the page still draws, under the native bar. Each time it shows it asks the page
/// for the pane and takes the web view only once the page answers, so the push never shows what
/// the page drew before. Its view keeps its own safe area, so the page's top inset takes in the bar.
final class WebPaneScreen: UIViewController {
    let pane: String
    private let host: WebViewHost
    private let show: (_ pane: String, _ shown: @escaping () -> Void) -> Void
    private let left: () -> Void
    private var showing = false
    /// The page was asked for the pane since the screen last left the stack.
    private var asked = false

    /// `show` asks the page for the pane and calls `shown` on its answer; `left` runs once the
    /// screen has left the stack, so the page lets the pane go.
    init(
        pane: String, title: String, host: WebViewHost,
        show: @escaping (_ pane: String, _ shown: @escaping () -> Void) -> Void,
        left: @escaping () -> Void
    ) {
        self.pane = pane
        self.host = host
        self.show = show
        self.left = left
        super.init(nibName: nil, bundle: nil)
        navigationItem.title = title
        navigationItem.largeTitleDisplayMode = .never
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        showing = true
        asked = true
        show(pane) { [weak self] in
            guard let self, showing else { return }
            host.move(into: view)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        showing = false
        if host.webView.superview === view { host.rest() }
    }

    /// Popped, or taken off the stack under another page; a cancelled back swipe never gets here.
    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        guard parent == nil, asked else { return }
        asked = false
        left()
    }
}
