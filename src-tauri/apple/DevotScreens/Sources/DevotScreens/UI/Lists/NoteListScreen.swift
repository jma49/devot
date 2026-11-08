import UIKit

/// A note list: All Notes, Pinned, a notebook, a tag or the Templates (design/phone.md, Note list
/// rows). Rows come from Rust; excerpts from the core for the rows about to show.
final class NoteListScreen: ListScreen, UICollectionViewDelegate {
    typealias Section = NoteListDataSource.Section

    enum Item: Hashable, Sendable {
        case header(NoteListDataSource.Section)
        case note(String)
    }

    let source: NoteListDataSource
    private var data: UICollectionViewDiffableDataSource<Section, Item>!
    private var folds: [Section: Bool] = [:]
    /// A write a context menu named, sent once the menu has gone.
    private var afterMenu: (() -> Void)?
    private var excerptsDue = false
    private let empty = UILabel()
    var now: () -> Date = Date.init

    init(title: String, view: ListView, status: StatusFilter = .all, tab: Tab, context: ListContext, isRoot: Bool) {
        source = context.source(view, status: status)
        super.init(title: title, tab: tab, context: context, isRoot: isRoot)
        source.onUpdate = { [weak self] in self?.apply($0) }
        context.watch(self) { [weak self] change in
            switch change {
            case .library: self?.redrawRows()
            case .excerpts(let ids): self?.excerptsArrived(ids)
            case .notes, .trash: break
            }
        }
    }

    required init?(coder: NSCoder) { nil }

    override func makeLayout() -> UICollectionViewLayout {
        var list = UICollectionLayoutListConfiguration(appearance: .plain)
        list.showsSeparators = false
        list.backgroundColor = Tokens.Color.phoneBackground
        list.headerTopPadding = 0
        list.trailingSwipeActionsConfigurationProvider = { [weak self] path in
            MainActor.assumeIsolated { self?.swipe(path, leading: false) }
        }
        list.leadingSwipeActionsConfigurationProvider = { [weak self] path in
            MainActor.assumeIsolated { self?.swipe(path, leading: true) }
        }
        return UICollectionViewCompositionalLayout.list(using: list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let notes = UICollectionView.CellRegistration<NoteCell, String> { [weak self] cell, _, id in
            self?.configure(cell, id)
        }
        let headers = UICollectionView.CellRegistration<UICollectionViewListCell, Section> { [weak self] cell, _, section in
            self?.configure(header: cell, section)
        }
        data = UICollectionViewDiffableDataSource(collectionView: collection) { collection, path, item in
            switch item {
            case .note(let id): collection.dequeueConfiguredReusableCell(using: notes, for: path, item: id)
            case .header(let section): collection.dequeueConfiguredReusableCell(using: headers, for: path, item: section)
            }
        }
        empty.text = emptyText
        empty.font = UIFont.preferredFont(forTextStyle: .body)
        empty.adjustsFontForContentSizeCategory = true
        empty.textColor = Tokens.Color.phoneTextSecondary
        empty.textAlignment = .center
        empty.numberOfLines = 0
        empty.isHidden = true
        collection.backgroundView = empty
        setBarItems()
        source.load()
        if context.library == nil { context.readLibrary() }
    }

    private var emptyText: String {
        switch source.view {
        case .templates: L10n.noteListEmptyTemplates()
        default: L10n.phoneListEmpty()
        }
    }

    // MARK: Rows

    private func configure(_ cell: NoteCell, _ id: String) {
        guard let note = source.row(id) else { return }
        let tag = note.tagIds.first.flatMap { first in context.library?.tags.first { $0.id == first } }
        cell.show(
            NoteCell.Row(
                note: note, excerpt: context.excerpts.excerpt(note), tag: tag, now: now(),
                reduceMotion: context.reduceMotion()))
    }

    private func configure(header cell: UICollectionViewListCell, _ section: Section) {
        var content = UIListContentConfiguration.header()
        content.text = section.name
        content.textProperties.color = Tokens.Color.phoneTextSecondary
        cell.contentConfiguration = content
        let chevron = UIImageView(image: UIImage(systemName: folded(section) ? "chevron.right" : "chevron.down"))
        chevron.tintColor = Tokens.Color.phoneTextSecondary
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        cell.accessories = [.customView(configuration: .init(customView: chevron, placement: .trailing()))]
        var background = UIBackgroundConfiguration.listCell()
        background.backgroundColor = Tokens.Color.phoneBackground
        cell.backgroundConfiguration = background
        cell.accessibilityTraits = [.header, .button]
        cell.accessibilityHint =
            folded(section) ? L10n.sidebarExpandSection(section: section.name) : L10n.sidebarCollapseSection(section: section.name)
    }

    /// Completed starts folded unless it is what the list is filtered for (`sectionCollapsed`).
    private func folded(_ section: Section) -> Bool {
        folds[section] ?? (section == .completed && source.status != .completed)
    }

    private func apply(_ update: NoteListDataSource.Update) {
        guard let data else { return }
        let snapshot = snapshot(update.layout, reconfiguring: update.reconfigured)
        if update.reloaded {
            data.applySnapshotUsingReloadData(snapshot)
        } else {
            data.apply(snapshot, animatingDifferences: update.animated)
        }
        if let id = update.selected, let path = data.indexPath(for: .note(id)) {
            collection.selectItem(at: path, animated: false, scrollPosition: [])
        }
        empty.isHidden = !update.layout.sections.isEmpty || !source.loaded
        scheduleExcerpts()
        if collection.isEditing { setBatchBar() }
    }

    private func snapshot(_ layout: NoteListDataSource.Layout, reconfiguring: Set<String>) -> NSDiffableDataSourceSnapshot<Section, Item> {
        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        let headed = source.view != .templates
        for section in layout.sections {
            snapshot.appendSections([section])
            if headed { snapshot.appendItems([.header(section)], toSection: section) }
            if !headed || !folded(section) {
                snapshot.appendItems((layout.ids[section] ?? []).map(Item.note), toSection: section)
            }
        }
        let shown = reconfiguring.map(Item.note).filter { snapshot.indexOfItem($0) != nil }
        snapshot.reconfigureItems(shown)
        return snapshot
    }

    private func redrawRows() {
        guard let data else { return }
        var snapshot = data.snapshot()
        snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { if case .note = $0 { true } else { false } })
        data.apply(snapshot, animatingDifferences: false)
    }

