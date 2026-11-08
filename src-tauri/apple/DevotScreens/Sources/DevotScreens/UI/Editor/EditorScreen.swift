import UIKit

/// What an editor screen asks of the page (docs/specs/iphone-screens.md, Editor screen).
@MainActor
struct EditorActions {
    /// The note to show, and whether its body takes the caret once asked (a new note).
    let show: (_ noteId: String, _ focusBody: Bool) -> Void
    let setMode: (NoteMode) -> Void
    let appeared: (Tab) -> Void
    /// A new note's screen is up and its note shown: the page may take the keyboard.
    var focus: (EditorScreen) -> Void = { _ in }
    /// The screen left its stack for good: a pop that finished, never one turned back.
    var left: (EditorScreen) -> Void = { _ in }
    /// What the bars and Note Info ask of the page: `editor.format`, `editor.ai`, `editor.find`,
    /// `editor.insets` and `note.info`.
    var page: (_ op: Op, _ args: [String: JSONValue], _ done: @escaping (Outcome) -> Void) -> Void = { _, _, done in
        done(.failed("E_SCREENS_UNAVAILABLE"))
    }
    /// A write from a picker or Note Info, through the gate.
    var write: (WriteIntent) -> Void = { _ in }
    /// A write from the More menu, which also feels once the gate lets it through.
    var ask: (WriteIntent) -> Void = { _ in }
    /// Move to Trash, through the gate; `leave` runs once the note is in the Trash.
    var trash: (_ id: String, _ leave: @escaping @MainActor () -> Void) -> Void = { _, _ in }
    var library: (@escaping (LibraryContents?) -> Void) -> Void = { $0(nil) }
    /// Pushes a note over this one: Forward, a backlink, a copy.
    var open: (_ id: String, _ title: String) -> Void = { _, _ in }
    /// The note's Markdown, for Share.
    var text: (_ id: String, _ done: @escaping (String) -> Void) -> Void = { _, _ in }
    var haptics = Haptics()
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
    private(set) var noteTitle: String
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
    private var keyboardShown: NSObjectProtocol?
    /// What the page said last of the note, for the menu, the pickers and Note Info.
    private(set) var note: EditorNote?
    /// The note popped last off this screen, which Forward opens again.
    private(set) var forward: (id: String, title: String)?
    private(set) var finding = false
    private(set) var keyboardUp = false
    private var keyboardCovered: CGFloat = 0
    private var findTurn = 0
    private weak var tagPicker: TagPicker?
    let formattingBar = FormattingBar()
    let findBar = FindBar()
    private(set) lazy var keyboard = KeyboardTracker(view: view)

