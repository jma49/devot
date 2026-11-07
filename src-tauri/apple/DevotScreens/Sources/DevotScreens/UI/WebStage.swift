import UIKit
import WebKit

/// Where the web view waits between two screens: one clipped point, so it stays in the window.
final class WebStage: UIView {
    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        clipsToBounds = true
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { nil }
}
