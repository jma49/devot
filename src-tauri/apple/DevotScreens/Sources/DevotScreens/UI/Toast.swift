import UIKit

/// An action that can be taken back for a few seconds.
struct UndoToast {
    enum Kind: Equatable {
        case trashed
        case completed
    }

    let kind: Kind
    let onUndo: () -> Void
}

@MainActor
protocol UndoOffering: AnyObject {
    func offer(_ toast: UndoToast)
}

/// A regular glass capsule over its own shadow: the kind's glyph and message, and the Undo pill.
final class ToastView: UIView {
    let shadowView = FloatShadowView()
    let glass = UIVisualEffectView(effect: nil)
    let icon = UIImageView()
    let label = UILabel()
    let undo = UIButton(type: .system)
    let pan = UIPanGestureRecognizer()
    /// Held by the toast it places: once the toast has gone, activating it would crash.
    var aboveBar: NSLayoutConstraint?
    private(set) var kind: UndoToast.Kind

    init(kind: UndoToast.Kind) {
        self.kind = kind
        super.init(frame: .zero)
        accessibilityIdentifier = "devot.toast"
        accessibilityElements = [label, undo]
        addSubview(shadowView)
        glass.cornerConfiguration = .capsule()
        glass.clipsToBounds = true
        addSubview(glass)
        for pinned in [shadowView, glass] {
            pinned.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                pinned.topAnchor.constraint(equalTo: topAnchor), pinned.bottomAnchor.constraint(equalTo: bottomAnchor),
                pinned.leadingAnchor.constraint(equalTo: leadingAnchor), pinned.trailingAnchor.constraint(equalTo: trailingAnchor),
            ])
        }
        icon.isAccessibilityElement = false
        icon.contentMode = .scaleAspectFit
        icon.setContentHuggingPriority(.required, for: .horizontal)
        label.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
            for: .systemFont(ofSize: 15, weight: .medium), maximumPointSize: 24)
        label.adjustsFontForContentSizeCategory = true
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.8
        label.textColor = Tokens.Color.textPrimary
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        undo.accessibilityIdentifier = "devot.toast.undo"
        undo.setContentHuggingPriority(.required, for: .horizontal)
        undo.setContentCompressionResistancePriority(.required, for: .horizontal)
        var pill = UIButton.Configuration.plain()
        pill.title = L10n.phoneToastUndo()
        pill.baseForegroundColor = Tokens.Color.phoneUndo
        pill.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
        pill.background.backgroundColor = Tokens.Color.phoneLens
        pill.background.cornerRadius = Tokens.Size.phoneToastUndo / 2
        let inset = (Tokens.Size.phoneTarget - Tokens.Size.phoneToastUndo) / 2
        pill.background.backgroundInsets = NSDirectionalEdgeInsets(top: inset, leading: 0, bottom: inset, trailing: 0)
        pill.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
                for: .systemFont(ofSize: 15, weight: .semibold), maximumPointSize: 24)
            return attributes
        }
        undo.configuration = pill
        let row = UIStackView(arrangedSubviews: [icon, label, undo])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 6)
        row.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: glass.contentView.topAnchor),
            row.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: Tokens.Size.phoneToast),
            undo.heightAnchor.constraint(greaterThanOrEqualToConstant: Tokens.Size.phoneTarget),
        ])
        addGestureRecognizer(pan)
        apply(kind)
    }

    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        shadowView.cornerRadius = bounds.height / 2
    }

    static func message(_ kind: UndoToast.Kind) -> String {
        switch kind {
        case .trashed: L10n.phoneToastTrashed()
        case .completed: L10n.phoneToastCompleted()
        }
    }

    /// Another action replaces the words where they are.
    func replace(with kind: UndoToast.Kind) {
        self.kind = kind
        UIView.transition(
            with: glass.contentView, duration: Tokens.Duration.phoneAdjust,
            options: [.transitionCrossDissolve, .allowUserInteraction]
        ) { self.apply(kind) }
    }

    /// Glass is put on once the toast has stopped moving: UIKit may not install it on a moving host.
    func applyGlass() {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = false
        UIView.animate(withDuration: Tokens.Duration.phoneAdjust) { self.glass.effect = effect }
    }

    private func apply(_ kind: UndoToast.Kind) {
        label.text = Self.message(kind)
        let size = UIImage.SymbolConfiguration(pointSize: Tokens.Size.iconPhoneToast, weight: .semibold)
        switch kind {
        case .trashed:
            icon.image = UIImage(systemName: "trash.fill", withConfiguration: size)
            icon.tintColor = Tokens.Color.phoneDestructive
        case .completed:
            icon.image = UIImage(systemName: "checkmark.circle.fill", withConfiguration: size)
            icon.tintColor = Tokens.Color.statusDoneMark
        }
    }
}