    private(set) lazy var modeItem = UIBarButtonItem(
        image: UIImage(systemName: NoteMode.edit.toggleSymbol),
        primaryAction: UIAction { [weak self] _ in self?.toggleMode() })
    private(set) lazy var infoItem = UIBarButtonItem(
        image: UIImage(systemName: "info.circle"),
        primaryAction: UIAction { [weak self] _ in self?.showInfo() })
    private(set) lazy var moreItem = UIBarButtonItem(
        image: UIImage(systemName: "ellipsis"),
        menu: UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] provide in provide(self?.moreMenu() ?? []) }
        ]))
    private(set) lazy var backItem = UIBarButtonItem(
        image: UIImage(systemName: "chevron.backward"),
        primaryAction: UIAction { [weak self] _ in self?.navigationController?.popViewController(animated: true) })
    private(set) lazy var forwardItem = UIBarButtonItem(
        image: UIImage(systemName: "chevron.forward"),
        primaryAction: UIAction { [weak self] _ in self?.goForward() })
    private(set) lazy var findItem = UIBarButtonItem(
        image: UIImage(systemName: "magnifyingglass"),
        primaryAction: UIAction { [weak self] _ in self?.startFind() })
    private(set) lazy var aiItem = UIBarButtonItem(
        image: UIImage(systemName: "sparkles"),
        primaryAction: UIAction { [weak self] _ in self?.suggest() })

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
        moreItem.accessibilityLabel = L10n.noteMore()
        navigationItem.rightBarButtonItems = [moreItem, modeItem, infoItem]
        backItem.accessibilityLabel = L10n.phoneNotePrevious()
        forwardItem.accessibilityLabel = L10n.phoneNoteNext()
        findItem.accessibilityLabel = L10n.phoneNoteFind()
        aiItem.accessibilityLabel = L10n.phoneNoteSuggest()
        forwardItem.isEnabled = false
        toolbarItems = [backItem, forwardItem, findItem, .flexibleSpace(), aiItem]
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
        for bar in [formattingBar, findBar] as [KeyboardBar] {
            bar.pin(in: view)
            show(bar, false)
        }
        formattingBar.format = { [weak self] id in self?.askPage(.editorFormat, ["id": .string(id)]) }
        formattingBar.accept = { [weak self] in self?.askPage(.editorAi, ["action": .string("accept")]) }
        formattingBar.hideKeyboard = { [weak self] in self?.view.endEditing(true) }
        findBar.search = { [weak self] query in self?.find(query) }
        findBar.step = { [weak self] forward in self?.stepFind(forward) }
        findBar.close = { [weak self] in self?.closeFind() }
        keyboard.alongside = { [weak self] change in self?.keyboardMoves(change) }
        keyboard.changed = { [weak self] change in self?.keyboardMoved(change) }
        keyboard.owns = { [weak self] in
            guard let self else { return false }
            return presentedViewController == nil || holdsKeyboard
        }
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
        navigationController?.setToolbarHidden(keyboardUp || finding, animated: animated)
        // The page's own horizontal gestures (text selection, swiping a table) keep the content.
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = false
        keyboard.start()
        if let popped = transitionCoordinator?.viewController(forKey: .from) as? EditorScreen, popped !== self,
            navigationController?.viewControllers.contains(popped) == false, let id = popped.noteId
        {
            forward = (id, popped.noteTitle)
            forwardItem.isEnabled = true
        }
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        keyboard.sync()
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
        if let keyboardShown { NotificationCenter.default.removeObserver(keyboardShown) }
        keyboardShown = nil
        keyboard.stop()
        if !(transitionCoordinator?.viewController(forKey: .to) is EditorScreen) {
            navigationController?.setToolbarHidden(true, animated: animated)
        }
        if finding { closeFind() }
        if host.holder === self { setScrollInset(0) }
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
        let scroll = host.webView.scrollView
        setContentScrollView(scroll, for: .top)
        scroll.keyboardDismissMode = .interactive
        keyboard.sync()
        applyInsets()
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
        keepPageAtTop()
    }

    /// WebKit reveals a body focused from code by the whole editable element, taller than the room
    /// above the keyboard, and scrolls the page off its top; a new note's caret is at its top.
    private func keepPageAtTop() {
        keyboardShown = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.pageToTop()
                if let token = self.keyboardShown { NotificationCenter.default.removeObserver(token) }
                self.keyboardShown = nil
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + EditorCover.timeout) { [weak self] in self?.pageToTop() }
    }

    private func pageToTop() {
        guard host.holder === self else { return }
        let scroll = host.webView.scrollView
        if scroll.contentOffset != .zero { scroll.setContentOffset(.zero, animated: false) }
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
        aiItem.isHidden = shown != .edit
        showBars()
        if let image = UIImage(systemName: shown.toggleSymbol) {
            modeItem.setSymbolImage(image, contentTransition: .replace)
        }
        labelModeItem()
    }

    func toggleMode() {
        actions.setMode(mode.other)
    }

    /// The note's facts changed: an open tags picker ticks what the note has now.
    func showNote(_ facts: EditorNote) {
        guard facts.id == noteId else { return }
        note = facts
        tagPicker?.noteChanged(facts)
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

    private func askPage(_ op: Op, _ args: [String: JSONValue] = [:], done: @escaping (JSONValue) -> Void = { _ in }) {
        actions.page(op, args) { outcome in
            if case .ok(let result) = outcome { done(result) }
        }
    }

    // MARK: Keyboard

    /// Inside the keyboard's own animation: the toolbar goes as the keyboard rises, the formatting bar comes.
    private func keyboardMoves(_ change: KeyboardChange) {
        keyboardUp = change.up
        navigationController?.setToolbarHidden(change.up || finding, animated: false)
        showBars()
        view.layoutIfNeeded()
    }

    /// Outside it, once: the page and the scroll view take the room the keyboard and the bar cover, at once.
    private func keyboardMoved(_ change: KeyboardChange) {
        keyboardCovered = change.covered
        applyInsets(duration: change.duration, curve: change.curve)
    }

    /// The keyboard and the bar over it, or the find bar alone once the keyboard is down.
    private var covered: CGFloat {
        let bar = Tokens.Size.phoneTarget + Tokens.Size.phoneSheetInset
        return keyboardCovered > 0 ? keyboardCovered + bar : finding ? bar : 0
    }

    /// The page hears only a bottom it does not have already.
    private func applyInsets(duration: TimeInterval = 0, curve: Int = KeyboardChange.keyboardCurve) {
        guard host.holder === self else { return }
        setScrollInset(covered)
        guard host.footInset != covered else { return }
        host.footInset = covered
        askPage(
            .editorInsets,
            ["bottom": .number(Double(covered)), "duration": .number(duration), "curve": .number(Double(curve))])
    }

    /// A keyboard raised for this note's own responders, not for a sheet over it.
    private var holdsKeyboard: Bool {
        if keyField.isFirstResponder || findBar.field.isFirstResponder { return true }
        return host.holder === self && Self.holdsFirstResponder(host.webView, depth: 4)
    }

    /// WebKit's first responder is its content view, a few levels into the web view.
    private static func holdsFirstResponder(_ view: UIView, depth: Int) -> Bool {
        if view.isFirstResponder { return true }
        guard depth > 0 else { return false }
        return view.subviews.contains { holdsFirstResponder($0, depth: depth - 1) }
    }

    private func setScrollInset(_ bottom: CGFloat) {
        let scroll = host.webView.scrollView
        guard scroll.contentInset.bottom != bottom else { return }
        scroll.contentInset.bottom = bottom
        scroll.verticalScrollIndicatorInsets.bottom = bottom
    }

    private func showBars() {
        show(formattingBar, keyboardUp && !finding && mode == .edit)
        show(findBar, finding)
    }

    private func show(_ bar: KeyboardBar, _ shown: Bool) {
        bar.alpha = shown ? 1 : 0
        bar.isUserInteractionEnabled = shown
        bar.accessibilityElementsHidden = !shown
    }

    // MARK: Find

    /// Swapped in without motion, in the formatting bar's place.
    func startFind() {
        guard !finding else {
            findBar.field.becomeFirstResponder()
            return
        }
        finding = true
        findBar.clear()
        UIView.performWithoutAnimation {
            navigationController?.setToolbarHidden(true, animated: false)
            showBars()
        }
        if !keyboardUp { applyInsets() }
        findBar.field.becomeFirstResponder()
    }

    private func find(_ query: String) {
        findTurn += 1
        let turn = findTurn
        let capped = String(query.prefix(Self.longestQuery))
        askPage(.editorFind, ["action": .string("search"), "query": .string(capped)]) { [weak self] result in
            guard let self, turn == findTurn, let count = FindCount(result) else { return }
            findBar.show(count)
        }
    }

    private func stepFind(_ forward: Bool) {
        findTurn += 1
        let turn = findTurn
        askPage(.editorFind, ["action": .string(forward ? "next" : "previous")]) { [weak self] result in
            guard let self, turn == findTurn, let count = FindCount(result) else { return }
            findBar.show(count)
        }
    }

    func closeFind() {
        guard finding else { return }
        finding = false
        findTurn += 1
        askPage(.editorFind, ["action": .string("close")])
        UIView.performWithoutAnimation {
            showBars()
            if !keyboardUp { navigationController?.setToolbarHidden(false, animated: false) }
        }
        if findBar.field.isFirstResponder { findBar.field.resignFirstResponder() }
        if !keyboardUp { applyInsets() }
    }

    /// `editor.find` takes at most this many characters (`screens::message`).
    static let longestQuery = 1000

    // MARK: Toolbar

    private func goForward() {
        guard let forward else { return }
        self.forward = nil
        forwardItem.isEnabled = false
        actions.open(forward.id, forward.title)
    }

    private func suggest() {
        askPage(.editorAi, ["action": .string("suggest")])
    }

    // MARK: More, pickers and Note Info

    func moreMenu() -> [UIMenuElement] {
        guard let note else { return [] }
        let ids = [note.id]
        let ask = actions.ask
        let pin = UIAction(
            title: note.pinned ? L10n.noteUnpin() : L10n.notePin(), image: UIImage(systemName: note.pinned ? "pin.slash" : "pin")
        ) { _ in ask(.batch(ids: ids, change: .pinned(!note.pinned))) }
        let statuses = UIMenu(
            title: L10n.phoneStatus(), image: UIImage(systemName: "circle.dashed"), options: .singleSelection,
            children: NoteStatus.allCases.map { status in
                UIAction(
                    title: status.name, image: UIImage(systemName: status.symbol),
                    state: note.status == status.rawValue ? .on : .off
                ) { _ in
                    if note.status != status.rawValue { ask(.batch(ids: ids, change: .status(status))) }
                }
            })
        let move = UIAction(title: L10n.noteMenuMove(), image: UIImage(systemName: "folder")) { [weak self] _ in
            self?.showPicker(.notebook)
        }
        let tags = UIAction(title: L10n.phoneNoteTags(), image: UIImage(systemName: "number")) { [weak self] _ in
            self?.showPicker(.tags)
        }
        let share = UIAction(title: L10n.phoneActionShare(), image: UIImage(systemName: "square.and.arrow.up")) {
            [weak self] _ in self?.share()
        }
        let find = UIAction(title: L10n.phoneNoteFind(), image: UIImage(systemName: "magnifyingglass")) { [weak self] _ in
            self?.startFind()
        }
        let duplicate = UIAction(title: L10n.noteMenuDuplicate(), image: UIImage(systemName: "plus.square.on.square")) {
            _ in ask(.duplicate(noteId: note.id))
        }
        let trash = UIAction(title: L10n.noteMoveToTrash(), image: UIImage(systemName: "trash"), attributes: .destructive) {
            [weak self] _ in self?.trash()
        }
        return [
            UIMenu(options: .displayInline, children: [pin, statuses, move, tags]),
            UIMenu(options: .displayInline, children: [share, find, duplicate]),
            UIMenu(options: .displayInline, children: [trash]),
        ]
    }

    enum Picker: String {
        case notebook, status, tags
    }

    private var pickerContext: PickerContext {
        PickerContext(write: actions.write, library: actions.library, haptics: actions.haptics)
    }

    /// From a chip on the page or the More menu; nothing is written until a row is picked.
    func showPicker(_ picker: Picker) {
        guard let note, presentedViewController == nil else { return }
        let content: UIViewController
        switch picker {
        case .notebook: content = NotePickers.notebook(note: note, context: pickerContext)
        case .status: content = NotePickers.status(note: note, context: pickerContext)
        case .tags:
            let tags = NotePickers.tags(note: note, context: pickerContext)
            tagPicker = tags
            content = tags
        }
        PickerSheet.present(content, from: self)
    }

    /// The screen leaves only once the note is in the Trash; the toast offers it back over the list.
    func trash() {
        guard let note else { return }
        actions.trash(note.id) { [weak self] in
            guard let self, let navigation = navigationController, navigation.topViewController === self else { return }
            navigation.popViewController(animated: true)
        }
    }

    private func share() {
        guard let id = noteId else { return }
        actions.text(id) { [weak self] markdown in
            guard let self, view.window != nil, presentedViewController == nil else { return }
            let sheet = UIActivityViewController(activityItems: [markdown], applicationActivities: nil)
            sheet.popoverPresentationController?.barButtonItem = moreItem
            present(sheet, animated: true)
        }
    }

    func showInfo() {
        guard let note, presentedViewController == nil else { return }
        actions.library { [weak self] contents in
            let notebook = contents?.books.first { $0.id == note.bookId }?.name ?? L10n.phoneNoNotebook()
            self?.actions.page(.noteInfo, ["noteId": .string(note.id)]) { outcome in
                var info: NoteInfo?
                if case .ok(let result) = outcome { info = NoteInfo(result) }
                self?.presentInfo(note: note, notebook: notebook, info: info)
            }
        }
    }

    private func presentInfo(note: EditorNote, notebook: String, info: NoteInfo?) {
        guard view.window != nil, presentedViewController == nil else { return }
        weak var shown: ContentSheetController?
        let write = actions.write
        let sheet = ContentSheetController(
            NoteInfoSheet(
                note: note, notebook: notebook, info: info,
                actions: NoteInfoActions(
                    setDates: { created, updated in
                        write(.setDates(noteId: note.id, createdAt: created, updatedAt: updated))
                    },
                    openNote: { [weak self] id, title in
                        shown?.dismiss(animated: true) { self?.actions.open(id, title) }
                    },
                    trash: { [weak self] in
                        shown?.dismiss(animated: true) { self?.trash() }
                    })))
        shown = sheet
        present(sheet, animated: true)
    }
}
