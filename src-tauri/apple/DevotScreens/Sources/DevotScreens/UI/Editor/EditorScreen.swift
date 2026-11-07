import UIKit

/// What an editor screen asks of the page (docs/specs/iphone-screens.md, Editor screen).
struct EditorActions {
    /// The note to show, and whether its body takes the caret once asked (a new note).
    let show: (_ noteId: String, _ focusBody: Bool) -> Void
    let setMode: (NoteMode) -> Void
    let info: () -> Void
    let appeared: (Tab) -> Void
    /// A new note's screen is up and its note shown: the page may take the keyboard.
    var focus: (EditorScreen) -> Void = { _ in }
    /// The screen left its stack for good: a pop that finished, never one turned back.
    var left: (EditorScreen) -> Void = { _ in }
}

/// A note pushed over its list: the system bar and back swipe around the page's editor, which
/// takes the web view full bleed under a cover until it has painted the note.
final class EditorScreen: WebHolderScreen {
    /// Nil on a new note's screen until the page has made the note.
    private(set) var noteId: String?
    /// Pushed by New Note, at once, before its note exists.
    let isNew: Bool
    /// The notebook New Note makes its note in; nil for unfiled.
    private(set) var bookId: String?
    let screenTab: Tab
    let cover: EditorCover
    private let actions: EditorActions
    private var noteTitle: String
    private var titleShown = true
    private var mode: NoteMode = .edit
    private let waitLimit: TimeInterval
    private var revealing = 0
    // WebKit raises the keyboard only for a focus inside a tap (iphone-screens.md, S2), so a
    // hidden native field raises it in viewDidAppear, then the web view takes it over and the page
    // focuses the body.
    private let keyField = UITextField(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    private var shownForTyping = false
    private var appearedForTyping = false
    private var focusAsked = false

    private(set) lazy var modeItem = UIBarButtonItem(
        image: UIImage(systemName: NoteMode.edit.toggleSymbol),
        primaryAction: UIAction { [weak self] _ in self?.toggleMode() })
    private(set) lazy var infoItem = UIBarButtonItem(
        image: UIImage(systemName: "info.circle"),
        primaryAction: UIAction { [weak self] _ in self?.showInfo() })

    convenience init(
        noteId: String, title: String, tab: Tab, host: WebViewHost, actions: EditorActions,
        coverTimeout: TimeInterval = EditorCover.timeout
    ) {
        self.init(
            noteId: noteId, isNew: false, title: title, tab: tab, host: host, actions: actions,
            coverTimeout: coverTimeout)
    }

    /// New Note's screen, pushed in the tap's own frame; `created` names its note once made.
    convenience init(
        newNoteIn bookId: String?, tab: Tab, host: WebViewHost, actions: EditorActions,
        coverTimeout: TimeInterval = EditorCover.timeout
    ) {
        self.init(noteId: nil, isNew: true, title: "", tab: tab, host: host, actions: actions, coverTimeout: coverTimeout)
        self.bookId = bookId
    }

    private init(
        noteId: String?, isNew: Bool, title: String, tab: Tab, host: WebViewHost, actions: EditorActions,
        coverTimeout: TimeInterval
    ) {
        self.noteId = noteId
        self.isNew = isNew
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
        if isNew {
            keyField.alpha = 0
            keyField.isAccessibilityElement = false
            keyField.autocorrectionType = .no
            view.addSubview(keyField)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        // The page's own horizontal gestures (text selection, swiping a table) keep the content.
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = false
    }

    /// Never in the tap: the keyboard is asked for once the push has landed.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard isNew, !appearedForTyping else { return }
        appearedForTyping = true
        keyField.becomeFirstResponder()
        askFocus()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if keyField.isFirstResponder { keyField.resignFirstResponder() }
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { actions.left(self) }
    }

    override func appeared() {
        actions.appeared(screenTab)
    }

    /// A pop reveals a note its still already shows, so the still waits for the page instead of a cover.
    override func tookWebView() {
        guard let noteId else {
            view.bringSubviewToFront(cover)
            return cover.raise(holding: true)
        }
        if isNew, !shownForTyping {
            view.bringSubviewToFront(cover)
            cover.raise(holding: true)
            return showForTyping(noteId)
        }
        guard let still = snapshot else {
            view.bringSubviewToFront(cover)
            cover.raise()
            return actions.show(noteId, false)
        }
        webContainer.bringSubviewToFront(still)
        revealing += 1
        let turn = revealing
        actions.show(noteId, false)
        DispatchQueue.main.asyncAfter(deadline: .now() + waitLimit) { [weak self] in
            guard let self, revealing == turn, host.holder === self else { return }
            fadeSnapshot(over: Tokens.Duration.phoneAdjust)
        }
    }

    /// The page made the new note: it shows, under the cover that has held since the push.
    func created(_ id: String) {
        guard isNew, noteId == nil else { return }
        noteId = id
        guard host.holder === self else { return }
        showForTyping(id)
    }

    private func showForTyping(_ id: String) {
        shownForTyping = true
        actions.show(id, true)
        cover.arm()
        askFocus()
    }

    private func askFocus() {
        guard appearedForTyping, shownForTyping, !focusAsked, host.holder === self else { return }
        focusAsked = true
        host.webView.becomeFirstResponder()
        actions.focus(self)
    }

    /// The page took no caret (a locked note opens in Preview): the keyboard goes down again.
    func focusRefused() {
        view.endEditing(true)
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
