import SwiftUI
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
        let heatmap = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, _ in
            cell.contentConfiguration = UIHostingConfiguration {
                HeatmapView(writing: self?.writing)
            }
        }
        let figures = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, _ in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                FiguresView(week: self.writing?.week(self.period), period: self.period) { [weak self] next in
                    self?.choose(next)
                }
            }
        }
        let note = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { cell, _, item in
            guard case .note(let ranked, let place) = item else { return }
            var content = UIListContentConfiguration.valueCell()
            content.image = UIImage(systemName: "\(place).circle")
            content.imageProperties.tintColor = Tokens.Color.phoneTextSecondary
            content.text = ranked.title.isEmpty ? L10n.noteUntitled() : ranked.title
            content.secondaryText = "+" + ranked.words.formatted()
            content.secondaryTextProperties.font = .monospacedDigitSystemFont(
                ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular)
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

/// Fifteen weeks of writing, a column a week and a row a weekday, shaded by the words written.
struct HeatmapView: View {
    let writing: ActivityWriting?
    @ScaledMetric(relativeTo: .caption2) private var cell = Tokens.Size.phoneHeatCell
    @ScaledMetric(relativeTo: .caption2) private var gap = Tokens.Size.phoneHeatGap

    private static func shade(_ level: Int) -> Color {
        let colors = [
            Tokens.Color.activityLevel0, Tokens.Color.activityLevel1, Tokens.Color.activityLevel2,
            Tokens.Color.activityLevel3, Tokens.Color.activityLevel4,
        ]
        return Color(colors[min(max(level, 0), colors.count - 1)])
    }

    private var summary: String {
        L10n.phoneActivitySummary(
            weeks: String(ActivityWriting.weeks), words: (writing?.totalWords ?? 0).formatted(),
            days: (writing?.activeDays ?? 0).formatted())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space4) {
            HStack(alignment: .firstTextBaseline) {
                Text(L10n.phoneActivityWriting()).font(.headline)
                Spacer()
                Text(L10n.phoneActivitySpan(weeks: String(ActivityWriting.weeks)))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
            }
            if let writing {
                let labels = ActivityWriting.monthLabels(first: writing.first, weeks: ActivityWriting.weeks)
                let columns = writing.grid
                VStack(alignment: .leading, spacing: gap) {
                    HStack(spacing: gap) {
                        ForEach(labels.indices, id: \.self) { week in
                            Text(labels[week])
                                .font(.caption2)
                                .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
                                .fixedSize()
                                .frame(width: cell, alignment: .leading)
                        }
                    }
                    .accessibilityHidden(true)
                    HStack(alignment: .top, spacing: gap) {
                        ForEach(columns.indices, id: \.self) { week in
                            VStack(spacing: gap) {
                                ForEach(0..<7, id: \.self) { row in
                                    RoundedRectangle(cornerRadius: Tokens.Radius.phoneHeatCell)
                                        .fill(columns[week][row].map(Self.shade) ?? .clear)
                                        .frame(width: cell, height: cell)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement()
                .accessibilityLabel(summary)
                .accessibilityAddTraits(.isImage)
            }
            HStack(spacing: gap) {
                Text(L10n.phoneActivityLess())
                ForEach(0...ActivityWriting.levels, id: \.self) { level in
                    RoundedRectangle(cornerRadius: Tokens.Radius.phoneHeatCell)
                        .fill(Self.shade(level))
                        .frame(width: Tokens.Size.phoneHeatLegend, height: Tokens.Size.phoneHeatLegend)
                }
                Text(L10n.phoneActivityMore())
            }
            .font(.caption2)
            .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
            .accessibilityHidden(true)
        }
        .padding(.vertical, Tokens.Space.space4)
    }
}

/// The week's choice and its three figures; a choice replaces the figures at once.
struct FiguresView: View {
    let week: ActivityWriting.Week?
    let period: ActivityWriting.Period
    let choose: (ActivityWriting.Period) -> Void

    private var figures: [(value: Int, label: String)] {
        [
            (week?.words ?? 0, period == .last ? L10n.phoneActivityWordsLast() : L10n.phoneActivityWordsThis()),
            (week?.streak ?? 0, L10n.phoneActivityStreak()),
            (week?.notesEdited ?? 0, L10n.phoneActivityEdited()),
        ]
    }

    var body: some View {
        VStack(spacing: Tokens.Space.space6) {
            Picker(L10n.phoneActivityPeriod(), selection: Binding(get: { period }, set: { choose($0) })) {
                Text(L10n.phoneActivityWeekThis()).tag(ActivityWriting.Period.this)
                Text(L10n.phoneActivityWeekLast()).tag(ActivityWriting.Period.last)
            }
            .pickerStyle(.segmented)
            HStack(alignment: .top) {
                ForEach(figures, id: \.label) { figure in
                    VStack(spacing: Tokens.Space.space2) {
                        Text(figure.value.formatted()).font(.title2.monospacedDigit()).fontWeight(.semibold)
                        Text(figure.label)
                            .font(.caption)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .combine)
                }
            }
            .transaction { $0.animation = nil }
        }
        .padding(.vertical, Tokens.Space.space4)
    }
}
