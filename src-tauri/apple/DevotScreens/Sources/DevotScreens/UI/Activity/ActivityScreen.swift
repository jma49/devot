import UIKit

/// The Activity tab's root (docs/specs/iphone-screens.md, Activity): the last weeks' writing as a
/// heatmap, the chosen week's figures and its most edited notes, which open as a list's rows do.
/// A change of week replaces the figures at once (design/motion.md, Activity).
final class ActivityScreen: ListScreen, UICollectionViewDelegate {
    enum Section: Int, CaseIterable {
        case heatmap
        case figures
        case ranked
    }

    enum Item: Hashable {
        case heatmap
        case figures
        case note(ActivityWriting.Ranked, place: Int)
        case empty
    }

    private(set) var writing: ActivityWriting?
    private(set) var period: ActivityWriting.Period = .this
    private var data: UICollectionViewDiffableDataSource<Section, Item>!
    private var reading = false
    private var readAgain = false
    private var stale = true

    init(context: ListContext) {
        super.init(title: L10n.phoneTabActivity(), tab: .activity, context: context, isRoot: true)
    }

    required init?(coder: NSCoder) { nil }

    override func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { index, environment in
            var list = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
            list.backgroundColor = Tokens.Color.phoneBackground
            if Section(rawValue: index) == .ranked { list.headerMode = .supplementary }
            return NSCollectionLayoutSection.list(using: list, layoutEnvironment: environment)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        collection.accessibilityIdentifier = "activity.list"
        let heatmap = UICollectionView.CellRegistration<HeatmapCell, Item> { [weak self] cell, _, _ in
            cell.show(self?.writing)
        }
        let figures = UICollectionView.CellRegistration<FiguresCell, Item> { [weak self] cell, _, _ in
            guard let self else { return }
            cell.show(writing?.week(period), period: period)
            cell.choose = { [weak self] next in self?.choose(next) }
        }
        let note = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { cell, _, item in
            guard case .note(let ranked, let place) = item else { return }
            var content = UIListContentConfiguration.valueCell()
            content.image = UIImage(systemName: "\(place).circle")
            content.imageProperties.tintColor = Tokens.Color.phoneTextSecondary
            content.text = ranked.title.isEmpty ? L10n.noteUntitled() : ranked.title
            content.secondaryText = "+" + ranked.words.formatted()
            content.secondaryTextProperties.font = UIFontMetrics(forTextStyle: .body).scaledFont(
                for: .monospacedDigitSystemFont(
                    ofSize: UIFont.preferredFont(forTextStyle: .body, compatibleWith: .init(preferredContentSizeCategory: .large)).pointSize,
                    weight: .regular))
            content.secondaryTextProperties.adjustsFontForContentSizeCategory = true
            cell.contentConfiguration = content
            cell.accessories = [.disclosureIndicator()]
        }
        let empty = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { cell, _, _ in
            var content = cell.defaultContentConfiguration()
            content.text = L10n.phoneActivityNoGrowth()
            content.textProperties.color = Tokens.Color.phoneTextSecondary
            cell.contentConfiguration = content
        }
        data = UICollectionViewDiffableDataSource(collectionView: collection) { collection, path, item in
            switch item {
            case .heatmap: collection.dequeueConfiguredReusableCell(using: heatmap, for: path, item: item)
            case .figures: collection.dequeueConfiguredReusableCell(using: figures, for: path, item: item)
            case .note: collection.dequeueConfiguredReusableCell(using: note, for: path, item: item)
            case .empty: collection.dequeueConfiguredReusableCell(using: empty, for: path, item: item)
            }
        }
        let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [weak self] cell, _, _ in
            var content = UIListContentConfiguration.header()
            content.text = self?.period == .last ? L10n.phoneActivityRankedLast() : L10n.phoneActivityRankedThis()
            cell.contentConfiguration = content
        }
        data.supplementaryViewProvider = { collection, kind, path in
            collection.dequeueConfiguredReusableSupplementary(using: header, for: path)
        }
        context.watch(self) { [weak self] change in
            guard let self, case .notes = change else { return }
            stale = true
            if viewIfLoaded?.window != nil { read() }
        }
        show()
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        if stale { read() }
    }

    /// The figures again, once at a time; a change while reading reads once more after.
    func read() {
        guard let bridge = context.bridge else { return }
        guard !reading else {
            readAgain = true
            return
        }
        reading = true
        stale = false
        bridge.request(.activityWriting, [:]) { [weak self] outcome in
            guard let self else { return }
            reading = false
            switch outcome {
            case .ok(let value):
                if let next = ActivityWriting(value) {
                    writing = next
                    show()
                } else {
                    bridge.log(.warn, "W_PHONE_ACTIVITY_READ_FAILED code=E_SCREENS_MESSAGE_INVALID")
                }
            case .failed(let code):
                stale = true
                bridge.log(.warn, "W_PHONE_ACTIVITY_READ_FAILED code=\(code)")
            }
            if readAgain {
                readAgain = false
                read()
            }
        }
    }

    func choose(_ next: ActivityWriting.Period) {
        guard next != period else { return }
        period = next
        context.haptics.play(.pickerChoice)
        show()
    }

    /// Every section drawn again without motion: a new reading or another week replaces the figures.
    private func show() {
        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        snapshot.appendSections(Section.allCases)
        snapshot.appendItems([.heatmap], toSection: .heatmap)
        snapshot.appendItems([.figures], toSection: .figures)
        let ranked = writing?.week(period).ranked ?? []
        snapshot.appendItems(
            ranked.isEmpty ? [.empty] : ranked.enumerated().map { .note($1, place: $0 + 1) }, toSection: .ranked)
        snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { $0 == .heatmap || $0 == .figures })
        data.apply(snapshot, animatingDifferences: false)
        if let header = collection.supplementaryView(
            forElementKind: UICollectionView.elementKindSectionHeader,
            at: IndexPath(item: 0, section: Section.ranked.rawValue)) as? UICollectionViewListCell,
            var content = header.contentConfiguration as? UIListContentConfiguration
        {
            content.text = period == .last ? L10n.phoneActivityRankedLast() : L10n.phoneActivityRankedThis()
            header.contentConfiguration = content
        }
    }

    func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt path: IndexPath) -> Bool {
        if case .note = data.itemIdentifier(for: path) { return true }
        return false
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt path: IndexPath) {
        guard case .note(let ranked, _) = data.itemIdentifier(for: path) else { return }
        context.open(ranked.id, ranked.title)
    }
}
