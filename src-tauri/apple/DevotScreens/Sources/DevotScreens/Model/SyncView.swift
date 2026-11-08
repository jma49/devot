import Foundation

/// The sync snapshot `direct.sync.get` and every sync change answer (`sync.ts`, `readSnapshot`).
struct SyncSnapshot: Equatable {
    struct Upload: Equatable {
        var sent: Int
        var total: Int
    }

    struct UnsyncedFiles: Equatable {
        var count: Int
        var code: String
    }

    struct Status: Equatable {
        var state = "off"
        var lastSync: Double?
        var code: String?
        var tooLarge = 0
        var pausedUntil: Double?
        var upload: Upload?
        var relayOutdated = false
        var unsyncedFiles: UnsyncedFiles?
        var skipped = 0
    }

    struct ICloudJoin: Equatable {
        var state: String
        var notes: Int?
        var reason: String?
        var code: String?
    }

    static let states = ["off", "connecting", "syncing", "idle", "offline", "paused", "stopped"]
    private static let joinStates = ["unavailable", "none", "joined", "ask", "declined", "fallback"]
    private static let fallbackReasons = ["missing", "otherVault", "unreadable"]
    private static let unsyncedCodes = ["E_SYNC_ATTACHMENTS_FULL", "E_SYNC_RELAY_OUTDATED"]
    private static let maxWall = 8_640_000_000_000_000.0

    var relayUrl = ""
    var enabled = false
    var vault = false
    var enrolled = false
    var transport = "relay"
    var status = Status()
    var icloudJoin: ICloudJoin?
    var moveStarted = false
    var rotated = false

    static let off = SyncSnapshot()

    init() {}

    init?(_ value: JSONValue) {
        guard case .object = value else { return nil }
        let s = value["status"] ?? .object([:])
        relayUrl = value["relayUrl"]?.string ?? ""
        enabled = value["enabled"]?.bool == true
        vault = value["vault"]?.bool == true
        enrolled = value["enrolled"]?.bool == true
        transport = value["transport"]?.string == "icloud" ? "icloud" : "relay"
        let state = s["state"]?.string.flatMap { Self.states.contains($0) ? $0 : nil } ?? "off"
        status.state = state
        status.lastSync = Self.time(s["lastSync"])
        status.code = Self.code(s["code"])
        status.tooLarge = Self.count(s["tooLarge"]) ?? 0
        status.pausedUntil = state == "paused" ? Self.time(s["pausedUntil"]) : nil
        if let sent = Self.count(s["upload"]?["sent"]), let total = Self.count(s["upload"]?["total"]), total > 0,
            sent <= total
        {
            status.upload = Upload(sent: sent, total: total)
        }
        status.relayOutdated = s["relayOutdated"]?.bool == true
        if let count = Self.count(s["unsyncedFiles"]?["count"]), count > 0,
            let code = s["unsyncedFiles"]?["code"]?.string, Self.unsyncedCodes.contains(code)
        {
            status.unsyncedFiles = UnsyncedFiles(count: count, code: code)
        }
        status.skipped = Self.count(s["skipped"]) ?? 0
        if let join = value["icloudJoin"], let state = join["state"]?.string, Self.joinStates.contains(state) {
            icloudJoin = ICloudJoin(
                state: state, notes: Self.count(join["notes"]),
                reason: join["reason"]?.string.flatMap { Self.fallbackReasons.contains($0) ? $0 : nil },
                code: Self.code(join["code"]))
        }
        moveStarted = value["moveStarted"]?.bool == true
        rotated = value["rotated"]?.bool == true
    }

    var onICloud: Bool { vault && transport == "icloud" }
    var inVault: Bool { enrolled || onICloud }
    var rotatedAway: Bool { rotated || status.code == "E_SYNC_VAULT_ROTATED" }
    var shownState: String { enabled ? status.state : "off" }

    static func count(_ value: JSONValue?) -> Int? {
        guard let number = value?.number, number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number
        else { return nil }
        return Int(number)
    }

    private static func time(_ value: JSONValue?) -> Double? {
        count(value).map(Double.init).flatMap { $0 <= maxWall ? $0 : nil }
    }

    private static func code(_ value: JSONValue?) -> String? {
        guard let code = value?.string, code.range(of: #"^[EWI]_[A-Z0-9_]+$"#, options: .regularExpression) != nil
        else { return nil }
        return code
    }
}

/// `sync_icloud_status`: whether this build has the container, and the account's state.
struct ICloudStatus: Equatable {
    static let accounts = ["available", "noAccount", "restricted", "temporarilyUnavailable"]
    static let none = ICloudStatus(available: false, account: nil)

