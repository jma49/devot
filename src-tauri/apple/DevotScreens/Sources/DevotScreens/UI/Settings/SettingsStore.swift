import Foundation
import Observation
import UIKit

/// What Settings asks of Rust and of the page; `Screens` answers, tests stand in for it.
@MainActor
protocol SettingsBridge: AnyObject {
    func direct(_ op: DirectOp, _ args: [String: JSONValue], done: @escaping (Outcome) -> Void)
    func request(_ op: Op, _ args: [String: JSONValue], done: @escaping (Outcome) -> Void)
    func log(_ level: LogLevel, _ line: String)
}

struct NotebookChoice: Hashable, Identifiable {
    let id: String
    let name: String
    let depth: Int
}

struct StoreProduct: Equatable {
    let product: String
    let displayPrice: String
}

struct CrashReports: Equatable {
    var available: Bool
    var on: Bool
}

/// AI's settings as Rust shows them: never a key, only whether one is stored.
struct AiView: Equatable {
    struct Provider: Equatable {
        var endpoint: String
        var model: String
        var defaultEndpoint: String
        var defaultModel: String
        var key: String
    }

    static let providers = ["anthropic", "openai"]

    var active: String
    var suggestOnIdle: Bool
    var anthropic: Provider
    var openai: Provider

    init?(_ value: JSONValue) {
        func provider(_ name: String) -> Provider? {
            guard let view = value[name], let endpoint = view["endpoint"]?.string, let model = view["model"]?.string
            else { return nil }
            return Provider(
                endpoint: endpoint, model: model, defaultEndpoint: view["defaultEndpoint"]?.string ?? "",
                defaultModel: view["defaultModel"]?.string ?? "", key: view["key"]?.string ?? "unknown")
        }
        guard let active = value["active"]?.string, AiView.providers.contains(active),
            let anthropic = provider("anthropic"), let openai = provider("openai")
        else { return nil }
        self.active = active
        suggestOnIdle = value["suggestOnIdle"]?.bool ?? false
        self.anthropic = anthropic
        self.openai = openai
    }

    subscript(provider: String) -> Provider {
        get { provider == "openai" ? openai : anthropic }
        set { if provider == "openai" { openai = newValue } else { anthropic = newValue } }
    }

    /// The whole settings `direct.ai.set` takes.
    var settings: JSONValue {
        let stored = { (p: Provider) in JSONValue.object(["endpoint": .string(p.endpoint), "model": .string(p.model)]) }
        return .object([
            "active": .string(active), "suggestOnIdle": .bool(suggestOnIdle), "anthropic": stored(anthropic),
            "openai": stored(openai),
        ])
    }
}

/// The snapshots Settings is built from, read from Rust when the Settings root shows, so a pushed
/// pane never waits for a first read. Every change applies here first, then goes to Rust; a
/// refused write puts the old value back and says so once.
@Observable
@MainActor
final class SettingsStore {
    @ObservationIgnored weak var bridge: (any SettingsBridge)?
    private(set) var editor: [String: JSONValue] = [:]
    @ObservationIgnored private var revision = -1.0
    private(set) var crashReports: CrashReports?
    private(set) var licence: Licence?
    var ai: AiView?
    private(set) var sync: SyncSnapshot?
    private(set) var icloud = ICloudStatus.none
    /// Counts `sync.pairing` notices: the Sync pane checks its pairing at once on each.
    private(set) var pairingNudges = 0
    @ObservationIgnored private var syncReading = false
    @ObservationIgnored private var syncAgain = false
    private(set) var notebooks: [NotebookChoice] = []
    private(set) var products: [StoreProduct] = []
    var failure: String?
    /// The time the licence rows are shown for: read again on coming back to the foreground and
    /// when the License row's value next changes, as the page's `licenceClock.ts` does.
    var now = Date() {
        didSet { armClock() }
    }
    @ObservationIgnored private var clock: Timer?
    @ObservationIgnored private var foreground: NSObjectProtocol?
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String

