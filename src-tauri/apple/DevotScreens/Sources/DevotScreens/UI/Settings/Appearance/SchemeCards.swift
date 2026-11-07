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
                SchemeCard(
                    title: catalog("appearanceSettings.\(scheme)"), selected: scheme == current,
                    stacked: type.isAccessibilitySize, motion: motion, mini: mini(scheme)
                ) { store.setEditor("appearance", .string(scheme)) }
            }
        }
        .sensoryFeedback(.selection, trigger: current)
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

/// One scheme's card: its mini phone over its name. The named button covers only the name, since
/// the contrast audit reads everything a button draws as its text and a light mini phone on the
/// card fails as text; the card under it is a second touch target for the same choice, out of the
/// accessibility tree so VoiceOver meets the scheme once, by its name.
private struct SchemeCard<Mini: View>: View {
    let title: String
    let selected: Bool
    let stacked: Bool
    let motion: MotionPolicy
    let mini: Mini
    let pick: () -> Void
    @State private var pressed = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.phoneGroupedCard, style: .continuous)
        let preview = mini.allowsHitTesting(false)
        Group {
            if stacked {
                HStack(spacing: Tokens.Size.phoneGroupedGap) {
                    preview
                    name(alignment: .leading)
                }
                .padding(Tokens.Space.space4)
            } else {
                VStack(spacing: 0) {
                    preview
                    name(alignment: .center).lineLimit(1).minimumScaleFactor(0.8)
                }
                .padding([.top, .horizontal], Tokens.Space.space4)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.phoneSchemeCard)
        .background {
            Button(action: pick) { shape.fill(Color(Tokens.Color.phoneCard)) }
                .buttonStyle(PressReportingStyle(pressed: $pressed))
                .accessibilityHidden(true)
        }
        .overlay {
            if selected {
                shape.strokeBorder(Color(Tokens.Color.accentFill), lineWidth: Tokens.Size.phoneThemeRing)
                    .allowsHitTesting(false)
            }
        }
        .pressScale(pressed, PressableCardStyle.card, motion)
    }

    private func name(alignment: Alignment) -> some View {
        Button(action: pick) {
            Text(title).cardLabel(selected ? Tokens.Color.phoneText : Tokens.Color.phoneTextSecondary)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.phoneTarget, alignment: alignment)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressReportingStyle(pressed: $pressed))
        .accessibilityAddTraits(selected ? .isSelected : [])
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
