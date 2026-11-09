import SwiftUI
import UIKit

/// The grouped list's type (design/layout.md, Phone grouped lists): labels 16/23, descriptions,
/// values and footers 14/19, scaled with Dynamic Type from the body style; the sheets' titles 20
/// bold from the title 3 style and bodies 16/24.
private struct SettingsType: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var line: CGFloat = 23
    private let weight: Font.Weight
    private let secondary: Bool
    private let color: UIColor?

    init(size: CGFloat, line: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body,
        secondary: Bool, color: UIColor? = nil) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        _line = ScaledMetric(wrappedValue: line, relativeTo: style)
        self.weight = weight
        self.secondary = secondary
        self.color = color
    }

    func body(content: Content) -> some View {
        content
            .font(.system(size: size, weight: weight))
            .lineSpacing(max(0, line - UIFont.systemFont(ofSize: size, weight: weight.uiKit).lineHeight))
            .foregroundStyle(Color(color ?? (secondary ? Tokens.Color.phoneTextSecondary : Tokens.Color.phoneText)))
    }
}

extension Font.Weight {
    fileprivate var uiKit: UIFont.Weight {
        switch self {
        case .bold: .bold
        case .medium: .medium
        default: .regular
        }
    }
}

extension View {
    func settingsLabel() -> some View { modifier(SettingsType(size: 16, line: 23, secondary: false)) }
    func settingsDetail() -> some View { modifier(SettingsType(size: 14, line: 19, secondary: true)) }
    func sheetTitle() -> some View {
        modifier(SettingsType(size: 20, line: 25, weight: .bold, relativeTo: .title3, secondary: false))
    }
    func sheetBody() -> some View { modifier(SettingsType(size: 16, line: 24, secondary: true)) }
    /// A card's name under its picture: 16/23 medium, its colour the only thing a choice changes.
    func cardLabel(_ color: UIColor) -> some View {
        modifier(SettingsType(size: 16, line: 23, weight: .medium, secondary: false, color: color))
    }
    /// A slider's value beside its name: 14/19 medium in tabular figures.
    func sliderValue() -> some View {
        modifier(SettingsType(size: 14, line: 19, weight: .medium, secondary: true)).monospacedDigit()
    }
    /// A short sheet's one line, in the primary text colour: the sheet's material lets the list through.
    func sheetMessage() -> some View { modifier(SettingsType(size: 16, line: 24, secondary: false)) }

    /// A row on the grouped card, at least the row's height.
    func settingsRow(described: Bool = false) -> some View {
        frame(
            maxWidth: .infinity,
            minHeight: (described ? Tokens.Size.phoneGroupedMinDescribed : Tokens.Size.phoneGroupedMin)
                - 2 * Tokens.Size.phoneGroupedPadY,
            alignment: .leading
        )
        .listRowBackground(Color(Tokens.Color.phoneCard))
    }
}

/// A label with at most one short description under it.
struct RowText: View {
    let title: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space2) {
            Text(title).settingsLabel()
            if let detail { Text(detail).settingsDetail() }
        }
    }
}

/// A row that opens a page: its value, then the disclosure chevron.
struct NavigationRow: View {
    var symbol: String?
    let title: String
    var detail: String?
    var value: String?
    var badge = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Size.phoneGroupedGap) {
                if let symbol {
                    Image(systemName: symbol)
                        .foregroundStyle(Color(Tokens.Color.phoneText))
                        .frame(width: Tokens.Size.phoneRowIcon)
                }
                RowText(title: title, detail: detail)
                Spacer(minLength: 0)
                if let value {
                    Text(value).settingsDetail().lineLimit(1)
                }
                if badge {
                    Text(verbatim: "!").font(.caption.bold()).foregroundStyle(Color(Tokens.Color.phoneOnAction))
                        .frame(minWidth: Tokens.Size.phoneBadge, minHeight: Tokens.Size.phoneBadge)
                        .background(Circle().fill(Color(Tokens.Color.phoneBadge)))
                        .accessibilityLabel(L10n.phoneBadgeAttention())
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(Tokens.Color.phoneChevron))
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .settingsRow(described: detail != nil)
    }
}

struct ToggleRow: View {
    let title: String
    var detail: String?
    let isOn: Bool
    let set: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { isOn }, set: set)) {
            RowText(title: title, detail: detail)
        }
        .tint(Color(Tokens.Color.accentFill))
        .settingsRow(described: detail != nil)
    }
}