/// The undo toast over a screen (design/motion.md, Undo toast): it rises, waits
/// `motion.duration.phone-toast`, fades; a sideways drag takes it away or lets it settle back.
@MainActor
final class ToastPresenter: NSObject, UndoOffering, UIGestureRecognizerDelegate {
    /// Where the tab bar's top edge is in the host, or nil while no bar is up.
    var barTop: () -> CGFloat? = { nil }
    var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
    var announce: (String) -> Void = { UIAccessibility.post(notification: .announcement, argument: $0) }
    /// Runs `body` after `delay` seconds; the result cancels it.
    var schedule: @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> () -> Void = ToastPresenter.afterDelay
    /// A toast stays while VoiceOver is reading it.
    var holdsFocus: (ToastView) -> Bool = { view in
        UIAccessibility.isVoiceOverRunning
            && (view.undo.accessibilityElementIsFocused() || view.label.accessibilityElementIsFocused())
    }

    private weak var host: UIView?
    private(set) var current: ToastView?
    private var undo: (() -> Void)?
    private var cancelTimer: (() -> Void)?
    private(set) var rise: UIViewPropertyAnimator?
    private var settle: SettleAnimator?

    func attach(to host: UIView) {
        self.host = host
    }

    /// The host laid out: the toast keeps its gap above the tab bar.
    func hostDidLayout() {
        guard let host, let aboveBar = current?.aboveBar else { return }
        let top = barTop()
        let constant = (top ?? 0) - Tokens.Size.phoneToastGap
        if aboveBar.isActive != (top != nil) { aboveBar.isActive = top != nil }
        if top != nil, aboveBar.constant != constant {
            aboveBar.constant = constant
            host.setNeedsLayout()
        }
    }

    func offer(_ toast: UndoToast) {
        announce(ToastView.message(toast.kind))
        undo = toast.onUndo
        if let current {
            current.replace(with: toast.kind)
            restartTimer()
            return
        }
        guard let host else { return }
        let view = ToastView(kind: toast.kind)
        install(view, in: host)
        arrive(view)
        restartTimer()
    }

    /// The toast goes at once, whatever it was doing.
    func dismissNow() {
        cancelTimer?()
        cancelTimer = nil
        rise?.stopAnimation(true)
        settle?.cancel()
        current?.removeFromSuperview()
        current = nil
        undo = nil
    }

    // MARK: Placement

