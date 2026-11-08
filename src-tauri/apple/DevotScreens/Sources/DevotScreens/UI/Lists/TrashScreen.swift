import UIKit

/// The Trash: Restore leads, Delete Permanently trails, and Empty Trash asks first. Every write
/// goes through the gate.
final class TrashScreen: ListScreen, UICollectionViewDelegate {
    private var data: UICollectionViewDiffableDataSource<Int, String>!
    private var rows: [String: TrashedRow] = [:]
    private var reading = false
    private var again = false
    private let empty = UILabel()
    private var afterMenu: (() -> Void)?

    init(tab: Tab, context: ListContext) {
        super.init(title: L10n.sidebarTrash(), tab: tab, context: context, isRoot: false)
        context.watch(self) { [weak self] change in
            if case .trash = change { self?.read() }
        }
    }

    required init?(coder: NSCoder) { nil }

    override func makeLayout() -> UICollectionViewLayout {
        var list = UICollectionLayoutListConfiguration(appearance: .plain)
        list.showsSeparators = false
        list.backgroundColor = Tokens.Color.phoneBackground
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
        let cells = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
            guard let row = self?.rows[id] else { return }
            var content = UIListContentConfiguration.subtitleCell()
            content.text = row.title.isEmpty ? L10n.noteUntitled() : row.title
            content.textProperties.color = Tokens.Color.phoneText
            content.secondaryText = NoteCell.time(row.deletedAt, now: Date())
            content.secondaryTextProperties.color = Tokens.Color.phoneTextSecondary
            content.directionalLayoutMargins.top = Tokens.Size.phoneRowPad
            content.directionalLayoutMargins.bottom = Tokens.Size.phoneRowPad
            cell.contentConfiguration = content
            var background = UIBackgroundConfiguration.listCell()
            background.backgroundColor = Tokens.Color.phoneBackground
            cell.backgroundConfiguration = background
        }
        data = UICollectionViewDiffableDataSource(collectionView: collection) { collection, path, id in
            collection.dequeueConfiguredReusableCell(using: cells, for: path, item: id)
        }
        empty.text = L10n.noteListEmptyTrash()
        empty.font = UIFont.preferredFont(forTextStyle: .body)
        empty.adjustsFontForContentSizeCategory = true
        empty.textColor = Tokens.Color.phoneTextSecondary
        empty.textAlignment = .center
        empty.isHidden = true
        collection.backgroundView = empty
        let emptyTrash = UIBarButtonItem(
            image: UIImage(systemName: "xmark.bin"),
            primaryAction: UIAction { [weak self] _ in self?.confirmEmpty() })
        emptyTrash.accessibilityLabel = L10n.trashEmpty()
        navigationItem.rightBarButtonItem = emptyTrash
        read()
    }

    private func read() {
        guard let bridge = context.bridge, data != nil else { return }
        guard !reading else {
            again = true
            return
        }
        reading = true
        bridge.direct(.listsTrash, [:]) { [weak self] outcome in
            guard let self else { return }
            reading = false
            switch outcome {
            case .ok(let value):
                if let found = value.decoded([TrashedRow].self) { show(found) }
            case .failed(let code):
                bridge.log(.warn, "W_PHONE_TRASH_READ_FAILED code=\(code)")
            }
            if again {
                again = false
                read()
            }
        }
    }

    private func show(_ found: [TrashedRow]) {
        let previous = rows
        rows = Dictionary(found.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(found.map(\.id))
        snapshot.reconfigureItems(found.filter { row in previous[row.id].map { $0 != row } ?? false }.map(\.id))
        data.apply(snapshot, animatingDifferences: !previous.isEmpty && !context.reduceMotion())
        empty.isHidden = !found.isEmpty
        navigationItem.rightBarButtonItem?.isEnabled = !found.isEmpty
    }

    private func swipe(_ path: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
        guard let id = data.itemIdentifier(for: path) else { return nil }
        let gate = context.gate
        if leading {
            let restore = UIContextualAction(style: .normal, title: L10n.trashRestore()) { _, _, completion in
                MainActor.assumeIsolated {
                    completion(!gate.locked())
                    gate.require(.batch(ids: [id], change: .restore))
                }
            }
            restore.image = UIImage(systemName: "arrow.uturn.backward")
            restore.backgroundColor = Tokens.Color.phoneActionStatus
            return UISwipeActionsConfiguration(actions: [restore])
        }
        let delete = UIContextualAction(style: .destructive, title: L10n.trashDeleteForever()) {
            [weak self] _, _, completion in
            MainActor.assumeIsolated {
                completion(false)
                self?.confirmDelete(id)
            }
        }
        delete.image = UIImage(systemName: "trash")
        delete.backgroundColor = Tokens.Color.phoneActionTrash
        let configuration = UISwipeActionsConfiguration(actions: [delete])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt path: IndexPath) -> Bool { false }

    func collectionView(
        _ collectionView: UICollectionView, contextMenuConfigurationForItemsAt paths: [IndexPath], point: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard paths.count == 1, let path = paths.first, let id = data.itemIdentifier(for: path) else { return nil }
        let gate = context.gate
        return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
            MainActor.assumeIsolated {
                UIMenu(children: [
                    UIAction(title: L10n.trashRestore(), image: UIImage(systemName: "arrow.uturn.backward")) { _ in
                        self?.afterMenu = { gate.require(.batch(ids: [id], change: .restore)) }
                    },
                    UIAction(
                        title: L10n.trashDeleteForever(), image: UIImage(systemName: "trash"), attributes: .destructive
                    ) { _ in self?.afterMenu = { self?.confirmDelete(id) } },
                ])
            }
        }
    }

    func collectionView(
        _ collectionView: UICollectionView, willEndContextMenuInteraction configuration: UIContextMenuConfiguration,
        animator: (any UIContextMenuInteractionAnimating)?
    ) {
        guard let run = afterMenu else { return }
        afterMenu = nil
        guard let animator else { return run() }
        animator.addCompletion { run() }
    }

    private func confirmDelete(_ id: String) {
        let title = rows[id].map { $0.title.isEmpty ? L10n.noteUntitled() : $0.title } ?? L10n.noteUntitled()
        confirm(L10n.trashConfirmOne(title: title), action: L10n.trashDeleteForever()) { [gate = context.gate] in
            gate.require(.batch(ids: [id], change: .purge))
        }
    }

    private func confirmEmpty() {
        confirm(
            L10n.trashConfirmEmpty(notes: L10n.phoneLibraryNoteCount(count: String(rows.count))), action: L10n.trashEmpty()
        ) { [gate = context.gate] in gate.require(.emptyTrash) }
    }

    private func confirm(_ title: String, action: String, then: @escaping () -> Void) {
        let alert = UIAlertController(title: title, message: L10n.trashCannotUndo(), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L10n.dialogCancel(), style: .cancel))
        alert.addAction(UIAlertAction(title: action, style: .destructive) { _ in then() })
        present(alert, animated: true)
    }
}
