import UIKit

/// A Settings pane the page still draws, under the native bar: it holds the web view and asks the
/// page for the pane each time it shows. Its view keeps its own safe area, so the page's top inset
/// takes in the bar.
final class WebPaneScreen: UIViewController {
    let pane: String
    private let host: WebViewHost
    private let show: (String) -> Void

    init(pane: String, title: String, host: WebViewHost, show: @escaping (String) -> Void) {
        self.pane = pane
        self.host = host
        self.show = show
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
        show(pane)
        host.move(into: view)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if host.webView.superview === view { host.rest() }
    }
}
