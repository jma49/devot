import UIKit

/// What the page's search found (`editor.find`); `current` counts from 1, 0 with no match.
struct FindCount: Equatable {
    let total: Int
    let current: Int
    let capped: Bool

    static let none = FindCount(total: 0, current: 0, capped: false)

    init(total: Int, current: Int, capped: Bool) {
        self.total = total
        self.current = current
        self.capped = capped
    }

    init?(_ value: JSONValue) {
        guard let total = value["total"]?.number, let current = value["current"]?.number else { return nil }
        self.init(total: Int(total), current: Int(current), capped: value["capped"]?.bool ?? false)
    }
}

/// Find in Note, in the formatting bar's place on the keyboard (design/motion.md, Find bar): it
/// swaps in without motion, and the count follows each key typed.
@MainActor
final class FindBar: KeyboardBar, UITextFieldDelegate {
    let capsule = GlassPiece()
    let circle = GlassPiece()
    let field = UITextField()
    let count = UILabel()
    private(set) var previousButton: UIButton!
    private(set) var nextButton: UIButton!
    private(set) var closeButton: UIButton!
    var search: (String) -> Void = { _ in }
    var step: (_ forward: Bool) -> Void = { _ in }
    var close: () -> Void = {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "devot.find"
        add(capsule)
        add(circle)
        field.placeholder = L10n.phoneNoteFind()
        field.accessibilityLabel = L10n.phoneNoteFind()
        field.returnKeyType = .search
        field.clearButtonMode = .whileEditing
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.textColor = Tokens.Color.phoneText
        field.font = UIFont.preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        field.addAction(UIAction { [weak self] _ in self?.typed() }, for: .editingChanged)
        count.font = UIFont.monospacedDigitSystemFont(
            ofSize: UIFont.preferredFont(forTextStyle: .subheadline).pointSize, weight: .regular)
        count.textColor = Tokens.Color.phoneTextSecondary
        count.setContentHuggingPriority(.required, for: .horizontal)
        count.setContentCompressionResistancePriority(.required, for: .horizontal)
        count.translatesAutoresizingMaskIntoConstraints = false
        previousButton = BarButton.make(symbol: "chevron.up", label: L10n.phoneFindPrevious()) { [weak self] in
            self?.step(false)
        }
        nextButton = BarButton.make(symbol: "chevron.down", label: L10n.phoneFindNext()) { [weak self] in
            self?.step(true)
        }
        closeButton = BarButton.make(symbol: "xmark", label: L10n.phoneFindClose()) { [weak self] in self?.close() }
        let row = UIStackView(arrangedSubviews: [field, count, previousButton, nextButton])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = Tokens.Space.space2
        row.translatesAutoresizingMaskIntoConstraints = false
        capsule.glass.contentView.addSubview(row)
        circle.glass.contentView.addSubview(closeButton)
        NSLayoutConstraint.activate([
            capsule.glass.topAnchor.constraint(equalTo: container.contentView.topAnchor),
            capsule.glass.bottomAnchor.constraint(equalTo: container.contentView.bottomAnchor),
            capsule.glass.leadingAnchor.constraint(equalTo: container.contentView.leadingAnchor),
            capsule.glass.heightAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            row.topAnchor.constraint(equalTo: capsule.glass.contentView.topAnchor),
            row.bottomAnchor.constraint(equalTo: capsule.glass.contentView.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: capsule.glass.contentView.leadingAnchor, constant: Tokens.Space.space7),
            row.trailingAnchor.constraint(equalTo: capsule.glass.contentView.trailingAnchor, constant: -Tokens.Space.space3),
            circle.glass.leadingAnchor.constraint(equalTo: capsule.glass.trailingAnchor, constant: Tokens.Space.space6),
            circle.glass.trailingAnchor.constraint(equalTo: container.contentView.trailingAnchor),
            circle.glass.centerYAnchor.constraint(equalTo: capsule.glass.centerYAnchor),
            circle.glass.widthAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            circle.glass.heightAnchor.constraint(equalToConstant: Tokens.Size.phoneTarget),
            closeButton.centerXAnchor.constraint(equalTo: circle.glass.contentView.centerXAnchor),
            closeButton.centerYAnchor.constraint(equalTo: circle.glass.contentView.centerYAnchor),
        ])
        show(.none)
    }

    required init?(coder: NSCoder) { nil }

    var query: String { field.text ?? "" }

    /// A count for an older query than the one in the field is dropped by the caller.
    func show(_ found: FindCount) {
        let empty = query.isEmpty
        count.isHidden = empty
        count.text = L10n.phoneFindCount(current: String(found.current), total: String(found.total))
        previousButton.isEnabled = found.total > 0
        nextButton.isEnabled = found.total > 0
    }

    func clear() {
        field.text = ""
        show(.none)
    }

    private func typed() {
        search(query)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        step(true)
        return false
    }
}
