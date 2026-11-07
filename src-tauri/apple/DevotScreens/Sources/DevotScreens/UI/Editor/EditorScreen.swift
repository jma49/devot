import UIKit

/// What an editor screen asks of the page (docs/specs/iphone-screens.md, Editor screen).
struct EditorActions {
    let show: (String) -> Void
    let setMode: (NoteMode) -> Void
    let info: () -> Void
    let appeared: (Tab) -> Void
}

/// A note pushed over its list: the system bar and back swipe around the page's editor, which
/// takes the web view full bleed under a cover until it has painted the note.
final class EditorScreen: WebHolderScreen {
    let noteId: String
    let screenTab: Tab
    let cover: EditorCover
    private let actions: EditorActions
    private var noteTitle: String
    private var titleShown = true
    private var mode: NoteMode = .edit
    private let waitLimit: TimeInterval
    private var revealing = 0

    private(set) lazy var modeItem = UIBarButtonItem(
        image: UIImage(systemName: NoteMode.edit.toggleSymbol),
        primaryAction: UIAction { [weak self] _ in self?.toggleMode() })
    private(set) lazy var infoItem = UIBarButtonItem(
        image: UIImage(systemName: "info.circle"),
        primaryAction: UIAction { [weak self] _ in self?.showInfo() })

    init(
        noteId: String, title: String, tab: Tab, host: WebViewHost, actions: EditorActions,
        coverTimeout: TimeInterval = EditorCover.timeout
    ) {
        self.noteId = noteId
        noteTitle = title
        screenTab = tab
        self.actions = actions
        cover = EditorCover(title: title, timeout: coverTimeout)
        waitLimit = coverTimeout
        super.init(host: host)
        hidesBottomBarWhenPushed = true
        navigationItem.backButtonDisplayMode = .minimal
        infoItem.accessibilityLabel = L10n.phoneInfoTitle()
        navigationItem.rightBarButtonItems = [modeItem, infoItem]
        labelModeItem()
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        view = UIView()
        view.backgroundColor = Tokens.Color.phoneBackground
        webContainer.frame = view.bounds
        webContainer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(webContainer)
        cover.frame = view.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(cover)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        // The page's own horizontal gestures (text selection, swiping a table) keep the content.
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = false
    }

    override func appeared() {
        actions.appeared(screenTab)
    }

    /// A pop reveals a note its still already shows, so the still waits for the page instead of a cover.
    override func tookWebView() {
        guard let still = snapshot else {
            view.bringSubviewToFront(cover)
            cover.raise()
            return actions.show(noteId)
        }
        webContainer.bringSubviewToFront(still)
        revealing += 1
        let turn = revealing
        actions.show(noteId)
        DispatchQueue.main.asyncAfter(deadline: .now() + waitLimit) { [weak self] in
            guard let self, revealing == turn, host.holder === self else { return }
            fadeSnapshot(over: Tokens.Duration.phoneAdjust)
        }
    }

    func ready(_ id: String) {
        guard id == noteId, host.holder === self else { return }
        cover.ready()
        revealing += 1
        fadeSnapshot(over: Tokens.Duration.phoneAdjust)
    }

    func showMode(_ shown: NoteMode) {
        guard shown != mode else { return }
        mode = shown
        if let image = UIImage(systemName: shown.toggleSymbol) {
            modeItem.setSymbolImage(image, contentTransition: .replace)
        }
        labelModeItem()
    }

    func toggleMode() {
        actions.setMode(mode.other)
    }

    func showInfo() {
        actions.info()
    }

    func retitle(_ next: String) {
        noteTitle = next
        cover.title = next
        showBarTitle()
    }

    /// The bar takes the title only once the page's own is under it.
    func titleVisible(_ visible: Bool) {
        titleShown = visible
        showBarTitle()
    }

    private func showBarTitle() {
        navigationItem.title = titleShown ? nil : (noteTitle.isEmpty ? L10n.noteUntitled() : noteTitle)
    }

    private func labelModeItem() {
        modeItem.accessibilityLabel = mode == .edit ? L10n.phoneNotePreview() : L10n.phoneNoteEdit()
    }
}
