import UIKit

/// The Library (design/phone.md, Library): the smart lists, then Notebooks and Tags under heads
/// that fold for the session, the saved searches, then Templates and Trash. Each row opens its list
/// on this tab, and a saved search opens in the Search tab.
final class LibraryScreen: ListScreen, UICollectionViewDelegate {
    enum Section: Int, Hashable, Sendable {
        case smart
        case notebooks
        case tags
        case searches
        case more
    }

    enum Item: Hashable, Sendable {
        case smart(SmartList)
        case head(Section)
        case book(String)
        case tag(String)
        case search(String)
        case templates
        case trash
    }

    enum SmartList: CaseIterable, Sendable {
        case all
        case pinned
        case active
        case completed
    }

    private var data: UICollectionViewDiffableDataSource<Section, Item>!
    private var library: LibraryContents?
    private var foldedSections: Set<Section> = []
    private var foldedBooks: Set<String> = []
    private var depths: [String: Int] = [:]
    /// Opens a list on this screen's stack.
    var push: (UIViewController) -> Void = { _ in }
    /// Runs a saved search's query in the Search tab.
    var openSearch: (String) -> Void = { _ in }

    init(tab: Tab, context: ListContext) {
        super.init(title: L10n.phoneTabLibrary(), tab: tab, context: context, isRoot: true)
        context.watch(self) { [weak self] change in
            if case .library(let read) = change { self?.show(read) }
        }
    }

    required init?(coder: NSCoder) { nil }

    override func makeLayout() -> UICollectionViewLayout {
        var list = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
        list.backgroundColor = Tokens.Color.phoneBackground
        return UICollectionViewCompositionalLayout.list(using: list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let cells = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
            self?.configure(cell, item)
        }
        data = UICollectionViewDiffableDataSource(collectionView: collection) { collection, path, item in
            collection.dequeueConfiguredReusableCell(using: cells, for: path, item: item)
        }
        let gate = context.gate
        let compose = UIBarButtonItem(
            systemItem: .compose, primaryAction: UIAction { _ in gate.require(.newNote(bookId: nil)) },
            menu: ListMenus.compose(
                newNote: { gate.require(.newNote(bookId: $0)) },
                library: { [weak self] done in done(self?.library) },
                fromTemplate: { [weak self] in self?.pickTemplate() }))
        compose.accessibilityLabel = L10n.noteListNewNote()
        let book = UIBarButtonItem(
            image: UIImage(systemName: "folder.badge.plus"),
            primaryAction: UIAction { [weak self] _ in self?.newNotebook() })
        book.accessibilityLabel = L10n.bookNew()
        navigationItem.rightBarButtonItems = [compose, .fixedSpace(0), book]
        if let read = context.library { show(read) }
        context.readLibrary()
    }

    /// A notebook named New Notebook at the top level, as on the Mac; it shows once the page reports it.
    func newNotebook() {
        context.gate.require(.newNotebook)
    }

    private func pickTemplate() {
        let gate = context.gate
        let picker = TemplatePicker(context: context) { [weak self] templateId in
            self?.dismiss(animated: true) { gate.require(.fromTemplate(templateId: templateId, bookId: nil)) }
        }
        present(UINavigationController(rootViewController: picker), animated: true)
    }

    private func show(_ read: LibraryContents) {
        let animated = library != nil && !context.reduceMotion()
        let previous = library
        library = read
        depths = read.depths
        guard let data else { return }
        var snapshot = snapshot()
        if previous != read { snapshot.reconfigureItems(snapshot.itemIdentifiers) }
        data.apply(snapshot, animatingDifferences: animated)
    }

    private func snapshot() -> NSDiffableDataSourceSnapshot<Section, Item> {
        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        snapshot.appendSections([.smart])
        snapshot.appendItems(SmartList.allCases.map(Item.smart), toSection: .smart)
        if let library, !library.books.isEmpty {
            snapshot.appendSections([.notebooks])
            snapshot.appendItems([.head(.notebooks)], toSection: .notebooks)
            if !foldedSections.contains(.notebooks) {
                snapshot.appendItems(shownBooks(library).map(Item.book), toSection: .notebooks)
            }
        }
        if let library, !library.tags.isEmpty {
            snapshot.appendSections([.tags])
            snapshot.appendItems([.head(.tags)], toSection: .tags)
            if !foldedSections.contains(.tags) {
                snapshot.appendItems(library.tags.map { .tag($0.id) }, toSection: .tags)
            }
        }
        if let library, !library.savedSearches.isEmpty {
            snapshot.appendSections([.searches])
            snapshot.appendItems([.head(.searches)], toSection: .searches)
            if !foldedSections.contains(.searches) {
                snapshot.appendItems(library.savedSearches.map { .search($0.id) }, toSection: .searches)
            }
        }
        snapshot.appendSections([.more])
        snapshot.appendItems([.templates, .trash], toSection: .more)
        return snapshot
    }