    var available: Bool
    var account: String?

    init(available: Bool, account: String?) {
        self.available = available
        self.account = account
    }

    init(_ value: JSONValue) {
        guard value["available"]?.bool == true else {
            self = .none
            return
        }
        available = true
        account = value["account"]?.string.flatMap { Self.accounts.contains($0) ? $0 : nil }
    }
}

/// What iCloud asks of the owner, if anything (`syncICloud.ts`, `icloudAttention`).
enum ICloudAttention: Equatable {
    case signedOut, restricted, unavailable, full, accountChanged, deleted, noContainer, moved, movedHere, joined
    case busy(until: Double?)
    case ask(notes: Int)
    case fallback(reason: String)

    enum Action: String, CaseIterable {
        case moveHere, uploadAgain, turnOff, follow, finish, join, decline
    }

    private static let byCode: [String: ICloudAttention] = [
        "E_SYNC_ICLOUD_SIGNED_OUT": .signedOut,
        "E_SYNC_ICLOUD_RESTRICTED": .restricted,
        "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE": .unavailable,
        "E_SYNC_ICLOUD_FULL": .full,
        "E_SYNC_ICLOUD_BUSY": .busy(until: nil),
        "E_SYNC_ICLOUD_ACCOUNT_CHANGED": .accountChanged,
        "E_SYNC_ICLOUD_DELETED": .deleted,
        "E_SYNC_CLOUDKIT_UNAVAILABLE": .noContainer,
        "E_SYNC_VAULT_MOVED": .moved,
    ]

    var kind: String {
        switch self {
        case .signedOut: "signedOut"
        case .restricted: "restricted"
        case .unavailable: "unavailable"
        case .full: "full"
        case .accountChanged: "accountChanged"
        case .deleted: "deleted"
        case .noContainer: "noContainer"
        case .moved: "moved"
        case .movedHere: "movedHere"
        case .joined: "joined"
        case .busy: "busy"
        case .ask: "ask"
        case .fallback: "fallback"
        }
    }

    private static let needsOwner: Set<String> = [
        "signedOut", "restricted", "full", "accountChanged", "deleted", "noContainer", "moved", "movedHere", "ask",
        "fallback",
    ]

    var needsOwner: Bool { Self.needsOwner.contains(kind) }
    /// Shown in the setup rows or a note rather than the status row.
    var outsideStatus: Bool { ["ask", "fallback", "joined"].contains(kind) }

    /// The iCloud state the status row words itself, so no code goes beside it.
    static func held(_ snapshot: SyncSnapshot) -> ICloudAttention? {
        let status = snapshot.status
        guard snapshot.enabled, let code = status.code, ["paused", "stopped", "offline"].contains(status.state)
        else { return nil }
        return byCode[code]
    }

    static func of(_ snapshot: SyncSnapshot) -> ICloudAttention? {
        if let held = held(snapshot) {
            if held == .moved, snapshot.moveStarted { return .movedHere }
            if case .busy = held { return .busy(until: snapshot.status.pausedUntil) }
            return held
        }
        guard let join = snapshot.icloudJoin else { return nil }
        if join.state == "joined", snapshot.transport == "icloud" {
            let status = snapshot.status
            let runsWell = status.code == nil && ["idle", "syncing", "connecting"].contains(status.state)
            return runsWell ? .joined : nil
        }
        if snapshot.vault { return nil }
        if join.state == "ask" { return .ask(notes: join.notes ?? 0) }
        if join.state == "fallback" { return .fallback(reason: join.reason ?? "missing") }
        guard join.state == "unavailable", let code = join.code, let blocked = byCode[code],
            [.signedOut, .restricted, .unavailable].contains(blocked)
        else { return nil }
        return blocked
    }
}

/// `sync_usage`: the relay's figures and caps (`syncUsage.ts`, `core/sync/usage.ts`).
struct StorageView: Equatable {
    enum Cap: Equatable {
        case unknown
        case none
        case set(limit: Int, imageLimit: Int?)
    }

    enum Fill: Int {
        case ok, warn, full
    }

    var storedBytes: Int
    var fileBytes: Int
    var cap: Cap

