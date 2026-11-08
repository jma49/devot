import Foundation

/// The licence as Rust reports it (`direct.licence.get`), read as `licence.ts` `readLicence` reads it.
struct Licence: Equatable {
    struct Trial: Equatable {
        var state: String
        /// Milliseconds since the epoch.
        var endsAt: Double?
        var code: String?
    }

    struct Activation: Equatable {
        var state: String
        var used: Int
        var limit: Int
    }

    struct AppStore: Equatable {
        var pro: Bool
        var code: String?
        var takesKeys: Bool
    }

    var gated: Bool
    var state: String
    var code: String?
    var id: String?
    var licensee: String?
    var trial: Trial?
    var activation: Activation?
    var appStore: AppStore?

    static let states: Set<String> = ["none", "valid", "revoked", "invalid"]
    static let unread = "E_APP_STORE_UNREAD"
    static let trialDays = 30
    static let buyURL = URL(string: "https://licence.devot.online/buy")!
    static let devicesURL = URL(string: "https://licence.devot.online/devices?from=app")!

    init(
        gated: Bool, state: String, code: String? = nil, id: String? = nil, licensee: String? = nil,
        trial: Trial? = nil, activation: Activation? = nil, appStore: AppStore? = nil
    ) {
        self.gated = gated
        self.state = state
        self.code = code
        self.id = id
        self.licensee = licensee
        self.trial = trial
        self.activation = activation
        self.appStore = appStore
    }

    init?(_ value: JSONValue) {
        guard let gated = value["gated"]?.bool, let state = value["state"]?.string, Licence.states.contains(state)
        else { return nil }
        let trial = value["trial"].flatMap { trial -> Trial? in
            guard let state = trial["state"]?.string, ["running", "ended", "available"].contains(state) else {
                return nil
            }
            return Trial(state: state, endsAt: trial["endsAt"]?.number, code: trial["code"]?.string)
        }
        let activation = value["activation"].flatMap { seat -> Activation? in
            guard let state = seat["state"]?.string, ["active", "required", "expired"].contains(state) else {
                return nil
            }
            return Activation(
                state: state, used: Int(seat["used"]?.number ?? 0), limit: Int(seat["limit"]?.number ?? 0))
        }
        let appStore = value["appStore"]?.object.map { store in
            AppStore(
                pro: store["pro"]?.bool == true, code: store["code"]?.string, takesKeys: store["takesKeys"]?.bool == true)
        }
        let licensee = value["licensee"]?.string
        self.init(
            gated: gated, state: state, code: value["code"]?.string, id: value["id"]?.string,
            licensee: licensee?.isEmpty == false ? licensee : nil,
            // A build that gates is never without a trial: one Rust did not describe counts as ended.
            trial: gated ? (trial ?? Trial(state: "ended", endsAt: nil, code: nil)) : nil,
            activation: activation, appStore: appStore)
    }

    var soldOnAppStore: Bool { appStore != nil }
    var takesKeys: Bool { appStore?.takesKeys ?? true }
    var held: Bool { state != "none" }
    var unlocked: Bool { state == "valid" || appStore?.pro == true }

    func trialRunning(_ now: Date) -> Bool {
        guard let trial, trial.state == "running" else { return false }
        return trial.endsAt.map { now.milliseconds < $0 } ?? true
    }

    /// Whether the end of the trial is why editing, sync and AI are locked.
    func trialOver(_ now: Date) -> Bool {
        gated && state != "valid" && appStore?.pro != true && !trialRunning(now)
    }

    /// `licenceEntitlements.has('editing')`: what unlocks sync and AI too.
    func allows(_ now: Date) -> Bool {
        if !gated || appStore?.pro == true { return true }
        if let seat = activation?.state, seat != "active" { return trialRunning(now) }
        if state == "valid" { return true }
        return trialRunning(now)
    }

    /// The License row's value and whether it and the Settings tab show "!" (`settingsRows.ts`).
    func row(_ now: Date) -> (label: String, attention: Bool) {
        let seat = activation?.state
        if appStore?.pro == true || (state == "valid" && (seat == nil || seat == "active")) {
            return (L10n.phoneSettingsLicencePro(), false)
        }
        if appStore?.code == Licence.unread { return (L10n.phoneSettingsLicenceChecking(), false) }
        if !gated { return (L10n.phoneSettingsLicenceFree(), false) }
        if trialRunning(now) {
            guard let endsAt = trial?.endsAt else { return (L10n.phoneSettingsLicenceTrial(), false) }
            let days = max(1, Int(((endsAt - now.milliseconds) / Licence.dayMs).rounded(.up)))
            return (L10n.phoneSettingsLicenceTrialDays(days: String(days)), days <= 3)
        }
        if trial?.state == "available" { return (L10n.phoneSettingsLicenceAvailable(), true) }
        return (L10n.phoneSettingsLicenceAttention(), true)
    }

