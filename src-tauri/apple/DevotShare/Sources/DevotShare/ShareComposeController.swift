import DevotShareInbox
import OSLog
import UIKit

/// The Share Extension's sheet: a title and the text, with Post and Cancel. Post leaves the share
/// in the inbox for the app, which makes the note the next time it is in front; the extension
/// never opens the database or a key (docs/specs/share-extension.md).
open class ShareComposeController: UIViewController {
    private let form = ShareFormController()
    private var content = ShareContent()
    private var images: [ShareItem.Image] = []
    private let log = Logger(subsystem: "io.github.jma49.devot.share", category: "share")
    /// Where shares go; tests and previews may set another.
    public var inbox: ShareInbox? = ShareInbox.shared()

    override open func viewDidLoad() {
        super.viewDidLoad()
        let navigation = UINavigationController(rootViewController: form)
        addChild(navigation)
        navigation.view.frame = view.bounds
        navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(navigation.view)
        navigation.didMove(toParent: self)

        form.title = ShareL10n.shareSheetTitle()
        form.navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.cancel() })
        let post = UIBarButtonItem(
            title: ShareL10n.sharePost(), primaryAction: UIAction { [weak self] _ in self?.post() })
        post.style = .prominent
        post.isEnabled = false
        form.navigationItem.rightBarButtonItem = post

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { @MainActor [weak self] in
            let content = await ShareContent.load(items)
            let sources = content.images
            let prepared = await Task.detached { ShareImages.prepare(sources) }.value
            self?.show(content, prepared.images, skipped: prepared.skipped)
        }
    }

    private func show(_ content: ShareContent, _ images: [ShareItem.Image], skipped: Int) {
        self.content = content
        self.images = images
        form.fill(title: content.title, text: content.text, url: content.url, images: images.count, skipped: skipped > 0)
        form.navigationItem.rightBarButtonItem?.isEnabled = true
    }

    private func post() {
        let item = ShareItem(title: form.titleText, text: form.bodyText, url: content.url, images: images)
        guard let inbox else { return fail("E_SHARE_INBOX_UNAVAILABLE") }
        do {
            try inbox.write(item)
            extensionContext?.completeRequest(returningItems: nil)
        } catch {
            fail(error.code)
        }
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    private func fail(_ code: String) {
        log.error("W_SHARE_POST_FAILED code=\(code, privacy: .public)")
        let message = switch code {
        case "E_SHARE_EMPTY": ShareL10n.shareErrorEmpty()
        case "E_SHARE_TOO_LARGE", "E_SHARE_TEXT_TOO_LONG", "E_SHARE_TITLE_TOO_LONG", "E_SHARE_IMAGES_TOO_MANY":
            ShareL10n.shareErrorTooLarge()
        default: ShareL10n.shareErrorSave()
        }
        let alert = UIAlertController(title: ShareL10n.shareErrorTitle(), message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: ShareL10n.shareOk(), style: .default))
        present(alert, animated: true)
    }
}

/// The sheet's fields, in a plain grouped layout with the system's own controls.
final class ShareFormController: UIViewController {
    private let titleField = UITextField()
    private let textView = UITextView()
    private let note = UILabel()

    var titleText: String { titleField.text ?? "" }
    var bodyText: String { textView.text ?? "" }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        titleField.placeholder = ShareL10n.shareFieldTitle()
        titleField.font = .preferredFont(forTextStyle: .headline)
        titleField.adjustsFontForContentSizeCategory = true
        titleField.borderStyle = .none
        titleField.returnKeyType = .next
        titleField.addAction(UIAction { [weak self] _ in self?.textView.becomeFirstResponder() }, for: .primaryActionTriggered)

        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.backgroundColor = .clear
        textView.accessibilityLabel = ShareL10n.shareFieldText()

        note.font = .preferredFont(forTextStyle: .footnote)
        note.adjustsFontForContentSizeCategory = true
        note.textColor = .secondaryLabel
        note.numberOfLines = 0
        note.isHidden = true

        let card = UIStackView(arrangedSubviews: [titleField, separator(), textView])
        card.axis = .vertical
        card.spacing = 8
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 16
        card.layer.cornerCurve = .continuous
        card.isLayoutMarginsRelativeArrangement = true
        card.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)

        let stack = UIStackView(arrangedSubviews: [card, note])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let guide = view.layoutMarginsGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -16),
            textView.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
    }

    func fill(title: String, text: String, url: String?, images: Int, skipped: Bool) {
        loadViewIfNeeded()
        titleField.text = title
        textView.text = text
        var lines: [String] = []
        if let url, !text.contains(url) { lines.append(url) }
        if images > 0 { lines.append(ShareL10n.shareImagesCount(count: "\(images)")) }
        if skipped { lines.append(ShareL10n.shareImagesSkipped()) }
        note.text = lines.joined(separator: "\n")
        note.isHidden = lines.isEmpty
        (title.isEmpty ? titleField : textView).becomeFirstResponder()
    }

    private func separator() -> UIView {
        let line = UIView()
        line.backgroundColor = .separator
        line.heightAnchor.constraint(equalToConstant: 1 / max(1, traitCollection.displayScale)).isActive = true
        return line
    }
}
