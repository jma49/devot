import UIKit

/// The Search tab (design/phone.md, Search): the system search field with the All and Titles
/// scopes; before a query, recent searches and notebooks, statuses and tags to search by, as solid
/// rows; then the notes found, each opening its editor on this tab.
final class SearchScreen: ListScreen, UICollectionViewDelegate, UISearchResultsUpdating, UISearchBarDelegate {
    enum Section: Hashable, Sendable {
        case recent
        case notebooks
        case statuses
        case tags
        case found
    }

    enum Item: Hashable, Sendable {
        case recent(String)
        case book(String)
        case status(NoteStatus)
        case tag(String)
        case note(String)
    }

    /// The statuses offered before a query, as the web Search offered them.
    static let statuses: [NoteStatus] = [.active, .onHold, .completed]

    let model: SearchModel
    let recents: RecentSearches
    let search = UISearchController(searchResultsController: nil)
    private var data: UICollectionViewDiffableDataSource<Section, Item>!
    private var library: LibraryContents?
    private var hits: [String: SearchModel.Hit] = [:]

    init(context: ListContext, recents: RecentSearches = RecentSearches()) {
        model = SearchModel { [weak context] in context?.bridge }
        self.recents = recents
        super.init(title: L10n.phoneTabSearch(), tab: .search, context: context, isRoot: true)
        model.onResults = { [weak self] in self?.showResults() }
        context.watch(self) { [weak self] change in
            guard let self else { return }
            switch change {
            case .notes: model.notesChanged()
            case .library(let read):
                library = read
                if model.query.isEmpty { apply() }
            case .excerpts(let ids): reconfigure(ids.map(Item.note))
            case .trash: break
            }
        }
        search.obscuresBackgroundDuringPresentation = false
        search.searchResultsUpdater = self
        search.searchBar.delegate = self
        search.searchBar.placeholder = L10n.phoneSearchPlaceholder()
        search.searchBar.autocapitalizationType = .none
        search.searchBar.scopeButtonTitles = SearchModel.Scope.allCases.map(\.name)
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = false
        definesPresentationContext = true
    }

    required init?(coder: NSCoder) { nil }