    /// When `row` next reads differently: the trial dropping a day, or ending (`licenceRowChangesAt`).
    func rowChangesAt(_ now: Date) -> Date? {
        guard let endsAt = trial?.endsAt, trialRunning(now) else { return nil }
        let days = ((endsAt - now.milliseconds) / Licence.dayMs).rounded(.up)
        return Date(timeIntervalSince1970: (endsAt - (days - 1) * Licence.dayMs) / 1000)
    }

    static let dayMs = 86_400_000.0
}

extension Date {
    var milliseconds: Double { timeIntervalSince1970 * 1000 }
}

/// What Settings says about the licence, as `licenceView.ts` words it; a code never shows.
enum LicenceText {
    private static let reasons: [String: String] = [
        "E_LICENCE_MALFORMED": "licence.reason.malformed",
        "E_LICENCE_UNKNOWN_KID": "licence.reason.unknownKid",
        "E_LICENCE_SIGNATURE": "licence.reason.signature",
        "E_LICENCE_KEYCHAIN": "licence.reason.keychain",
        "E_LICENCE_KEYCHAIN_UNAVAILABLE": "licence.reason.keychain",
        "E_LICENCE_KEYCHAIN_DENIED": "licence.reason.keychainDenied",
        "E_LICENCE_DEVICE_LIMIT": "licence.reason.deviceLimit",
        "E_LICENCE_ACTIVATION_REQUIRED": "licence.reason.activationRequired",
        "E_LICENCE_ACTIVATION_EXPIRED": "licence.reason.activationExpired",
        "E_LICENCE_ACTIVATION_FAILED": "licence.reason.activationFailed",
        "E_LICENCE_ACTIVATION_REFUSED": "licence.reason.activationFailed",
        "E_LICENCE_RATE_LIMITED": "licence.reason.rateLimited",
        "E_LICENCE_ACTIVATION_UNREADABLE": "licence.reason.activationUnreadable",
        "E_LICENCE_KEYS_OFF": "licence.reason.keysOff",
        "E_APP_STORE_NO_REPLY": "licence.reason.storeNoReply",
        "E_APP_STORE_UNAVAILABLE": "licence.reason.storeUnavailable",
        "E_APP_STORE_UNVERIFIED": "licence.reason.storeUnverified",
        "E_APP_STORE_NO_PRO": "licence.reason.noPro",
        "E_APP_STORE_PRODUCT": "licence.reason.storeProduct",
        "E_APP_STORE_FAMILY_SHARED": "licence.reason.familyShared",
        "E_APP_STORE_NOT_FOUND": "licence.reason.storeUnverified",
        "E_APP_STORE_MISMATCH": "licence.reason.storeUnverified",
        "E_APP_STORE_SIGNATURE": "licence.reason.storeUnverified",
        "E_APP_STORE_EXCHANGE_REFUSED": "licence.reason.storeUnverified",
        "E_APP_STORE_UNREACHABLE": "licence.reason.storeNoReply",
        "E_APP_STORE_UPSTREAM": "licence.reason.storeUpstream",
        "E_APP_STORE_EXCHANGE_FAILED": "licence.reason.exchangeFailed",
        "E_LICENCE_CONFIG": "licence.reason.exchangeFailed",
        "E_LICENCE_REVOKED": "licence.reason.revoked",
    ]

    /// `failure.ts`: the plain reasons any failure can carry.
    private static let failures: [String: String] = [
        "E_NET_FAILED": "failure.offline",
        "E_SYNC_OFFLINE": "failure.offline",
        "E_SYNC_RELAY_FAILED": "failure.offline",
        "E_AI_NETWORK_FAILED": "failure.offline",
        "E_APP_STORE_NETWORK": "failure.offline",
        "E_NET_HOST_REFUSED": "failure.addressRefused",
        "E_NET_HTTPS_ONLY": "failure.addressRefused",
        "E_URL_CREDENTIALS_REFUSED": "failure.addressRefused",
        "E_URL_SCHEME_REFUSED": "failure.addressRefused",
        "E_NET_TOO_MANY_REDIRECTS": "failure.serverRefused",
        "E_AI_HTTP": "failure.serverRefused",
        "E_AI_REQUEST_REJECTED": "failure.serverRefused",
        "E_SYNC_TOKEN_REFUSED": "failure.serverRefused",
        "E_AI_PROVIDER_UNAVAILABLE": "failure.serverUnavailable",
        "E_APP_STORE_PRODUCT_UNAVAILABLE": "failure.serverUnavailable",
    ]