    private func install(_ view: ToastView, in host: UIView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(view)
        let safe = host.safeAreaLayoutGuide
        let gap = Tokens.Size.phoneToastGap
        let atSafeBottom = view.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -gap)
        atSafeBottom.priority = UILayoutPriority(998)
        let aboveBar = view.bottomAnchor.constraint(equalTo: host.topAnchor)
        aboveBar.priority = UILayoutPriority(999)
        aboveBar.isActive = false
        view.aboveBar = aboveBar
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: Tokens.Size.phoneScreenEdge),
            view.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -Tokens.Size.phoneScreenEdge),
            view.bottomAnchor.constraint(lessThanOrEqualTo: safe.bottomAnchor, constant: -gap),
            view.bottomAnchor.constraint(lessThanOrEqualTo: host.keyboardLayoutGuide.topAnchor, constant: -gap),
            atSafeBottom,
        ])
        view.undo.addAction(UIAction { [weak self] _ in self?.undoTapped() }, for: .touchUpInside)
        view.pan.delegate = self
        view.pan.addTarget(self, action: #selector(panned(_:)))
        current = view
        hostDidLayout()
        host.layoutIfNeeded()
    }

    // MARK: Arriving and leaving

    private func arrive(_ view: ToastView) {
        view.alpha = 0
        let animator: UIViewPropertyAnimator
        if reduceMotion() {
            animator = UIViewPropertyAnimator(duration: Tokens.Duration.phoneCrossfade, curve: .easeOut) { view.alpha = 1 }
        } else {
            view.transform = CGAffineTransform(translationX: 0, y: Tokens.Size.phoneToastRise)
            animator = UIViewPropertyAnimator(
                duration: Tokens.Duration.phoneEnter, timingParameters: Tokens.Easing.phoneEnter.timingParameters)
            animator.addAnimations {
                view.alpha = 1
                view.transform = .identity
            }
        }
        animator.addCompletion { [weak view] _ in view?.applyGlass() }
        rise = animator
        animator.startAnimation()
    }

    private func leave(_ view: ToastView) {
        if current === view { current = nil }
        cancelTimer?()
        cancelTimer = nil
        settle?.cancel()
        UIView.animate(withDuration: Tokens.Duration.phoneExit, delay: 0, options: .curveEaseIn) {
            view.alpha = 0
        } completion: { _ in
            view.removeFromSuperview()
        }
    }

    private func restartTimer() {
        cancelTimer?()
        cancelTimer = schedule(Tokens.Duration.phoneToast) { [weak self] in self?.expire() }
    }

    private func expire() {
        guard let current else { return }
        if holdsFocus(current) { return restartTimer() }
        leave(current)
    }

    private func undoTapped() {
        let run = undo
        undo = nil
        if let current { leave(current) }
        run?()
    }

    // MARK: The drag

    func gestureRecognizerShouldBegin(_ recogniser: UIGestureRecognizer) -> Bool {
        guard let pan = recogniser as? UIPanGestureRecognizer else { return true }
        return ToastModel.panBegins(pan.translation(in: pan.view?.superview))
    }

    @objc func panned(_ pan: UIPanGestureRecognizer) {
        guard let view = current, pan.view === view else { return }
        let travelled = pan.translation(in: view.superview).x
        switch pan.state {
        case .began:
            cancelTimer?()
            cancelTimer = nil
            if let rise, rise.state == .active { rise.stopAnimation(false) }
            if let rise, rise.state == .stopped { rise.finishAnimation(at: .end) }
            settle?.cancel()
            view.transform = CGAffineTransform(translationX: travelled, y: 0)
        case .changed:
            view.transform = CGAffineTransform(translationX: travelled, y: 0)
        case .ended:
            let velocity = pan.velocity(in: view.superview).x
            switch ToastModel.release(translation: travelled, velocity: velocity, width: view.bounds.width) {
            case .fly(let target, _, let duration):
                flyOff(view, to: target, duration: duration)
            case .settle(let velocity):
                settleBack(view, from: travelled, velocity: velocity)
            }
        case .cancelled, .failed:
            settleBack(view, from: travelled, velocity: 0)
        default:
            break
        }
    }

    private func flyOff(_ view: ToastView, to target: CGFloat, duration: TimeInterval) {
        current = nil
        undo = nil
        UIViewPropertyAnimator.runningPropertyAnimator(withDuration: duration, delay: 0, options: .curveLinear) {
            view.transform = CGAffineTransform(translationX: target, y: 0)
        } completion: { _ in
            view.removeFromSuperview()
        }
    }

    private func settleBack(_ view: ToastView, from x: CGFloat, velocity: CGFloat) {
        let animator = SettleAnimator(view: view, from: x, velocity: velocity) { [weak self] in self?.restartTimer() }
        settle = animator
        animator.start()
    }

    // MARK: Defaults

    private static func afterDelay(_ delay: TimeInterval, _ body: @escaping @MainActor () -> Void) -> () -> Void {
        let item = DispatchWorkItem { MainActor.assumeIsolated(body) }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        return { item.cancel() }
    }
}
