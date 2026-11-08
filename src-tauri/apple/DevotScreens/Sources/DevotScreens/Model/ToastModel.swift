import CoreGraphics
import Foundation

/// The undo toast's rules without UIKit (design/motion.md, Undo toast).
enum ToastModel {
    /// A toast let go flies this far past its own width.
    static let flyOvershoot: CGFloat = 24
    /// The pan fails once the finger has moved this far up or down.
    static let verticalLimit: CGFloat = 12

    /// UIKit starts the pan after about 10 pt of travel; it begins only if that travel went sideways.
    static func panBegins(_ translation: CGPoint) -> Bool {
        abs(translation.y) <= verticalLimit && abs(translation.y) <= abs(translation.x)
    }

    enum Release: Equatable {
        /// Off to `target` at a constant `speed`, taking `duration`.
        case fly(target: CGFloat, speed: CGFloat, duration: TimeInterval)
        /// Back to its place on the settle spring, carrying the finger's speed.
        case settle(velocity: CGFloat)
    }

    /// Dismissed past a quarter of its width, or faster than the flick speed in the direction of the
    /// drag; a flick against the drag counts for nothing.
    static func release(translation: CGFloat, velocity: CGFloat, width: CGFloat) -> Release {
        let direction: CGFloat = translation > 0 ? 1 : translation < 0 ? -1 : 0
        let along = velocity * direction
        guard direction != 0,
            abs(translation) > width * Tokens.Ratio.phoneToastDismiss || along > Tokens.Velocity.phoneToastFlick
        else { return .settle(velocity: velocity) }
        let target = direction * (width + flyOvershoot)
        let distance = abs(target - translation)
        let speed = max(along, distance / Tokens.Duration.phoneFly)
        return .fly(target: target, speed: speed, duration: distance / speed)
    }
}
