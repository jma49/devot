import SwiftUI

/// A card or swatch that gives under the finger: it scales down over the quick duration while
/// pressed and settles back on release; it holds still under Reduce Motion or Animations Off.
struct PressableCardStyle: ButtonStyle {
    static let card: CGFloat = 0.97
    static let swatch: CGFloat = 0.94

    var scale = PressableCardStyle.card
    let motion: MotionPolicy

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.pressScale(configuration.isPressed, scale, motion)
    }
}

/// Reports its press to a whole card drawn around it, so the card scales with its swatches on it.
struct PressReportingStyle: ButtonStyle {
    @Binding var pressed: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.onChange(of: configuration.isPressed) { pressed = $1 }
    }
}

extension View {
    func pressScale(_ pressed: Bool, _ scale: CGFloat, _ motion: MotionPolicy) -> some View {
        let still = motion.reduced
        let settle = Tokens.Spring.phoneSettle
        return scaleEffect(pressed && !still ? scale : 1)
            .animation(
                still
                    ? nil
                    : pressed
                        ? .easeOut(duration: Tokens.Duration.quick)
                        : .spring(response: settle.response, dampingFraction: settle.dampingRatio),
                value: pressed)
    }
}
