import UIKit

/// One button of the editor's glass bars: 44 × 44 pt, a symbol and a label from the catalog.
@MainActor
enum BarButton {
    static func make(symbol: String, label: String, action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: symbol)
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .body)
        configuration.baseForegroundColor = Tokens.Color.phoneText
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        button.accessibilityLabel = label
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            button.heightAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
        ])
        return button
    }
}

/// A glass shape of the editor's bars over its float shadow, drawn as `GlassStyle` says.
@MainActor
final class GlassPiece {
    let glass = UIVisualEffectView(effect: nil)
    let shadow = FloatShadowView()

    init() {
        glass.cornerConfiguration = .capsule()
        glass.clipsToBounds = true
        glass.translatesAutoresizingMaskIntoConstraints = false
        shadow.translatesAutoresizingMaskIntoConstraints = false
    }

    /// The shadow sits in `host`, under the container that holds the glass, and keeps to its frame.
    func shade(in host: UIView, below container: UIView) {
        host.insertSubview(shadow, belowSubview: container)
        NSLayoutConstraint.activate([
            shadow.topAnchor.constraint(equalTo: glass.topAnchor), shadow.bottomAnchor.constraint(equalTo: glass.bottomAnchor),
            shadow.leadingAnchor.constraint(equalTo: glass.leadingAnchor),
            shadow.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
        ])
    }

    func layout() {
        shadow.cornerRadius = glass.bounds.height / 2
    }
}

/// The glass bars on the keyboard (design/motion.md, Formatting bar on the keyboard): pinned to
/// the keyboard layout guide, so they ride the keyboard's own curve and an interactive dismissal.
@MainActor
class KeyboardBar: UIView {
    /// One glass container, so the pieces in it read as one group.
    let container: UIVisualEffectView = {
        let effect = UIGlassContainerEffect()
        effect.spacing = Tokens.Space.space6
        return UIVisualEffectView(effect: effect)
    }()
    private(set) var pieces: [GlassPiece] = []
    private(set) var look: GlassLook = .regular(tint: 0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: topAnchor), container.bottomAnchor.constraint(equalTo: bottomAnchor),
            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        for name in GlassStyle.changes {
            NotificationCenter.default.addObserver(self, selector: #selector(glassChanged), name: name, object: nil)
        }
    }

    required init?(coder: NSCoder) { nil }

    @objc private func glassChanged() {
        applyGlass(GlassStyle.current)
    }

    func add(_ piece: GlassPiece) {
        pieces.append(piece)
        container.contentView.addSubview(piece.glass)
        piece.shade(in: self, below: container)
    }

    func applyGlass(_ next: GlassLook) {
        look = next
        for piece in pieces { GlassStyle.apply(next, to: piece.glass, interactive: true) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for piece in pieces { piece.layout() }
    }

    /// Above the keyboard by the sheet inset, between the screen's edges; it follows an undocked keyboard too.
    func pin(in host: UIView) {
        translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(self)
        host.keyboardLayoutGuide.followsUndockedKeyboard = true
        let safe = host.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: Tokens.Size.phoneScreenEdge),
            trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -Tokens.Size.phoneScreenEdge),
            bottomAnchor.constraint(equalTo: host.keyboardLayoutGuide.topAnchor, constant: -Tokens.Size.phoneSheetInset),
        ])
        applyGlass(GlassStyle.current)
    }
}

/// The formatting capsule and the Hide Keyboard circle. Its buttons send `editor.format`; they
/// never take the keyboard from the page.
@MainActor
final class FormattingBar: KeyboardBar {
    struct Format {
        let id: String
        let symbol: String
        let label: String
    }

    static var formats: [Format] {
        [
            Format(id: "heading", symbol: "textformat.size", label: L10n.formatHeading()),
            Format(id: "bold", symbol: "bold", label: L10n.formatBold()),
            Format(id: "italic", symbol: "italic", label: L10n.formatItalic()),
            Format(id: "taskList", symbol: "checklist", label: L10n.formatTaskList()),
            Format(id: "code", symbol: "chevron.left.forwardslash.chevron.right", label: L10n.formatCode()),
            Format(id: "link", symbol: "link", label: L10n.formatLink()),
        ]
    }

    let capsule = GlassPiece()
    let circle = GlassPiece()
    private(set) var buttons: [UIButton] = []
    private(set) var hideButton: UIButton!
    var format: (String) -> Void = { _ in }
    var accept: () -> Void = {}
    var hideKeyboard: () -> Void = {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "devot.formatting"
        accessibilityLabel = L10n.phoneNoteFormatting()
        add(capsule)
        add(circle)
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .equalSpacing
        row.translatesAutoresizingMaskIntoConstraints = false
        // On a narrow phone the buttons keep their 44 pt and the row scrolls inside the capsule.
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        for format in Self.formats {
            let button = BarButton.make(symbol: format.symbol, label: format.label) { [weak self] in self?.format(format.id) }
            buttons.append(button)
            row.addArrangedSubview(button)
        }
        let accept = BarButton.make(symbol: "sparkles", label: L10n.phoneNoteAccept()) { [weak self] in self?.accept() }
        buttons.append(accept)
        row.addArrangedSubview(accept)
        capsule.glass.contentView.addSubview(scroll)
        let hide = BarButton.make(symbol: "keyboard.chevron.compact.down", label: L10n.phoneNoteHideKeyboard()) {
            [weak self] in self?.hideKeyboard()
        }
        hideButton = hide
        buttons.append(hide)
        circle.glass.contentView.addSubview(hide)
        let gap = Tokens.Space.space6
        NSLayoutConstraint.activate([
            capsule.glass.topAnchor.constraint(equalTo: container.contentView.topAnchor),
            capsule.glass.bottomAnchor.constraint(equalTo: container.contentView.bottomAnchor),
            capsule.glass.leadingAnchor.constraint(equalTo: container.contentView.leadingAnchor),
            capsule.glass.heightAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            scroll.topAnchor.constraint(equalTo: capsule.glass.contentView.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: capsule.glass.contentView.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: capsule.glass.contentView.leadingAnchor, constant: Tokens.Space.space3),
            scroll.trailingAnchor.constraint(equalTo: capsule.glass.contentView.trailingAnchor, constant: -Tokens.Space.space3),
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            row.widthAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.widthAnchor),
            circle.glass.leadingAnchor.constraint(equalTo: capsule.glass.trailingAnchor, constant: gap),
            circle.glass.trailingAnchor.constraint(equalTo: container.contentView.trailingAnchor),
            circle.glass.centerYAnchor.constraint(equalTo: capsule.glass.centerYAnchor),
            circle.glass.widthAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            circle.glass.heightAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            hide.centerXAnchor.constraint(equalTo: circle.glass.contentView.centerXAnchor),
            hide.centerYAnchor.constraint(equalTo: circle.glass.contentView.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }
}