    /// The notebooks whose ancestors are all open, in the Library's order.
    private func shownBooks(_ library: LibraryContents) -> [String] {
        var hidden = Set<String>()
        var shown: [String] = []
        for book in library.books {
            if let parent = book.parentId, hidden.contains(parent) || foldedBooks.contains(parent) {
                hidden.insert(book.id)
            } else {
                shown.append(book.id)
            }
        }
        return shown
    }

    private func hasChildren(_ id: String) -> Bool {
        library?.books.contains { $0.parentId == id } ?? false
    }

    private func configure(_ cell: UICollectionViewListCell, _ item: Item) {
        var content = UIListContentConfiguration.cell()
        content.textProperties.color = Tokens.Color.phoneText
        content.secondaryTextProperties.color = Tokens.Color.phoneTextSecondary
        content.imageProperties.tintColor = Tokens.Color.phoneText
        content.prefersSideBySideTextAndSecondaryText = true
        var accessories: [UICellAccessory] = []
        let counts = library?.counts
        cell.indentationLevel = 0
        cell.accessibilityTraits = []
        cell.accessibilityHint = nil
        switch item {
        case .smart(let smart):
            content.text = Self.name(smart)
            content.image = UIImage(systemName: Self.symbol(smart))
            content.secondaryText = counts.map { String(Self.count(smart, $0)) }
            accessories = [.disclosureIndicator()]
        case .head(let section):
            content = UIListContentConfiguration.header()
            content.text = Self.head(section)
            content.textProperties.color = Tokens.Color.phoneTextSecondary
            let folded = foldedSections.contains(section)
            accessories = [Self.chevron(folded)]
            cell.accessibilityTraits = [.header, .button]
            cell.accessibilityHint =
                folded
                ? L10n.sidebarExpandSection(section: content.text ?? "")
                : L10n.sidebarCollapseSection(section: content.text ?? "")
        case .book(let id):
            let book = library?.books.first { $0.id == id }
            content.text = book?.name
            content.image = UIImage(systemName: "folder")
            content.secondaryText = book.map { String($0.count) }
            cell.indentationLevel = min(depths[id] ?? 0, 4)
            cell.indentationWidth = 28
            accessories = hasChildren(id) ? [fold(id, name: book?.name ?? "")] : [.disclosureIndicator()]
        case .tag(let id):
            let tag = library?.tags.first { $0.id == id }
            content.text = tag?.name
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = Self.tagColor(tag?.color)
            content.imageProperties.maximumSize = CGSize(
                width: Tokens.Size.iconPhoneTagDot, height: Tokens.Size.iconPhoneTagDot)
            content.imageProperties.reservedLayoutSize = CGSize(width: Tokens.Size.phoneRowIcon, height: 0)
            content.secondaryText = tag.map { String($0.count) }
            accessories = [.disclosureIndicator()]
        case .search(let id):
            content.text = library?.savedSearches.first { $0.id == id }?.name
            content.image = UIImage(systemName: "magnifyingglass")
        case .templates:
            content.text = L10n.sidebarTemplates()
            content.image = UIImage(systemName: "doc.on.doc")
            content.secondaryText = counts.map { String($0.templates) }
            accessories = [.disclosureIndicator()]
        case .trash:
            content.text = L10n.sidebarTrash()
            content.image = UIImage(systemName: "trash")
            content.secondaryText = counts.map { String($0.trash) }
            accessories = [.disclosureIndicator()]
        }
        cell.contentConfiguration = content
        cell.accessories = accessories
    }

