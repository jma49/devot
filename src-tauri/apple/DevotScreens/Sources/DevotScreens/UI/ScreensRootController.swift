import UIKit

/// Lets every touch through to the views behind it.
final class PassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}

/// A transparent child of tao's root view controller, pinned to all its edges. In stage 0 it is
/// empty and leaves the web view where tao put it.
final class ScreensRootController: UIViewController {
    override func loadView() {
        let view = PassthroughView()
        view.backgroundColor = .clear
        view.isOpaque = false
        self.view = view
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
}
