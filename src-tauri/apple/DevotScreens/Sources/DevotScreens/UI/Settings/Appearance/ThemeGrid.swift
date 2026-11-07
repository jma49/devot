import SwiftUI

/// The six themes as cards, each with its light and its dark swatch: the card sets both, a swatch
/// sets its own appearance.
struct ThemeGrid: View {
    let store: SettingsStore
    let themes: ThemeStore
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        let spacing = Tokens.Space.space6
        let columns = Array(
            repeating: GridItem(.flexible(), spacing: spacing), count: type.isAccessibilitySize ? 1 : 2)
        LazyVGrid(columns: columns, spacing: spacing) {
            ForEach(Tokens.Theme.all, id: \.id) { theme in
                ThemeCard(
                    theme: theme, light: themes.light == theme, dark: themes.dark == theme,
                    strength: themes.gradientStrength, motion: MotionPolicy(editor: store.editor)
                ) { store.setEditor($0) }
            }
        }
        .sensoryFeedback(.selection, trigger: [themes.light.id, themes.dark.id])
    }

    static func name(_ theme: Tokens.Theme) -> String {
        catalog("appearanceSettings.theme\(theme.id.prefix(1).uppercased())\(theme.id.dropFirst())")
    }
}

private struct ThemeCard: View {
    let theme: Tokens.Theme
    let light: Bool
    let dark: Bool
    let strength: Double
    let motion: MotionPolicy
    let pick: ([String: JSONValue]) -> Void
    @State private var pressed = false
    /// The badge keeps its size as the swatch it marks does.
    private static let badgeSymbol: CGFloat = 12

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.phoneGroupedCard, style: .continuous)
        let name = ThemeGrid.name(theme)
        let both = light && dark
        ZStack(alignment: .top) {
            Button {
                pick(["lightTheme": .string(theme.id), "darkTheme": .string(theme.id)])
            } label: {
                shape.fill(Color(Tokens.Color.phoneCard))
                    .overlay(shape.strokeBorder(Color(Tokens.Color.phoneSeparator), lineWidth: Tokens.Size.phoneSeparator))
                    .overlay(alignment: .bottom) {
                        if (ProcessInfo.processInfo.environment["DEVOTDIAG"] ?? "").contains("nonames") { Color.clear.frame(height: 23).padding(.bottom, Tokens.Space.space7) } else {
                        Text(name).cardLabel(both ? Tokens.Color.accentText : Tokens.Color.phoneText)
                            .lineLimit(1)
                            .padding(.bottom, Tokens.Space.space7) }
                    }
                    .contentShape(shape)
            }
            .buttonStyle(PressReportingStyle(pressed: $pressed))
            .accessibilityLabel(name)
            .accessibilityHint(L10n.phoneSettingsAppearanceThemeBothHint())
            .accessibilityAddTraits(both ? .isSelected : [])
            HStack(spacing: Tokens.Space.space4) {
                swatch(.light, chosen: light, label: L10n.phoneSettingsAppearanceThemeLight(theme: name))
                swatch(.dark, chosen: dark, label: L10n.phoneSettingsAppearanceThemeDark(theme: name))
            }
            .padding(.top, Tokens.Space.space7)
        }
        .frame(minHeight: height)
        .pressScale(pressed, PressableCardStyle.card, motion)
    }

    @ScaledMetric(relativeTo: .body) private var labelHeight: CGFloat = 23
    /// Padding above the swatches, between them and the name, and under the name.
    private var height: CGFloat { 3 * Tokens.Space.space7 + Tokens.Size.phoneSwatchBox + labelHeight }

    private func swatch(_ style: UIUserInterfaceStyle, chosen: Bool, label: String) -> some View {
        Button {
            pick([style == .dark ? "darkTheme" : "lightTheme": .string(theme.id)])
        } label: {
            ZStack {
                if chosen {
                    Circle().strokeBorder(Color(Tokens.Color.accentFill), lineWidth: Tokens.Size.phoneSwatchRing)
                }
                ThemeSwatchView(swatch: ThemeSwatch(theme: theme, style: style, strength: strength))
                    .frame(width: Tokens.Size.phoneSwatch, height: Tokens.Size.phoneSwatch)
            }
            .frame(width: Tokens.Size.phoneSwatchBox, height: Tokens.Size.phoneSwatchBox)
            .overlay(alignment: .bottomTrailing) {
                if chosen {
                    Image(systemName: style == .dark ? "moon" : "sun.max")
                        .resizable().scaledToFit().fontWeight(.medium)
                        .frame(width: Self.badgeSymbol, height: Self.badgeSymbol)
                        .foregroundStyle(Color(Tokens.Color.phoneText))
                        .frame(width: Tokens.Size.phoneSwatchBadge, height: Tokens.Size.phoneSwatchBadge)
                        .background(Circle().fill(Color(Tokens.Color.phoneElevated)))
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(PressableCardStyle(scale: PressableCardStyle.swatch, motion: motion))
        .accessibilityLabel(label)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// One appearance of a theme: its background and glow, "Aa" in its text colour and its accent dot.
struct ThemeSwatchView: View {
    let swatch: ThemeSwatch

    var body: some View {
        Circle().fill(Color(swatch.background))
            .overlay { ThemeGlow(colors: swatch.glow).clipShape(Circle()) }
            .overlay {
                if (ProcessInfo.processInfo.environment["DEVOTDIAG"] ?? "").contains("noaa") { Color.clear } else if (ProcessInfo.processInfo.environment["DEVOTDIAG"] ?? "").contains("aacanvas") {
                    Canvas { context, size in
                        context.draw(context.resolve(Text(verbatim: "Aa").font(.system(size: 20, weight: .semibold)).foregroundStyle(Color(swatch.text))), at: CGPoint(x: size.width / 2, y: size.height / 2))
                    }
                } else {
                TextPicture(text: "Aa", font: .system(size: 20, weight: .semibold), color: swatch.text, wraps: false) }
            }
            .overlay(alignment: .bottomTrailing) {
                Circle().fill(Color(swatch.accent)).frame(width: 10, height: 10).padding(Tokens.Space.space4)
            }
            .overlay(Circle().strokeBorder(Color(swatch.separator), lineWidth: Tokens.Size.phoneSeparator))
            .accessibilityHidden(true)
    }
}
