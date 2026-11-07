import Foundation

/// The Sync pane's words, as the page writes them (`SyncSection.tsx`, `syncWhy.ts`, `format.ts`).
enum SyncText {
    private static let stopAdvice: [String: String] = [
        "E_SYNC_PROTOCOL": "sync.advice.protocol",
        "E_SYNC_CIRCUIT_OPEN": "sync.advice.circuit",
        "E_SYNC_RESTORE_CHOICE": "sync.advice.restoreChoice",
        "E_SYNC_VAULT_MOVED": "sync.advice.moved",
        "E_SYNC_VAULT_ROTATED": "sync.advice.rotated",
    ]
    private static let revoked: [String: String] = [
        "E_SYNC_REVOKED": "syncSettings.stoppedRevoked",
        "E_SYNC_UNAUTHORIZED": "syncSettings.stoppedRevoked",
    ]
    private static let unreachable: Set<String> = ["E_SYNC_OFFLINE", "E_SYNC_RELAY_FAILED"]
    static let storageFull = "E_SYNC_STORAGE_FULL"
    private static let quota = "E_SYNC_QUOTA"

    static let why: [String: String] = [
        "E_SYNC_RELAY_OUTDATED": "syncSettings.why.outdated",
        "E_SYNC_VAULT_EXISTS": "syncSettings.why.otherVault",
        "E_SYNC_PAIRING_GONE": "syncSettings.why.codeGone",
        "E_SYNC_PAIRING_EXPIRED": "syncSettings.why.codeGone",
        "E_SYNC_PAIRING_CODE": "syncSettings.why.codeMistyped",
        "E_SYNC_PAIRING_CHECKSUM": "syncSettings.why.codeMistyped",
        "E_SYNC_PAIRING_VERSION": "syncSettings.why.codeMistyped",
        "E_SYNC_PAIRING_AUTH": "syncSettings.why.codeRefused",
        "E_SYNC_PAIRING_RELAY": "syncSettings.why.otherRelay",
        "E_SYNC_RECOVERY_FORMAT": "syncSettings.why.keyMistyped",
        "E_SYNC_RECOVERY_CHECKSUM": "syncSettings.why.keyMistyped",
        "E_SYNC_RECOVERY_VERSION": "syncSettings.why.keyMistyped",
        "E_SYNC_RECOVERY_OTHER_VAULT": "syncSettings.why.leaveOtherKey",
        "E_SYNC_NO_RELAY": "syncSettings.why.noRelay",
        "E_SYNC_NO_VAULT": "syncSettings.why.noVault",
        "E_SYNC_RELAY_URL_INVALID": "syncSettings.why.relayInvalid",
        "E_SYNC_RELAY_SECRET": "syncSettings.why.relaySecret",
        "E_SYNC_RELAY_SECRET_INVALID": "syncSettings.why.relaySecretInvalid",
        "E_SYNC_OFFLINE": "syncSettings.why.unreachable",
        "E_SYNC_RELAY_FAILED": "syncSettings.why.unreachable",
        "E_SYNC_KEYCHAIN": "syncSettings.why.keychain",
        "E_SYNC_KEYCHAIN_UNAVAILABLE": "syncSettings.why.keychain",
        "E_SYNC_TOO_MANY_DEVICES": "syncSettings.why.tooManyDevices",
        "E_SYNC_ENROLL_DENIED": "syncSettings.why.enrollDenied",
        "E_SYNC_CLOUDKIT_UNAVAILABLE": "syncSettings.icloudUnavailableBuild",
        "E_SYNC_ICLOUD_SIGNED_OUT": "syncSettings.icloudSignedOut",
        "E_SYNC_ICLOUD_RESTRICTED": "syncSettings.icloudRestricted",
        "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE": "syncSettings.icloudTemporarilyUnavailable",
        "E_SYNC_ICLOUD_FULL": "syncSettings.icloudFull",
        "E_SYNC_ICLOUD_BUSY": "syncSettings.why.icloudBusy",
        "E_SYNC_ICLOUD_DELETED": "syncSettings.icloudDeleted",
        "E_SYNC_ICLOUD_ACCOUNT_CHANGED": "syncSettings.icloudAccountChanged",
        "E_SYNC_ICLOUD_OTHER_ACCOUNT": "syncSettings.icloudOtherAccount",
        "E_SYNC_ICLOUD_OTHER_VAULT": "syncSettings.why.icloudOtherVault",
        "E_SYNC_ICLOUD_NO_VAULT": "syncSettings.why.icloudNoVault",
        "E_SYNC_ICLOUD_LEAVING": "syncSettings.why.icloudLeaving",
        "E_SYNC_ICLOUD_NOT_USED": "syncSettings.why.icloudNotUsed",
        "E_SYNC_ICLOUD_FAILED": "syncSettings.why.icloudFailed",
        "E_SYNC_ICLOUD_ZONE_MISSING": "syncSettings.why.icloudZoneMissing",
        "E_SYNC_ICLOUD_RECORD_INVALID": "syncSettings.why.icloudRecordInvalid",
        "E_SYNC_ICLOUD_STAGING": "syncSettings.why.icloudStaging",
        "E_SYNC_MOVED_REFUSED": "syncSettings.why.movedRefused",
        "E_SYNC_VAULT_MOVED": "sync.advice.moved",
        "E_SYNC_VAULT_ROTATED": "syncSettings.why.rotated",
    ]

