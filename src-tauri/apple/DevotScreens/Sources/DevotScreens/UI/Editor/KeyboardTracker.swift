import UIKit

/// One keyboard frame change as the editor screen uses it (design/motion.md, Bottom toolbar and
/// the keyboard): how much of the screen the keyboard covers, on its own duration and curve.
struct KeyboardChange: Equatable {
    /// Points of the view the keyboard covers, up from the view's bottom edge.
    let covered: CGFloat
    let duration: TimeInterval
    /// `UIView.AnimationCurve`'s raw value: the keyboard's own is 7, which has no case.
    let curve: Int

    static let keyboardCurve = 7
    /// What `editor.insets` takes (`screens::message`).
    static let longest: TimeInterval = 2

    init(covered: CGFloat, duration: TimeInterval, curve: Int) {
        self.covered = max(0, covered)
        self.duration = min(max(0, duration), Self.longest)
        self.curve = min(max(0, curve), Self.keyboardCurve)
    }

    var up: Bool { covered > 0 }

    /// The curve as animation options, so a block runs on the keyboard's own curve.
    var options: UIView.AnimationOptions { UIView.AnimationOptions(rawValue: UInt(curve) << 16) }

    /// A keyboard that went off the bottom, or floats clear of it, covers nothing.
    static func covered(keyboard: CGRect, view: CGRect) -> CGFloat {
        guard !keyboard.isNull, keyboard.width > 0, keyboard.height > 0, keyboard.minY < view.maxY,
            keyboard.maxY >= view.maxY
        else { return 0 }
        return view.maxY - max(keyboard.minY, view.minY)
    }
}

/// Follows the keyboard for one screen: the bars move inside the keyboard's own animation, and the
/// insets are handed on once, outside it, for the page to apply at once.
@MainActor
final class KeyboardTracker {
    typealias Animate = (_ duration: TimeInterval, _ options: UIView.AnimationOptions, _ changes: @escaping () -> Void) -> Void

    static let system: Animate = { duration, options, changes in
        UIView.animate(
            withDuration: duration, delay: 0, options: [options, .beginFromCurrentState, .allowUserInteraction],
            animations: changes)
    }

    weak var view: UIView?
    var animate: Animate = KeyboardTracker.system
    var alongside: (KeyboardChange) -> Void = { _ in }
    var changed: (KeyboardChange) -> Void = { _ in }
    private(set) var last: KeyboardChange?
    private var observer: NSObjectProtocol?

    init(view: UIView) {
        self.view = view
    }

    func start() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] note in
            let frame = Self.frame(note.userInfo ?? [:])
            MainActor.assumeIsolated { self?.keyboardWillChange(frame) }
        }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        last = nil
    }

    /// The keyboard's end frame in screen space, on its own duration and curve.
    struct Frame: Sendable {
        let end: CGRect
        let duration: TimeInterval
        let curve: Int
    }

    nonisolated static func frame(_ info: [AnyHashable: Any]) -> Frame? {
        guard let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return nil }
        return Frame(
            end: end, duration: (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0,
            curve: (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.intValue
                ?? KeyboardChange.keyboardCurve)
    }

    func keyboardWillChange(_ info: [AnyHashable: Any]) {
        keyboardWillChange(Self.frame(info))
    }

    private func keyboardWillChange(_ frame: Frame?) {
        guard let view, let window = view.window, let frame else { return }
        let keyboard = view.convert(frame.end, from: window.screen.coordinateSpace)
        let change = KeyboardChange(
            covered: KeyboardChange.covered(keyboard: keyboard, view: view.bounds), duration: frame.duration,
            curve: frame.curve)
        guard change.covered != last?.covered else { return }
        last = change
        animate(change.duration, change.options) { [weak self] in self?.alongside(change) }
        changed(change)
    }
}
