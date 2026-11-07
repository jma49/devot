import SwiftUI

/// Auto, Light and Dark as three mini phones drawn in the chosen themes.
struct SchemeCards: View {
    let store: SettingsStore
    let themes: ThemeStore
    @Environment(\.dynamicTypeSize) private var type

    static let schemes = ["system", "light", "dark"]
    private static let border: CGFloat = 1.5

    var body: some View {
        let current = store.editor["appearance"]?.string ?? "system"
        let motion = MotionPolicy(editor: store.editor)
        let layout = type.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: Tokens.Space.space4))
            : AnyLayout(HStackLayout(spacing: Tokens.Space.space4))
        layout {
            ForEach(Self.schemes, id: \.self) { scheme in
                card(scheme, selected: scheme == current, stacked: type.isAccessibilitySize)
                    .buttonStyle(PressableCardStyle(motion: motion))
            }
        }
        .sensoryFeedback(.selection, trigger: current)
    }

    private func card(_ scheme: String, selected: Bool, stacked: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.phoneGroupedCard, style: .continuous)
        let label = Text(catalog("appearanceSettings.\(scheme)"))
            .cardLabel(selected ? Tokens.Color.phoneText : Tokens.Color.phoneTextSecondary)
        return Button {
            store.setEditor("appearance", .string(scheme))
        } label: {
            Group {
                if stacked {
                    HStack(spacing: Tokens.Size.phoneGroupedGap) {
                        mini(scheme)
                        label
                        Spacer(minLength: 0)
                    }
                } else {
                    VStack(spacing: Tokens.Space.space4) {
                        mini(scheme)
                        label.lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(Tokens.Space.space4)
            .frame(minHeight: Tokens.Size.phoneSchemeCard)
            .background(shape.fill(Color(Tokens.Color.phoneCard)))
            .overlay {
                if selected { shape.strokeBorder(Color(Tokens.Color.accentFill), lineWidth: Tokens.Size.phoneThemeRing) }
            }
            .contentShape(shape)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func mini(_ scheme: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.phoneSchemeMini, style: .continuous)
        let light = ThemeSwatch(theme: themes.light, style: .light, strength: themes.gradientStrength)
        let dark = ThemeSwatch(theme: themes.dark, style: .dark, strength: themes.gradientStrength)
        return ZStack {
            MiniScreen(swatch: scheme == "dark" ? dark : light)
            if scheme == "system" {
                MiniScreen(swatch: dark).mask(alignment: .trailing) {
                    Rectangle().frame(width: Tokens.Size.phoneSchemeMiniWidth / 2)
                }
                Rectangle().fill(Color(light.separator)).frame(width: Tokens.Size.phoneSeparator)
            }
        }
        .frame(width: Tokens.Size.phoneSchemeMiniWidth, height: Tokens.Size.phoneSchemeMiniHeight)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color(light.separator), lineWidth: Self.border))
        .accessibilityHidden(true)
    }
}

/// A phone screen in miniature: a bar with the accent, three lines of text, a block and the tab bar.
struct MiniScreen: View {
    let swatch: ThemeSwatch

    private static let lines: [CGFloat] = [0.6, 0.8, 0.5]

    var body: some View {
        ZStack(alignment: .top) {
            Color(swatch.background)
            ThemeGlow(colors: swatch.glow)
            GeometryReader { geometry in
                let inner = geometry.size.width - 2 * Tokens.Space.space3
                VStack(alignment: .leading, spacing: Tokens.Space.space2) {
                    HStack {
                        Spacer()
                        Circle().fill(Color(swatch.accent)).frame(width: 6, height: 6)
                    }
                    .frame(height: 14)
                    ForEach(Self.lines, id: \.self) { share in
                        Capsule().fill(Color(swatch.secondary)).frame(width: inner * share, height: 4)
                    }
                    RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Color(swatch.card)).frame(height: 10)
                    Spacer(minLength: 0)
                    Capsule().fill(Color(swatch.card)).frame(height: 7).padding(.horizontal, Tokens.Space.space3)
                }
                .padding(Tokens.Space.space3)
            }
        }
    }
}
