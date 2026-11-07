import SwiftUI

/// The glow a theme paints at the top of a list screen: one soft ellipse from each top corner,
/// fading out over `depth` (half the view's height when it is nil).
struct ThemeGlow: View {
    let colors: [UIColor]
    var depth: CGFloat?

    private static let fade: [(CGFloat, CGFloat)] = [(1, 0), (0.7, 0.25), (0.38, 0.5), (0.14, 0.75), (0.04, 0.9), (0, 1)]

    var body: some View {
        if colors.count == 2 {
            GeometryReader { geometry in
                let width = geometry.size.width * 3
                let height = 2 * (depth ?? geometry.size.height / 2)
                ZStack {
                    corner(colors[0]).frame(width: width, height: height).position(x: 0, y: 0)
                    corner(colors[1]).frame(width: width, height: height).position(x: geometry.size.width, y: 0)
                }
            }
            .clipped()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private func corner(_ color: UIColor) -> some View {
        EllipticalGradient(
            stops: Self.fade.map { Gradient.Stop(color: Color(color).opacity($0.0), location: $0.1) },
            center: .center)
    }
}

/// The glow of the theme in effect, behind a root screen.
struct ScreenGlow: View {
    @Environment(\.colorScheme) private var scheme
    static let depth: CGFloat = 360

    var body: some View {
        let themes = ThemeStore.shared
        let dark = scheme == .dark
        ThemeGlow(
            colors: ThemeSwatch(
                theme: dark ? themes.dark : themes.light, style: dark ? .dark : .light,
                strength: themes.gradientStrength
            ).glow,
            depth: Self.depth)
    }
}