    static func text(_ key: String) -> String { catalog(key) }

    static func reason(_ code: String) -> String? {
        if let key = failures[code] { return text(key) }
        if code.hasSuffix("_TIMEOUT") || code.hasSuffix("_TIMED_OUT") { return L10n.failureTimeout() }
        return nil
    }

    /// `failureText`: the action's sentence, then the code's plain reason when there is one.
    static func failure(_ sentence: String, _ code: String) -> String {
        guard let reason = reason(code) else { return sentence }
        let ended = sentence.last.map { ".!?".contains($0) } ?? false
        return "\(ended ? sentence : sentence + ".") \(reason)"
    }

    static func problem(_ code: String) -> String {
        if let key = reasons[code] { return text(key) }
        return reason(code) ?? L10n.licenceReasonOther()
    }

    static func licensee(_ name: String) -> String {
        name == "App Store purchase" ? L10n.licenceAppStoreLicensee() : name
    }

    static func state(_ licence: Licence) -> String {
        if licence.appStore?.pro == true { return L10n.licenceSettingsStatePurchased() }
        if licence.appStore?.code == Licence.unread { return L10n.licenceSettingsStateStoreReading() }
        if let code = licence.appStore?.code { return L10n.licenceSettingsStateStoreUnread(problem: problem(code)) }
        if licence.state == "none", !licence.gated { return L10n.licenceSettingsUngated() }
        if licence.state == "none", let code = licence.code {
            return L10n.licenceSettingsStateUnreadable(problem: problem(code))
        }
        return text("licenceSettings.state.\(licence.state)")
    }

    static func trial(_ licence: Licence, _ now: Date) -> String? {
        guard licence.gated, licence.state != "valid", let trial = licence.trial else { return nil }
        if licence.appStore?.pro == true || licence.appStore?.code != nil { return nil }
        if trial.state == "available" { return L10n.licenceSettingsTrialAvailable() }
        if trial.code != nil { return L10n.licenceSettingsTrialUnreadable() }
        if licence.trialRunning(now), let endsAt = trial.endsAt {
            let end = Date(timeIntervalSince1970: endsAt / 1000)
            return L10n.licenceSettingsTrialRunning(
                date: end.formatted(date: .abbreviated, time: .shortened), left: timeLeft(endsAt - now.milliseconds))
        }
        return L10n.licenceSettingsTrialEnded()
    }

    /// What is left in its largest unit, rounded down, never under a minute.
    static func timeLeft(_ ms: Double) -> String {
        let hour = 3_600_000.0
        var parts = DateComponents()
        if ms >= Licence.dayMs {
            parts.day = Int(ms / Licence.dayMs)
        } else if ms >= hour {
            parts.hour = Int(ms / hour)
        } else {
            parts.minute = max(1, Int(ms / 60_000))
        }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = [.day, .hour, .minute]
        return formatter.string(from: parts) ?? ""
    }

    static func seat(_ licence: Licence) -> String? {
        guard let seat = licence.activation else { return nil }
        let problem: String? =
            switch seat.state {
            case "active": nil
            case "expired": L10n.licenceSettingsDevicesExpired()
            default: L10n.licenceSettingsDevicesRequired()
            }
        if seat.limit == 0 { return problem }
        let seats = L10n.licenceSettingsDevicesSeats(used: String(seat.used), limit: String(seat.limit))
        return problem.map { "\(seats) \($0)" } ?? seats
    }

    /// Why sync is locked (`lockedSentence`); an App Store build names Devot Pro.
    static func syncLocked(_ licence: Licence, _ now: Date) -> String {
        let ended = licence.trialOver(now)
        if licence.soldOnAppStore {
            return catalog(ended ? "licence.locked.syncProTrialEnded" : "licence.locked.syncPro")
        }
        return catalog(ended ? "licence.locked.syncTrialEnded" : "licence.locked.sync")
    }

    /// Why AI is locked; an App Store build, which may take no key, names Devot Pro.
    static func aiLocked(_ licence: Licence, _ now: Date) -> String {
        let ended = licence.trialOver(now)
        if licence.soldOnAppStore {
            return ended ? L10n.licenceLockedAiProTrialEnded() : L10n.licenceLockedAiPro()
        }
        return ended ? L10n.licenceLockedAiTrialEnded() : L10n.licenceLockedAi()
    }
}
