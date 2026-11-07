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
            if licence?.soldOnAppStore == true {
                ActionRow(title: L10n.phoneSettingsRestore(), value: restoring?.text, busy: restoring == .running, action: restore)
                if licence?.appStore?.pro == true {
                    NavigationRow(title: L10n.phoneSettingsMacKey(), action: actions.showMacKey)
                    ActionRow(title: L10n.phoneSettingsRefund(), value: refunding?.text, busy: refunding == .running, action: refund)
                }
            }
        } footer: {
            if let version = store.version {
                Text(L10n.phoneSettingsBuild(version: version)).settingsDetail().monospacedDigit()
                    .foregroundStyle(Color(Tokens.Color.phoneTextFaint))
                    .frame(maxWidth: .infinity)
                    .padding(.top, SheetMetrics.gap)
            }
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
                    .foregroundStyle(Color(Tokens.Color.phoneOnAction))
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

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        onAppear()
    }

    func updateSearchResults(for searchController: UISearchController) {
        query.text = searchController.searchBar.text ?? ""
    }
}
