import SwiftUI

/// A slider named on a line above its track, its value on the right (design/layout.md, Phone
/// grouped lists): a selection tick per step, and `released` once the finger lifts.
struct LabelledSlider: View {
    let title: String
    let value: String
    @Binding var amount: Double
    let range: ClosedRange<Double>
    let step: Double
    var minimum: SliderEnd?
    var maximum: SliderEnd?
    let released: () -> Void

    enum SliderEnd {
        case caption(String)
        case symbol(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space2) {
            HStack {
                Text(title).settingsLabel()
                Spacer(minLength: Tokens.Size.phoneGroupedGap)
                Text(value).sliderValue()
            }
            .accessibilityHidden(true)
            Slider(value: $amount, in: range, step: step) {
                Text(title)
            } minimumValueLabel: {
                end(minimum)
            } maximumValueLabel: {
                end(maximum)
            } onEditingChanged: { editing in
                if !editing { released() }
            }
            .tint(Color(Tokens.Color.accentFill))
            .frame(minHeight: Tokens.Size.phoneGroupedRow)
            .accessibilityValue(value)
        }
        .sensoryFeedback(.selection, trigger: amount)
        .settingsRow()
    }

    @ViewBuilder private func end(_ end: SliderEnd?) -> some View {
        switch end {
        case .caption(let text): Text(text).settingsDetail()
        case .symbol(let name):
            Image(systemName: name).foregroundStyle(Color(Tokens.Color.phoneTextSecondary)).accessibilityHidden(true)
        case nil: EmptyView()
        }
    }
}

/// Glass Transparency: each step applies at once, the release stores it on this iPhone.
struct TransparencySlider: View {
    let glass: GlassStyleStore

    var body: some View {
        LabelledSlider(
            title: L10n.phoneAppearanceTransparency(), value: Self.signed(glass.transparency),
            amount: Binding(get: { Double(glass.transparency) }, set: { glass.apply(Int($0.rounded())) }),
            range: Double(GlassStyle.range.lowerBound)...Double(GlassStyle.range.upperBound),
            step: Double(GlassStyle.step),
            minimum: .caption(L10n.phoneAppearanceSolid()), maximum: .caption(L10n.phoneAppearanceClear()),
            released: glass.commit)
    }

    static func signed(_ value: Int) -> String {
        value.formatted(.number.sign(strategy: .always(includingZero: false)))
    }
}