/// An action: no chevron, its label tinted, and its outcome as its value.
struct ActionRow: View {
    let title: String
    var value: String?
    var destructive = false
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).settingsLabel()
                    .foregroundStyle(Color(destructive ? Tokens.Color.phoneDestructive : Tokens.Color.accentText))
                Spacer(minLength: Tokens.Size.phoneGroupedGap)
                if let value { Text(value).settingsDetail().lineLimit(2).multilineTextAlignment(.trailing) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .settingsRow()
    }
}

/// A section's header over its card, as written, in place of the system's fainter, uppercased header style.
struct Header: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).modifier(SettingsType(size: 14, line: 19, weight: .medium, secondary: true)).textCase(nil)
    }
}

/// A footer under a card, on the keyline.
struct Footer: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).settingsDetail()
    }
}

/// A pane's one-line problem, as the page shows it above the pane.
struct ProblemRow: View {
    let text: String

    var body: some View {
        Text(text).settingsDetail().foregroundStyle(Color(Tokens.Color.phoneDestructive))
            .accessibilityAddTraits(.updatesFrequently)
            .listRowBackground(Color(Tokens.Color.phoneCard))
    }
}

enum SheetMetrics {
    static let gap = Tokens.Size.phoneGroupGap
    static let lens: CGFloat = 56
}

/// The sheet's round head: a symbol on the lens colour.
struct SheetLens: View {
    let symbol: String?

    init(symbol: String) { self.symbol = symbol }

    /// The lens with Devot's dove in place of a symbol.
    static var dove: SheetLens { SheetLens(nil) }

    private init(_ symbol: String?) { self.symbol = symbol }

    var body: some View {
        mark
            .frame(width: SheetMetrics.lens, height: SheetMetrics.lens)
            .background(Circle().fill(Color(Tokens.Color.phoneLens)))
            .accessibilityHidden(true)
    }

    @ViewBuilder private var mark: some View {
        if let symbol {
            Image(systemName: symbol).font(.title2).foregroundStyle(Color(Tokens.Color.accentText))
        } else {
            Image(Brand.dove, bundle: .module).resizable().scaledToFit().padding(SheetMetrics.lens / 4)
        }
    }
}

/// A sheet's full-width action; the prominent one is the sheet's one primary action.
struct SheetButton: View {
    let title: String
    var detail: String?
    var prominent = true
    let action: () -> Void

    var body: some View {
        let label = HStack {
            Text(title).font(.headline)
            if let detail { Text(detail).font(.subheadline) }
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.phoneSheetDone)
        if prominent {
            Button(action: action) { label.foregroundStyle(Color(Tokens.Color.accentOnFill)) }
                .buttonStyle(.glassProminent).tint(Color(Tokens.Color.accentFill))
        } else {
            Button(action: action) { label }.buttonStyle(.glass)
        }
    }
}

/// A Settings page pushed on the Settings stack, under an inline title.
final class SettingsHosting<Content: View>: UIHostingController<Content> {
    /// Runs once the page has left the stack; a cancelled back swipe never runs it.
    var left: () -> Void = {}
    private(set) var placeKeeper: PlaceKeeper?

    init(title: String, _ content: Content) {
        super.init(rootView: content)
        navigationItem.title = title
        navigationItem.largeTitleDisplayMode = .never
    }

    @MainActor required dynamic init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        followTheme { [weak self] in self?.view.backgroundColor = Tokens.Color.phoneBackground }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if placeKeeper == nil, let list = view.firstSubview(of: UICollectionView.self) {
            placeKeeper = PlaceKeeper(list)
        }
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { left() }
    }
}

extension View {
    /// The grouped list on the phone's background, and the one-line alert of a refused write.
    func settingsPage(_ store: SettingsStore, glow: Bool = false) -> some View {
        // The tab bar's scroll edge effect would otherwise fade a pane's last footer even at the foot.
        contentMargins(.bottom, Tokens.Size.phoneTabEdge, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .background(alignment: .top) {
                ZStack(alignment: .top) {
                    Color(Tokens.Color.phoneBackground)
                    if glow { ScreenGlow() }
                }
                .ignoresSafeArea()
            }
            .scrollEdgeEffectStyle(GlassStyleStore.shared.barEdge.swiftUI, for: [.top, .bottom])
            .alert(
                store.failure ?? "",
                isPresented: Binding(get: { store.failure != nil }, set: { if !$0 { store.failure = nil } })
            ) {
                Button(L10n.phoneSettingsAlertOk(), role: .cancel) {}
            }
    }
}

/// A catalog string by its key, for the keys a table of settings names.
func catalog(_ key: String) -> String {
    L10n.text(key, key)
}
