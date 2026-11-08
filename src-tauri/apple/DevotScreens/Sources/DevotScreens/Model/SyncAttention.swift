/// Whether Settings marks Sync because iCloud asks something of the owner (`syncICloud.ts`,
/// `syncNeedsOwner`), from the snapshot `direct.sync.get` answers.
enum SyncAttention {
    private static let byCode: [String: String] = [
        "E_SYNC_ICLOUD_SIGNED_OUT": "signedOut",
        "E_SYNC_ICLOUD_RESTRICTED": "restricted",
        "E_SYNC_ICLOUD_ACCOUNT_UNAVAILABLE": "unavailable",
        "E_SYNC_ICLOUD_FULL": "full",
        "E_SYNC_ICLOUD_BUSY": "busy",
        "E_SYNC_ICLOUD_ACCOUNT_CHANGED": "accountChanged",
        "E_SYNC_ICLOUD_DELETED": "deleted",
        "E_SYNC_CLOUDKIT_UNAVAILABLE": "noContainer",
        "E_SYNC_VAULT_MOVED": "moved",
    ]

    private static let ownerKinds: Set<String> = [
        "signedOut", "restricted", "full", "accountChanged", "deleted", "noContainer", "moved", "movedHere", "ask",
        "fallback",
    ]

    static func needsOwner(_ sync: JSONValue) -> Bool {
        kind(sync).map(ownerKinds.contains) ?? false
    }

    static func kind(_ sync: JSONValue) -> String? {
        let status = sync["status"]
        let state = status?["state"]?.string ?? ""
        if sync["enabled"]?.bool == true, let code = status?["code"]?.string,
            ["paused", "stopped", "offline"].contains(state), let held = byCode[code]
        {
            return held == "moved" && sync["moveStarted"]?.bool == true ? "movedHere" : held
        }
        guard let join = sync["icloudJoin"], let joinState = join["state"]?.string else { return nil }
        if joinState == "joined", sync["transport"]?.string == "icloud" {
            let runsWell = status?["code"]?.string == nil && ["idle", "syncing", "connecting"].contains(state)
            return runsWell ? "joined" : nil
        }
        if sync["vault"]?.bool == true { return nil }
        if joinState == "ask" || joinState == "fallback" { return joinState }
        guard joinState == "unavailable", let code = join["code"]?.string, let blocked = byCode[code] else {
            return nil
        }
        return ["signedOut", "restricted", "unavailable"].contains(blocked) ? blocked : nil
    }
}