    init(center: NotificationCenter = .default) {
        foreground = center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.now = Date()
                self?.readLicence()
            }
        }
    }

    private func armClock() {
        clock?.invalidate()
        clock = nil
        guard let at = licence?.rowChangesAt(now) else { return }
        clock = Timer.scheduledTimer(withTimeInterval: max(0, at.timeIntervalSinceNow), repeats: false) {
            [weak self] _ in
            MainActor.assumeIsolated { self?.now = Date() }
        }
    }

    func load() {
        now = Date()
        read(.editorSettingsGet) { [weak self] in self?.adoptEditor($0) }
        read(.crashReportsGet) { [weak self] value in
            guard let available = value["available"]?.bool, let on = value["on"]?.bool else { return }
            self?.crashReports = CrashReports(available: available, on: on)
        }
        read(.licenceGet) { [weak self] value in
            guard let self else { return }
            adoptLicence(value)
            if licence?.soldOnAppStore == true, products.isEmpty { loadProducts() }
        }
        read(.aiGet) { [weak self] in self?.ai = AiView($0) }
        readSync()
        bridge?.request(.settingsNotebooks, [:]) { [weak self] outcome in
            guard case .ok(let value) = outcome, let list = value["notebooks"]?.array else { return }
            self?.notebooks = list.compactMap { item in
                guard let id = item["id"]?.string, let name = item["name"]?.string else { return nil }
                return NotebookChoice(id: id, name: name, depth: Int(item["depth"]?.number ?? 0))
            }
        }
    }

    /// Without StoreKit's price Buy still works: StoreKit's own sheet shows it.
    func loadProducts() {
        read(.storeProducts) { [weak self] value in
            self?.products = (value.array ?? []).compactMap { item in
                guard let product = item["product"]?.string, let price = item["displayPrice"]?.string else {
                    return nil
                }
                return StoreProduct(product: product, displayPrice: price)
            }
        }
    }

    var syncOn: Bool { sync?.enabled ?? false }
    var syncNeedsOwner: Bool { sync.flatMap(ICloudAttention.of)?.needsOwner ?? false }

    func heard(_ notice: NoticeKind) {
        switch notice {
        case .syncChanged: readSync()
        case .syncPairing: pairingNudges += 1
        default: break
        }
    }

    /// One read at a time: a change heard during it reads once more after it.
    func readSync() {
        guard let bridge else { return }
        guard !syncReading else {
            syncAgain = true
            return
        }
        syncReading = true
        bridge.direct(.syncGet, [:]) { [weak self] outcome in
            guard let self else { return }
            syncReading = false
            switch outcome {
            case .ok(let value): adoptSync(value)
            case .failed(let code): log("W_PHONE_SETTINGS_READ_FAILED op=\(DirectOp.syncGet.rawValue) code=\(code)")
            }
            if syncAgain {
                syncAgain = false
                readSync()
            }
        }
    }

    /// iCloud's state is read again whenever what it depends on changes (`useICloudStatus`).
    func adoptSync(_ value: JSONValue) {
        guard let next = SyncSnapshot(value) else { return }
        let before = sync.map(Self.icloudInputs)
        sync = next
        if before != Self.icloudInputs(next) { readICloud() }
    }

    private static func icloudInputs(_ sync: SyncSnapshot) -> [String] {
        ["\(sync.vault)", sync.transport, "\(sync.enabled)", sync.status.code ?? "", sync.icloudJoin?.state ?? ""]
    }

    private func readICloud() {
        bridge?.direct(.syncIcloudStatus, [:]) { [weak self] outcome in
            if case .ok(let value) = outcome { self?.icloud = ICloudStatus(value) } else { self?.icloud = .none }
        }
    }

    func flag(_ key: String) -> Bool { editor[key]?.bool ?? false }

    func setEditor(_ key: String, _ value: JSONValue) {
        let old = editor[key]
        editor[key] = value
        bridge?.direct(.editorSettingsSet, ["patch": .object([key: value])]) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .ok(let snapshot): adoptEditor(snapshot)
            case .failed(let code):
                if editor[key] == value { editor[key] = old }
                refused(key: key, code: code)
            }
        }
    }

    func setCrashReports(_ on: Bool) {
        guard let old = crashReports else { return }
        crashReports?.on = on
        bridge?.direct(.crashReportsSet, ["on": .bool(on)]) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .ok(let value):
                if let available = value["available"]?.bool, let on = value["on"]?.bool {
                    crashReports = CrashReports(available: available, on: on)
                }
            case .failed(let code):
                crashReports = old
                refused(key: "crashReports", code: code)
            }
        }
    }

    func setAi(_ next: AiView) {
        guard let old = ai, next != old else { return }
        ai = next
        bridge?.direct(.aiSet, ["settings": next.settings]) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .ok(let value): if let view = AiView(value) { ai = view }
            case .failed(let code):
                if ai == next { ai = old }
                refused(key: "ai", code: code)
            }
        }
    }

    /// A licence, key or purchase action: its result is handed back, its failure code too.
    func run(_ op: DirectOp, _ args: [String: JSONValue] = [:], done: @escaping (Result<JSONValue, Failure>) -> Void) {
        guard let bridge else {
            done(.failure(Failure(code: "E_SCREENS_UNAVAILABLE")))
            return
        }
        bridge.direct(op, args) { outcome in
            switch outcome {
            case .ok(let value): done(.success(value))
            case .failed(let code): done(.failure(Failure(code: code)))
            }
        }
    }

    struct Failure: Error, Equatable {
        let code: String
    }

    func adoptLicence(_ value: JSONValue) {
        if let next = Licence(value) { licence = next }
        now = Date()
    }

    func readLicence() {
        read(.licenceGet) { [weak self] in self?.adoptLicence($0) }
    }

    func log(_ line: String) {
        bridge?.log(.warn, line)
    }

    private func read(_ op: DirectOp, _ adopt: @escaping (JSONValue) -> Void) {
        bridge?.direct(op, [:]) { [weak self] outcome in
            switch outcome {
            case .ok(let value): adopt(value)
            case .failed(let code): self?.bridge?.log(.warn, "W_PHONE_SETTINGS_READ_FAILED op=\(op.rawValue) code=\(code)")
            }
        }
    }

    /// A snapshot newer than the one held: answers and changes can arrive in any order.
    private func adoptEditor(_ snapshot: JSONValue) {
        guard let revision = snapshot["revision"]?.number, let settings = snapshot["settings"]?.object,
            revision >= self.revision
        else { return }
        self.revision = revision
        editor = settings
    }

    private func refused(key: String, code: String) {
        failure = L10n.appearanceSettingsFailed()
        bridge?.log(.warn, "W_PHONE_SETTINGS_SAVE_FAILED key=\(key) code=\(code)")
    }
}
