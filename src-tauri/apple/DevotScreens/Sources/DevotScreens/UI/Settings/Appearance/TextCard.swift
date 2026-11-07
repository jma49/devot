import SwiftUI

/// The Note Font's sample at Text Size, a second line at Preview Font Size, and a slider for each.
/// The sample follows every step; Rust hears of the size when the finger lifts.
struct TextCard: View {
    let store: SettingsStore
    @State private var size: Double?
    @State private var preview: Double?

    static let range: ClosedRange<Double> = 10...32
    static let defaultSize: Double = 13
    static let defaultPreview: Double = 15

    var body: some View {
        let fontSize = size ?? store.editor["fontSize"]?.number ?? Self.defaultSize
        let previewSize = preview ?? store.editor["previewFontSize"]?.number ?? Self.defaultPreview
        VStack(alignment: .leading, spacing: Tokens.Space.space4) {
            TextPicture(
                text: L10n.phoneSettingsAppearanceSample(), font: NoteFont(editor: store.editor).font(size: fontSize),
                color: Tokens.Color.phoneText)
            TextPicture(
                text: L10n.phoneSettingsAppearanceSamplePreview(), font: .system(size: previewSize),
                color: Tokens.Color.phoneTextSecondary)
        }
        .padding(.vertical, Tokens.Space.space4)
        .settingsRow()
        slider(L10n.phoneAppearanceTextSize(), "fontSize", $size, fontSize)
        slider(catalog("appearanceSettings.previewFontSize"), "previewFontSize", $preview, previewSize)
    }

    private func slider(_ title: String, _ key: String, _ dragged: Binding<Double?>, _ value: Double) -> some View {
        LabelledSlider(
            title: title, value: L10n.phoneSettingsAppearancePoints(size: value.formatted(.number.precision(.fractionLength(0)))),
            amount: Binding(get: { value }, set: { dragged.wrappedValue = $0 }),
            range: Self.range, step: 1,
            minimum: .symbol("textformat.size.smaller"), maximum: .symbol("textformat.size.larger")
        ) {
            if let final = dragged.wrappedValue { store.setEditor(key, .number(final)) }
            dragged.wrappedValue = nil
        }
    }
}

/// From a solid colour to the theme's full gradient, shown while either appearance has a gradient theme.
struct GradientCard: View {
    let store: SettingsStore
    let themes: ThemeStore
    @State private var dragged: Double?

    var body: some View {
        let value = dragged ?? themes.gradientStrength
        LabelledSlider(
            title: catalog("appearanceSettings.gradient"),
            value: value.formatted(.number.precision(.fractionLength(0))),
            amount: Binding(get: { value }, set: { dragged = $0; themes.preview(strength: $0) }),
            range: 0...ThemeStore.gradientStrengthMax, step: Double(GlassStyle.step),
            minimum: .caption(L10n.phoneAppearanceSolid()), maximum: .caption(L10n.phoneAppearanceGradientFull())
        ) {
            if let final = dragged { store.setEditor("gradientStrength", .number(final)) }
            dragged = nil
        }
    }
}

/// The note's typeface as the editor draws it, for the samples and the Note Font page.
struct NoteFont {
    let family: String
    let installed: String?

    static let families = ["system", "mono", "menlo", "monaco", "courierNew"]

    init(editor: [String: JSONValue]) {
        family = editor["fontFamily"]?.string ?? "mono"
        installed = editor["installedFont"]?.string
    }

    init(family: String, installed: String? = nil) {
        self.family = family
        self.installed = installed
    }

    /// An imported file is drawn in the system face: the web view loads its bytes, UIKit does not.
    func font(size: CGFloat) -> Font {
        switch family {
        case "mono": .system(size: size, design: .monospaced)
        case "menlo": .custom("Menlo", fixedSize: size)
        case "monaco": .custom("Monaco", fixedSize: size)
        case "courierNew": .custom("Courier New", fixedSize: size)
        case "installed": installed.map { .custom($0, fixedSize: size) } ?? .system(size: size)
        default: .system(size: size)
        }
    }
}