    init?(_ value: JSONValue) {
        guard let stored = SyncSnapshot.count(value["storedBytes"]), let files = SyncSnapshot.count(value["fileBytes"])
        else { return nil }
        storedBytes = stored
        fileBytes = files
        switch value["caps"] {
        case nil: cap = .unknown
        case .null?: cap = .none
        case .object(let caps)?:
            guard let limit = SyncSnapshot.count(caps["storedBytes"]), limit > 0 else { return nil }
            if caps["fileBytes"] == nil {
                cap = .set(limit: limit, imageLimit: nil)
            } else {
                guard let images = SyncSnapshot.count(caps["fileBytes"]) else { return nil }
                cap = .set(limit: limit, imageLimit: images)
            }
        default: return nil
        }
    }

    var recordBytes: Int { max(0, storedBytes - fileBytes) }

    var room: Int? {
        guard case .set(let limit, _) = cap else { return nil }
        return max(0, limit - storedBytes)
    }

    var imageRoom: Int? {
        guard case .set(_, let images?) = cap, let room else { return nil }
        return min(room, max(0, images - fileBytes))
    }

    private static func fill(_ used: Int, _ limit: Int) -> Fill {
        used >= limit ? .full : Double(used) >= Double(limit) * 0.8 ? .warn : .ok
    }

    /// `noticeFor` against nothing seen: the worst band the figures reach.
    var notice: String? {
        guard case .set(let limit, let imageLimit) = cap else { return nil }
        let storage = Self.fill(storedBytes, limit)
        let images = imageLimit.map { Self.fill(fileBytes, $0) } ?? .ok
        if storage == .full { return "storageFull" }
        if images == .full { return "imagesFull" }
        if storage == .warn { return "storageWarn" }
        if images == .warn { return "imagesWarn" }
        return nil
    }
}

/// A pairing on show (`sync.ts`, `readPairing`).
struct ShownPairing: Equatable {
    var code: String
    var link: String
    var size: Int
    var modules: [Bool]
    var expires: Double

    init?(_ value: JSONValue) {
        guard let code = value["code"]?.string,
            code.range(of: #"^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$"#, options: .regularExpression) != nil,
            let link = value["link"]?.string, link.hasPrefix("devot://pair?"),
            let expires = SyncSnapshot.count(value["expires"]),
            let size = SyncSnapshot.count(value["qr"]?["size"]), size > 0, size <= 177,
            let modules = value["qr"]?["modules"]?.string, modules.count == size * size,
            modules.allSatisfy({ $0 == "0" || $0 == "1" })
        else { return nil }
        self.code = code
        self.link = link
        self.size = size
        self.modules = modules.map { $0 == "1" }
        self.expires = Double(expires)
    }
}

/// A device of the vault (`sync.ts`, `readDevices`).
struct SyncDevice: Equatable, Identifiable {
    var id: String
    var label: String
    var created: Double
    var current: Bool
    var unseen: Bool

    static func list(_ value: JSONValue) -> [SyncDevice] {
        (value.array ?? []).compactMap { item in
            guard let id = item["id"]?.string,
                id.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil,
                let label = item["label"]?.string, let created = SyncSnapshot.count(item["created"])
            else { return nil }
            return SyncDevice(
                id: id, label: String(label.prefix(256)), created: Double(created), current: item["current"]?.bool == true,
                unseen: item["unseen"]?.bool == true)
        }
    }
}

enum SyncLinks {
    /// The relay a pasted pairing link names, or nil for a bare code.
    static func relay(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("devot://pair?"),
            let query = trimmed.split(separator: "?", maxSplits: 1).last,
            let relay = URLComponents(string: "devot://pair?" + query)?.queryItems?.first(where: { $0.name == "relay" })?
                .value, !relay.isEmpty,
            let scheme = URL(string: relay)?.scheme?.lowercased(), scheme == "https" || scheme == "http"
        else { return nil }
        return relay
    }

    /// Whether Rust takes this as a relay: https, or http to this machine only.
    static func allowed(_ relay: String) -> Bool {
        guard let url = URLComponents(string: relay), let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "https" { return url.host?.isEmpty == false }
        let host = url.host?.lowercased() ?? ""
        return scheme == "http"
            && (host == "localhost" || host == "[::1]" || host == "::1"
                || host.range(of: #"^127(\.\d{1,3}){3}$"#, options: .regularExpression) != nil)
    }

    static func host(_ relay: String) -> String {
        guard let url = URLComponents(string: relay), let host = url.host else { return relay }
        return url.port.map { "\(host):\($0)" } ?? host
    }
}
