import SwiftUI

/// The glass sample over the theme, then Glass Transparency; both locked under Reduce
/// Transparency or Increase Contrast, where the system frosts its glass anyway.
struct GlassCard: View {
    let glass: GlassStyleStore

    var body: some View {
        GlassSample(style: glass.style, firm: glass.barEdge == .hard)
            .frame(height: Tokens.Size.phoneGlassSample)
            .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.phoneGlassSample, style: .continuous))
            .listRowInsets(EdgeInsets(
                top: Tokens.Space.space4, leading: Tokens.Space.space4, bottom: Tokens.Space.space4,
                trailing: Tokens.Space.space4))
            .listRowBackground(Color(Tokens.Color.phoneCard))
        TransparencySlider(glass: glass)
            .disabled(glass.reduced)
            .opacity(glass.reduced ? Tokens.Opacity.disabled : 1)
    }
}

/// A screen in miniature under Devot's glass: a bar with a back button and a title over three
/// rows, and the floating tab bar. It uses the glass Devot's own views use, never a second bar.
struct GlassSample: View {
    let style: GlassStyle
    let firm: Bool

    private static let bar: CGFloat = 44
    private static let control: CGFloat = 32
    private static let row: CGFloat = 14
    private static let tab = CGSize(width: 120, height: 28)

    var body: some View {
        ZStack(alignment: .top) {
            Color(Tokens.Color.phoneBackground)
            ScreenGlow()
            VStack(spacing: Tokens.Space.space3) {
                ForEach(0..<3, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: Tokens.Space.space3, style: .continuous)
                        .fill(Color(Tokens.Color.phoneCard))
                        .frame(height: Self.row)
                }
            }
            .padding(.horizontal, Tokens.Space.space6)
            .padding(.top, Self.bar / 2)
            HStack(spacing: Tokens.Space.space4) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(Tokens.Color.phoneText))
                    .frame(width: Self.control, height: Self.control)
                    .devotGlass(style, in: Circle())
                Text(L10n.phoneSettingsAppearanceSampleTitle()).settingsLabel().fontWeight(.semibold)
                Spacer()
            }
            .padding(.horizontal, Tokens.Space.space4)
            .frame(height: Self.bar)
            .background { if firm { Color(Tokens.Color.phoneBackground) } }
            Capsule()
                .frame(width: Self.tab.width, height: Self.tab.height)
                .foregroundStyle(.clear)
                .devotGlass(style, in: Capsule())
                .frame(maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, Tokens.Space.space4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.phoneSettingsAppearanceSampleLabel())
    }
}
