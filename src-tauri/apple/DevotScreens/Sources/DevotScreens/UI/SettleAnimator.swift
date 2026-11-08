import UIKit

/// `phone-settle` from a release position and velocity, as a closed form that stops at the first
/// time it reaches the target. UIKit and SwiftUI springs overshoot; a toast let go near rest at
/// 800 pt/s would pass its place by up to 15 pt.
struct SettleCurve {
    let from: CGFloat
    let to: CGFloat
    let velocity: CGFloat
    private let omega: Double
    private let zeta: Double

    init(from: CGFloat, to: CGFloat, velocity: CGFloat, spring: Tokens.SpringParameters = Tokens.Spring.phoneSettle) {
        self.from = from
        self.to = to
        self.velocity = velocity
        omega = (Double(spring.stiffness) / Double(spring.mass)).squareRoot()
        zeta = Double(spring.damping) / (2 * (Double(spring.stiffness) * Double(spring.mass)).squareRoot())
    }

    /// The spring's own position, with no stop at the target.
    func free(at time: TimeInterval) -> CGFloat {
        let start = Double(from - to)
        let damped = omega * (1 - zeta * zeta).squareRoot()
        let sine = (Double(velocity) + zeta * omega * start) / damped
        let value = exp(-zeta * omega * time) * (start * cos(damped * time) + sine * sin(damped * time))
        return to + CGFloat(value)
    }

    /// The position and whether the target has been reached: the first crossing, or rest within a
    /// hundredth of a point.
    func clamped(at time: TimeInterval) -> (value: CGFloat, finished: Bool) {
        let start = from - to
        guard start != 0 else { return (to, true) }
        let value = free(at: time)
        let offset = value - to
        if offset * start <= 0 { return (to, true) }
        let ahead = free(at: time + 0.001) - to
        if abs(offset) < 0.01, abs(ahead) < 0.01 { return (to, true) }
        return (value, false)
    }
}

/// Runs a `SettleCurve` on a display link at up to 120 Hz and hands each position to `apply`.
/// It drives one small view's `transform` on the main thread and nothing else.
@MainActor
final class SettleAnimator {
    private let curve: SettleCurve
    private let apply: (CGFloat) -> Void
    private let completion: () -> Void
    private var link: CADisplayLink?
    private var begin: CFTimeInterval = 0
    private(set) var finished = false

    init(from: CGFloat, to: CGFloat, velocity: CGFloat, apply: @escaping (CGFloat) -> Void, completion: @escaping () -> Void = {}) {
        curve = SettleCurve(from: from, to: to, velocity: velocity)
        self.apply = apply
        self.completion = completion
    }

    /// A view let go at `x` from its place with `velocity` points a second.
    convenience init(view: UIView, from x: CGFloat, velocity: CGFloat, completion: @escaping () -> Void = {}) {
        self.init(
            from: x, to: 0, velocity: velocity,
            apply: { [weak view] in view?.transform = CGAffineTransform(translationX: $0, y: 0) }, completion: completion)
    }

    func start() {
        guard link == nil, !finished else { return }
        let link = CADisplayLink(target: LinkTarget(self), selector: #selector(LinkTarget.fire(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        begin = CACurrentMediaTime()
        self.link = link
        link.add(to: .main, forMode: .common)
    }

    /// Without finishing: the view is wherever it was.
    func cancel() {
        link?.invalidate()
        link = nil
        finished = true
    }

    /// One frame, `elapsed` seconds after the release; true while it runs.
    @discardableResult
    func step(elapsed: TimeInterval) -> Bool {
        guard !finished else { return false }
        let (value, done) = curve.clamped(at: elapsed)
        apply(value)
        guard done else { return true }
        link?.invalidate()
        link = nil
        finished = true
        completion()
        return false
    }

    fileprivate func tick() {
        step(elapsed: CACurrentMediaTime() - begin)
    }
}

@MainActor
private final class LinkTarget: NSObject {
    weak var animator: SettleAnimator?

    init(_ animator: SettleAnimator) {
        self.animator = animator
    }

    @objc func fire(_ link: CADisplayLink) {
        guard let animator else { return link.invalidate() }
        animator.tick()
    }
}
