import Observation
import SwiftUI
import UIKit

@Observable
@MainActor
final class SettingsQuery {
    var text = ""
}

/// What the root's rows do beyond pushing a page.
@MainActor
struct SettingsActions {
    var open: (SettingsPage) -> Void = { _ in }
    var showTrial: (Date) -> Void = { _ in }
    var showMacKey: () -> Void = {}
}

/// The Settings tab's root: the app card, the groups of panes, the App Store's action rows and
/// the build; search results replace the groups while the search field holds a query.
struct SettingsRootView: View {
    let store: SettingsStore
    let query: SettingsQuery
    let actions: SettingsActions
    @State private var restoring: Restoring?
    @State private var refunding: Refunding?

    static let symbols = [
        "general": "gearshape", "appearance": "paintbrush", "editing": "text.cursor", "preview": "doc.richtext",
        "sync": "arrow.triangle.2.circlepath", "ai": "sparkles", "licence": "key.horizontal",
    ]

    var body: some View {
        let sections = SettingsSearch().sections(for: query.text)
        List {
            if query.text.trimmingCharacters(in: .whitespaces).isEmpty {
                groups
            } else {
                ForEach(sections, id: \.pane) { section in
                    Section {
                        ForEach(section.results, id: \.self) { result in
                            NavigationRow(symbol: Self.symbols[result.pane], title: catalog(result.label)) {
                                SettingsPage(pane: result.pane).map(actions.open)
                            }
                        }
                    } header: {
                        Header(catalog(SettingsSearch.paneLabel(section.pane)))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .settingsPage(store, glow: true)
        .overlay {
            if !query.text.trimmingCharacters(in: .whitespaces).isEmpty, sections.isEmpty {
                ContentUnavailableView(L10n.phoneSettingsNoResults(), systemImage: "magnifyingglass")
            }
        }
    }

    @ViewBuilder
    private var groups: some View {
        let licence = store.licence
        let row = licence?.row(store.now)
        Section {
            appCard(licence, row)
        }
        Section {
            ForEach(["general", "appearance", "editing", "preview"], id: \.self) { pane($0) }
        } header: {
            Header(L10n.phoneSettingsGroupGeneral())
        }
        Section {
            pane(
                "sync", value: store.syncOn ? L10n.phoneSettingsOn() : L10n.phoneSettingsOff(), badge: store.syncNeedsOwner)
        } header: {
            Header(L10n.phoneSettingsGroupSync())
        }
        Section {
            pane("ai")
        } header: {
            Header(L10n.phoneSettingsGroupAi())
        }
        Section {
            pane("licence", value: row?.label, badge: row?.attention ?? false)
            ForEach(StoreRow.shown(licence), id: \.self) { storeRow($0) }
        } footer: {
            if let version = store.version {
                BuildFooter(text: L10n.phoneSettingsBuild(version: version))
            }
        }
    }

    @ViewBuilder private func storeRow(_ row: StoreRow) -> some View {
        switch row {
        case .restore:
            ActionRow(title: L10n.phoneSettingsRestore(), value: restoring?.text, busy: restoring == .running, action: restore)
        case .macKey:
            NavigationRow(title: L10n.phoneSettingsMacKey(), action: actions.showMacKey)
        case .refund:
            ActionRow(title: L10n.phoneSettingsRefund(), value: refunding?.text, busy: refunding == .running, action: refund)
        }
    }

    private func pane(_ id: String, value: String? = nil, badge: Bool = false) -> some View {
        NavigationRow(symbol: Self.symbols[id], title: catalog(SettingsSearch.paneLabel(id)), value: value, badge: badge) {
            SettingsPage(pane: id).map(actions.open)
        }
    }

    private func appCard(_ licence: Licence?, _ row: (label: String, attention: Bool)?) -> some View {
        let summary = [store.version, row?.label].compactMap { $0 }.joined(separator: " \u{00B7} ")
        return Button {
            if let licence, licence.trialRunning(store.now), let endsAt = licence.trial?.endsAt {
                actions.showTrial(Date(timeIntervalSince1970: endsAt / 1000))
            } else {
                actions.open(.licence(.plain))
            }
        } label: {
            HStack(spacing: Tokens.Size.phoneGroupedGap) {
                Image(systemName: "bird.fill")
                    .foregroundStyle(Color(Tokens.Color.accentOnFill))
                    .frame(width: Tokens.Size.phoneTarget, height: Tokens.Size.phoneTarget)
                    .background(RoundedRectangle(cornerRadius: Tokens.Radius.phoneGroupedCard / 2).fill(Color(Tokens.Color.accentFill)))
                    .accessibilityHidden(true)
                RowText(title: L10n.phoneSettingsAppName(), detail: summary.isEmpty ? nil : summary)
                Spacer(minLength: 0)
                if row?.attention == true {
                    Text(verbatim: "!").font(.caption.bold()).foregroundStyle(Color(Tokens.Color.phoneOnAction))
                        .frame(minWidth: Tokens.Size.phoneBadge, minHeight: Tokens.Size.phoneBadge)
                        .background(Circle().fill(Color(Tokens.Color.phoneBadge)))
                        .accessibilityLabel(L10n.phoneBadgeAttention())
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(Tokens.Color.phoneChevron))
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-app")
        .settingsRow(described: true)
    }

    private func restore() {
        guard restoring != .running else { return }
        restoring = .running
        store.run(.storeRestore) { result in
            switch result {
            case .success(let snapshot):
                store.adoptLicence(snapshot)
                restoring = store.licence?.allows(Date()) == true ? .restored : .nothing
            case .failure(let failure):
                store.log("W_PHONE_RESTORE_FAILED code=\(failure.code)")
                restoring = .failed(failure.code)
            }
        }
    }

    private func refund() {
        guard refunding != .running else { return }
        refunding = .running
        store.run(.storeRefund) { result in
            switch result {
            case .success(let outcome): refunding = outcome.string == "requested" ? .requested : nil
            case .failure(let failure):
                store.log("W_PHONE_REFUND_FAILED code=\(failure.code)")
                refunding = .failed(failure.code)
            }
        }
    }
}

/// The build under the last card, centred, its gap above scaled with its text.
private struct BuildFooter: View {
    let text: String
    @ScaledMetric(relativeTo: .body) private var gap = SheetMetrics.gap

    var body: some View {
        Text(text).settingsDetail().monospacedDigit().frame(maxWidth: .infinity).padding(.top, gap)
    }
}

/// The rows under License in an App Store build: Restore Purchases, then the Mac key and the
/// refund once Devot Pro is bought. A build sold elsewhere has none.
enum StoreRow: Hashable {
    case restore, macKey, refund

    static func shown(_ licence: Licence?) -> [StoreRow] {
        guard let licence, licence.soldOnAppStore else { return [] }
        return licence.appStore?.pro == true ? [.restore, .macKey, .refund] : [.restore]
    }
}

/// Restore Purchases' value: what the last restore did.
enum Restoring: Equatable {
    case running, restored, nothing
    case failed(String)

    var text: String {
        switch self {
        case .running: L10n.phoneSettingsRestoring()
        case .restored: L10n.phoneSettingsRestored()
        case .nothing: L10n.phoneSettingsNothingRestored()
        case .failed(let code): LicenceText.problem(code)
        }
    }
}

/// Request a Refund's value; a cancel leaves the row as it was.
enum Refunding: Equatable {
    case running, requested
    case failed(String)

    var text: String {
        switch self {
        case .running: L10n.phoneSettingsRefundOpening()
        case .requested: L10n.phoneSettingsRefundRequested()
        case .failed("E_APP_STORE_REFUND_DUPLICATE"): L10n.phoneSettingsRefundDuplicate()
        case .failed("E_APP_STORE_NETWORK"): L10n.phoneSettingsRefundOffline()
        case .failed: L10n.phoneSettingsRefundFailed()
        }
    }
}

/// The Settings tab's root under a large title, with the system search field and Pair a device.
final class SettingsRootScreen: UIHostingController<SettingsRootView>, UISearchResultsUpdating {
    private let query: SettingsQuery
    var onAppear: () -> Void = {}
    var onPair: () -> Void = {}
    private var footKeeper: FootKeeper?

    init(store: SettingsStore, query: SettingsQuery, actions: SettingsActions) {
        self.query = query
        super.init(rootView: SettingsRootView(store: store, query: query, actions: actions))
        navigationItem.title = L10n.settingsTitle()
        navigationItem.largeTitleDisplayMode = .always
        navigationItem.backButtonDisplayMode = .minimal
        let search = UISearchController(searchResultsController: nil)
        search.obscuresBackgroundDuringPresentation = false
        search.searchBar.placeholder = L10n.settingsSearch()
        search.searchBar.autocapitalizationType = .none
        search.searchResultsUpdater = self
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = true
        let pair = UIBarButtonItem(
            image: UIImage(systemName: "qrcode.viewfinder"), primaryAction: UIAction { [weak self] _ in self?.onPair() })
        pair.accessibilityLabel = L10n.phoneSettingsPair()
        navigationItem.rightBarButtonItem = pair
    }

    @MainActor required dynamic init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        followTheme { [weak self] in self?.view.backgroundColor = Tokens.Color.phoneBackground }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if footKeeper == nil, let list = view.firstSubview(of: UICollectionView.self) {
            footKeeper = FootKeeper(list)
        }
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        onAppear()
    }

    func updateSearchResults(for searchController: UISearchController) {
        query.text = searchController.searchBar.text ?? ""
    }
}

/// Keeps a list at its foot while its content grows, once the reader has scrolled there: a list keeps its
/// offset otherwise, so a larger text size would push the build footer off the screen, and SwiftUI's list
/// can pass through a short content size on the way.
@MainActor
final class FootKeeper {
    private let list: UIScrollView
    private let movedByTheReader: @MainActor (UIScrollView) -> Bool
    private var observations: [NSKeyValueObservation] = []
    private var adjusting = false
    private(set) var atTheFoot = false

    init(_ list: UIScrollView, movedByTheReader: @escaping @MainActor (UIScrollView) -> Bool = {
        $0.isTracking || $0.isDragging || $0.isDecelerating
    }) {
        self.list = list
        self.movedByTheReader = movedByTheReader
        observations = [
            list.observe(\.contentOffset) { [weak self] _, _ in MainActor.assumeIsolated { self?.moved() } },
            list.observe(\.contentSize) { [weak self] _, _ in MainActor.assumeIsolated { self?.resized() } },
        ]
    }

    private var foot: CGFloat {
        max(-list.adjustedContentInset.top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
    }

    private func moved() {
        guard !adjusting, movedByTheReader(list) else { return }
        atTheFoot = list.contentOffset.y >= foot - 1
    }

    private func resized() {
        guard atTheFoot, abs(list.contentOffset.y - foot) > 0.5 else { return }
        adjusting = true
        list.contentOffset.y = foot
        adjusting = false
    }
}

extension UIView {
    fileprivate func firstSubview<View: UIView>(of type: View.Type) -> View? {
        for subview in subviews {
            if let match = subview as? View ?? subview.firstSubview(of: type) { return match }
        }
        return nil
    }
}
