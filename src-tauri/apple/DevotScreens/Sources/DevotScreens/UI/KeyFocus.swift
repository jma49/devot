import UIKit

extension UIResponder {
    /// The first responder, found by the one action sent to no target, which UIKit hands to it.
    @MainActor static var firstResponder: UIResponder? {
        FirstResponder.found = nil
        UIApplication.shared.sendAction(#selector(devotRecordFirstResponder), to: nil, from: nil, for: nil)
        return FirstResponder.found
    }

    @objc fileprivate func devotRecordFirstResponder() {
        FirstResponder.found = self
    }
}

@MainActor private enum FirstResponder {
    static weak var found: UIResponder?
}

extension UIViewController {
    /// On an iPad, a screen takes the keys while nothing else does, so its key commands and the tab
    /// bar's answer a hardware keyboard before anything is tapped; a field that has them keeps them.
    func takeKeysIfFree() {
        guard traitCollection.userInterfaceIdiom == .pad, view.window != nil, !isFirstResponder else { return }
        let current = UIResponder.firstResponder
        guard current == nil || current is UIApplication || current is UIWindow else { return }
        becomeFirstResponder()
    }
}
