import UIKit

/// The Templates list, which New Template adds to, and the picker From Template opens.
@MainActor
enum TemplatesScreen {
    static func make(context: ListContext, tab: Tab) -> NoteListScreen {
        NoteListScreen(title: L10n.sidebarTemplates(), view: .templates, tab: tab, context: context, isRoot: false)
    }
}

/// From Template: the templates by name; choosing one hands it back, and the caller writes once
/// the picker has gone.
final class TemplatePicker: UIViewController, UICollectionViewDelegate {
    private let source: NoteListDataSource
    private let context: ListContext
    private let choose: (String) -> Void
    private var data: UICollectionViewDiffableDataSource<Int, String>!

    init(context: ListContext, choose: @escaping (String) -> Void) {
        self.context = context
        self.choose = choose
        source = context.source(.templates)
        super.init(nibName: nil, bundle: nil)
        navigationItem.title = L10n.templatesPickTitle()
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
        var list = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
        list.backgroundColor = Tokens.Color.phoneBackground
        let collection = UICollectionView(
            frame: view.bounds, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: list))
        collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collection.delegate = self
        view.addSubview(collection)
        let rows = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
            var content = cell.defaultContentConfiguration()
            let note = self?.source.row(id)
            content.text = note.map { NoteCell.title($0, excerpt: self?.context.excerpts.excerpt($0)) }
            content.image = UIImage(systemName: "doc.text")
            cell.contentConfiguration = content
        }
        data = UICollectionViewDiffableDataSource(collectionView: collection) { collection, path, id in
            collection.dequeueConfiguredReusableCell(using: rows, for: path, item: id)
        }
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        source.onUpdate = { [weak self] update in
            guard let self else { return }
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(update.layout.ids[.recent] ?? [])
            data.apply(snapshot, animatingDifferences: update.animated)
        }
        source.load()
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt path: IndexPath) {
        guard let id = data.itemIdentifier(for: path) else { return }
        choose(id)
    }
}
