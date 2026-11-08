import Observation
import UIKit

/// The theme in effect: the light theme's colours in light, the dark theme's in dark, and the
/// theme and colour scheme on every window. It changes before Rust hears of a change, so a pick shows in
/// the next frame.
@MainActor
@Observable
final class ThemeStore {
    static let shared = ThemeStore()

    private(set) var light: Tokens.Theme = .default
    private(set) var dark: Tokens.Theme = .default
    private(set) var scheme = "system"
    /// 0 is the base colour alone and 100 the full glow, for the gradient themes only.
    private(set) var gradientStrength: Double = 0
    @ObservationIgnored private let windows: @MainActor () -> [UIWindow]

    nonisolated static let gradientThemes: Set<String> = ["dawn", "tide", "sage", "ember"]
    nonisolated static let gradientStrengthMax: Double = 100

    init(windows: @escaping @MainActor () -> [UIWindow] = ThemeStore.sceneWindows) {
        self.windows = windows
    }

    var gradientShown: Bool { Self.gradientThemes.contains(light.id) || Self.gradientThemes.contains(dark.id) }

    func adopt(_ editor: [String: JSONValue]) {
        let light = editor["lightTheme"]?.string.flatMap { Tokens.Theme($0) } ?? .default
        let dark = editor["darkTheme"]?.string.flatMap { Tokens.Theme($0) } ?? .default
        let strength = min(Self.gradientStrengthMax, max(0, editor["gradientStrength"]?.number ?? 0))
        let scheme = editor["appearance"]?.string ?? "system"
        if scheme != self.scheme || windows().contains(where: { $0.overrideUserInterfaceStyle != Self.style(scheme) }) {
            self.scheme = scheme
            for window in windows() { window.overrideUserInterfaceStyle = Self.style(scheme) }
        }
        if light != self.light || dark != self.dark {
            self.light = light
            self.dark = dark
            Tokens.Theme.current = Self.composite(light: light, dark: dark)
        }
        for window in windows() where window.traitCollection[Tokens.ThemeTrait.self] != Tokens.Theme.current {
            window.traitOverrides[Tokens.ThemeTrait.self] = Tokens.Theme.current
        }
        if strength != gradientStrength { gradientStrength = strength }
    }

    /// The Gradient slider's value while it is dragged; the release writes it and `adopt` takes it back.
    func preview(strength: Double) {
        gradientStrength = min(Self.gradientStrengthMax, max(0, strength))
    }

    static func style(_ scheme: String) -> UIUserInterfaceStyle {
        switch scheme {
        case "light": .light
        case "dark": .dark
        default: .unspecified
        }
    }

    static func composite(light: Tokens.Theme, dark: Tokens.Theme) -> Tokens.Theme {
        if light == dark { return light }
        let backdrop = Tokens.Backdrop(
            angle: light.backdrop?.angle ?? dark.backdrop?.angle ?? 0,
            light: light.backdrop?.light ?? [], dark: dark.backdrop?.dark ?? [])
        return Tokens.Theme(
            id: "\(light.id)+\(dark.id)", light: light.light, dark: dark.dark,
            backdrop: light.backdrop == nil && dark.backdrop == nil ? nil : backdrop,
            glow: Tokens.Glow(light: light.glow?.light ?? [], dark: dark.glow?.dark ?? []))
    }

    static func sceneWindows() -> [UIWindow] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    }
}

/// What a theme looks like in one appearance, drawn from its own colours rather than the theme in
/// effect.
struct ThemeSwatch {
    let background: UIColor
    let card: UIColor
    let separator: UIColor
    let text: UIColor
    let secondary: UIColor
    let accent: UIColor
    /// The glow's top-left and top-right colours; none without a glow, or at strength 0.
    let glow: [UIColor]

    init(theme: Tokens.Theme, style: UIUserInterfaceStyle, strength: Double) {
        let traits = UITraitCollection(userInterfaceStyle: style)
        let color = { (name: Tokens.ColorName) in theme.color(name).resolvedColor(with: traits) }
        background = color(.phoneBackground)
        card = color(.phoneCard)
        separator = color(.phoneSeparator)
        text = color(.phoneText)
        secondary = color(.phoneTextSecondary)
        accent = color(.accentFill)
        let stops = style == .dark ? theme.glow?.dark ?? [] : theme.glow?.light ?? []
        let scale = ThemeStore.gradientThemes.contains(theme.id) ? strength / ThemeStore.gradientStrengthMax : 1
        glow = scale > 0 ? stops.map { $0.uiColor.withAlphaComponent($0.alpha * scale) } : []
    }
}

/// Runs `apply` now and again after each change to what it read: UIKit colours are resolved when
/// set, so a bar's tint is set again when the theme changes.
@MainActor func followTheme(_ apply: @escaping @MainActor () -> Void) {
    withObservationTracking(apply) {
        Task { @MainActor in followTheme(apply) }
    }
}
