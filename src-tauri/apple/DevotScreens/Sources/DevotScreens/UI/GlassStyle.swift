import UIKit

/// How a piece of Devot's own glass is drawn (design/phone.md, Glass).
enum GlassLook: Equatable {
    case solid
    /// `tint`: the opacity of `color.phone.glass-opaque` over the glass, 0 for none.
    case regular(tint: CGFloat)
    case clear(tint: CGFloat)
}

/// Glass Transparency, from −100 (solid) through 0 (the system's regular glass) to 100 (the
/// clearest), and solid whenever Reduce Transparency or Increase Contrast is on.
@MainActor
enum GlassStyle {
    /// No stored setting yet, so the system's regular glass.
    static var transparency: () -> Double = { 0 }

    static func look(transparency: Double, reduceTransparency: Bool, increaseContrast: Bool) -> GlassLook {
        if reduceTransparency || increaseContrast || transparency <= -100 { return .solid }
        if transparency < 0 { return .regular(tint: CGFloat(-transparency / 100)) }
        if transparency == 0 { return .regular(tint: 0) }
        return .clear(tint: CGFloat(max(0, 0.25 - min(transparency, 100) / 400)))
    }

    static var current: GlassLook {
        look(
            transparency: transparency(), reduceTransparency: UIAccessibility.isReduceTransparencyEnabled,
            increaseContrast: UIAccessibility.isDarkerSystemColorsEnabled)
    }

    /// The notifications after which `current` may have changed.
    static let changes: [Notification.Name] = [
        UIAccessibility.reduceTransparencyStatusDidChangeNotification,
        UIAccessibility.darkerSystemColorsStatusDidChangeNotification,
    ]

    static func apply(_ look: GlassLook, to view: UIVisualEffectView, interactive: Bool) {
        let effect: UIGlassEffect
        let tint: CGFloat
        switch look {
        case .solid:
            view.effect = nil
            view.backgroundColor = Tokens.Color.phoneGlassOpaque
            return
        case .regular(let shade):
            effect = UIGlassEffect(style: .regular)
            tint = shade
        case .clear(let shade):
            effect = UIGlassEffect(style: .clear)
            tint = shade
        }
        effect.isInteractive = interactive
        effect.tintColor = tint > 0 ? Tokens.Color.phoneGlassOpaque.withAlphaComponent(tint) : nil
        view.backgroundColor = nil
        view.effect = effect
    }
}