    /// `failureText`: the action's sentence, then why in sync's words, or the plain reason.
    static func failure(_ message: String, _ code: String) -> String {
        guard let key = why[code] else { return LicenceText.failure(catalog(message), code) }
        let reason = catalog(key)
        let ended = reason.last.map { ".!?".contains($0) } ?? false
        return "\(catalog(message)) \(ended ? reason : reason + ".")"
    }

    static func number(_ value: Int) -> String {
        value.formatted(.number.locale(Locale(identifier: "en")))
    }

    static func count(_ value: Int, _ one: String, _ other: String) -> String {
        L10n.fill(catalog(value == 1 ? one : other), ["count": number(value)])
    }

    /// `fileSize`: kB without a fraction, MB and GB with at most one digit after the point.
    static func fileSize(_ bytes: Int) -> String {
        let (value, unit): (Double, String) =
            bytes < 1_000_000
            ? (Double(bytes) / 1000, "kB") : bytes < 1_000_000_000 ? (Double(bytes) / 1_000_000, "MB") : (Double(bytes) / 1_000_000_000, "GB")
        let shown = bytes <= 0 ? 0 : max(value, unit == "kB" ? 1 : 0)
        let digits = unit == "kB" ? 0 : 1
        return "\(shown.formatted(.number.locale(Locale(identifier: "en")).precision(.fractionLength(0...digits)).rounded(rule: .toNearestOrAwayFromZero))) \(unit)"
    }

    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    static func when(_ ms: Double) -> String {
        date(ms).formatted(date: .abbreviated, time: .shortened)
    }

    static func day(_ ms: Double) -> String {
        date(ms).formatted(date: .abbreviated, time: .omitted)
    }

    static func shortTime(_ ms: Double) -> String {
        date(ms).formatted(date: .omitted, time: .shortened)
    }

    /// `untilTime`: the time today, else the weekday and time.
    static func until(_ ms: Double, _ now: Date) -> String {
        let at = date(ms)
        if Calendar.current.isDate(at, inSameDayAs: now) { return shortTime(ms) }
        return at.formatted(.dateTime.weekday(.wide).hour().minute(.twoDigits))
    }

    static func countdown(_ ms: Double) -> String {
        let seconds = max(0, Int((ms / 1000).rounded(.up)))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }

    static func pause(_ until: Double, over: Bool, code: String?, now: Date) -> String {
        let full = code == storageFull
        if over { return catalog(full ? "syncSettings.storageFullRetry" : "syncSettings.resuming") }
        return L10n.fill(
            catalog(full ? "syncSettings.storageFull" : "syncSettings.pausedUntil"), ["time": Self.until(until, now)])
    }

    static func pauseOver(_ snapshot: SyncSnapshot, _ now: Date) -> Bool {
        snapshot.status.pausedUntil.map { now.timeIntervalSince1970 * 1000 >= $0 } ?? false
    }

