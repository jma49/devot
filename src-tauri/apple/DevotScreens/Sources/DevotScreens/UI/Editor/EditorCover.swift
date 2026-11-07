import UIKit

/// What a pushed note shows until the page has painted it: the background and the note's title
/// where the page draws it, so the push never shows the list the page drew last.
final class EditorCover: UIView {
    /// The longest the cover waits for the page (docs/specs/performance.md).
    static let timeout: TimeInterval = 0.4
    // The page's `.phone-note-heading` line height, as a multiple of its size.
    private static let titleLineHeight: CGFloat = 1.23
    // The body size the page's text scale is relative to (`textScaleFrom` in phone/navigation.ts).
    private static let defaultBodyPoints: CGFloat = 17

    private let label = UILabel()
    private var model = CoverModel()
    private var frameLink: CADisplayLink?
    private var fader: UIViewPropertyAnimator?
    private var raised = 0
    private let waitLimit: TimeInterval

    var title: String {
        didSet { showTitle() }
    }

    var waiting: Bool { model.waiting }

    init(title: String, timeout: TimeInterval) {
        self.title = title
        waitLimit = timeout
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityIdentifier = "editor.cover"
        label.numberOfLines = 0
        label.adjustsFontForContentSizeCategory = false
        addSubview(label)
        showTitle()
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (cover: Self, _) in
            cover.showTitle()
        }
    }

    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let edge = Tokens.Size.phoneScreenEdge
        let width = max(0, bounds.width - 2 * edge)
        let height = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        label.frame = CGRect(
            x: edge, y: (window?.safeAreaInsets.top ?? safeAreaInsets.top) + Tokens.Size.phoneContentTop,
            width: width, height: height)
    }

    /// Up at once over whatever the page drew last; it fades when `CoverModel` says.
    func raise() {
        fader?.stopAnimation(true)
        fader = nil
        backgroundColor = Tokens.Color.phoneBackground
        alpha = 1
        isHidden = false
        model.raise()
        raised += 1
        let turn = raised
        frameLink?.invalidate()
        let link = CADisplayLink(target: self, selector: #selector(frameDrawn))
        link.add(to: .main, forMode: .common)
        frameLink = link
        DispatchQueue.main.asyncAfter(deadline: .now() + waitLimit) { [weak self] in
            guard let self, raised == turn, model.timedOut() else { return }
            fade()
        }
    }

    func ready() {
        if model.ready() { fade() }
    }

    @objc private func frameDrawn() {
        frameLink?.invalidate()
        frameLink = nil
        if model.firstFrame() { fade() }
    }

    private func fade() {
        frameLink?.invalidate()
        frameLink = nil
        let fader = UIViewPropertyAnimator(
            duration: Tokens.Duration.phoneAdjust, timingParameters: Tokens.Easing.standard.timingParameters)
        fader.addAnimations { [weak self] in self?.alpha = 0 }
        fader.addCompletion { [weak self] position in
            guard let self, position == .end else { return }
            isHidden = true
            self.fader = nil
        }
        self.fader = fader
        fader.startAnimation()
    }

    /// The page's title type: the note scale's title size under Dynamic Type, bold, the editor's ink.
    private func showTitle() {
        let scale = UIFont.preferredFont(forTextStyle: .body).pointSize / Self.defaultBodyPoints
        let size = Tokens.Font.sizePhoneNoteTitle * scale
        let line = NSMutableParagraphStyle()
        line.minimumLineHeight = size * Self.titleLineHeight
        line.maximumLineHeight = size * Self.titleLineHeight
        label.attributedText = NSAttributedString(
            string: title,
            attributes: [
                .font: UIFont.systemFont(ofSize: size, weight: .bold),
                .foregroundColor: Tokens.Color.textEditor,
                .paragraphStyle: line,
            ])
        accessibilityLabel = title.isEmpty ? L10n.noteUntitled() : title
        setNeedsLayout()
    }
}
