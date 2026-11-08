import UIKit

/// A row's peek (design/phone.md, Peek): the title, the excerpt, then the notebook and tags. It is
/// drawn natively, so a peek never waits on the page.
final class NotePreviewController: UIViewController {
    private let note: NoteRow
    private let excerpt: String?
    private let notebook: String?
    private let tags: [String]
    private let width: CGFloat

    init(note: NoteRow, excerpt: String?, library: LibraryContents?, width: CGFloat) {
        self.note = note
        self.width = width
        self.excerpt = excerpt
        notebook = library?.books.first { $0.id == note.bookId }?.name
        let names = Dictionary((library?.tags ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        tags = note.tagIds.compactMap { names[$0] }
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
        let title = label(NoteCell.title(note, excerpt: excerpt), .title3, Tokens.Color.phoneText, lines: 2)
        title.font = UIFontMetrics(forTextStyle: .title3).scaledFont(
            for: .systemFont(ofSize: UIFont.preferredFont(forTextStyle: .title3).pointSize, weight: .semibold))
        let body = label(excerpt ?? "", .body, Tokens.Color.phoneTextSecondary, lines: 6)
        var meta = [notebook ?? L10n.phoneNoNotebook()]
        meta += tags.map { "#\($0)" }
        let footer = label(meta.joined(separator: "  "), .footnote, Tokens.Color.phoneTextFaint, lines: 2)
        let stack = UIStackView(arrangedSubviews: [title, body, footer])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let inset = Tokens.Size.phoneListEdge
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: inset),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: inset),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -inset),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -inset),
        ])
        let fitted = stack.systemLayoutSizeFitting(
            CGSize(width: width - 2 * inset, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        preferredContentSize = CGSize(width: width, height: fitted.height + 2 * inset)
        view.accessibilityElements = [title, body, footer]
    }

    private func label(_ text: String, _ style: UIFont.TextStyle, _ color: UIColor, lines: Int) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = UIFont.preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = lines
        label.isHidden = text.isEmpty
        return label
    }
}