    /// The chevron of a notebook with notebooks inside folds it; the rest of its row opens it.
    private func fold(_ id: String, name: String) -> UICellAccessory {
        let folded = foldedBooks.contains(id)
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: folded ? "chevron.right" : "chevron.down")
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote)
        configuration.baseForegroundColor = Tokens.Color.phoneTextSecondary
        let button = UIButton(
            configuration: configuration,
            primaryAction: UIAction { [weak self] _ in
                guard let self else { return }
                if foldedBooks.remove(id) == nil { foldedBooks.insert(id) }
                refold(.book(id))
            })
        button.accessibilityLabel = folded ? L10n.phoneLibraryExpand(name: name) : L10n.phoneLibraryCollapse(name: name)
        let size = Tokens.Size.phoneTarget
        button.frame = CGRect(x: 0, y: 0, width: size, height: size)
        return .customView(configuration: .init(customView: button, placement: .trailing(), reservedLayoutWidth: .custom(size)))
    }

    private static func chevron(_ folded: Bool) -> UICellAccessory {
        let chevron = UIImageView(image: UIImage(systemName: folded ? "chevron.right" : "chevron.down"))
        chevron.tintColor = Tokens.Color.phoneTextSecondary
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        return .customView(configuration: .init(customView: chevron, placement: .trailing()))
    }

    private static func head(_ section: Section) -> String {
        switch section {
        case .notebooks: L10n.sidebarNotebooks()
        case .tags: L10n.sidebarTags()
        case .searches: L10n.sidebarSavedSearches()
        case .smart, .more: ""
        }
    }

    static func tagColor(_ name: String?) -> UIColor {
        guard let name, let token = Tokens.ColorName(rawValue: "color.tag-icon.\(name)") else {
            return Tokens.Color.phoneTextSecondary
        }
        return Tokens.Theme.current.color(token)
    }

    static func name(_ smart: SmartList) -> String {
        switch smart {
        case .all: L10n.sidebarAllNotes()
        case .pinned: L10n.sidebarPinned()
        case .active: L10n.statusActive()
        case .completed: L10n.statusCompleted()
        }
    }

    private static func symbol(_ smart: SmartList) -> String {
        switch smart {
        case .all: "tray.full"
        case .pinned: "pin"
        case .active: NoteStatus.active.symbol
        case .completed: "checkmark.circle"
        }
    }

    private static func count(_ smart: SmartList, _ counts: LibraryCounts) -> Int {
        switch smart {
        case .all: counts.all
        case .pinned: counts.pinned
        case .active: counts.active
        case .completed: counts.completed
        }
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt path: IndexPath) {
        guard let item = data.itemIdentifier(for: path) else { return }
        switch item {
        case .head(let section):
            collectionView.deselectItem(at: path, animated: false)
            if foldedSections.remove(section) == nil { foldedSections.insert(section) }
            refold(item)
        case .search(let id):
            collectionView.deselectItem(at: path, animated: false)
            if let query = library?.savedSearches.first(where: { $0.id == id })?.query { openSearch(query) }
        default:
            guard let screen = screen(item) else { return }
            push(screen)
        }
    }

    private func refold(_ item: Item) {
        var snapshot = snapshot()
        snapshot.reconfigureItems([item])
        data.apply(snapshot, animatingDifferences: !context.reduceMotion())
    }

    private func screen(_ item: Item) -> UIViewController? {
        let note = { (title: String, view: ListView, status: StatusFilter) in
            NoteListScreen(title: title, view: view, status: status, tab: self.listTab, context: self.context, isRoot: false)
        }
        switch item {
        case .smart(.all): return note(L10n.sidebarAllNotes(), .all, .all)
        case .smart(.pinned): return note(L10n.sidebarPinned(), .pinned, .all)
        case .smart(.active): return note(L10n.statusActive(), .all, .active)
        case .smart(.completed): return note(L10n.statusCompleted(), .all, .completed)
        case .book(let id):
            return note(library?.books.first { $0.id == id }?.name ?? L10n.sidebarNotebooks(), .book(id), .all)
        case .tag(let id): return note("#" + (library?.tags.first { $0.id == id }?.name ?? ""), .tag(id), .all)
        case .templates: return TemplatesScreen.make(context: context, tab: listTab)
        case .trash: return TrashScreen(tab: listTab, context: context)
        case .head, .search: return nil
        }
    }
}