    /// True when the status row words the code in this state, so no code goes beside it.
    static func wordedCode(_ snapshot: SyncSnapshot) -> Bool {
        let status = snapshot.status
        guard let code = status.code else { return false }
        if ICloudAttention.held(snapshot) != nil { return true }
        switch status.state {
        case "stopped": return stopAdvice[code] != nil || revoked[code] != nil
        case "paused": return status.pausedUntil != nil && (code == storageFull || code == quota)
        case "offline": return unreachable.contains(code)
        default: return false
        }
    }

    static func details(_ snapshot: SyncSnapshot) -> [String] {
        let status = snapshot.status
        var parts: [String] = []
        if let upload = status.upload, snapshot.enabled {
            parts.append(
                L10n.fill(catalog("syncSettings.upload"), ["sent": number(upload.sent), "total": number(upload.total)]))
        }
        if let code = status.code, let reason = LicenceText.reason(code), snapshot.enabled, status.state != "idle",
            !wordedCode(snapshot)
        {
            parts.append(reason)
        }
        parts.append(
            status.lastSync.map { L10n.fill(catalog("syncSettings.lastSync"), ["time": when($0)]) }
                ?? catalog("syncSettings.neverSynced"))
        return parts
    }

    static func status(_ snapshot: SyncSnapshot, _ now: Date) -> String {
        let status = snapshot.status
        let shown = snapshot.shownState
        var parts = [
            shown == "paused" && status.pausedUntil != nil
                ? pause(status.pausedUntil!, over: pauseOver(snapshot, now), code: status.code, now: now)
                : catalog("syncSettings.state.\(shown)")
        ]
        if shown == "stopped", let code = status.code, let words = stopAdvice[code] ?? revoked[code] {
            parts.append(catalog(words))
        }
        return (parts + details(snapshot)).joined(separator: " ")
    }

    private static let lines: [String: String] = [
        "signedOut": "syncSettings.icloudSignedOut",
        "restricted": "syncSettings.icloudRestricted",
        "unavailable": "syncSettings.icloudTemporarilyUnavailable",
        "full": "syncSettings.icloudFull",
        "busy": "syncSettings.icloudPausedUntil",
        "accountChanged": "syncSettings.icloudAccountChanged",
        "deleted": "syncSettings.icloudDeleted",
        "noContainer": "syncSettings.icloudUnavailableBuild",
        "moved": "syncSettings.vaultMoved",
        "movedHere": "syncSettings.vaultMovedHere",
        "joined": "syncSettings.icloudJoined",
        "ask": "syncSettings.icloudJoinAsk",
        "fallback": "syncSettings.icloudKeychainMissing",
    ]

    private static func withHint(_ text: String, _ hint: String) -> String {
        let said = catalog(hint)
        return said.isEmpty ? text : "\(text) \(said)"
    }

    /// `icloudLine`: what Settings says about iCloud's state, and what the owner can do about it.
    static func icloudLine(
        _ attention: ICloudAttention, _ snapshot: SyncSnapshot, _ icloud: ICloudStatus, now: Date
    ) -> (text: String, actions: [ICloudAttention.Action]) {
        let key = lines[attention.kind]!
        let text: String
        switch attention {
        case .busy(let until):
            text =
                until == nil || pauseOver(snapshot, now)
                ? catalog("syncSettings.resumingICloud") : L10n.fill(catalog(key), ["time": self.until(until!, now)])
        case .ask(let notes): text = L10n.fill(catalog(key), ["count": number(notes)])
        case .fallback(let reason) where reason == "otherVault": text = catalog("syncSettings.icloudOtherItem")
        default: text = catalog(key)
        }
        switch attention {
        case .accountChanged: return (text, [.moveHere, .turnOff])
        case .deleted: return (text, [.uploadAgain, .turnOff])
        case .noContainer: return (text, [.turnOff])
        case .moved:
            return snapshot.transport == "relay" && icloud.available
                ? (withHint(text, "syncSettings.vaultMovedHint"), [.follow])
                : (withHint(text, "syncSettings.vaultMovedElsewhere"), [])
        case .movedHere:
            return icloud.available
                ? (withHint(text, "syncSettings.vaultMovedHereHint"), [.finish])
                : (withHint(text, "syncSettings.vaultMovedElsewhere"), [])
        case .ask: return (text, [.join, .decline])
        default: return (text, [])
        }
    }
}