    override func makeLayout() -> UICollectionViewLayout {
        var list = UICollectionLayoutListConfiguration(appearance: .plain)
        list.backgroundColor = Tokens.Color.phoneBackground
        list.headerMode = .supplementary
        return UICollectionViewCompositionalLayout.list(using: list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        collection.keyboardDismissMode = .onDrag
        let notes = UICollectionView.CellRegistration<NoteCell, String> { [weak self] cell, _, id in
            guard let self, let hit = hits[id] else { return }
            cell.show(row(hit))
        }
        let rows = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
            self?.configure(cell, item)
        }
        data = UICollectionViewDiffableDataSource(collectionView: collection) { collection, path, item in
            if case .note(let id) = item {
                return collection.dequeueConfiguredReusableCell(using: notes, for: path, item: id)
            }
            return collection.dequeueConfiguredReusableCell(using: rows, for: path, item: item)
        }
        let headers = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [weak self] header, _, path in
            guard let self, let section = data.sectionIdentifier(for: path.section) else { return }
            header.contentConfiguration = heading(section)
        }
        data.supplementaryViewProvider = { collection, _, path in
            collection.dequeueConfiguredReusableSupplementary(using: headers, for: path)
        }
        library = context.library
        apply()
        context.readLibrary()
    }

    /// A saved search from the Library: shown and run without raising the keyboard.
    func show(query: String) {
        loadViewIfNeeded()
        search.searchBar.text = query
        model.run(query)
    }

    func updateSearchResults(for searchController: UISearchController) {
        model.type(searchController.searchBar.text ?? "")
        if model.query.isEmpty { apply() }
    }

    func searchBar(_ searchBar: UISearchBar, selectedScopeButtonIndexDidChange selectedScope: Int) {
        guard SearchModel.Scope.allCases.indices.contains(selectedScope) else { return }
        model.choose(SearchModel.Scope.allCases[selectedScope])
    }

    private func showResults() {
        hits = Dictionary((model.results?.hits ?? []).map { ($0.note.id, $0) }, uniquingKeysWith: { first, _ in first })
        let lacking = (model.results?.hits ?? []).filter { $0.excerpt == nil }.map(\.note)
        if !lacking.isEmpty { context.excerpts.want(lacking) }
        apply()
    }

    private func apply() {
        guard let data else { return }
        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        if let results = model.results, !model.query.isEmpty {
            if !results.hits.isEmpty {
                snapshot.appendSections([.found])
                snapshot.appendItems(results.hits.map { .note($0.note.id) }, toSection: .found)
                snapshot.reconfigureItems(snapshot.itemIdentifiers)
            }
        } else if model.query.isEmpty {
            let recent = recents.queries
            if !recent.isEmpty {
                snapshot.appendSections([.recent])
                snapshot.appendItems(recent.map(Item.recent), toSection: .recent)
            }
            let books = library?.books ?? []
            if !books.isEmpty {
                snapshot.appendSections([.notebooks])
                snapshot.appendItems(books.map { .book($0.id) }, toSection: .notebooks)
            }
            snapshot.appendSections([.statuses])
            snapshot.appendItems(Self.statuses.map(Item.status), toSection: .statuses)
            let tags = library?.tags ?? []
            if !tags.isEmpty {
                snapshot.appendSections([.tags])
                snapshot.appendItems(tags.map { .tag($0.id) }, toSection: .tags)
            }
        }
        data.apply(snapshot, animatingDifferences: false)
        contentUnavailableConfiguration = nothingFound()
    }

    private func reconfigure(_ items: [Item]) {
        guard let data else { return }
        var snapshot = data.snapshot()
        let shown = items.filter { snapshot.indexOfItem($0) != nil }
        guard !shown.isEmpty else { return }
        snapshot.reconfigureItems(shown)
        data.apply(snapshot, animatingDifferences: false)
    }

    private func nothingFound() -> UIContentUnavailableConfiguration? {
        guard let results = model.results, results.hits.isEmpty, results.query == model.query, !model.query.isEmpty
        else { return nil }
        var empty = UIContentUnavailableConfiguration.empty()
        empty.image = UIImage(systemName: "magnifyingglass")
        empty.text = L10n.phoneSearchNone(query: results.query)
        empty.secondaryText = L10n.phoneSearchHint()
        empty.textProperties.color = Tokens.Color.phoneText
        empty.secondaryTextProperties.color = Tokens.Color.phoneTextSecondary
        empty.imageProperties.tintColor = Tokens.Color.phoneTextSecondary
        return empty
    }

    private func heading(_ section: Section) -> UIListContentConfiguration {
        var content = UIListContentConfiguration.plainHeader()
        content.textProperties.color = Tokens.Color.phoneTextSecondary
        switch section {
        case .recent: content.text = L10n.phoneSearchRecent()
        case .notebooks: content.text = L10n.sidebarNotebooks()
        case .statuses: content.text = L10n.sidebarStatuses()
        case .tags: content.text = L10n.sidebarTags()
        case .found:
            content.text = L10n.phoneTabNotes()
            if let results = model.results {
                content.secondaryText = results.capped ? "\(results.hits.count)+" : String(results.hits.count)
                content.secondaryTextProperties.color = Tokens.Color.phoneTextFaint
                content.prefersSideBySideTextAndSecondaryText = true
            }
        }
        return content
    }

    private func row(_ hit: SearchModel.Hit) -> NoteCell.Row {
        let tag = hit.note.tagIds.first.flatMap { id in library?.tags.first { $0.id == id } }
        return NoteCell.Row(
            note: hit.note, excerpt: hit.excerpt ?? context.excerpts.excerpt(hit.note), tag: tag, now: Date(),
            reduceMotion: context.reduceMotion())
    }

    private func configure(_ cell: UICollectionViewListCell, _ item: Item) {
        var content = UIListContentConfiguration.cell()
        content.textProperties.color = Tokens.Color.phoneText
        content.imageProperties.tintColor = Tokens.Color.phoneTextSecondary
        content.imageProperties.reservedLayoutSize = CGSize(width: Tokens.Size.phoneRowIcon, height: 0)
        switch item {
        case .recent(let query):
            content.text = query
            content.image = UIImage(systemName: "clock")
        case .book(let id):
            content.text = library?.books.first { $0.id == id }?.name
            content.image = UIImage(systemName: "folder")
        case .status(let status):
            content.text = status.name
            content.image = UIImage(systemName: status.symbol)
            content.imageProperties.tintColor = NoteCell.color(status)
        case .tag(let id):
            let tag = library?.tags.first { $0.id == id }
            content.text = tag.map { "#\($0.name)" }
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = LibraryScreen.tagColor(tag?.color)
            content.imageProperties.maximumSize = CGSize(width: 10, height: 10)
        case .note:
            break
        }
        cell.contentConfiguration = content
        var background = UIBackgroundConfiguration.listCell()
        background.backgroundColor = Tokens.Color.phoneBackground
        cell.backgroundConfiguration = background
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt path: IndexPath) {
        guard let item = data.itemIdentifier(for: path) else { return }
        if case .note(let id) = item, let hit = hits[id] {
            recents.remember(model.results?.query ?? model.query)
            context.open(id, NoteCell.title(hit.note, excerpt: hit.excerpt ?? context.excerpts.excerpt(hit.note)))
            return
        }
        collectionView.deselectItem(at: path, animated: false)
        guard let query = query(item) else { return }
        search.searchBar.text = query
        model.run(query)
    }

    /// What a row before a query fills the field with, followed by a space for the next word.
    func query(_ item: Item) -> String? {
        switch item {
        case .recent(let query): return query
        case .book(let id):
            return library?.books.first { $0.id == id }.map { SearchQuery.book(id: $0.id, name: $0.name) + " " }
        case .status(let status): return "is:\(status.rawValue) "
        case .tag(let id):
            return library?.tags.first { $0.id == id }.map { SearchQuery.tag(id: $0.id, name: $0.name) + " " }
        case .note: return nil
        }
    }
}

/// Clauses as `src/core/search.ts` spells them: by name where quoting holds the name, else by ID.
enum SearchQuery {
    static func book(id: String, name: String) -> String {
        named(name).map { "in:\($0)" } ?? "bookId:\(id)"
    }

    static func tag(id: String, name: String) -> String {
        named(name).map { "#\($0)" } ?? "tagId:\(id)"
    }

    /// A name with no space and no leading quote reads back as it is; one with a space reads back
    /// inside double quotes unless it holds one.
    private static func named(_ name: String) -> String? {
        guard !name.isEmpty, name.first != "\"", name.first != "'" else { return nil }
        guard name.contains(where: \.isWhitespace) else { return name }
        return name.contains("\"") ? nil : "\"\(name)\""
    }
}