    private func toggle(_ section: Section) {
        folds[section] = !folded(section)
        var snapshot = snapshot(source.layout, reconfiguring: [])
        snapshot.reconfigureItems([.header(section)])
        data.apply(snapshot, animatingDifferences: !context.reduceMotion())
        scheduleExcerpts()
    }

    // MARK: Excerpts

    /// Once a frame at most: the rows on screen and a screen's worth ahead.
    private func scheduleExcerpts() {
        guard !excerptsDue else { return }
        excerptsDue = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            excerptsDue = false
            let paths = collection.indexPathsForVisibleItems.sorted()
            guard let first = paths.first, let last = paths.last else { return }
            let snapshot = data.snapshot()
            let items = snapshot.itemIdentifiers
            let start = data.itemIdentifier(for: first).flatMap(snapshot.indexOfItem) ?? 0
            let end = data.itemIdentifier(for: last).flatMap(snapshot.indexOfItem) ?? start
            let ahead = max(end - start, 10)
            let window = items[max(0, start)..<min(items.count, end + ahead + 1)]
            context.excerpts.want(window.compactMap { item in
                if case .note(let id) = item { return source.row(id) }
                return nil
            })
        }
    }

    func excerptsArrived(_ ids: [String]) {
        guard let data else { return }
        var snapshot = data.snapshot()
        let shown = ids.map(Item.note).filter { snapshot.indexOfItem($0) != nil }
        guard !shown.isEmpty else { return }
        snapshot.reconfigureItems(shown)
        data.apply(snapshot, animatingDifferences: false)
    }

    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt path: IndexPath) {
        scheduleExcerpts()
        guard source.hasMore else { return }
        let snapshot = data.snapshot()
        if let item = data.itemIdentifier(for: path), let index = snapshot.indexOfItem(item),
            index > snapshot.numberOfItems - 40
        {
            source.loadMore()
        }
    }

    // MARK: Selection

    func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt path: IndexPath) -> Bool {
        guard case .header? = data.itemIdentifier(for: path) else { return true }
        return !collectionView.isEditing
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt path: IndexPath) {
        switch data.itemIdentifier(for: path) {
        case .header(let section)?:
            collectionView.deselectItem(at: path, animated: false)
            toggle(section)
        case .note(let id)?:
            if collectionView.isEditing { return setBatchBar() }
            guard let note = source.row(id) else { return }
            context.open(id, NoteCell.title(note, excerpt: context.excerpts.excerpt(note)))
        case nil:
            break
        }
    }

    func collectionView(_ collectionView: UICollectionView, didDeselectItemAt path: IndexPath) {
        if collectionView.isEditing { setBatchBar() }
    }

    /// A new note this list started: its row is drawn under the editor's cover and selected.
    func created(_ id: String) {
        source.quietly(selecting: id)
    }

    override func viewWillAppear(_ animated: Bool) {
        let interactive = transitionCoordinator?.isInteractive ?? false
        if !interactive {
            for id in context.untouchedNewNotes() { source.removeUntouched(id) }
        }
        super.viewWillAppear(animated)
    }

    // MARK: Swipes and the context menu

    private func row(_ path: IndexPath) -> NoteRow? {
        guard case .note(let id)? = data?.itemIdentifier(for: path) else { return nil }
        return source.row(id)
    }

    private func swipe(_ path: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
        guard !collection.isEditing, source.view != .templates, let note = row(path) else { return nil }
        let actions = SwipeActions(gate: context.gate)
        return leading ? actions.leading(note) : actions.trailing(note)
    }

    func collectionView(
        _ collectionView: UICollectionView, contextMenuConfigurationForItemsAt paths: [IndexPath], point: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard paths.count == 1, !collectionView.isEditing, let path = paths.first, let note = row(path) else { return nil }
        let context = context
        context.prepareHaptics()
        let width = collectionView.bounds.width - 2 * Tokens.Size.phoneListEdge
        return UIContextMenuConfiguration(
            identifier: note.id as NSString,
            previewProvider: {
                MainActor.assumeIsolated {
                    NotePreviewController(
                        note: note, excerpt: context.excerpts.excerpt(note), library: context.library, width: width)
                }
            },
            actionProvider: { [weak self] _ in
                MainActor.assumeIsolated { self?.menu(note) }
            })
    }

    private func menu(_ note: NoteRow) -> UIMenu {
        let context = context
        return ListMenus.row(
            note, library: { [weak self] in self?.library($0) },
            write: { [weak self] intent in self?.afterMenu = { context.ask(intent) } },
            share: { [weak self] in self?.afterMenu = { self?.share(note) } })
    }

    func library(_ done: @escaping (LibraryContents?) -> Void) {
        if let library = context.library { return done(library) }
        context.readLibrary()
        done(nil)
    }

    func collectionView(
        _ collectionView: UICollectionView, contextMenuConfiguration configuration: UIContextMenuConfiguration,
        highlightPreviewForItemAt path: IndexPath
    ) -> UITargetedPreview? {
        guard let cell = collectionView.cellForItem(at: path) else { return nil }
        return UITargetedPreview(view: cell)
    }

    func collectionView(
        _ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration,
        animator: any UIContextMenuInteractionCommitAnimating
    ) {
        guard let id = configuration.identifier as? String, let note = source.row(id) else { return }
        animator.addCompletion { [weak self] in
            guard let self else { return }
            context.open(id, NoteCell.title(note, excerpt: context.excerpts.excerpt(note)))
        }
    }

    /// The menu's write goes through the gate once the menu has gone, so a sheet never rises under it.
    func collectionView(
        _ collectionView: UICollectionView, willEndContextMenuInteraction configuration: UIContextMenuConfiguration,
        animator: (any UIContextMenuInteractionAnimating)?
    ) {
        guard let run = afterMenu else { return }
        afterMenu = nil
        guard let animator else { return run() }
        animator.addCompletion { run() }
    }

    private func share(_ note: NoteRow) {
        context.text(note.id) { [weak self] _, markdown in
            guard let self, view.window != nil else { return }
            let sheet = UIActivityViewController(activityItems: [markdown], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = view
            }
            present(sheet, animated: true)
        }
    }

    // MARK: Bar items

    private var bookId: String? {
        if case .book(let id) = source.view { return id }
        return nil
    }

    private func setBarItems() {
        guard !collection.isEditing else {
            navigationItem.rightBarButtonItems = [
                UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.select(false) })
            ]
            return
        }
        var items: [UIBarButtonItem] = []
        let gate = context.gate
        if source.view == .templates {
            let new = UIBarButtonItem(
                systemItem: .compose, primaryAction: UIAction { _ in gate.require(.newTemplate) })
            new.accessibilityLabel = L10n.templatesNew()
            items.append(new)
        } else {
            let bookId = bookId
            let compose = UIBarButtonItem(
                systemItem: .compose, primaryAction: UIAction { _ in gate.require(.newNote(bookId: bookId)) },
                menu: ListMenus.compose(
                    newNote: { gate.require(.newNote(bookId: $0 ?? bookId)) },
                    library: { [weak self] in self?.library($0) },
                    fromTemplate: { [weak self] in self?.pickTemplate() }))
            compose.accessibilityLabel = L10n.noteListNewNote()
            items.append(compose)
            items.append(.fixedSpace(0))
        }
        let filtering = source.status != .all
        let filter = UIBarButtonItem(
            image: UIImage(
                systemName: filtering ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"),
            menu: ListMenus.filter(
                source.status, select: source.view == .templates ? nil : { [weak self] in self?.select(true) },
                choose: { [weak self] in self?.filter($0) }))
        filter.accessibilityLabel = L10n.phoneFilterLabel()
        filter.accessibilityValue = source.status.name
        filter.tintColor = filtering ? Tokens.Color.accentText : nil
        if source.view != .templates { items.append(filter) }
        navigationItem.rightBarButtonItems = items
    }

    private func filter(_ status: StatusFilter) {
        if status != source.status { context.haptics.play(.pickerChoice) }
        source.filter(status)
        setBarItems()
    }

    private func pickTemplate() {
        let bookId = bookId
        let gate = context.gate
        let picker = TemplatePicker(context: context) { [weak self] templateId in
            self?.dismiss(animated: true) { gate.require(.fromTemplate(templateId: templateId, bookId: bookId)) }
        }
        present(UINavigationController(rootViewController: picker), animated: true)
    }

    // MARK: Selecting several notes

    private func select(_ on: Bool) {
        collection.isEditing = on
        if on { context.prepareHaptics() }
        if !on {
            for path in collection.indexPathsForSelectedItems ?? [] { collection.deselectItem(at: path, animated: true) }
        }
        setBarItems()
        setBatchBar()
        navigationController?.setToolbarHidden(!on, animated: !context.reduceMotion())
    }

    private var selectedIds: [String] {
        (collection.indexPathsForSelectedItems ?? []).compactMap { path in
            if case .note(let id)? = data.itemIdentifier(for: path) { return id }
            return nil
        }
    }

    private func setBatchBar() {
        let ids = selectedIds
        let context = context
        let some = !ids.isEmpty
        let pinned = ids.allSatisfy { source.row($0)?.pinned ?? false }
        let pin = UIBarButtonItem(
            title: pinned ? L10n.batchUnpin() : L10n.batchPin(), image: UIImage(systemName: pinned ? "pin.slash" : "pin"),
            primaryAction: UIAction { [weak self] _ in
                context.ask(.batch(ids: ids, change: .pinned(!pinned)))
                self?.select(false)
            })
        let move = UIBarButtonItem(
            title: L10n.batchMove(), image: UIImage(systemName: "folder"),
            menu: UIMenu(children: [
                ListMenus.notebooks(selected: nil, library: { [weak self] in self?.library($0) }) { [weak self] book in
                    context.ask(.batch(ids: ids, change: .book(book)))
                    self?.select(false)
                }
            ]))
        let status = UIBarButtonItem(
            title: L10n.phoneSetStatus(), image: UIImage(systemName: "circle.dashed"),
            menu: UIMenu(children: NoteStatus.allCases.map { status in
                UIAction(title: status.name, image: UIImage(systemName: status.symbol)) { [weak self] _ in
                    context.ask(.batch(ids: ids, change: .status(status)))
                    self?.select(false)
                }
            }))
        let trash = UIBarButtonItem(
            title: L10n.batchTrash(), image: UIImage(systemName: "trash"),
            primaryAction: UIAction(attributes: .destructive) { [weak self] _ in
                context.ask(.batch(ids: ids, change: .trash))
                self?.select(false)
            })
        for item in [pin, move, status, trash] { item.isEnabled = some }
        toolbarItems = [pin, .flexibleSpace(), move, .flexibleSpace(), status, .flexibleSpace(), trash]
    }
}
